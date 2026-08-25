import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isComposioJsonObject } from "./composio-cli-json.ts";
import type { ComposioCliRunner } from "./composio-cli-runner.ts";
import { executeComposioTool, throwComposioToolFailure } from "./composio-tool-execution.ts";
import { formatComposioToolOutput } from "./composio-tool-output.ts";
import { FORBIDDEN_COMPOSIO_RECIPE_SLUGS } from "./composio-tool-policy.ts";

const DYNAMIC_TOOL_ENTRY_TYPE = "pi-composio-cli:dynamic-tool";
const DYNAMIC_TOOLS_RESET_ENTRY_TYPE = "pi-composio-cli:dynamic-tools-reset";
const DYNAMIC_TOOL_NAME_MAX_LENGTH = 64;
const DYNAMIC_TOOL_HASH_LENGTH = 10;
const DYNAMIC_TOOL_TIMEOUT_MS = 5 * 60 * 1_000;
const ACCOUNT_PARAMETER = "__pi_composio_account";
const DRY_RUN_PARAMETER = "__pi_composio_dry_run";
const FILE_PARAMETER = "__pi_composio_file";

/** An ordinary Composio tool schema safe to persist in a Pi custom session entry. */
export type ComposioDynamicToolDescriptor = {
  readonly slug: string;
  readonly toolkit: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
};

function normalizedDynamicToolSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

/** Produce a deterministic provider-safe Pi name for an ordinary Composio tool slug. */
export function composioDynamicToolName(slug: string): string {
  const normalizedSlug = normalizedDynamicToolSlug(slug) || "tool";
  const unabridgedName = `composio_${normalizedSlug}`;
  if (unabridgedName.length <= DYNAMIC_TOOL_NAME_MAX_LENGTH) {
    return unabridgedName;
  }

  const hash = createHash("sha256").update(slug).digest("hex").slice(0, DYNAMIC_TOOL_HASH_LENGTH);
  const visibleLength =
    DYNAMIC_TOOL_NAME_MAX_LENGTH - "composio_".length - 1 - DYNAMIC_TOOL_HASH_LENGTH;
  return `composio_${normalizedSlug.slice(0, visibleLength)}_${hash}`;
}

function inferredToolkit(slug: string): string {
  return slug.split("_")[0]?.toLowerCase() || "unknown";
}

function parseDynamicToolDescriptor(
  schemaKey: string,
  value: unknown,
): ComposioDynamicToolDescriptor | undefined {
  if (!isComposioJsonObject(value)) {
    return undefined;
  }

  const slug =
    typeof value.tool_slug === "string"
      ? value.tool_slug
      : typeof value.slug === "string"
        ? value.slug
        : schemaKey;
  if (
    !slug ||
    FORBIDDEN_COMPOSIO_RECIPE_SLUGS.some((forbiddenSlug) => forbiddenSlug === slug.toUpperCase())
  ) {
    return undefined;
  }

  const inputSchema = value.input_schema ?? value.inputSchema;
  if (!isComposioJsonObject(inputSchema)) {
    return undefined;
  }

  return {
    slug,
    toolkit: typeof value.toolkit === "string" ? value.toolkit.toLowerCase() : inferredToolkit(slug),
    description:
      typeof value.description === "string" && value.description.trim()
        ? value.description.trim()
        : `Execute the ${slug} Composio tool.`,
    inputSchema: structuredClone(inputSchema),
  };
}

/** Extract ordinary tool descriptors from search or get-schema meta-tool output. */
export function extractComposioDynamicToolDescriptors(
  parsedOutput: unknown,
): ReadonlyArray<ComposioDynamicToolDescriptor> {
  if (!isComposioJsonObject(parsedOutput)) {
    return [];
  }

  const data = isComposioJsonObject(parsedOutput.data) ? parsedOutput.data : parsedOutput;
  const toolSchemas = data.tool_schemas;
  if (!isComposioJsonObject(toolSchemas)) {
    return [];
  }

  const descriptors: ComposioDynamicToolDescriptor[] = [];
  for (const [schemaKey, schema] of Object.entries(toolSchemas)) {
    const descriptor = parseDynamicToolDescriptor(schemaKey, schema);
    if (descriptor !== undefined) {
      descriptors.push(descriptor);
    }
  }
  return descriptors;
}

function schemaWithPiExecutionControls(
  descriptor: ComposioDynamicToolDescriptor,
): Readonly<Record<string, unknown>> {
  const schema: Record<string, unknown> = { ...structuredClone(descriptor.inputSchema) };
  const existingProperties = isComposioJsonObject(schema.properties) ? schema.properties : {};
  if (
    ACCOUNT_PARAMETER in existingProperties ||
    DRY_RUN_PARAMETER in existingProperties ||
    FILE_PARAMETER in existingProperties
  ) {
    throw new Error(
      `Composio dynamic schema conflict: ${descriptor.slug} already defines a reserved Pi execution field.`,
    );
  }

  schema.type = "object";
  schema.properties = {
    ...existingProperties,
    [ACCOUNT_PARAMETER]: {
      type: "string",
      description: "Optional connected account alias, word ID, or connected-account ID.",
    },
    [DRY_RUN_PARAMETER]: {
      type: "boolean",
      description: "Validate and preview this call without executing it.",
      default: false,
    },
    [FILE_PARAMETER]: {
      type: "string",
      description: "Optional local path for a tool with exactly one file-uploadable input.",
    },
  };
  return schema;
}

function dynamicExecutionArguments(parameters: unknown): {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly account?: string;
  readonly dryRun?: boolean;
  readonly file?: string;
} {
  if (!isComposioJsonObject(parameters)) {
    throw new Error("Composio dynamic tool arguments must be a JSON object.");
  }

  const accountValue = parameters[ACCOUNT_PARAMETER];
  if (accountValue !== undefined && typeof accountValue !== "string") {
    throw new Error(`Composio dynamic account selector must be a string: ${ACCOUNT_PARAMETER}.`);
  }
  const dryRunValue = parameters[DRY_RUN_PARAMETER];
  if (dryRunValue !== undefined && typeof dryRunValue !== "boolean") {
    throw new Error(`Composio dynamic dry-run selector must be a boolean: ${DRY_RUN_PARAMETER}.`);
  }
  const fileValue = parameters[FILE_PARAMETER];
  if (fileValue !== undefined && typeof fileValue !== "string") {
    throw new Error(`Composio dynamic file selector must be a string: ${FILE_PARAMETER}.`);
  }

  const argumentsRecord: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (key !== ACCOUNT_PARAMETER && key !== DRY_RUN_PARAMETER && key !== FILE_PARAMETER) {
      argumentsRecord[key] = value;
    }
  }

  return {
    arguments: argumentsRecord,
    ...(accountValue === undefined ? {} : { account: accountValue }),
    ...(dryRunValue === undefined ? {} : { dryRun: dryRunValue }),
    ...(fileValue === undefined ? {} : { file: fileValue }),
  };
}

function isPersistedDynamicToolDescriptor(value: unknown): value is ComposioDynamicToolDescriptor {
  return (
    isComposioJsonObject(value) &&
    typeof value.slug === "string" &&
    typeof value.toolkit === "string" &&
    typeof value.description === "string" &&
    isComposioJsonObject(value.inputSchema)
  );
}

/** Session-aware registry that activates ordinary typed tools only after discovery. */
export class ComposioDynamicToolRegistry {
  readonly #pi: ExtensionAPI;
  readonly #runner: ComposioCliRunner;
  readonly #dynamicToolNames = new Set<string>();
  readonly #activeDescriptors = new Map<string, ComposioDynamicToolDescriptor>();

  constructor(pi: ExtensionAPI, runner: ComposioCliRunner) {
    this.#pi = pi;
    this.#runner = runner;
  }

  /** Register schemas from a successful meta response, persist them, and activate additively. */
  async loadDiscoveredTools(parsedOutput: unknown): Promise<ReadonlyArray<string>> {
    const descriptors = extractComposioDynamicToolDescriptors(parsedOutput);
    const loadedToolNames: string[] = [];
    for (const descriptor of descriptors) {
      const toolName = this.#registerDynamicTool(descriptor);
      this.#activeDescriptors.set(descriptor.slug, descriptor);
      this.#pi.appendEntry(DYNAMIC_TOOL_ENTRY_TYPE, descriptor);
      loadedToolNames.push(toolName);
    }
    this.#activateToolNames(loadedToolNames);
    return loadedToolNames;
  }

  /** Restore the current branch's dynamic tool state after session startup or switching. */
  restoreSessionTools(ctx: ExtensionContext): ReadonlyArray<string> {
    const restoredDescriptors = new Map<string, ComposioDynamicToolDescriptor>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") {
        continue;
      }
      if (entry.customType === DYNAMIC_TOOLS_RESET_ENTRY_TYPE) {
        restoredDescriptors.clear();
      } else if (
        entry.customType === DYNAMIC_TOOL_ENTRY_TYPE &&
        isPersistedDynamicToolDescriptor(entry.data)
      ) {
        restoredDescriptors.set(entry.data.slug, entry.data);
      }
    }

    this.#deactivateKnownDynamicTools();
    this.#activeDescriptors.clear();
    const restoredToolNames: string[] = [];
    for (const descriptor of restoredDescriptors.values()) {
      restoredToolNames.push(this.#registerDynamicTool(descriptor));
      this.#activeDescriptors.set(descriptor.slug, descriptor);
    }
    this.#activateToolNames(restoredToolNames);
    return restoredToolNames;
  }

  /** Deactivate every discovered ordinary tool for the current session and persist the reset. */
  resetSessionTools(): number {
    const deactivatedCount = this.#activeDescriptors.size;
    this.#deactivateKnownDynamicTools();
    this.#activeDescriptors.clear();
    this.#pi.appendEntry(DYNAMIC_TOOLS_RESET_ENTRY_TYPE, { deactivatedCount });
    return deactivatedCount;
  }

  #registerDynamicTool(descriptor: ComposioDynamicToolDescriptor): string {
    const toolName = composioDynamicToolName(descriptor.slug);
    const parameterSchema = Type.Unsafe(schemaWithPiExecutionControls(descriptor));
    const runner = this.#runner;
    this.#dynamicToolNames.add(toolName);

    this.#pi.registerTool({
      name: toolName,
      label: `${descriptor.toolkit}: ${descriptor.slug}`,
      description: `${descriptor.description} Executed through the official Composio CLI with its connection, permission, upload, and artifact handling.`,
      parameters: parameterSchema,
      async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
        const parsedParameters = dynamicExecutionArguments(parameters);
        const execution = await executeComposioTool({
          runner,
          slug: descriptor.slug,
          arguments: parsedParameters.arguments,
          options: {
            timeoutMs: DYNAMIC_TOOL_TIMEOUT_MS,
            cwd: ctx.cwd,
            ...(parsedParameters.account === undefined ? {} : { account: parsedParameters.account }),
            ...(parsedParameters.dryRun === undefined ? {} : { dryRun: parsedParameters.dryRun }),
            ...(parsedParameters.file === undefined ? {} : { file: parsedParameters.file }),
            ...(signal === undefined ? {} : { signal }),
          },
        });
        if (execution._tag === "failure") {
          return throwComposioToolFailure(execution.error);
        }
        return formatComposioToolOutput({ operation: toolName, result: execution.value });
      },
    });
    return toolName;
  }

  #activateToolNames(toolNames: ReadonlyArray<string>): void {
    if (toolNames.length === 0) {
      return;
    }
    this.#pi.setActiveTools([...new Set([...this.#pi.getActiveTools(), ...toolNames])]);
  }

  #deactivateKnownDynamicTools(): void {
    const activeTools = this.#pi.getActiveTools();
    this.#pi.setActiveTools(activeTools.filter((name) => !this.#dynamicToolNames.has(name)));
  }
}
