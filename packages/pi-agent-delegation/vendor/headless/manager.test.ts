/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: scripted
 * stub sessions registered under the claude/codex names (the production
 * backends launch real processes and have their own live test files), plus
 * the real pi backend for its cheap registry precondition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type {
  BackendName,
  ParentContext,
  SpawnTask,
  SubagentSnapshot,
} from "./src/domain.ts";
import { BackendPreflightRejectedError } from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import { runTool } from "./src/runtime.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    piBackend,
    makeStubBackend({
      backend: "claude",
      defaultModelLabel: "claude/sonnet",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 40,
    }),
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt-5-codex",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 30,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "claude");
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:claude\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // The waitFor marked the settle as consumed.
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("FAIL: blow up please")),
    );
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("excess spawns activate in FIFO order as slots settle", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);

    const activationOrder: number[] = [];
    const fifth = runTool(
      runtime,
      manager.spawn("codex", task("Task 5")),
    ).then((snapshot) => {
      activationOrder.push(5);
      return snapshot;
    });
    const sixth = runTool(
      runtime,
      manager.spawn("codex", task("Task 6")),
    ).then((snapshot) => {
      activationOrder.push(6);
      return snapshot;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(activationOrder, []);

    await runTool(runtime, manager.cancel([spawns[0]!.id]));
    const fifthSnapshot = await fifth;
    assert.deepEqual(activationOrder, [5]);

    await runTool(runtime, manager.cancel([spawns[1]!.id]));
    const sixthSnapshot = await sixth;
    assert.deepEqual(activationOrder, [5, 6]);
    assert.equal(fifthSnapshot.prompt, "Task 5");
    assert.equal(sixthSnapshot.prompt, "Task 6");
  });
});

test("parallel excess spawns never exceed four active runs", async () => {
  await withManager(async (manager, runtime) => {
    let maximumRunning = 0;
    const recordRunningCount = () => {
      const running = manager.view
        .list()
        .filter((snapshot) => snapshot.status === "running").length;
      maximumRunning = Math.max(maximumRunning, running);
    };
    const unsubscribe = manager.view.subscribe(recordRunningCount);
    try {
      const spawns = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          runTool(
            runtime,
            manager.spawn("codex", task(`Parallel task ${index + 1}`)),
          ),
        ),
      );
      recordRunningCount();
      assert.equal(spawns.length, 12);
      assert.equal(maximumRunning, 4);
    } finally {
      unsubscribe();
    }
  });
});

test("queued spawn cancellation and shutdown do not leak admission", async () => {
  await withManager(async (manager, runtime) => {
    const active = await Promise.all(
      [1, 2, 3, 4].map((index) =>
        runTool(runtime, manager.spawn("codex", task(`Active ${index}`))),
      ),
    );

    const cancelledController = new AbortController();
    const cancelledSpawn = runTool(
      runtime,
      manager.spawn("codex", task("Cancelled while queued")),
      { signal: cancelledController.signal },
    );
    const nextSpawn = runTool(
      runtime,
      manager.spawn("codex", task("Next queued spawn")),
    );
    cancelledController.abort();
    await assert.rejects(cancelledSpawn, /Operation was aborted/);

    await runTool(runtime, manager.cancel([active[0]!.id]));
    const admitted = await nextSpawn;
    assert.equal(admitted.prompt, "Next queued spawn");
    assert.ok(
      manager.view
        .list()
        .every((snapshot) => snapshot.prompt !== "Cancelled while queued"),
    );

    const shutdownSpawn = runTool(
      runtime,
      manager.spawn("codex", task("Queued during shutdown")),
    );
    await runTool(runtime, manager.disposeAll);
    await assert.rejects(shutdownSpawn, /shut down while waiting to spawn/);
    assert.equal(manager.view.size(), 0);
  });
});

test("pi spawn fails fast without the parent model registry", async () => {
  await withManager(async (manager, runtime) => {
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("needs a registry"))),
      /model registry/,
    );
    // The failed spawn must release its concurrency reservation.
    const snap = await runTool(runtime, manager.spawn("codex", task("ok")));
    assert.equal(snap.backend, "codex");
  });
});

test("pi model resolution rejections are fallback-safe", async () => {
  await withManager(async (manager, runtime) => {
    const cases = [
      {
        model: "missing-model",
        models: [],
        message: /Unknown model/,
      },
      {
        model: "shared-model",
        models: [
          { id: "shared-model", provider: "provider-a" },
          { id: "shared-model", provider: "provider-b" },
        ],
        message: /multiple providers/,
      },
    ] as const;

    for (const testCase of cases) {
      // SAFETY: Pi model resolution only calls find() and getAll() before the
      // expected rejection; no AgentSession is constructed in these cases.
      const modelRegistry = {
        find: () => undefined,
        getAll: () => [...testCase.models],
      } as unknown as ModelRegistry;
      const spawnTask: SpawnTask = {
        ...task("resolve a model"),
        model: testCase.model,
        parent: { ...parent, modelRegistry },
      };
      const result = await runTool(
        runtime,
        manager.spawn("pi", spawnTask).pipe(Effect.result),
      );
      assert.ok(Result.isFailure(result));
      assert.ok(result.failure instanceof BackendPreflightRejectedError);
      assert.match(result.failure.message, testCase.message);
    }

    // Both rejected preflights must release their concurrency reservations.
    const snap = await runTool(runtime, manager.spawn("codex", task("ok")));
    assert.equal(snap.backend, "codex");
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    // Settle one subagent, then fill all four slots with running ones.
    const settled = await runTool(
      runtime,
      manager.spawn("claude", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    // Restarting the settled one would be a fifth concurrent run.
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /Max 4 subagents/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("an accepted idle restart can be cancelled immediately", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    const report = await runTool(runtime, manager.cancel([snap.id]));

    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.runGeneration, 2);
  });
});

test("automatic delivery retains both continuation generations exactly once", async () => {
  await withManager(async (manager, runtime) => {
    const delivery = createDeferredResultDelivery<SubagentSnapshot>(
      (snapshot) => `${snapshot.id}:${snapshot.runGeneration}`,
    );
    manager.view.setOnSettled((snapshot, consumed) => {
      if (!consumed) delivery.defer({ ...snapshot, meta: { ...snapshot.meta } });
    });

    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const delivered = delivery.drain();
    assert.deepEqual(
      delivered.map((snapshot) => ({
        generation: snapshot.runGeneration,
        matchesExpectedOutput: snapshot.finalText.startsWith(
          `[stub:claude] completed: ${snapshot.runGeneration === 1 ? "First" : "Second"} turn`,
        ),
      })),
      [
        { generation: 1, matchesExpectedOutput: true },
        { generation: 2, matchesExpectedOutput: true },
      ],
    );
    assert.deepEqual(delivery.drain(), []);
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    const restarting = manager.view.get(snap.id);
    assert.equal(restarting?.status, "running");
    assert.equal(restarting?.runGeneration, 2);
    assert.equal(restarting?.finalText, "");

    const wait = runTool(runtime, manager.waitFor([snap.id]));
    const early = await Promise.race([
      wait.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    assert.equal(early, "pending");
    await wait;

    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.equal(afterSecond?.runGeneration, 2);
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});
