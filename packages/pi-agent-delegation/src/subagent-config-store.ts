import { randomUUID } from "node:crypto";
import {
  access,
  link,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stringify } from "yaml";
import type { DelegateProfileTarget } from "./delegate-profiles.ts";
import { parseDelegateProfile } from "./delegate-profiles.ts";
import { parseSubagentDefinition } from "./subagent-definitions.ts";

/** Scope used for conversational subagent and profile configuration writes. */
export type SubagentConfigScope = "global" | "project";

/** Expected configuration storage failure returned without partially writing. */
export interface SubagentConfigStoreError {
  readonly code:
    | "invalid-name"
    | "invalid-definition"
    | "already-exists"
    | "not-found"
    | "unsafe-target"
    | "write-failed";
  readonly message: string;
  readonly filePath?: string;
}

/** Successful configuration storage operation. */
export interface SubagentConfigStoreSuccess {
  readonly ok: true;
  readonly filePath: string;
}

/** Result of a validated configuration storage operation. */
export type SubagentConfigStoreResult =
  | SubagentConfigStoreSuccess
  | { readonly ok: false; readonly error: SubagentConfigStoreError };

/** Fields accepted when saving one Pi-compatible named subagent. */
export interface SaveSubagentDefinitionInput {
  readonly scope: SubagentConfigScope;
  readonly cwd: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly tools?: ReadonlyArray<string>;
  readonly skills?: ReadonlyArray<string>;
  readonly workingDir?: string;
  readonly replace?: boolean;
  readonly globalAgentDir?: string;
}

/** Fields accepted when saving one strict delegate compute profile. */
export interface SaveDelegateProfileInput {
  readonly scope: SubagentConfigScope;
  readonly cwd: string;
  readonly name: string;
  readonly description: string;
  readonly bestFor: ReadonlyArray<string>;
  readonly strengths: ReadonlyArray<string>;
  readonly limitations: ReadonlyArray<string>;
  readonly target: DelegateProfileTarget;
  readonly replace?: boolean;
  readonly globalProfileDir?: string;
}

const CONFIG_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

interface ProjectDirectoryIdentity {
  readonly directory: string;
  readonly device: number;
  readonly inode: number;
}

async function captureProjectDirectoryIdentity(
  directory: string,
): Promise<
  | { readonly ok: true; readonly value: ProjectDirectoryIdentity }
  | { readonly ok: false; readonly error: SubagentConfigStoreError }
> {
  try {
    const target = await lstat(directory);
    if (target.isSymbolicLink() || !target.isDirectory()) {
      return {
        ok: false,
        error: {
          code: "unsafe-target",
          message: `Project configuration path is not a stable directory: ${directory}`,
          filePath: directory,
        },
      };
    }
    return {
      ok: true,
      value: {
        directory,
        device: target.dev,
        inode: target.ino,
      },
    };
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "write-failed",
        message: `Could not capture project configuration directory identity "${directory}": ${cause instanceof Error ? cause.message : String(cause)}`,
        filePath: directory,
      },
    };
  }
}

async function verifyProjectDirectoryIdentity(
  expected: ProjectDirectoryIdentity,
): Promise<SubagentConfigStoreResult | undefined> {
  const current = await captureProjectDirectoryIdentity(expected.directory);
  if (
    current.ok &&
    current.value.device === expected.device &&
    current.value.inode === expected.inode
  ) {
    return undefined;
  }
  return {
    ok: false,
    error: current.ok
      ? {
          code: "unsafe-target",
          message: `Project configuration directory changed during the operation: ${expected.directory}`,
          filePath: expected.directory,
        }
      : current.error,
  };
}

async function prepareProjectConfigDirectory(options: {
  readonly cwd: string;
  readonly directory: string;
  readonly create: boolean;
}): Promise<SubagentConfigStoreResult | undefined> {
  const root = resolve(options.cwd);
  const directory = resolve(options.directory);
  const childPath = relative(root, directory);
  if (
    childPath === "" ||
    childPath === ".." ||
    childPath.startsWith(`..${pathSeparator()}`) ||
    isAbsolute(childPath)
  ) {
    return {
      ok: false,
      error: {
        code: "unsafe-target",
        message: `Project configuration directory escapes the project root: ${directory}`,
        filePath: directory,
      },
    };
  }

  let current = root;
  let missing = false;
  for (const segment of childPath.split(pathSeparator())) {
    current = join(current, segment);
    try {
      const target = await lstat(current);
      if (target.isSymbolicLink() || !target.isDirectory()) {
        return {
          ok: false,
          error: {
            code: "unsafe-target",
            message: `Project configuration path contains a symlink or non-directory: ${current}`,
            filePath: current,
          },
        };
      }
    } catch (cause) {
      const errorCode =
        typeof cause === "object" && cause !== null && "code" in cause
          ? cause.code
          : undefined;
      if (errorCode === "ENOENT") {
        missing = true;
        break;
      }
      return {
        ok: false,
        error: {
          code: "write-failed",
          message: `Could not inspect project configuration path "${current}": ${cause instanceof Error ? cause.message : String(cause)}`,
          filePath: current,
        },
      };
    }
  }

  if (missing && !options.create) return undefined;
  if (options.create) {
    try {
      await mkdir(directory, { recursive: true });
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: "write-failed",
          message: `Could not create project configuration directory "${directory}": ${cause instanceof Error ? cause.message : String(cause)}`,
          filePath: directory,
        },
      };
    }
  }

  try {
    const [realRoot, realDirectory] = await Promise.all([
      realpath(root),
      realpath(directory),
    ]);
    const expectedDirectory = join(realRoot, childPath);
    if (realDirectory !== expectedDirectory) {
      return {
        ok: false,
        error: {
          code: "unsafe-target",
          message: `Project configuration directory resolves outside its declared scope: ${directory}`,
          filePath: directory,
        },
      };
    }
  } catch (cause) {
    const errorCode =
      typeof cause === "object" && cause !== null && "code" in cause
        ? cause.code
        : undefined;
    if (!options.create && errorCode === "ENOENT") return undefined;
    return {
      ok: false,
      error: {
        code: "write-failed",
        message: `Could not resolve project configuration directory "${directory}": ${cause instanceof Error ? cause.message : String(cause)}`,
        filePath: directory,
      },
    };
  }
  return undefined;
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function invalidName(name: string): SubagentConfigStoreResult | undefined {
  if (CONFIG_NAME_PATTERN.test(name)) return undefined;
  return {
    ok: false,
    error: {
      code: "invalid-name",
      message:
        `Configuration name "${name}" is invalid. Use lowercase letters, numbers, hyphens, or underscores, starting with a letter or number.`,
    },
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function atomicValidatedWrite(options: {
  readonly filePath: string;
  readonly content: string;
  readonly replace: boolean;
  readonly projectDirectoryIdentity?: ProjectDirectoryIdentity;
}): Promise<SubagentConfigStoreResult> {
  if (await pathExists(options.filePath)) {
    let target;
    try {
      target = await lstat(options.filePath);
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: "write-failed",
          message: `Could not inspect existing configuration "${options.filePath}": ${cause instanceof Error ? cause.message : String(cause)}`,
          filePath: options.filePath,
        },
      };
    }
    if (target.isSymbolicLink() || !target.isFile()) {
      return {
        ok: false,
        error: {
          code: "unsafe-target",
          message: `Refusing to replace non-regular configuration file "${options.filePath}".`,
          filePath: options.filePath,
        },
      };
    }
    if (!options.replace) {
      return {
        ok: false,
        error: {
          code: "already-exists",
          message: `Configuration "${options.filePath}" already exists; confirm replacement explicitly.`,
          filePath: options.filePath,
        },
      };
    }
  }

  const directory = dirname(options.filePath);
  if (options.projectDirectoryIdentity) {
    const changed = await verifyProjectDirectoryIdentity(
      options.projectDirectoryIdentity,
    );
    if (changed) return changed;
  }
  const temporaryPath = join(
    directory,
    `.${basename(options.filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, options.content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    if (options.projectDirectoryIdentity) {
      const changed = await verifyProjectDirectoryIdentity(
        options.projectDirectoryIdentity,
      );
      if (changed) {
        await rm(temporaryPath, { force: true });
        return changed;
      }
    }
    if (options.replace) {
      await rename(temporaryPath, options.filePath);
    } else {
      // A same-directory hard link is an atomic no-clobber publish: only one
      // concurrent creator can claim the destination, and partial temp files
      // are never visible under the final configuration name.
      await link(temporaryPath, options.filePath);
      await rm(temporaryPath);
    }
    if (options.projectDirectoryIdentity) {
      const changed = await verifyProjectDirectoryIdentity(
        options.projectDirectoryIdentity,
      );
      if (changed) {
        // The pathname is no longer tied to the directory we validated. Do
        // not unlink through it: a swapper could place an unrelated file at
        // the same name after publication.
        return changed;
      }
    }
    return { ok: true, filePath: options.filePath };
  } catch (cause) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    const errorCode =
      typeof cause === "object" && cause !== null && "code" in cause
        ? cause.code
        : undefined;
    if (!options.replace && errorCode === "EEXIST") {
      return {
        ok: false,
        error: {
          code: "already-exists",
          message: `Configuration "${options.filePath}" already exists; confirm replacement explicitly.`,
          filePath: options.filePath,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "write-failed",
        message: `Could not write configuration "${options.filePath}": ${cause instanceof Error ? cause.message : String(cause)}`,
        filePath: options.filePath,
      },
    };
  }
}

/** Validate and atomically save one named subagent definition. */
export async function saveSubagentDefinition(
  input: SaveSubagentDefinitionInput,
): Promise<SubagentConfigStoreResult> {
  const invalid = invalidName(input.name);
  if (invalid) return invalid;

  const directory =
    input.scope === "global"
      ? (input.globalAgentDir ?? join(homedir(), ".pi", "agent", "agents"))
      : join(input.cwd, ".pi", "agents");
  const filePath = join(directory, `${input.name}.md`);
  let projectDirectoryIdentity: ProjectDirectoryIdentity | undefined;
  if (input.scope === "project") {
    const unsafeDirectory = await prepareProjectConfigDirectory({
      cwd: input.cwd,
      directory,
      create: true,
    });
    if (unsafeDirectory) return unsafeDirectory;
    const captured = await captureProjectDirectoryIdentity(directory);
    if (!captured.ok) return { ok: false, error: captured.error };
    projectDirectoryIdentity = captured.value;
  }
  const frontmatter = stringify(
    {
      name: input.name,
      description: input.description,
      ...(input.tools ? { tools: [...input.tools] } : {}),
      ...(input.skills ? { skills: [...input.skills] } : {}),
      ...(input.workingDir ? { cwd: input.workingDir } : {}),
    },
    { lineWidth: 0 },
  ).trimEnd();
  const content = `---\n${frontmatter}\n---\n\n${input.instructions.trim()}\n`;
  const parsed = parseSubagentDefinition(content, {
    filePath,
    source: input.scope,
  });
  if (!parsed.ok || !parsed.value.description || !parsed.value.instructions) {
    return {
      ok: false,
      error: {
        code: "invalid-definition",
        message: parsed.ok
          ? "Saved subagents require both a non-empty description and instruction body."
          : parsed.error.message,
        filePath,
      },
    };
  }

  return atomicValidatedWrite({
    filePath,
    content,
    replace: input.replace ?? false,
    projectDirectoryIdentity,
  });
}

/** Validate and atomically save one strict delegate compute profile. */
export async function saveDelegateProfile(
  input: SaveDelegateProfileInput,
): Promise<SubagentConfigStoreResult> {
  const invalid = invalidName(input.name);
  if (invalid) return invalid;

  const directory =
    input.scope === "global"
      ? (input.globalProfileDir ??
        join(homedir(), ".pi", "agent", "delegate-profiles"))
      : join(input.cwd, ".pi", "delegate-profiles");
  const filePath = join(directory, `${input.name}.yaml`);
  let projectDirectoryIdentity: ProjectDirectoryIdentity | undefined;
  if (input.scope === "project") {
    const unsafeDirectory = await prepareProjectConfigDirectory({
      cwd: input.cwd,
      directory,
      create: true,
    });
    if (unsafeDirectory) return unsafeDirectory;
    const captured = await captureProjectDirectoryIdentity(directory);
    if (!captured.ok) return { ok: false, error: captured.error };
    projectDirectoryIdentity = captured.value;
  }
  const content = stringify(
    {
      name: input.name,
      description: input.description,
      bestFor: [...input.bestFor],
      strengths: [...input.strengths],
      limitations: [...input.limitations],
      target: { ...input.target },
    },
    { lineWidth: 0 },
  );
  const parsed = parseDelegateProfile(content, {
    filePath,
    source: input.scope,
  });
  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        code: "invalid-definition",
        message: parsed.error.message,
        filePath,
      },
    };
  }

  return atomicValidatedWrite({
    filePath,
    content,
    replace: input.replace ?? false,
    projectDirectoryIdentity,
  });
}

/** Delete one direct subagent or profile file from an explicitly chosen scope. */
export async function deleteSubagentConfiguration(options: {
  readonly kind: "subagent" | "profile";
  readonly scope: SubagentConfigScope;
  readonly cwd: string;
  readonly name: string;
  readonly globalAgentDir?: string;
  readonly globalProfileDir?: string;
}): Promise<SubagentConfigStoreResult> {
  const invalid = invalidName(options.name);
  if (invalid) return invalid;

  const directory =
    options.kind === "subagent"
      ? options.scope === "global"
        ? (options.globalAgentDir ?? join(homedir(), ".pi", "agent", "agents"))
        : join(options.cwd, ".pi", "agents")
      : options.scope === "global"
        ? (options.globalProfileDir ??
          join(homedir(), ".pi", "agent", "delegate-profiles"))
        : join(options.cwd, ".pi", "delegate-profiles");
  const candidatePaths =
    options.kind === "subagent"
      ? [join(directory, `${options.name}.md`)]
      : [
          join(directory, `${options.name}.yaml`),
          join(directory, `${options.name}.yml`),
        ];
  let projectDirectoryIdentity: ProjectDirectoryIdentity | undefined;
  if (options.scope === "project") {
    const unsafeDirectory = await prepareProjectConfigDirectory({
      cwd: options.cwd,
      directory,
      create: false,
    });
    if (unsafeDirectory) return unsafeDirectory;
    if (await pathExists(directory)) {
      const captured = await captureProjectDirectoryIdentity(directory);
      if (!captured.ok) return { ok: false, error: captured.error };
      projectDirectoryIdentity = captured.value;
    }
  }

  const existingPaths: string[] = [];
  for (const candidatePath of candidatePaths) {
    try {
      const target = await lstat(candidatePath);
      if (target.isSymbolicLink() || !target.isFile()) {
        return {
          ok: false,
          error: {
            code: "unsafe-target",
            message: `Refusing to delete non-regular configuration file "${candidatePath}".`,
            filePath: candidatePath,
          },
        };
      }
      existingPaths.push(candidatePath);
    } catch (cause) {
      const errorCode =
        typeof cause === "object" && cause !== null && "code" in cause
          ? cause.code
          : undefined;
      if (errorCode === "ENOENT") continue;
      return {
        ok: false,
        error: {
          code: "write-failed",
          message: `Could not inspect configuration "${candidatePath}": ${cause instanceof Error ? cause.message : String(cause)}`,
          filePath: candidatePath,
        },
      };
    }
  }

  if (existingPaths.length === 0) {
    return {
      ok: false,
      error: {
        code: "not-found",
        message: `Configuration "${options.name}" does not exist in ${directory}.`,
        filePath: candidatePaths[0],
      },
    };
  }
  if (existingPaths.length > 1) {
    return {
      ok: false,
      error: {
        code: "invalid-definition",
        message: `Profile "${options.name}" has both .yaml and .yml files; remove the duplicate explicitly before deleting by name.`,
        filePath: directory,
      },
    };
  }

  const filePath = existingPaths[0];
  if (!filePath) {
    return {
      ok: false,
      error: {
        code: "not-found",
        message: `Configuration "${options.name}" disappeared before deletion.`,
      },
    };
  }
  try {
    if (projectDirectoryIdentity) {
      const changed = await verifyProjectDirectoryIdentity(
        projectDirectoryIdentity,
      );
      if (changed) return changed;
    }
    await rm(filePath);
    return { ok: true, filePath };
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "write-failed",
        message: `Could not delete configuration "${filePath}": ${cause instanceof Error ? cause.message : String(cause)}`,
        filePath,
      },
    };
  }
}
