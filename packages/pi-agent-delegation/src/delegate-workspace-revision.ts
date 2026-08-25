import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { sep } from "node:path";

const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;

/** SHA-256 identity for the complete review-relevant state of a Git workspace. */
export type DelegateWorkspaceRevisionHash = string & {
  readonly __delegateWorkspaceRevisionHash: unique symbol;
};

/** Frozen description of the Git state bound to one delegate review. */
export interface DelegateWorkspaceRevision {
  readonly hash: DelegateWorkspaceRevisionHash;
  readonly head: string;
  readonly workspaceRoot: string;
  readonly untrackedPaths: ReadonlyArray<string>;
}

/** Searchable failure returned when a safe Git workspace revision cannot be captured. */
export interface DelegateWorkspaceRevisionError {
  readonly code:
    | "git-unavailable"
    | "not-git-workspace"
    | "workspace-read-failed";
  readonly message: string;
}

/** Safe result of capturing a workspace revision; failures never fall back to a partial hash. */
export type DelegateWorkspaceRevisionResult =
  | { readonly ok: true; readonly revision: DelegateWorkspaceRevision }
  | { readonly ok: false; readonly error: DelegateWorkspaceRevisionError };

interface GitCommandFailure extends Error {
  readonly code?: string | number;
  readonly stderr?: Buffer | string;
}

/** Validate and brand a serialized workspace revision hash. */
export function parseDelegateWorkspaceRevisionHash(
  value: string,
): DelegateWorkspaceRevisionHash | undefined {
  return /^[a-f0-9]{64}$/u.test(value)
    ? (value as DelegateWorkspaceRevisionHash)
    : undefined;
}

/** Capture HEAD, tracked index state, staged and unstaged diffs, and untracked contents. */
export async function captureDelegateWorkspaceRevision(
  workspacePath: string,
): Promise<DelegateWorkspaceRevisionResult> {
  let requestedPath: string;
  try {
    requestedPath = await realpath(workspacePath);
  } catch (error) {
    return workspaceRevisionFailure(
      "workspace-read-failed",
      `Delegate workspace revision could not resolve "${workspacePath}": ${errorMessage(error)}`,
    );
  }

  let workspaceRoot: string;
  try {
    workspaceRoot = (
      await runGitCommand(requestedPath, ["rev-parse", "--show-toplevel"])
    )
      .toString("utf8")
      .trim();
  } catch (error) {
    const failure = error as GitCommandFailure;
    if (failure.code === "ENOENT") {
      return workspaceRevisionFailure(
        "git-unavailable",
        "Delegate workspace revision could not run Git because the executable is unavailable.",
      );
    }
    return workspaceRevisionFailure(
      "not-git-workspace",
      `Delegate workspace revision requires a Git workspace at "${workspacePath}".`,
    );
  }

  try {
    workspaceRoot = await realpath(workspaceRoot);
    const [headResult, trackedIndex, stagedDiff, unstagedDiff, untrackedOutput] =
      await Promise.all([
        runGitCommand(workspaceRoot, ["rev-parse", "--verify", "HEAD"]).catch(
          () => Buffer.from("(unborn)\n"),
        ),
        runGitCommand(workspaceRoot, ["ls-files", "--stage", "-z"]),
        runGitCommand(workspaceRoot, [
          "diff",
          "--cached",
          "--binary",
          "--full-index",
          "--no-ext-diff",
          "--no-textconv",
        ]),
        runGitCommand(workspaceRoot, [
          "diff",
          "--binary",
          "--full-index",
          "--no-ext-diff",
          "--no-textconv",
        ]),
        runGitCommand(workspaceRoot, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ]),
      ]);

    const untrackedPathBuffers = splitNullTerminated(untrackedOutput).sort(
      Buffer.compare,
    );
    const hash = createHash("sha256");
    updateLengthPrefixedHash(hash, "delegate-workspace-revision-v1");
    updateLengthPrefixedHash(hash, headResult);
    updateLengthPrefixedHash(hash, trackedIndex);
    updateLengthPrefixedHash(hash, stagedDiff);
    updateLengthPrefixedHash(hash, unstagedDiff);

    for (const relativePath of untrackedPathBuffers) {
      validateGitRelativePath(relativePath);
      const absolutePath = Buffer.concat([
        Buffer.from(`${workspaceRoot}${sep}`),
        relativePath,
      ]);
      const fileStats = await lstat(absolutePath);
      updateLengthPrefixedHash(hash, relativePath);
      if (fileStats.isSymbolicLink()) {
        updateLengthPrefixedHash(hash, "symbolic-link");
        updateLengthPrefixedHash(
          hash,
          await readlink(absolutePath, { encoding: "buffer" }),
        );
      } else if (fileStats.isFile()) {
        updateLengthPrefixedHash(hash, "regular-file");
        updateLengthPrefixedHash(hash, await readFile(absolutePath));
      } else {
        throw new Error(
          `unsupported untracked file type at "${relativePath.toString("utf8")}"`,
        );
      }
    }

    const revisionHash = parseDelegateWorkspaceRevisionHash(hash.digest("hex"));
    if (!revisionHash) {
      throw new Error("SHA-256 returned an invalid workspace revision hash");
    }
    const revision: DelegateWorkspaceRevision = Object.freeze({
      hash: revisionHash,
      head: headResult.toString("utf8").trim(),
      workspaceRoot,
      untrackedPaths: Object.freeze(
        untrackedPathBuffers.map((path) => path.toString("utf8")),
      ),
    });
    return Object.freeze({ ok: true, revision });
  } catch (error) {
    return workspaceRevisionFailure(
      "workspace-read-failed",
      `Delegate workspace revision could not capture "${workspaceRoot}": ${errorMessage(error)}`,
    );
  }
}

function runGitCommand(
  workingDirectory: string,
  arguments_: ReadonlyArray<string>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", workingDirectory, ...arguments_],
      {
        encoding: "buffer",
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function splitNullTerminated(value: Buffer): Buffer[] {
  const paths: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    if (index > start) paths.push(value.subarray(start, index));
    start = index + 1;
  }
  if (start < value.length) paths.push(value.subarray(start));
  return paths;
}

function validateGitRelativePath(relativePath: Buffer): void {
  if (relativePath.length === 0 || relativePath[0] === 47) {
    throw new Error("unsafe empty or absolute untracked path");
  }
  const components = relativePath.toString("binary").split("/");
  if (components.some((component) => component === "." || component === "..")) {
    throw new Error(
      `unsafe untracked path "${relativePath.toString("utf8")}"`,
    );
  }
}

function updateLengthPrefixedHash(
  hash: ReturnType<typeof createHash>,
  value: string | Buffer,
): void {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function workspaceRevisionFailure(
  code: DelegateWorkspaceRevisionError["code"],
  message: string,
): DelegateWorkspaceRevisionResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message }),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
