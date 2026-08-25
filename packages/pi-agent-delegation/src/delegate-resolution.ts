import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { DelegateProfile } from "./delegate-profiles.ts";
import { discoverDelegateProfiles } from "./delegate-profiles.ts";
import type { SubagentDefinition } from "./subagent-definitions.ts";
import { discoverSubagentDefinitions } from "./subagent-definitions.ts";

/** Fully resolved strict subagent/profile configuration ready for spawning. */
export interface ResolvedStrictDelegate {
  readonly subagent: SubagentDefinition & {
    readonly description: string;
    readonly instructions: string;
  };
  readonly profile: DelegateProfile;
  readonly workingDir: string;
  readonly warnings: ReadonlyArray<string>;
}

/** Expected strict delegate resolution failure. */
export interface StrictDelegateResolutionError {
  readonly code:
    | "subagent-not-found"
    | "profile-not-found"
    | "invalid-subagent"
    | "invalid-configuration"
    | "invalid-working-directory";
  readonly message: string;
}

/** Result of resolving a saved subagent and strict compute profile. */
export type StrictDelegateResolutionResult =
  | { readonly ok: true; readonly value: ResolvedStrictDelegate }
  | { readonly ok: false; readonly error: StrictDelegateResolutionError };

/** Resolve and trust-gate one saved subagent plus strict compute profile. */
export async function resolveStrictDelegate(options: {
  readonly cwd: string;
  readonly includeProject: boolean;
  readonly subagentName: string;
  readonly profileName: string;
  readonly workingDir?: string;
  readonly globalAgentDir?: string;
  readonly globalProfileDir?: string;
}): Promise<StrictDelegateResolutionResult> {
  const [subagents, profiles] = await Promise.all([
    discoverSubagentDefinitions({
      cwd: options.cwd,
      includeProject: options.includeProject,
      globalAgentDir: options.globalAgentDir,
    }),
    discoverDelegateProfiles({
      cwd: options.cwd,
      includeProject: options.includeProject,
      globalProfileDir: options.globalProfileDir,
    }),
  ]);

  const subagent = subagents.definitions.find(
    (candidate) => candidate.name === options.subagentName,
  );
  if (!subagent) {
    const configurationErrors = subagents.errors
      .map((error) => `${error.filePath}: ${error.message}`)
      .join("; ");
    return {
      ok: false,
      error: {
        code: configurationErrors
          ? "invalid-configuration"
          : "subagent-not-found",
        message: configurationErrors
          ? `Subagent "${options.subagentName}" could not be resolved because subagent configuration is invalid: ${configurationErrors}`
          : `Unknown subagent "${options.subagentName}". Available: ${subagents.definitions.map((value) => value.name).join(", ") || "none"}.`,
      },
    };
  }
  if (!subagent.description?.trim() || !subagent.instructions?.trim()) {
    return {
      ok: false,
      error: {
        code: "invalid-subagent",
        message: `Subagent "${subagent.name}" must define both a non-empty description and instruction body.`,
      },
    };
  }
  if (subagent.spawning === true) {
    return {
      ok: false,
      error: {
        code: "invalid-subagent",
        message: `Subagent "${subagent.name}" requests spawning, but nested delegation is disabled until bounded recursion controls exist.`,
      },
    };
  }

  const profile = profiles.profiles.find(
    (candidate) => candidate.name === options.profileName,
  );
  if (!profile) {
    const configurationErrors = profiles.errors
      .map((error) => `${error.filePath}: ${error.message}`)
      .join("; ");
    return {
      ok: false,
      error: {
        code: configurationErrors
          ? "invalid-configuration"
          : "profile-not-found",
        message: configurationErrors
          ? `Profile "${options.profileName}" could not be resolved because profile configuration is invalid: ${configurationErrors}`
          : `Unknown delegate profile "${options.profileName}". Available: ${profiles.profiles.map((value) => value.name).join(", ") || "none"}.`,
      },
    };
  }

  const workingDir = resolve(
    options.cwd,
    options.workingDir ?? subagent.cwd ?? ".",
  );
  try {
    if (!(await stat(workingDir)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid-working-directory",
        message: `Delegate working directory is not a directory: ${workingDir}`,
      },
    };
  }

  return {
    ok: true,
    value: {
      subagent: {
        ...subagent,
        description: subagent.description,
        instructions: subagent.instructions,
      },
      profile,
      workingDir,
      warnings: [
        ...subagents.diagnostics.map((diagnostic) => diagnostic.message),
        ...profiles.diagnostics.map((diagnostic) => diagnostic.message),
      ],
    },
  };
}
