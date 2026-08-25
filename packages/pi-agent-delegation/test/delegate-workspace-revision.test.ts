import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureDelegateWorkspaceRevision } from "../src/delegate-workspace-revision.ts";

test("workspace revision is deterministic and invalidated by every Git worktree layer", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "delegate-revision-"));
  try {
    runGit(workspace, "init");
    runGit(workspace, "config", "user.email", "review@example.test");
    runGit(workspace, "config", "user.name", "Review Test");
    await writeFile(join(workspace, "tracked.txt"), "committed\n");
    runGit(workspace, "add", "tracked.txt");
    runGit(workspace, "commit", "-m", "initial");

    const committed = await requireRevision(workspace);
    const repeated = await requireRevision(workspace);
    assert.equal(repeated.hash, committed.hash);
    assert.ok(Object.isFrozen(committed));
    assert.ok(Object.isFrozen(committed.untrackedPaths));

    await writeFile(join(workspace, "tracked.txt"), "unstaged\n");
    const unstaged = await requireRevision(workspace);
    assert.notEqual(unstaged.hash, committed.hash);

    runGit(workspace, "add", "tracked.txt");
    const staged = await requireRevision(workspace);
    assert.notEqual(staged.hash, unstaged.hash);

    await writeFile(join(workspace, "untracked.txt"), "first\n");
    const untracked = await requireRevision(workspace);
    assert.notEqual(untracked.hash, staged.hash);
    assert.deepEqual(untracked.untrackedPaths, ["untracked.txt"]);

    await writeFile(join(workspace, "untracked.txt"), "second\n");
    const editedUntracked = await requireRevision(workspace);
    assert.notEqual(editedUntracked.hash, untracked.hash);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("workspace revision returns a safe error outside Git", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "delegate-no-git-"));
  try {
    const result = await captureDelegateWorkspaceRevision(workspace);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "not-git-workspace");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function requireRevision(workspace: string) {
  const result = await captureDelegateWorkspaceRevision(workspace);
  if (!result.ok) assert.fail(result.error.message);
  return result.revision;
}

function runGit(workspace: string, ...arguments_: ReadonlyArray<string>): void {
  execFileSync("git", ["-C", workspace, ...arguments_], {
    stdio: "ignore",
  });
}
