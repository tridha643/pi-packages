import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import {
  BACKEND_NAMES,
  REASONING_EFFORTS,
  type BackendName,
  type ReasoningEffort,
} from "../vendor/headless/src/domain.ts";

/** Harness names accepted by exact delegate profile targets. */
export const DELEGATE_HARNESSES = BACKEND_NAMES;

/** Reasoning levels accepted by exact delegate profile targets. */
export const DELEGATE_REASONING_LEVELS = REASONING_EFFORTS;

/** A delegate runtime supported by an exact profile target. */
export type DelegateHarness = BackendName;

/** A normalized reasoning level requested by a profile target. */
export type DelegateReasoning = ReasoningEffort;

/** Identifies where a delegate profile was discovered. */
export type DelegateProfileSource = "global" | "project";

/** One exact saved delegate compute target. */
export interface DelegateProfileTarget {
  readonly harness: DelegateHarness;
  readonly model: string;
  readonly reasoning: DelegateReasoning;
}

/** One freeform delegate compute candidate; saved profiles use one exact target. */
export type DelegateProfileCandidate = DelegateProfileTarget;

/** A strictly parsed delegate profile and its configuration origin. */
export interface DelegateProfile {
  readonly name: string;
  readonly description: string;
  readonly bestFor: ReadonlyArray<string>;
  readonly strengths: ReadonlyArray<string>;
  readonly limitations: ReadonlyArray<string>;
  readonly target: DelegateProfileTarget;
  readonly source: DelegateProfileSource;
  readonly filePath: string;
}

/** Build the one-item candidate list used by every strict saved-profile launch. */
export function buildStrictDelegateCandidateList(
  profile: DelegateProfile,
): readonly [DelegateProfileTarget] {
  return [profile.target];
}

/** A typed delegate profile parsing or file-reading failure. */
export interface DelegateProfileError {
  readonly code:
    | "invalid-yaml"
    | "invalid-schema"
    | "unknown-field"
    | "file-read-failed";
  readonly message: string;
  readonly filePath: string;
  readonly field?: string;
  readonly candidateIndex?: number;
}

/** A non-fatal delegate profile discovery warning. */
export interface DelegateProfileDiagnostic {
  readonly severity: "warning";
  readonly code: "duplicate-name" | "directory-read-failed";
  readonly message: string;
  readonly filePath: string;
}

/** The discriminated result of parsing one delegate profile. */
export type DelegateProfileParseResult =
  | { readonly ok: true; readonly value: DelegateProfile }
  | { readonly ok: false; readonly error: DelegateProfileError };

/** Context required to parse one delegate profile file. */
export interface ParseDelegateProfileOptions {
  readonly filePath: string;
  readonly source: DelegateProfileSource;
}

/** Filesystem roots used to discover global and project delegate profiles. */
export interface DiscoverDelegateProfilesOptions {
  readonly cwd: string;
  readonly globalProfileDir?: string;
  /** Trust gate for project-local profiles; defaults to true. */
  readonly includeProject?: boolean;
}

/** All valid discovered profiles plus invalid-file and discovery diagnostics. */
export interface DelegateProfileDiscoveryResult {
  readonly profiles: ReadonlyArray<DelegateProfile>;
  readonly errors: ReadonlyArray<DelegateProfileError>;
  readonly diagnostics: ReadonlyArray<DelegateProfileDiagnostic>;
}

/** Prompt-safe bounds for concise saved profile routing metadata. */
export const DELEGATE_PROFILE_METADATA_LIMITS = Object.freeze({
  descriptionCharacters: 240,
  listItems: 6,
  listItemCharacters: 160,
});

const PROFILE_FIELDS = new Set([
  "name",
  "description",
  "bestFor",
  "strengths",
  "limitations",
  "target",
]);
const TARGET_FIELDS = new Set(["harness", "model", "reasoning"]);
function isDelegateHarness(value: unknown): value is DelegateHarness {
  return (
    typeof value === "string" &&
    DELEGATE_HARNESSES.some((candidate) => candidate === value)
  );
}

function isDelegateReasoning(value: unknown): value is DelegateReasoning {
  return (
    typeof value === "string" &&
    DELEGATE_REASONING_LEVELS.some((candidate) => candidate === value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNonEmptyString(
  value: unknown,
  field: string,
  filePath: string,
  maximumCharacters?: number,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: DelegateProfileError } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "invalid-schema",
        message: `Delegate profile field "${field}" must be a non-empty string.`,
        filePath,
        field,
      },
    };
  }
  const normalized = value.trim();
  if (maximumCharacters !== undefined && normalized.length > maximumCharacters) {
    return {
      ok: false,
      error: {
        code: "invalid-schema",
        message: `Delegate profile field "${field}" must be at most ${maximumCharacters} characters.`,
        filePath,
        field,
      },
    };
  }
  return { ok: true, value: normalized };
}

function parseMetadataList(
  value: unknown,
  field: "bestFor" | "strengths" | "limitations",
  filePath: string,
): { readonly ok: true; readonly value: ReadonlyArray<string> } | { readonly ok: false; readonly error: DelegateProfileError } {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > DELEGATE_PROFILE_METADATA_LIMITS.listItems
  ) {
    return {
      ok: false,
      error: {
        code: "invalid-schema",
        message: `Delegate profile field "${field}" must contain 1-${DELEGATE_PROFILE_METADATA_LIMITS.listItems} strings.`,
        filePath,
        field,
      },
    };
  }
  const items: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = parseNonEmptyString(
      item,
      `${field}[${index}]`,
      filePath,
      DELEGATE_PROFILE_METADATA_LIMITS.listItemCharacters,
    );
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }
  return { ok: true, value: items };
}

function invalidProfile(
  filePath: string,
  message: string,
  field?: string,
  candidateIndex?: number,
): DelegateProfileParseResult {
  return {
    ok: false,
    error: {
      code: "invalid-schema",
      message,
      filePath,
      ...(field === undefined ? {} : { field }),
      ...(candidateIndex === undefined ? {} : { candidateIndex }),
    },
  };
}

/** Parse and strictly validate one YAML delegate profile. */
export function parseDelegateProfile(
  content: string,
  options: ParseDelegateProfileOptions,
): DelegateProfileParseResult {
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(content, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "invalid-yaml",
        message: `Invalid delegate profile YAML: ${cause instanceof Error ? cause.message : "unknown YAML error"}`,
        filePath: options.filePath,
      },
    };
  }
  const yamlIssue = document.errors[0] ?? document.warnings[0];
  if (yamlIssue) {
    return {
      ok: false,
      error: {
        code: "invalid-yaml",
        message: `Invalid delegate profile YAML: ${yamlIssue.message}`,
        filePath: options.filePath,
      },
    };
  }

  let raw: unknown;
  try {
    raw = document.toJS();
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "invalid-yaml",
        message: `Invalid delegate profile YAML: ${cause instanceof Error ? cause.message : "could not decode YAML"}`,
        filePath: options.filePath,
      },
    };
  }
  if (!isRecord(raw)) {
    return invalidProfile(
      options.filePath,
      "Delegate profile must be a YAML mapping.",
    );
  }

  for (const field of Object.keys(raw)) {
    if (!PROFILE_FIELDS.has(field)) {
      return {
        ok: false,
        error: {
          code: "unknown-field",
          message: `Unknown delegate profile field "${field}".`,
          filePath: options.filePath,
          field,
        },
      };
    }
  }

  const parsedName = parseNonEmptyString(raw.name, "name", options.filePath);
  if (!parsedName.ok) return { ok: false, error: parsedName.error };

  const parsedDescription = parseNonEmptyString(
    raw.description,
    "description",
    options.filePath,
    DELEGATE_PROFILE_METADATA_LIMITS.descriptionCharacters,
  );
  if (!parsedDescription.ok) return { ok: false, error: parsedDescription.error };
  const parsedBestFor = parseMetadataList(raw.bestFor, "bestFor", options.filePath);
  if (!parsedBestFor.ok) return { ok: false, error: parsedBestFor.error };
  const parsedStrengths = parseMetadataList(
    raw.strengths,
    "strengths",
    options.filePath,
  );
  if (!parsedStrengths.ok) return { ok: false, error: parsedStrengths.error };
  const parsedLimitations = parseMetadataList(
    raw.limitations,
    "limitations",
    options.filePath,
  );
  if (!parsedLimitations.ok) return { ok: false, error: parsedLimitations.error };

  if (!isRecord(raw.target)) {
    return invalidProfile(
      options.filePath,
      'Delegate profile field "target" must be a YAML mapping.',
      "target",
    );
  }
  for (const field of Object.keys(raw.target)) {
    if (!TARGET_FIELDS.has(field)) {
      return {
        ok: false,
        error: {
          code: "unknown-field",
          message: `Unknown delegate profile target field "${field}".`,
          filePath: options.filePath,
          field: `target.${field}`,
        },
      };
    }
  }

  if (!isDelegateHarness(raw.target.harness)) {
    return invalidProfile(
      options.filePath,
      `Delegate profile target harness must be one of: ${DELEGATE_HARNESSES.join(", ")}.`,
      "target.harness",
    );
  }
  const parsedModel = parseNonEmptyString(
    raw.target.model,
    "target.model",
    options.filePath,
  );
  if (!parsedModel.ok) return { ok: false, error: parsedModel.error };
  if (!isDelegateReasoning(raw.target.reasoning)) {
    return invalidProfile(
      options.filePath,
      `Delegate profile target reasoning must be one of: ${DELEGATE_REASONING_LEVELS.join(", ")}.`,
      "target.reasoning",
    );
  }

  return {
    ok: true,
    value: {
      name: parsedName.value,
      description: parsedDescription.value,
      bestFor: parsedBestFor.value,
      strengths: parsedStrengths.value,
      limitations: parsedLimitations.value,
      target: {
        harness: raw.target.harness,
        model: parsedModel.value,
        reasoning: raw.target.reasoning,
      },
      source: options.source,
      filePath: options.filePath,
    },
  };
}

async function discoverProfilesInDirectory(
  directory: string,
  source: DelegateProfileSource,
): Promise<DelegateProfileDiscoveryResult> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    const errorCode = isRecord(cause) ? cause.code : undefined;
    if (errorCode === "ENOENT") {
      return { profiles: [], errors: [], diagnostics: [] };
    }
    return {
      profiles: [],
      errors: [],
      diagnostics: [
        {
          severity: "warning",
          code: "directory-read-failed",
          message: `Could not read delegate profile directory "${directory}".`,
          filePath: directory,
        },
      ],
    };
  }

  const profiles: DelegateProfile[] = [];
  const errors: DelegateProfileError[] = [];
  const entriesToRead = entries
    .filter(
      (entry) =>
        (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) &&
        (entry.isFile() || entry.isSymbolicLink()),
    )
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entriesToRead) {
    const filePath = join(directory, entry.name);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      errors.push({
        code: "file-read-failed",
        message: `Could not read delegate profile "${filePath}".`,
        filePath,
      });
      continue;
    }

    const result = parseDelegateProfile(content, { filePath, source });
    if (result.ok) profiles.push(result.value);
    else errors.push(result.error);
  }

  return { profiles, errors, diagnostics: [] };
}

/** Discover global and project delegate profiles, with project profiles overriding by name. */
export async function discoverDelegateProfiles(
  options: DiscoverDelegateProfilesOptions,
): Promise<DelegateProfileDiscoveryResult> {
  const globalDirectory =
    options.globalProfileDir ?? join(homedir(), ".pi", "agent", "delegate-profiles");
  const projectDirectory = join(options.cwd, ".pi", "delegate-profiles");
  const emptyProjectResult: DelegateProfileDiscoveryResult = {
    profiles: [],
    errors: [],
    diagnostics: [],
  };
  const [globalResult, projectResult] = await Promise.all([
    discoverProfilesInDirectory(globalDirectory, "global"),
    options.includeProject === false
      ? Promise.resolve(emptyProjectResult)
      : discoverProfilesInDirectory(projectDirectory, "project"),
  ]);

  const profilesByName = new Map<string, DelegateProfile>();
  const diagnostics = [...globalResult.diagnostics, ...projectResult.diagnostics];
  for (const profile of [...globalResult.profiles, ...projectResult.profiles]) {
    const previous = profilesByName.get(profile.name);
    if (previous && previous.source === profile.source) {
      diagnostics.push({
        severity: "warning",
        code: "duplicate-name",
        message: `Delegate profile "${profile.name}" is defined more than once in ${profile.source} configuration; "${profile.filePath}" wins.`,
        filePath: profile.filePath,
      });
    }
    profilesByName.set(profile.name, profile);
  }

  return {
    profiles: [...profilesByName.values()],
    errors: [...globalResult.errors, ...projectResult.errors],
    diagnostics,
  };
}
