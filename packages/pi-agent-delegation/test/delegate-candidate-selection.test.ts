import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Result } from "effect";
import { selectAndSpawnDelegateCandidate } from "../src/delegate-candidate-selection.ts";
import type { SubagentManagerShape } from "../vendor/headless/src/manager.ts";
import {
  BackendPreflightRejectedError,
  BackendUnavailableError,
  ConcurrencyLimitError,
  SpawnError,
  type BackendName,
  type SpawnTask,
  type SubagentSnapshot,
} from "../vendor/headless/src/domain.ts";

function snapshot(backend: BackendName, task: SpawnTask): SubagentSnapshot {
  return {
    id: "sa-1",
    backend,
    title: task.title,
    prompt: task.prompt,
    cwd: task.cwd,
    resultDelivery: task.resultDelivery ?? "automatic",
    runGeneration: 1,
    status: "running",
    createdAt: 0,
    meta: { backend, modelLabel: task.model },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
  };
}

const baseTask = {
  prompt: "Inspect the repository.",
  title: "inspect",
  cwd: "/tmp",
  parent: { parentCwd: "/tmp", projectTrusted: true },
} satisfies Omit<SpawnTask, "model" | "reasoningEffort">;

test("falls back only across explicit unavailable and preflight-rejected candidates", async () => {
  const attempts: string[] = [];
  const spawn: SubagentManagerShape["spawn"] = (backend, task) => {
    attempts.push(`${backend}/${task.model}/${task.reasoningEffort}`);
    if (backend === "claude") {
      return Effect.fail(
        new BackendUnavailableError({ message: "claude unavailable" }),
      );
    }
    if (backend === "codex") {
      return Effect.fail(
        new BackendPreflightRejectedError({ message: "unknown model" }),
      );
    }
    return Effect.succeed(snapshot(backend, task));
  };

  const selected = await Effect.runPromise(
    selectAndSpawnDelegateCandidate({
      spawn,
      task: baseTask,
      candidates: [
        { harness: "claude", model: "opus", reasoning: "high" },
        { harness: "codex", model: "missing", reasoning: "high" },
        { harness: "pi", model: "provider/model", reasoning: "high" },
      ],
    }),
  );

  assert.deepEqual(attempts, [
    "claude/opus/high",
    "codex/missing/high",
    "pi/provider/model/high",
  ]);
  assert.equal(selected.selected.harness, "pi");
  assert.equal(selected.rejected.length, 2);
});

test("one exact saved-profile target fails clearly without substitution", async () => {
  const attempts: string[] = [];
  const spawn: SubagentManagerShape["spawn"] = (backend) => {
    attempts.push(backend);
    return Effect.fail(
      new BackendUnavailableError({ message: "Exact model is unavailable." }),
    );
  };
  const result = await Effect.runPromise(
    selectAndSpawnDelegateCandidate({
      spawn,
      candidates: [
        { harness: "claude", model: "claude-opus-5", reasoning: "high" },
      ],
      task: baseTask,
    }).pipe(Effect.result),
  );

  assert.deepEqual(attempts, ["claude"]);
  assert.equal(Result.isFailure(result), true);
  if (Result.isFailure(result)) {
    assert.match(
      result.failure.message,
      /Delegate profile target claude\/claude-opus-5:high was unavailable/,
    );
  }
});

test("an ambiguous SpawnError stops selection without trying later candidates", async () => {
  const attempts: string[] = [];
  const spawn: SubagentManagerShape["spawn"] = (backend) => {
    attempts.push(backend);
    return Effect.fail(
      new SpawnError({ message: "turn/start timed out after possible acceptance" }),
    );
  };

  const result = await Effect.runPromise(
    selectAndSpawnDelegateCandidate({
      spawn,
      task: baseTask,
      candidates: [
        { harness: "codex", model: "first", reasoning: "high" },
        { harness: "pi", model: "second", reasoning: "high" },
      ],
    }).pipe(Effect.result),
  );

  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof SpawnError);
  assert.deepEqual(attempts, ["codex"]);
});

test("a concurrency limit stops selection without trying later candidates", async () => {
  const attempts: string[] = [];
  const spawn: SubagentManagerShape["spawn"] = (backend) => {
    attempts.push(backend);
    return Effect.fail(
      new ConcurrencyLimitError({ message: "all slots occupied" }),
    );
  };

  const result = await Effect.runPromise(
    selectAndSpawnDelegateCandidate({
      spawn,
      task: baseTask,
      candidates: [
        { harness: "claude", model: "first", reasoning: "high" },
        { harness: "pi", model: "second", reasoning: "low" },
      ],
    }).pipe(Effect.result),
  );

  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof ConcurrencyLimitError);
  assert.deepEqual(attempts, ["claude"]);
});

test("rejects a Codex candidate that cannot enforce a named tool allowlist", async () => {
  const attempts: string[] = [];
  const spawn: SubagentManagerShape["spawn"] = (backend, task) => {
    attempts.push(backend);
    return Effect.succeed(snapshot(backend, task));
  };

  const selected = await Effect.runPromise(
    selectAndSpawnDelegateCandidate({
      spawn,
      task: { ...baseTask, allowedTools: ["read"] },
      candidates: [
        { harness: "codex", model: "gpt", reasoning: "high" },
        { harness: "pi", model: "provider/model", reasoning: "high" },
      ],
    }),
  );

  assert.deepEqual(attempts, ["pi"]);
  assert.equal(selected.rejected[0]?.candidate.harness, "codex");
});

test("rejects every external-harness candidate that cannot enforce a named tool allowlist", async () => {
  const attempts: string[] = [];
  const spawn: SubagentManagerShape["spawn"] = (backend, task) => {
    attempts.push(backend);
    return Effect.succeed(snapshot(backend, task));
  };

  const selected = await Effect.runPromise(
    selectAndSpawnDelegateCandidate({
      spawn,
      task: { ...baseTask, allowedTools: ["read"] },
      candidates: [
        { harness: "cursor", model: "composer-2.5-fast", reasoning: "high" },
        {
          harness: "opencode",
          model: "moonshotai/kimi-k2.7-code",
          reasoning: "high",
        },
        { harness: "pi", model: "provider/model", reasoning: "high" },
      ],
    }),
  );

  assert.deepEqual(attempts, ["pi"]);
  assert.deepEqual(
    selected.rejected.map((entry) => entry.candidate.harness),
    ["cursor", "opencode"],
  );
  assert.match(selected.rejected[0]?.reason ?? "", /^Cursor cannot enforce/u);
  assert.match(selected.rejected[1]?.reason ?? "", /^OpenCode cannot enforce/u);
});

test("an external-harness candidate is still eligible without a tool allowlist", async () => {
  const attempts: string[] = [];
  const spawn: SubagentManagerShape["spawn"] = (backend, task) => {
    attempts.push(backend);
    return Effect.succeed(snapshot(backend, task));
  };

  const selected = await Effect.runPromise(
    selectAndSpawnDelegateCandidate({
      spawn,
      task: baseTask,
      candidates: [
        { harness: "cursor", model: "composer-2.5-fast", reasoning: "high" },
        { harness: "pi", model: "provider/model", reasoning: "high" },
      ],
    }),
  );

  assert.deepEqual(attempts, ["cursor"]);
  assert.equal(selected.selected.harness, "cursor");
  assert.deepEqual(selected.rejected, []);
});
