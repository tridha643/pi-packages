import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { opencodeBackend } from "./src/backends/opencode.ts";
import type { ParentContext, SpawnTask } from "./src/domain.ts";
import { SubagentManager } from "./src/manager.ts";
import {
  createSubagentRuntime,
  runTool,
  type SubagentRuntime,
} from "./src/runtime.ts";

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function openCodeTask(prompt: string): SpawnTask {
  return {
    prompt,
    title: "live OpenCode test",
    cwd: process.cwd(),
    model: "openai/gpt-5.4-mini",
    reasoningEffort: "off",
    parent,
  };
}

/** Reject a live OpenCode operation while leaving caller cleanup in finally. */
function openCodeDeadline<A>(
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
            `Live OpenCode ${operationName} exceeded ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function openCodeAvailable() {
  return Effect.runPromise(opencodeBackend.available);
}

function restoreEnvironmentVariable(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test(
  "OpenCode backend completes a live manager run",
  { timeout: 105_000 },
  async (t) => {
    if (!(await openCodeAvailable())) {
      t.skip("OpenCode executable is unavailable");
      return;
    }

    const originalConfigHome = process.env.XDG_CONFIG_HOME;
    const isolatedConfigHome = await mkdtemp(
      join(tmpdir(), "pi-opencode-live-config-"),
    );
    let runtime: SubagentRuntime | undefined;
    // Keep XDG_DATA_HOME unchanged so the isolated config still sees the
    // user's existing OpenCode provider authentication.
    process.env.XDG_CONFIG_HOME = isolatedConfigHome;

    try {
      runtime = createSubagentRuntime();
      const manager = await runtime.runPromise(SubagentManager);
      const spawned = await runTool(
        runtime,
        manager.spawn(
          "opencode",
          openCodeTask("Reply with exactly: hello opencode"),
        ),
      );

      await openCodeDeadline(
        runTool(runtime, manager.waitFor([spawned.id])),
        "run",
        70_000,
      );
      const done = manager.view.get(spawned.id);
      assert.equal(done?.status, "done");
      assert.match(done?.finalText ?? "", /hello opencode/i);
      assert.equal(done?.meta.backend, "opencode");
      assert.ok(done?.meta.nativeSessionId);
    } finally {
      try {
        if (runtime) {
          await openCodeDeadline(runtime.dispose(), "disposal", 10_000);
        }
      } finally {
        restoreEnvironmentVariable("XDG_CONFIG_HOME", originalConfigHome);
        await rm(isolatedConfigHome, { recursive: true, force: true });
      }
    }
  },
);
