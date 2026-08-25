import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  detectDelegateReviewGitScope,
  selectDelegateReviewBaseBranch,
  type DelegateReviewGitExecutor,
} from "../src/delegate-review-git-scope.ts";

const gitExecutor: DelegateReviewGitExecutor = {
  exec(command, arguments_, options) {
    return new Promise((resolve) => {
      execFile(
        command,
        arguments_,
        {
          cwd: options?.cwd,
          timeout: options?.timeout,
        },
        (error, stdout, stderr) => {
          const code =
            error && "code" in error && typeof error.code === "number"
              ? error.code
              : error
                ? 1
                : 0;
          resolve({ stdout, stderr, code });
        },
      );
    });
  },
};

test("base selection follows dev, main, and master precedence", () => {
  const allAvailable = { dev: true, main: true, master: true };
  assert.equal(
    selectDelegateReviewBaseBranch("feature", allAvailable),
    "dev",
  );
  assert.equal(selectDelegateReviewBaseBranch("dev", allAvailable), "main");
  assert.equal(selectDelegateReviewBaseBranch("main", allAvailable), "dev");
  assert.equal(
    selectDelegateReviewBaseBranch("feature", {
      dev: false,
      main: true,
      master: true,
    }),
    "main",
  );
});

test("review scope uses merge base and covers dirty worktree layers", async () => {
  const workspace = await createRepository("main");
  try {
    runGit(workspace, "branch", "dev");
    runGit(workspace, "switch", "-c", "feature");
    await writeFile(join(workspace, "feature.txt"), "committed feature\n");
    runGit(workspace, "add", "feature.txt");
    runGit(workspace, "commit", "-m", "feature commit");

    runGit(workspace, "switch", "dev");
    await writeFile(join(workspace, "base-only.txt"), "base only\n");
    runGit(workspace, "add", "base-only.txt");
    runGit(workspace, "commit", "-m", "base-only commit");
    const devTip = runGitOutput(workspace, "rev-parse", "HEAD");
    runGit(workspace, "switch", "feature");
    const expectedMergeBase = runGitOutput(
      workspace,
      "merge-base",
      "dev",
      "HEAD",
    );

    await writeFile(join(workspace, "feature.txt"), "staged feature\n");
    runGit(workspace, "add", "feature.txt");
    await writeFile(join(workspace, "tracked.txt"), "unstaged tracked\n");
    await writeFile(join(workspace, "untracked.txt"), "untracked\n");

    const result = await detectDelegateReviewGitScope(gitExecutor, workspace);

    assert.equal(result.metadata.scope, "base-diff");
    assert.equal(result.metadata.baseBranch, "dev");
    assert.equal(result.metadata.mergeBase, expectedMergeBase);
    assert.notEqual(result.metadata.mergeBase, devTip);
    assert.equal(result.metadata.hasTrackedChanges, true);
    assert.equal(result.metadata.hasAnyChanges, true);
    assert.match(result.metadata.status, /feature\.txt/u);
    assert.match(result.metadata.status, /tracked\.txt/u);
    assert.match(result.metadata.status, /untracked\.txt/u);
    assert.match(result.task, new RegExp(`git diff ${expectedMergeBase}`, "u"));
    assert.match(result.task, /excludes base-only commits/u);
    assert.match(result.task, /git diff --cached/u);
    assert.match(result.task, /every relevant untracked file/u);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.metadata));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("review scope falls back to the current checkout without a local base", async () => {
  const workspace = await createRepository("topic");
  try {
    const result = await detectDelegateReviewGitScope(gitExecutor, workspace);

    assert.equal(result.metadata.scope, "current-state");
    assert.equal(result.metadata.baseBranch, undefined);
    assert.equal(result.metadata.mergeBase, undefined);
    assert.match(result.task, /No usable local base and merge base exist/u);
    assert.match(result.task, /git ls-files/u);
    assert.match(result.task, /git diff --cached/u);
    assert.match(result.task, /git diff/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("review scope chooses the latest commit when the base diff is clean", async () => {
  const workspace = await createRepository("main");
  try {
    const head = runGitOutput(workspace, "rev-parse", "--short", "HEAD");
    const result = await detectDelegateReviewGitScope(gitExecutor, workspace);

    assert.equal(result.metadata.scope, "latest-commit");
    assert.equal(result.metadata.baseBranch, "main");
    assert.equal(result.metadata.latestCommit, head);
    assert.equal(result.metadata.hasTrackedChanges, false);
    assert.equal(result.metadata.hasAnyChanges, false);
    assert.match(result.task, /review the latest commit/u);
    assert.match(result.task, /git show --root HEAD/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("detached checkout reports the short commit as its current ref", async () => {
  const workspace = await createRepository("main");
  try {
    runGit(workspace, "switch", "--detach");
    const head = runGitOutput(workspace, "rev-parse", "--short", "HEAD");
    const result = await detectDelegateReviewGitScope(gitExecutor, workspace);

    assert.equal(result.metadata.currentRef, head);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function createRepository(initialBranch: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "delegate-review-scope-"));
  runGit(workspace, "init", "--initial-branch", initialBranch);
  runGit(workspace, "config", "user.email", "review@example.test");
  runGit(workspace, "config", "user.name", "Review Test");
  await writeFile(join(workspace, "tracked.txt"), "committed\n");
  runGit(workspace, "add", "tracked.txt");
  runGit(workspace, "commit", "-m", "initial");
  return workspace;
}

function runGit(workspace: string, ...arguments_: ReadonlyArray<string>): void {
  execFileSync("git", ["-C", workspace, ...arguments_], {
    stdio: "ignore",
  });
}

function runGitOutput(
  workspace: string,
  ...arguments_: ReadonlyArray<string>
): string {
  return execFileSync("git", ["-C", workspace, ...arguments_], {
    encoding: "utf8",
  }).trim();
}
