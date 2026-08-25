import assert from "node:assert/strict";
import test from "node:test";
import { validateDelegateContinuation } from "../src/delegate-continuation.ts";
import type { SubagentSnapshot } from "../vendor/headless/src/domain.ts";

function snapshot(
  overrides: Partial<SubagentSnapshot> = {},
): SubagentSnapshot {
  return {
    id: "sa-1",
    backend: "codex",
    title: "strict task",
    prompt: "Do the task",
    cwd: "/tmp/project",
    subagentName: "scout",
    profileName: "fast",
    resultDelivery: "automatic",
    runGeneration: 1,
    status: "done",
    createdAt: 1,
    settledAt: 2,
    meta: { backend: "codex" },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "done",
    turns: 1,
    ...overrides,
  };
}

test("accepts only a completed direct strict delegate", () => {
  assert.equal(validateDelegateContinuation("sa-1", snapshot()).ok, true);
  assert.equal(
    validateDelegateContinuation("sa-1", snapshot({ status: "running" })).ok,
    false,
  );
  assert.equal(
    validateDelegateContinuation("sa-1", snapshot({ status: "error" })).ok,
    false,
  );
  assert.equal(
    validateDelegateContinuation(
      "sa-1",
      snapshot({ subagentName: undefined, profileName: undefined }),
    ).ok,
    false,
  );
  assert.equal(
    validateDelegateContinuation(
      "sa-1",
      snapshot({ resultDelivery: "managed" }),
    ).ok,
    false,
  );
  assert.equal(validateDelegateContinuation("sa-missing", undefined).ok, false);
});

test("continuation errors explain the safe next action", () => {
  const failed = validateDelegateContinuation(
    "sa-1",
    snapshot({ status: "error" }),
  );
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(failed.error.message, /start a fresh delegate/);

  const managed = validateDelegateContinuation(
    "sa-1",
    snapshot({ resultDelivery: "managed" }),
  );
  assert.equal(managed.ok, false);
  if (!managed.ok) assert.match(managed.error.message, /owned by a chain/);
});
