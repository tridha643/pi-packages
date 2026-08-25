import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DelegateRunStore } from "../src/delegate-run-store.ts";

test("run store appends minimal structured events with owner-only permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delegate-runs-"));
  try {
    const store = new DelegateRunStore(directory);
    const result = await store.append({
      schemaVersion: 1,
      event: "launched",
      timestamp: "2026-07-24T12:00:00.000Z",
      parentSessionId: "parent-1",
      delegateId: "sa-1",
      runGeneration: 1,
      project: "repo",
      cwd: "/tmp/repo",
      subagent: "builder",
      profile: "balanced",
      harness: "codex",
      model: "gpt-5.6-sol",
      reasoning: "medium",
      contextPolicy: "handoff",
      evidencePackId: "pack-1",
      evidenceSourceIds: ["memory:7"],
      writePaths: [],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const contents = await readFile(result.filePath, "utf8");
    const event: unknown = JSON.parse(contents.trim());
    assert.deepEqual(event, {
      schemaVersion: 1,
      event: "launched",
      timestamp: "2026-07-24T12:00:00.000Z",
      parentSessionId: "parent-1",
      delegateId: "sa-1",
      runGeneration: 1,
      project: "repo",
      cwd: "/tmp/repo",
      subagent: "builder",
      profile: "balanced",
      harness: "codex",
      model: "gpt-5.6-sol",
      reasoning: "medium",
      contextPolicy: "handoff",
      evidencePackId: "pack-1",
      evidenceSourceIds: ["memory:7"],
      writePaths: [],
    });
    if (process.platform !== "win32") {
      assert.equal((await stat(result.filePath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("run store serializes concurrent appends without losing events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delegate-runs-"));
  try {
    const store = new DelegateRunStore(directory);
    const events = [1, 2, 3].map((generation) =>
      store.append({
        schemaVersion: 1,
        event: "continued",
        timestamp: "2026-07-24T12:00:00.000Z",
        parentSessionId: "parent-1",
        delegateId: "sa-1",
        runGeneration: generation,
        project: "repo",
        cwd: "/tmp/repo",
        subagent: "builder",
        profile: "balanced",
        contextPolicy: "continue",
      }),
    );
    const results = await Promise.all(events);
    assert.equal(results.every((result) => result.ok), true);
    const first = results[0];
    assert.ok(first?.ok);
    if (!first?.ok) return;
    const lines = (await readFile(first.filePath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 3);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
