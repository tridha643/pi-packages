import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

/** A normalized relative file or directory root owned by one writing delegate. */
export type DelegateWritePath = string & { readonly __delegateWritePath: unique symbol };

/** Expected writer ownership validation failure. */
export interface DelegateWriterOwnershipError {
  readonly code: "invalid-write-path" | "overlapping-write-paths";
  readonly message: string;
}

/** Result of parsing one lane's declared shared-workspace write ownership. */
export type DelegateWriterOwnershipResult =
  | { readonly ok: true; readonly paths: ReadonlyArray<DelegateWritePath> }
  | { readonly ok: false; readonly error: DelegateWriterOwnershipError };

function ownershipComparisonPath(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function pathContains(parent: string, child: string): boolean {
  const comparableParent = ownershipComparisonPath(parent);
  const comparableChild = ownershipComparisonPath(child);
  return (
    comparableChild === comparableParent ||
    comparableChild.startsWith(`${comparableParent}${sep}`)
  );
}

/** Parse relative write roots without creating worktrees or touching the filesystem. */
export function parseDelegateWritePaths(options: {
  readonly cwd: string;
  readonly paths: ReadonlyArray<string> | undefined;
}): DelegateWriterOwnershipResult {
  const roots = new Set<DelegateWritePath>();
  const cwd = resolve(options.cwd);
  for (const rawPath of options.paths ?? []) {
    const value = rawPath.trim();
    if (
      value.length === 0 ||
      value.includes("\0") ||
      isAbsolute(value) ||
      /[*?\[\]{}]/.test(value)
    ) {
      return {
        ok: false,
        error: {
          code: "invalid-write-path",
          message: `Delegate write path "${rawPath}" must be a literal relative file or directory path without glob syntax.`,
        },
      };
    }
    const absolute = resolve(cwd, normalize(value));
    const relativePath = relative(cwd, absolute);
    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      return {
        ok: false,
        error: {
          code: "invalid-write-path",
          message: `Delegate write path "${rawPath}" must stay inside the shared working directory.`,
        },
      };
    }
    // SAFETY: The checks above prove this is a normalized relative path inside cwd.
    roots.add(relativePath as DelegateWritePath);
  }

  const sorted = [...roots].sort();
  for (const [index, candidate] of sorted.entries()) {
    const parent = sorted.find(
      (other, otherIndex) => otherIndex !== index && pathContains(other, candidate),
    );
    if (parent) {
      return {
        ok: false,
        error: {
          code: "overlapping-write-paths",
          message: `Delegate write paths "${parent}" and "${candidate}" overlap within one lane. Declare only the narrowest common owner.`,
        },
      };
    }
  }
  return { ok: true, paths: sorted };
}

/** Reject overlapping ownership across parallel writing lanes before any lane launches. */
export function validateParallelDelegateOwnership(
  lanes: ReadonlyArray<{
    readonly name: string;
    readonly paths: ReadonlyArray<DelegateWritePath>;
  }>,
): DelegateWriterOwnershipError | undefined {
  for (let leftIndex = 0; leftIndex < lanes.length; leftIndex++) {
    const left = lanes[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < lanes.length; rightIndex++) {
      const right = lanes[rightIndex];
      if (!right) continue;
      for (const leftPath of left.paths) {
        for (const rightPath of right.paths) {
          if (pathContains(leftPath, rightPath) || pathContains(rightPath, leftPath)) {
            return {
              code: "overlapping-write-paths",
              message: `Parallel delegate ownership overlaps: "${left.name}" owns "${leftPath}" while "${right.name}" owns "${rightPath}". Use one writer for overlapping files.`,
            };
          }
        }
      }
    }
  }
  return undefined;
}

/** Format a searchable child-prompt ownership contract for the shared workspace. */
export function formatDelegateWriterOwnership(
  paths: ReadonlyArray<DelegateWritePath>,
): string | undefined {
  if (paths.length === 0) return undefined;
  return [
    "<shared_workspace_write_ownership>",
    "You may edit only these relative paths in the current shared workspace:",
    ...paths.map((filePath) => `- ${filePath}`),
    "Do not create a worktree. Do not edit outside these paths. The parent and sibling delegates must not edit these paths while this run is active.",
    "</shared_workspace_write_ownership>",
  ].join("\n");
}
