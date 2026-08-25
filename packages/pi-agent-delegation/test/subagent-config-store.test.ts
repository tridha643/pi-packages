import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deleteSubagentConfiguration,
  saveDelegateProfile,
  saveSubagentDefinition,
} from "../src/subagent-config-store.ts";

async function withTempDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "subagent-config-store-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("saves validated subagent markdown and requires explicit replacement", async () => {
  await withTempDirectory(async (directory) => {
    const globalAgentDir = join(directory, "agents");
    const first = await saveSubagentDefinition({
      scope: "global",
      cwd: directory,
      globalAgentDir,
      name: "bee",
      description: "Skeptical reviewer",
      instructions: "Challenge unsupported conclusions.",
      tools: ["read", "grep"],
      skills: ["testing-quality"],
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const content = await readFile(first.filePath, "utf8");
    assert.match(content, /name: bee/);
    assert.match(content, /Challenge unsupported conclusions\./);

    const duplicate = await saveSubagentDefinition({
      scope: "global",
      cwd: directory,
      globalAgentDir,
      name: "bee",
      description: "Replacement",
      instructions: "Replace it.",
    });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.error.code, "already-exists");

    const replacement = await saveSubagentDefinition({
      scope: "global",
      cwd: directory,
      globalAgentDir,
      name: "bee",
      description: "Replacement",
      instructions: "Replace it.",
      replace: true,
    });
    assert.equal(replacement.ok, true);
    assert.match(await readFile(first.filePath, "utf8"), /Replace it\./);
  });
});

test("concurrent create-only writes atomically allow exactly one winner", async () => {
  await withTempDirectory(async (directory) => {
    const globalAgentDir = join(directory, "agents");
    const results = await Promise.all([
      saveSubagentDefinition({
        scope: "global",
        cwd: directory,
        globalAgentDir,
        name: "scout",
        description: "First writer",
        instructions: "Return first.",
      }),
      saveSubagentDefinition({
        scope: "global",
        cwd: directory,
        globalAgentDir,
        name: "scout",
        description: "Second writer",
        instructions: "Return second.",
      }),
    ]);

    assert.equal(results.filter((result) => result.ok).length, 1);
    const failure = results.find((result) => !result.ok);
    assert.ok(failure && !failure.ok);
    assert.equal(failure.error.code, "already-exists");
    const stored = await readFile(join(globalAgentDir, "scout.md"), "utf8");
    assert.ok(
      stored.includes("First writer") || stored.includes("Second writer"),
    );
  });
});

test("rejects invalid names and incomplete profile metadata before writing", async () => {
  await withTempDirectory(async (directory) => {
    const badName = await saveDelegateProfile({
      scope: "global",
      cwd: directory,
      globalProfileDir: join(directory, "profiles"),
      name: "../escape",
      description: "Exact target",
      bestFor: ["Implementation"],
      strengths: ["Reliable edits"],
      limitations: ["Higher latency"],
      target: { harness: "pi", model: "provider/model", reasoning: "high" },
    });
    assert.equal(badName.ok, false);
    if (!badName.ok) assert.equal(badName.error.code, "invalid-name");

    const empty = await saveDelegateProfile({
      scope: "global",
      cwd: directory,
      globalProfileDir: join(directory, "profiles"),
      name: "empty",
      description: "Exact target",
      bestFor: [],
      strengths: ["Reliable edits"],
      limitations: ["Higher latency"],
      target: { harness: "pi", model: "provider/model", reasoning: "high" },
    });
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.error.code, "invalid-definition");
  });
});

test("project writes and deletes reject symlinked configuration directories", async () => {
  await withTempDirectory(async (directory) => {
    const project = join(directory, "project");
    const outside = join(directory, "outside");
    await mkdir(join(project, ".pi"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(project, ".pi", "agents"), "dir");

    const saved = await saveSubagentDefinition({
      scope: "project",
      cwd: project,
      name: "bee",
      description: "Must stay scoped",
      instructions: "Do not escape.",
    });
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.error.code, "unsafe-target");
    await assert.rejects(access(join(outside, "bee.md")));

    await writeFile(join(outside, "bee.md"), "outside");
    const deleted = await deleteSubagentConfiguration({
      kind: "subagent",
      scope: "project",
      cwd: project,
      name: "bee",
    });
    assert.equal(deleted.ok, false);
    if (!deleted.ok) assert.equal(deleted.error.code, "unsafe-target");
    assert.equal(await readFile(join(outside, "bee.md"), "utf8"), "outside");
  });
});

test("deleting from a missing project config directory returns not-found", async () => {
  await withTempDirectory(async (directory) => {
    const project = join(directory, "project");
    await mkdir(project);

    const result = await deleteSubagentConfiguration({
      kind: "subagent",
      scope: "project",
      cwd: project,
      name: "missing",
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "not-found");
  });
});

test("deletes discovered .yml profiles as well as canonical .yaml profiles", async () => {
  await withTempDirectory(async (directory) => {
    const globalProfileDir = join(directory, "profiles");
    await mkdir(globalProfileDir, { recursive: true });
    const ymlPath = join(globalProfileDir, "quality.yml");
    await writeFile(
      ymlPath,
      "name: quality\ndescription: Exact target\nbestFor:\n  - Implementation\nstrengths:\n  - Reliable edits\nlimitations:\n  - Higher latency\ntarget:\n  harness: pi\n  model: provider/model\n  reasoning: high\n",
    );

    const deleted = await deleteSubagentConfiguration({
      kind: "profile",
      scope: "global",
      cwd: directory,
      name: "quality",
      globalProfileDir,
    });

    assert.equal(deleted.ok, true);
    if (deleted.ok) assert.equal(deleted.filePath, ymlPath);
    await assert.rejects(access(ymlPath));
  });
});

test("saves and deletes a strict profile in the requested scope", async () => {
  await withTempDirectory(async (directory) => {
    const globalProfileDir = join(directory, "profiles");
    const saved = await saveDelegateProfile({
      scope: "global",
      cwd: directory,
      globalProfileDir,
      name: "deep-thinker",
      description: "Careful cross-harness analysis",
      bestFor: ["Complex implementation"],
      strengths: ["Deep reasoning"],
      limitations: ["Higher latency"],
      target: { harness: "claude", model: "opus", reasoning: "high" },
    });
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    const content = await readFile(saved.filePath, "utf8");
    assert.match(content, /target:/);
    assert.match(content, /bestFor:/);
    assert.doesNotMatch(content, /candidates:/);

    const deleted = await deleteSubagentConfiguration({
      kind: "profile",
      scope: "global",
      cwd: directory,
      name: "deep-thinker",
      globalProfileDir,
    });
    assert.equal(deleted.ok, true);

    const missing = await deleteSubagentConfiguration({
      kind: "profile",
      scope: "global",
      cwd: directory,
      name: "deep-thinker",
      globalProfileDir,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "not-found");
  });
});
