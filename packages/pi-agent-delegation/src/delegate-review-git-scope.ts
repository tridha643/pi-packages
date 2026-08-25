const GIT_COMMAND_TIMEOUT_MS = 10_000;

/** Local branch names considered when selecting a Git review base. */
export type DelegateReviewBaseBranch = "dev" | "main" | "master";

/** Minimal command runner implemented by ExtensionAPI.exec and deterministic test adapters. */
export interface DelegateReviewGitExecutor {
  exec(
    command: string,
    arguments_: string[],
    options?: {
      readonly cwd?: string;
      readonly timeout?: number;
    },
  ): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
  }>;
}

/** Structured Git scope accompanying the task sent to a review subagent. */
export interface DelegateReviewGitScopeMetadata {
  readonly repoRoot: string;
  readonly currentRef: string;
  readonly scope: "base-diff" | "current-state" | "latest-commit";
  readonly baseBranch?: DelegateReviewBaseBranch;
  readonly mergeBase?: string;
  readonly latestCommit?: string;
  readonly status: string;
  readonly hasTrackedChanges: boolean;
  readonly hasAnyChanges: boolean;
}

/** Review task text and machine-readable metadata detected from the current checkout. */
export interface DelegateReviewGitScope {
  readonly task: string;
  readonly metadata: DelegateReviewGitScopeMetadata;
}

/** Detect a merge-base-aware review scope using an ExtensionAPI-compatible Git executor. */
export async function detectDelegateReviewGitScope(
  gitExecutor: DelegateReviewGitExecutor,
  workingDirectory: string,
): Promise<DelegateReviewGitScope> {
  const repoRoot = await requireGitOutput(gitExecutor, workingDirectory, [
    "rev-parse",
    "--show-toplevel",
  ]);
  const currentBranch = await requireGitOutput(gitExecutor, repoRoot, [
    "branch",
    "--show-current",
  ]);
  const currentRef =
    currentBranch ||
    (await requireGitOutput(gitExecutor, repoRoot, [
      "rev-parse",
      "--short",
      "HEAD",
    ]));
  const [hasDev, hasMain, hasMaster, status] = await Promise.all([
    hasUsableLocalBranch(gitExecutor, repoRoot, "dev"),
    hasUsableLocalBranch(gitExecutor, repoRoot, "main"),
    hasUsableLocalBranch(gitExecutor, repoRoot, "master"),
    requireGitOutput(gitExecutor, repoRoot, [
      "status",
      "--short",
      "--untracked-files=all",
    ]),
  ]);
  const baseBranch = selectDelegateReviewBaseBranch(currentBranch, {
    dev: hasDev,
    main: hasMain,
    master: hasMaster,
  });

  if (!baseBranch) {
    const metadata = freezeDelegateReviewMetadata({
      repoRoot,
      currentRef,
      scope: "current-state",
      status,
      hasTrackedChanges: false,
      hasAnyChanges: status.length > 0,
    });
    return Object.freeze({
      metadata,
      task: buildDelegateReviewGitTask(metadata),
    });
  }

  const mergeBase = await optionalGitOutput(gitExecutor, repoRoot, [
    "merge-base",
    `refs/heads/${baseBranch}`,
    "HEAD",
  ]);
  if (!mergeBase) {
    const metadata = freezeDelegateReviewMetadata({
      repoRoot,
      currentRef,
      scope: "current-state",
      baseBranch,
      status,
      hasTrackedChanges: false,
      hasAnyChanges: status.length > 0,
    });
    return Object.freeze({
      metadata,
      task: buildDelegateReviewGitTask(metadata),
    });
  }

  const [hasTrackedChanges, latestCommit] = await Promise.all([
    detectTrackedChanges(gitExecutor, repoRoot, mergeBase),
    optionalGitOutput(gitExecutor, repoRoot, [
      "rev-parse",
      "--short",
      "HEAD",
    ]),
  ]);
  const hasAnyChanges = hasTrackedChanges || status.length > 0;
  const metadata = freezeDelegateReviewMetadata({
    repoRoot,
    currentRef,
    scope: hasAnyChanges ? "base-diff" : "latest-commit",
    baseBranch,
    mergeBase,
    latestCommit,
    status,
    hasTrackedChanges,
    hasAnyChanges,
  });
  return Object.freeze({
    metadata,
    task: buildDelegateReviewGitTask(metadata),
  });
}

/** Select the local review base in dev, main, and master precedence for the current branch. */
export function selectDelegateReviewBaseBranch(
  currentBranch: string,
  availableBranches: Readonly<Record<DelegateReviewBaseBranch, boolean>>,
): DelegateReviewBaseBranch | undefined {
  if (currentBranch === "dev") {
    if (availableBranches.main) return "main";
    if (availableBranches.master) return "master";
    return undefined;
  }
  if (currentBranch !== "main" && currentBranch !== "master") {
    if (availableBranches.dev) return "dev";
    if (availableBranches.main) return "main";
    if (availableBranches.master) return "master";
    return undefined;
  }
  if (availableBranches.dev) return "dev";
  if (currentBranch === "main" && availableBranches.master) return "master";
  if (currentBranch === "master" && availableBranches.main) return "main";
  return currentBranch;
}

/** Format concise Git commands that cover the detected committed and worktree review scope. */
export function buildDelegateReviewGitTask(
  metadata: DelegateReviewGitScopeMetadata,
): string {
  const lines = [
    `Review the Git repository at \`${metadata.repoRoot}\` on \`${metadata.currentRef}\`.`,
    "Start with `git status --short --untracked-files=all`.",
  ];

  if (
    metadata.scope === "base-diff" &&
    metadata.baseBranch &&
    metadata.mergeBase
  ) {
    lines.push(
      `Review the checkout against merge base \`${metadata.mergeBase}\` from local \`${metadata.baseBranch}\`; this excludes base-only commits.`,
      `Inspect \`git diff --stat ${metadata.mergeBase}\` and \`git diff ${metadata.mergeBase}\`.`,
    );
  } else if (metadata.scope === "latest-commit") {
    lines.push(
      "No changes exist against the selected merge base, so review the latest commit.",
      "Inspect `git show --stat --root HEAD` and `git show --root HEAD`.",
    );
  } else {
    lines.push(
      "No usable local base and merge base exist, so review the current checkout.",
      "Inspect tracked files with `git ls-files`, staged changes with `git diff --cached`, and unstaged changes with `git diff`.",
    );
  }

  lines.push(
    "Inspect staged changes with `git diff --cached`, unstaged changes with `git diff`, and every relevant untracked file reported by status.",
    `Detected status:\n${metadata.status || "(clean)"}`,
    "Return only prioritized, actionable findings with file and line references where possible.",
  );
  return lines.join("\n");
}

function freezeDelegateReviewMetadata(
  metadata: DelegateReviewGitScopeMetadata,
): DelegateReviewGitScopeMetadata {
  return Object.freeze(metadata);
}

async function hasUsableLocalBranch(
  gitExecutor: DelegateReviewGitExecutor,
  repoRoot: string,
  branch: DelegateReviewBaseBranch,
): Promise<boolean> {
  const ref = await optionalGitOutput(gitExecutor, repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (!ref) return false;
  const commit = await runGit(gitExecutor, repoRoot, [
    "cat-file",
    "-e",
    `${ref}^{commit}`,
  ]);
  return commit.code === 0;
}

async function detectTrackedChanges(
  gitExecutor: DelegateReviewGitExecutor,
  repoRoot: string,
  revision: string,
): Promise<boolean> {
  const result = await runGit(gitExecutor, repoRoot, [
    "diff",
    "--quiet",
    revision,
  ]);
  if (result.code === 0) return false;
  if (result.code === 1) return true;
  throw gitCommandError(["diff", "--quiet", revision], result);
}

async function optionalGitOutput(
  gitExecutor: DelegateReviewGitExecutor,
  repoRoot: string,
  arguments_: ReadonlyArray<string>,
): Promise<string | undefined> {
  const result = await runGit(gitExecutor, repoRoot, arguments_);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function requireGitOutput(
  gitExecutor: DelegateReviewGitExecutor,
  repoRoot: string,
  arguments_: ReadonlyArray<string>,
): Promise<string> {
  const result = await runGit(gitExecutor, repoRoot, arguments_);
  if (result.code !== 0) throw gitCommandError(arguments_, result);
  return result.stdout.trim();
}

function runGit(
  gitExecutor: DelegateReviewGitExecutor,
  repoRoot: string,
  arguments_: ReadonlyArray<string>,
) {
  return gitExecutor.exec("git", [...arguments_], {
    cwd: repoRoot,
    timeout: GIT_COMMAND_TIMEOUT_MS,
  });
}

function gitCommandError(
  arguments_: ReadonlyArray<string>,
  result: {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
  },
): Error {
  const detail =
    result.stderr.trim() ||
    result.stdout.trim() ||
    `exit code ${result.code}`;
  return new Error(
    `Delegate review Git scope command failed: git ${arguments_.join(" ")}: ${detail}`,
  );
}
