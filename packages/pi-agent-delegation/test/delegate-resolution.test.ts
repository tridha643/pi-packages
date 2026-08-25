import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveStrictDelegate } from "../src/delegate-resolution.ts";

async function withFixture(
  run: (fixture: {
    root: string;
    project: string;
    globalAgents: string;
    globalProfiles: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "delegate-resolution-"));
  const project = join(root, "project");
  const globalAgents = join(root, "global-agents");
  const globalProfiles = join(root, "global-profiles");
  await Promise.all([
    mkdir(join(project, ".pi", "agents"), { recursive: true }),
    mkdir(join(project, ".pi", "delegate-profiles"), { recursive: true }),
    mkdir(globalAgents, { recursive: true }),
    mkdir(globalProfiles, { recursive: true }),
  ]);
  try {
    await run({ root, project, globalAgents, globalProfiles });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const PROFILE =
  "name: fast\ndescription: Fast local target\nbestFor:\n  - Quick tasks\nstrengths:\n  - Low latency\nlimitations:\n  - Less depth\ntarget:\n  harness: pi\n  model: provider/model\n  reasoning: low\n";

test("untrusted resolution ignores project overrides before selecting", async () => {
  await withFixture(async ({ project, globalAgents, globalProfiles }) => {
    await writeFile(
      join(globalAgents, "bee.md"),
      "---\nname: bee\ndescription: Global Bee\n---\nGlobal instructions.\n",
    );
    await writeFile(
      join(project, ".pi", "agents", "bee.md"),
      "---\nname: bee\ndescription: Project Bee\n---\nProject instructions.\n",
    );
    await writeFile(join(globalProfiles, "fast.yaml"), PROFILE);

    const result = await resolveStrictDelegate({
      cwd: project,
      includeProject: false,
      subagentName: "bee",
      profileName: "fast",
      globalAgentDir: globalAgents,
      globalProfileDir: globalProfiles,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.subagent.source, "global");
      assert.equal(result.value.subagent.description, "Global Bee");
    }
  });
});

test("strict resolution rejects missing role fields and nested spawning", async () => {
  await withFixture(async ({ project, globalAgents, globalProfiles }) => {
    await writeFile(join(globalProfiles, "fast.yaml"), PROFILE);
    await writeFile(
      join(globalAgents, "missing.md"),
      "---\nname: missing\n---\nInstructions only.\n",
    );
    const missing = await resolveStrictDelegate({
      cwd: project,
      includeProject: false,
      subagentName: "missing",
      profileName: "fast",
      globalAgentDir: globalAgents,
      globalProfileDir: globalProfiles,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "invalid-subagent");

    await writeFile(
      join(globalAgents, "nested.md"),
      "---\nname: nested\ndescription: Nested\nspawning: true\n---\nSpawn more work.\n",
    );
    const nested = await resolveStrictDelegate({
      cwd: project,
      includeProject: false,
      subagentName: "nested",
      profileName: "fast",
      globalAgentDir: globalAgents,
      globalProfileDir: globalProfiles,
    });
    assert.equal(nested.ok, false);
    if (!nested.ok) assert.match(nested.error.message, /nested delegation is disabled/);
  });
});

test("call working directory overrides the saved subagent directory", async () => {
  await withFixture(async ({ project, globalAgents, globalProfiles }) => {
    await mkdir(join(project, "saved-cwd"));
    await mkdir(join(project, "call-cwd"));
    await writeFile(
      join(globalAgents, "bee.md"),
      "---\nname: bee\ndescription: Bee\ncwd: saved-cwd\n---\nAnalyze.\n",
    );
    await writeFile(join(globalProfiles, "fast.yaml"), PROFILE);

    const result = await resolveStrictDelegate({
      cwd: project,
      includeProject: false,
      subagentName: "bee",
      profileName: "fast",
      workingDir: "call-cwd",
      globalAgentDir: globalAgents,
      globalProfileDir: globalProfiles,
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.workingDir, join(project, "call-cwd"));
  });
});
