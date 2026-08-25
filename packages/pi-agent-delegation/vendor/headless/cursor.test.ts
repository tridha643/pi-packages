import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { cursorBackend } from "./src/backends/cursor.ts";
import type { ParentContext, SpawnTask } from "./src/domain.ts";
import { SubagentManager } from "./src/manager.ts";
import { createSubagentRuntime, runTool } from "./src/runtime.ts";

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function cursorTask(prompt: string): SpawnTask {
  return {
    prompt,
    title: "live Cursor test",
    cwd: process.cwd(),
    model: "composer-2.5",
    reasoningEffort: "off",
    parent,
  };
}

/** Reject a live Cursor operation while leaving caller cleanup in finally. */
function cursorDeadline<A>(
  operation: Promise<A>,
  operationName: string,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Live Cursor ${operationName} exceeded ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function cursorAvailable() {
  return Effect.runPromise(cursorBackend.available);
}

test(
  "Cursor backend completes a live manager run",
  { timeout: 90_000 },
  async (t) => {
    if (!(await cursorAvailable())) {
      t.skip("Cursor SDK credentials are unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const spawned = await runTool(
        runtime,
        manager.spawn(
          "cursor",
          cursorTask("Reply with exactly: hello cursor"),
        ),
      );

      await cursorDeadline(
        runTool(runtime, manager.waitFor([spawned.id])),
        "run",
        60_000,
      );
      const done = manager.view.get(spawned.id);
      assert.equal(done?.status, "done");
      assert.match(done?.finalText ?? "", /hello cursor/i);
      assert.equal(done?.meta.backend, "cursor");
      assert.ok(done?.meta.nativeSessionId);
    } finally {
      await cursorDeadline(runtime.dispose(), "disposal", 10_000);
    }
  },
);
