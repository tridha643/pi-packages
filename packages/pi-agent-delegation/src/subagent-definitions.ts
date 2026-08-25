import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { parseDocument } from "yaml";

const ROLE_FIELDS = new Set([
  "name",
  "description",
  "tools",
  "skill",
  "skills",
  "cwd",
  "spawning",
]);
const IGNORED_FIELDS = new Set([
  "model",
  "thinking",
  "interactive",
  "auto-exit",
  "session-mode",
]);

/** Identifies where a subagent definition was discovered. */
export type SubagentDefinitionSource = "global" | "project";

/** A parsed delegate-safe subset of a Pi markdown subagent definition. */
export interface SubagentDefinition {
  readonly name: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly tools?: ReadonlyArray<string>;
  readonly skills?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly spawning?: boolean;
  readonly source: SubagentDefinitionSource;
  readonly filePath: string;
}

/** A non-fatal warning emitted while parsing a subagent definition. */
export interface SubagentDefinitionDiagnostic {
  readonly severity: "warning";
  readonly code: "ignored-field" | "duplicate-name" | "directory-read-failed";
  readonly message: string;
  readonly filePath: string;
  readonly field?: string;
}

/** A typed subagent definition parsing or file-reading failure. */
export interface SubagentDefinitionError {
  readonly code:
    | "invalid-frontmatter"
    | "invalid-yaml"
    | "invalid-schema"
    | "unknown-field"
    | "file-read-failed";
  readonly message: string;
  readonly filePath: string;
  readonly field?: string;
}

/** The result of parsing one markdown subagent definition. */
export type SubagentDefinitionParseResult =
  | {
      readonly ok: true;
      readonly value: SubagentDefinition;
      readonly diagnostics: ReadonlyArray<SubagentDefinitionDiagnostic>;
    }
  | {
      readonly ok: false;
      readonly error: SubagentDefinitionError;
      readonly diagnostics: ReadonlyArray<SubagentDefinitionDiagnostic>;
    };

/** Context required to parse one markdown subagent definition. */
export interface ParseSubagentDefinitionOptions {
  readonly filePath: string;
  readonly source: SubagentDefinitionSource;
  readonly fallbackName?: string;
}

/** Filesystem roots used to discover global and project subagents. */
export interface DiscoverSubagentDefinitionsOptions {
  readonly cwd: string;
  readonly globalAgentDir?: string;
  /** Trust gate for project-local definitions; defaults to true. */
  readonly includeProject?: boolean;
}

/** All valid discovered subagents plus parse and compatibility diagnostics. */
export interface SubagentDefinitionDiscoveryResult {
  readonly definitions: ReadonlyArray<SubagentDefinition>;
  readonly errors: ReadonlyArray<SubagentDefinitionError>;
  readonly diagnostics: ReadonlyArray<SubagentDefinitionDiagnostic>;
}

type MarkdownFrontmatter = {
  readonly yaml: string;
  readonly body: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMarkdownFrontmatter(content: string): MarkdownFrontmatter | undefined {
  const match = /^(?:\uFEFF)?---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/.exec(
    content,
  );
  if (!match) return undefined;

  const yaml = match[1];
  if (yaml === undefined) return undefined;
  return {
    yaml,
    body: content.slice(match[0].length).trim(),
  };
}

function nonEmptyString(
  value: unknown,
  field: string,
  filePath: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: SubagentDefinitionError } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "invalid-schema",
        message: `Subagent definition field "${field}" must be a non-empty string.`,
        filePath,
        field,
      },
    };
  }
  return { ok: true, value: value.trim() };
}

function optionalStringList(
  value: unknown,
  field: "tools" | "skills",
  filePath: string,
):
  | { readonly ok: true; readonly value: ReadonlyArray<string> | undefined }
  | { readonly ok: false; readonly error: SubagentDefinitionError } {
  if (value === undefined) return { ok: true, value: undefined };

  const rawValues =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? value
        : undefined;
  if (!rawValues) {
    return {
      ok: false,
      error: {
        code: "invalid-schema",
        message: `Subagent definition field "${field}" must be a comma-separated string or string array.`,
        filePath,
        field,
      },
    };
  }

  const parsed = rawValues.map((entry) => entry.trim()).filter(Boolean);
  if (parsed.length === 0 || new Set(parsed).size !== parsed.length) {
    return {
      ok: false,
      error: {
        code: "invalid-schema",
        message: `Subagent definition field "${field}" must contain unique, non-empty names.`,
        filePath,
        field,
      },
    };
  }
  return { ok: true, value: parsed };
}

function parseFailure(
  error: SubagentDefinitionError,
  diagnostics: ReadonlyArray<SubagentDefinitionDiagnostic> = [],
): SubagentDefinitionParseResult {
  return { ok: false, error, diagnostics };
}

/** Parse a Pi markdown subagent while ignoring delegate-inapplicable compute and pane fields. */
export function parseSubagentDefinition(
  content: string,
  options: ParseSubagentDefinitionOptions,
): SubagentDefinitionParseResult {
  const frontmatter = parseMarkdownFrontmatter(content);
  if (!frontmatter) {
    return parseFailure({
      code: "invalid-frontmatter",
      message: "Subagent definition must begin with YAML frontmatter delimited by --- lines.",
      filePath: options.filePath,
    });
  }

  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(frontmatter.yaml, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
  } catch (cause) {
    return parseFailure({
      code: "invalid-yaml",
      message: `Invalid subagent definition YAML: ${cause instanceof Error ? cause.message : "unknown YAML error"}`,
      filePath: options.filePath,
    });
  }
  const yamlIssue = document.errors[0] ?? document.warnings[0];
  if (yamlIssue) {
    return parseFailure({
      code: "invalid-yaml",
      message: `Invalid subagent definition YAML: ${yamlIssue.message}`,
      filePath: options.filePath,
    });
  }

  let raw: unknown;
  try {
    raw = document.toJS();
  } catch (cause) {
    return parseFailure({
      code: "invalid-yaml",
      message: `Invalid subagent definition YAML: ${cause instanceof Error ? cause.message : "could not decode YAML"}`,
      filePath: options.filePath,
    });
  }
  if (!isRecord(raw)) {
    return parseFailure({
      code: "invalid-schema",
      message: "Subagent definition frontmatter must be a YAML mapping.",
      filePath: options.filePath,
    });
  }

  const diagnostics: SubagentDefinitionDiagnostic[] = [];
  for (const field of Object.keys(raw)) {
    if (IGNORED_FIELDS.has(field)) {
      diagnostics.push({
        severity: "warning",
        code: "ignored-field",
        message: `Subagent field "${field}" controls compute or pane behavior and is ignored by delegate.`,
        filePath: options.filePath,
        field,
      });
      continue;
    }
    if (!ROLE_FIELDS.has(field)) {
      return parseFailure(
        {
          code: "unknown-field",
          message: `Unknown subagent definition field "${field}".`,
          filePath: options.filePath,
          field,
        },
        diagnostics,
      );
    }
  }

  const fallbackName = options.fallbackName ?? basename(options.filePath, extname(options.filePath));
  const parsedName = nonEmptyString(raw.name ?? fallbackName, "name", options.filePath);
  if (!parsedName.ok) return parseFailure(parsedName.error, diagnostics);

  let description: string | undefined;
  if (raw.description !== undefined) {
    const parsedDescription = nonEmptyString(raw.description, "description", options.filePath);
    if (!parsedDescription.ok) return parseFailure(parsedDescription.error, diagnostics);
    description = parsedDescription.value;
  }

  const parsedTools = optionalStringList(raw.tools, "tools", options.filePath);
  if (!parsedTools.ok) return parseFailure(parsedTools.error, diagnostics);

  if (raw.skill !== undefined && raw.skills !== undefined) {
    return parseFailure(
      {
        code: "invalid-schema",
        message: "Subagent definition may specify either \"skill\" or \"skills\", but not both.",
        filePath: options.filePath,
        field: "skills",
      },
      diagnostics,
    );
  }
  const parsedSkills = optionalStringList(raw.skills ?? raw.skill, "skills", options.filePath);
  if (!parsedSkills.ok) return parseFailure(parsedSkills.error, diagnostics);

  let cwd: string | undefined;
  if (raw.cwd !== undefined) {
    const parsedCwd = nonEmptyString(raw.cwd, "cwd", options.filePath);
    if (!parsedCwd.ok) return parseFailure(parsedCwd.error, diagnostics);
    cwd = parsedCwd.value;
  }

  if (raw.spawning !== undefined && typeof raw.spawning !== "boolean") {
    return parseFailure(
      {
        code: "invalid-schema",
        message: "Subagent definition field \"spawning\" must be a boolean.",
        filePath: options.filePath,
        field: "spawning",
      },
      diagnostics,
    );
  }

  return {
    ok: true,
    value: {
      name: parsedName.value,
      ...(description === undefined ? {} : { description }),
      ...(frontmatter.body.length === 0 ? {} : { instructions: frontmatter.body }),
      ...(parsedTools.value === undefined ? {} : { tools: parsedTools.value }),
      ...(parsedSkills.value === undefined ? {} : { skills: parsedSkills.value }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(raw.spawning === undefined ? {} : { spawning: raw.spawning }),
      source: options.source,
      filePath: options.filePath,
    },
    diagnostics,
  };
}

async function discoverSubagentsInDirectory(
  directory: string,
  source: SubagentDefinitionSource,
): Promise<SubagentDefinitionDiscoveryResult> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    const errorCode = isRecord(cause) ? cause.code : undefined;
    if (errorCode === "ENOENT") {
      return { definitions: [], errors: [], diagnostics: [] };
    }
    return {
      definitions: [],
      errors: [],
      diagnostics: [
        {
          severity: "warning",
          code: "directory-read-failed",
          message: `Could not read subagent directory "${directory}".`,
          filePath: directory,
        },
      ],
    };
  }

  const definitions: SubagentDefinition[] = [];
  const errors: SubagentDefinitionError[] = [];
  const diagnostics: SubagentDefinitionDiagnostic[] = [];
  const markdownEntries = entries
    .filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of markdownEntries) {
    const filePath = join(directory, entry.name);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      errors.push({
        code: "file-read-failed",
        message: `Could not read subagent definition "${filePath}".`,
        filePath,
      });
      continue;
    }

    const result = parseSubagentDefinition(content, {
      filePath,
      source,
      fallbackName: basename(entry.name, ".md"),
    });
    diagnostics.push(...result.diagnostics);
    if (result.ok) definitions.push(result.value);
    else errors.push(result.error);
  }

  return { definitions, errors, diagnostics };
}

/** Discover global and project Pi subagents, with project definitions overriding by name. */
export async function discoverSubagentDefinitions(
  options: DiscoverSubagentDefinitionsOptions,
): Promise<SubagentDefinitionDiscoveryResult> {
  const globalDirectory =
    options.globalAgentDir ?? join(homedir(), ".pi", "agent", "agents");
  const projectDirectory = join(options.cwd, ".pi", "agents");
  const emptyProjectResult: SubagentDefinitionDiscoveryResult = {
    definitions: [],
    errors: [],
    diagnostics: [],
  };
  const [globalResult, projectResult] = await Promise.all([
    discoverSubagentsInDirectory(globalDirectory, "global"),
    options.includeProject === false
      ? Promise.resolve(emptyProjectResult)
      : discoverSubagentsInDirectory(projectDirectory, "project"),
  ]);

  const definitionsByName = new Map<string, SubagentDefinition>();
  const diagnostics = [...globalResult.diagnostics, ...projectResult.diagnostics];
  for (const definition of [...globalResult.definitions, ...projectResult.definitions]) {
    const previous = definitionsByName.get(definition.name);
    if (previous && previous.source === definition.source) {
      diagnostics.push({
        severity: "warning",
        code: "duplicate-name",
        message: `Subagent "${definition.name}" is defined more than once in ${definition.source} configuration; "${definition.filePath}" wins.`,
        filePath: definition.filePath,
        field: "name",
      });
    }
    definitionsByName.set(definition.name, definition);
  }

  return {
    definitions: [...definitionsByName.values()],
    errors: [...globalResult.errors, ...projectResult.errors],
    diagnostics,
  };
}
