import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import type { ComposioCliRunner, ComposioCliRunSuccess } from "./composio-cli-runner.ts";
import { enforceComposioRecipePolicy, type ComposioMetaToolSlug } from "./composio-tool-policy.ts";
import {
  executeComposioTool,
  throwComposioToolFailure,
  type ExecuteComposioToolOptions,
} from "./composio-tool-execution.ts";
import { resolveComposioStoredOutput } from "./composio-stored-output.ts";
import { formatComposioToolOutput } from "./composio-tool-output.ts";

const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60 * 1_000;
const REMOTE_EXECUTION_TIMEOUT_MS = 200 * 1_000;
const CONNECTION_WAIT_TIMEOUT_MS = 11 * 60 * 1_000;
const ALLOWED_PROXY_HEADER_NAMES = new Set([
  "accept",
  "accept-language",
  "content-language",
  "content-type",
  "idempotency-key",
  "if-match",
  "if-none-match",
  "prefer",
  "range",
  "user-agent",
  "x-correlation-id",
  "x-request-id",
]);
const SENSITIVE_PROXY_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
]);
const SENSITIVE_PROXY_HEADER_SEGMENT_PATTERN =
  /(?:^|-)(?:(?:api|access|client|private|rapidapi|subscription)-?key|apikey|auth|authentication|credential|password|secret|signature|token)(?:-|$)/u;
const SENSITIVE_PROXY_HEADER_VALUE_PATTERN = /^(?:apikey|basic|bearer|digest|token)\s+/iu;
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const SENSITIVE_PROXY_CANONICAL_QUERY_NAMES = new Set([
  "accesstoken",
  "apikey",
  "auth",
  "authentication",
  "authorization",
  "authtoken",
  "clientsecret",
  "credential",
  "idtoken",
  "key",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "sessiontoken",
  "sig",
  "token",
]);

function isSensitiveProxyHeaderName(name: string): boolean {
  const normalizedName = name.trim().toLowerCase();
  return (
    SENSITIVE_PROXY_HEADER_NAMES.has(normalizedName) ||
    SENSITIVE_PROXY_HEADER_SEGMENT_PATTERN.test(normalizedName)
  );
}

function assertSafeProxyHeader(name: string, value: string): void {
  const normalizedName = name.trim().toLowerCase();
  if (!HTTP_HEADER_NAME_PATTERN.test(name) || /[\r\n]/u.test(value)) {
    throw new Error(`Composio proxy header invalid: ${name}. Header names and values must be single-line HTTP syntax.`);
  }
  if (!ALLOWED_PROXY_HEADER_NAMES.has(normalizedName)) {
    throw new Error(
      `Composio proxy header not allowed: ${name}. Only known non-credential headers can be forwarded through CLI arguments.`,
    );
  }
  if (isSensitiveProxyHeaderName(name) || SENSITIVE_PROXY_HEADER_VALUE_PATTERN.test(value.trim())) {
    throw new Error(
      `Composio proxy sensitive header forbidden: ${name}. Store authentication in the connected account instead.`,
    );
  }
}

function isSensitiveProxyQueryParameter(name: string): boolean {
  const canonicalName = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return (
    SENSITIVE_PROXY_CANONICAL_QUERY_NAMES.has(canonicalName) ||
    canonicalName.endsWith("signature")
  );
}

function assertSafeProxyEndpoint(endpoint: string): void {
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint, "https://pi-composio.invalid");
  } catch {
    throw new Error("Composio proxy endpoint invalid: provide an absolute or toolkit-relative URL.");
  }
  if (parsedEndpoint.username || parsedEndpoint.password) {
    throw new Error(
      "Composio proxy endpoint credentials forbidden: store authentication in the connected account.",
    );
  }
  if (parsedEndpoint.hash) {
    throw new Error(
      "Composio proxy endpoint fragment forbidden: URL fragments are not sent in HTTP requests and may expose credentials in process arguments.",
    );
  }
  for (const parameterName of parsedEndpoint.searchParams.keys()) {
    if (isSensitiveProxyQueryParameter(parameterName)) {
      throw new Error(
        `Composio proxy sensitive query parameter forbidden: ${parameterName}. Store authentication in the connected account.`,
      );
    }
  }
}

const SEARCH_TOOLS_PARAMETERS = Type.Object({
  queries: Type.Array(
    Type.Object({
      use_case: Type.String({
        description: "Complete normalized use case, without personal identifiers.",
        maxLength: 1024,
      }),
      known_fields: Type.Optional(
        Type.String({
          description: "One short comma-separated string of known key:value identifiers or settings.",
        }),
      ),
    }),
    { minItems: 1, maxItems: 7 },
  ),
  session: Type.Optional(
    Type.Object({
      id: Type.Optional(Type.String({ description: "Existing Composio workflow session ID." })),
      generate_id: Type.Optional(
        Type.Boolean({ description: "Generate a session ID for a new workflow." }),
      ),
    }),
  ),
  model: Type.Optional(Type.String({ description: "Current client LLM model name." })),
});

const GET_TOOL_SCHEMAS_PARAMETERS = Type.Object({
  tool_slugs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  include: Type.Optional(
    Type.Array(Type.Union([Type.Literal("input_schema"), Type.Literal("output_schema")]), {
      default: ["input_schema"],
    }),
  ),
  session_id: Type.Optional(Type.String()),
});

const MULTI_EXECUTE_PARAMETERS = Type.Object({
  tools: Type.Array(
    Type.Object({
      tool_slug: Type.String({ minLength: 1 }),
      arguments: Type.Record(Type.String(), Type.Unknown()),
    }),
    { minItems: 1, maxItems: 50 },
  ),
  thought: Type.Optional(Type.String()),
  sync_response_to_workbench: Type.Boolean({ default: false }),
  memory: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
  current_step: Type.Optional(Type.String()),
  current_step_metric: Type.Optional(Type.String()),
  session_id: Type.Optional(Type.String()),
});

const MANAGE_CONNECTIONS_PARAMETERS = Type.Object({
  toolkits: Type.Array(Type.String(), { minItems: 1 }),
  reinitiate_all: Type.Optional(Type.Boolean({ default: false })),
  session_id: Type.Optional(Type.String()),
});

const WAIT_FOR_CONNECTIONS_PARAMETERS = Type.Object({
  toolkits: Type.Array(Type.String(), { minItems: 1 }),
  mode: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")], { default: "any" })),
  session_id: Type.Optional(Type.String()),
});

const REMOTE_WORKBENCH_PARAMETERS = Type.Object({
  code_to_execute: Type.String({
    description: "Python to run in Composio's persistent remote Jupyter sandbox.",
  }),
  thought: Type.Optional(Type.String()),
  current_step: Type.Optional(Type.String()),
  current_step_metric: Type.Optional(Type.String()),
  session_id: Type.Optional(Type.String()),
});

const REMOTE_BASH_PARAMETERS = Type.Object({
  command: Type.String({
    description: "Bash command to execute in Composio's persistent remote sandbox.",
  }),
  session_id: Type.Optional(Type.String()),
});

const EXECUTE_TOOL_PARAMETERS = Type.Object({
  slug: Type.String({ description: "Exact ordinary Composio tool slug; never invent one." }),
  arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { default: {} })),
  account: Type.Optional(
    Type.String({ description: "Connected account alias, word ID, or connected-account ID." }),
  ),
  file: Type.Optional(
    Type.String({ description: "Local path for a tool with exactly one file-uploadable input." }),
  ),
  dry_run: Type.Optional(Type.Boolean({ default: false })),
});

const LIST_CONNECTIONS_PARAMETERS = Type.Object({
  toolkit: Type.Optional(Type.String({ description: "Optional lowercase toolkit slug filter." })),
});

const PROXY_PARAMETERS = Type.Object({
  endpoint: Type.String({ description: "Absolute or relative toolkit API endpoint." }),
  toolkit: Type.String({ description: "Toolkit slug whose connected account authenticates the call." }),
  method: Type.Optional(
    Type.Union(
      [
        Type.Literal("GET"),
        Type.Literal("POST"),
        Type.Literal("PUT"),
        Type.Literal("DELETE"),
        Type.Literal("PATCH"),
      ],
      { default: "GET" },
    ),
  ),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  data: Type.Optional(Type.Unknown({ description: "Raw string or JSON request body." })),
});

/** Callback that registers ordinary tool schemas found in a successful meta-tool response. */
export type LoadComposioDiscoveredTools = (
  parsedOutput: unknown,
) => Promise<ReadonlyArray<string>>;

/** Dependencies needed to register the fixed first-class Composio tool surface. */
export type RegisterComposioFixedToolsOptions = {
  readonly runner: ComposioCliRunner;
  readonly loadDiscoveredTools: LoadComposioDiscoveredTools;
};

function unknownObjectRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Composio tool arguments must be a JSON object.");
  }
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    record[key] = Reflect.get(value, key) as unknown;
  }
  return record;
}

async function executeFixedMetaTool(params: {
  readonly runner: ComposioCliRunner;
  readonly slug: ComposioMetaToolSlug;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal | undefined;
  readonly cwd: string;
  readonly timeoutMs: number;
}) {
  const execution = await executeComposioTool({
    runner: params.runner,
    slug: params.slug,
    arguments: params.arguments,
    options: {
      timeoutMs: params.timeoutMs,
      cwd: params.cwd,
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    },
  });
  if (execution._tag === "failure") {
    return throwComposioToolFailure(execution.error);
  }
  return execution.value;
}

function registerSimpleMetaTool<TParameters extends TSchema>(
  pi: ExtensionAPI,
  options: RegisterComposioFixedToolsOptions,
  definition: {
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly slug: ComposioMetaToolSlug;
    readonly parameters: TParameters;
    readonly timeoutMs: number;
    readonly promptGuidelines?: ReadonlyArray<string>;
  },
): void {
  pi.registerTool({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    promptSnippet: definition.description,
    ...(definition.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: [...definition.promptGuidelines] }),
    parameters: definition.parameters,
    async execute(_toolCallId, rawParameters: Static<TParameters>, signal, _onUpdate, ctx) {
      const result = await executeFixedMetaTool({
        runner: options.runner,
        slug: definition.slug,
        arguments: unknownObjectRecord(rawParameters),
        signal,
        cwd: ctx.cwd,
        timeoutMs: definition.timeoutMs,
      });
      return formatComposioToolOutput({ operation: definition.name, result });
    },
  });
}

function replaceComposioParsedOutput(
  result: ComposioCliRunSuccess,
  parsedOutput: unknown,
): ComposioCliRunSuccess {
  return {
    ...result,
    stdout: JSON.stringify(parsedOutput, null, 2),
    parsedOutput,
  };
}

/** Register every non-recipe meta-tool plus ordinary execution, connection, and proxy tools. */
export function registerComposioFixedTools(
  pi: ExtensionAPI,
  options: RegisterComposioFixedToolsOptions,
): void {
  pi.registerTool({
    name: "composio_search_tools",
    label: "Search Composio Tools",
    description:
      "Search Composio for toolkit capabilities and load matching ordinary tools into Pi. Use this before inventing a tool slug.",
    promptSnippet: "Search Composio capabilities and dynamically load matching toolkit tools",
    parameters: SEARCH_TOOLS_PARAMETERS,
    async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
      const searchArguments = {
        ...parameters,
        session: parameters.session ?? { generate_id: true },
        model: parameters.model ?? ctx.model?.id,
      };
      const result = await executeFixedMetaTool({
        runner: options.runner,
        slug: "COMPOSIO_SEARCH_TOOLS",
        arguments: searchArguments,
        signal,
        cwd: ctx.cwd,
        timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      });
      const schemaOutput = await resolveComposioStoredOutput(result.parsedOutput);
      if (schemaOutput._tag === "failure") {
        throw new Error(schemaOutput.error.message);
      }
      const loadedToolNames = await options.loadDiscoveredTools(schemaOutput.value);
      return formatComposioToolOutput({
        operation: "composio_search_tools",
        result: replaceComposioParsedOutput(result, schemaOutput.value),
        loadedToolNames,
      });
    },
  });

  pi.registerTool({
    name: "composio_get_tool_schemas",
    label: "Get Composio Tool Schemas",
    description:
      "Retrieve exact schemas for known Composio tool slugs and load those ordinary tools into Pi.",
    promptSnippet: "Retrieve and activate exact schemas for known Composio tool slugs",
    parameters: GET_TOOL_SCHEMAS_PARAMETERS,
    async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
      const result = await executeFixedMetaTool({
        runner: options.runner,
        slug: "COMPOSIO_GET_TOOL_SCHEMAS",
        arguments: parameters,
        signal,
        cwd: ctx.cwd,
        timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      });
      const schemaOutput = await resolveComposioStoredOutput(result.parsedOutput);
      if (schemaOutput._tag === "failure") {
        throw new Error(schemaOutput.error.message);
      }
      const loadedToolNames = await options.loadDiscoveredTools(schemaOutput.value);
      return formatComposioToolOutput({
        operation: "composio_get_tool_schemas",
        result: replaceComposioParsedOutput(result, schemaOutput.value),
        loadedToolNames,
      });
    },
  });

  registerSimpleMetaTool(pi, options, {
    name: "composio_multi_execute_tool",
    label: "Composio Multi Execute",
    description: "Execute up to 50 independent ordinary Composio tools in parallel.",
    slug: "COMPOSIO_MULTI_EXECUTE_TOOL",
    parameters: MULTI_EXECUTE_PARAMETERS,
    timeoutMs: REMOTE_EXECUTION_TIMEOUT_MS,
  });
  registerSimpleMetaTool(pi, options, {
    name: "composio_manage_connections",
    label: "Manage Composio Connections",
    description: "Check toolkit connections and initiate OAuth links for missing accounts.",
    slug: "COMPOSIO_MANAGE_CONNECTIONS",
    parameters: MANAGE_CONNECTIONS_PARAMETERS,
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  });
  registerSimpleMetaTool(pi, options, {
    name: "composio_wait_for_connections",
    label: "Wait for Composio Connections",
    description: "Wait for any or all requested Composio OAuth connections to finish.",
    slug: "COMPOSIO_WAIT_FOR_CONNECTIONS",
    parameters: WAIT_FOR_CONNECTIONS_PARAMETERS,
    timeoutMs: CONNECTION_WAIT_TIMEOUT_MS,
  });
  registerSimpleMetaTool(pi, options, {
    name: "composio_remote_workbench",
    label: "Composio Remote Workbench",
    description:
      "Run Python in Composio's persistent remote Jupyter sandbox. Recipe operations remain excluded.",
    slug: "COMPOSIO_REMOTE_WORKBENCH",
    parameters: REMOTE_WORKBENCH_PARAMETERS,
    timeoutMs: REMOTE_EXECUTION_TIMEOUT_MS,
    promptGuidelines: [
      "Never construct, retrieve, or execute COMPOSIO_UPSERT_RECIPE or COMPOSIO_GET_RECIPE through the remote workbench.",
    ],
  });
  registerSimpleMetaTool(pi, options, {
    name: "composio_remote_bash_tool",
    label: "Composio Remote Bash",
    description:
      "Run a bash command in Composio's persistent remote sandbox. Recipe operations remain excluded.",
    slug: "COMPOSIO_REMOTE_BASH_TOOL",
    parameters: REMOTE_BASH_PARAMETERS,
    timeoutMs: REMOTE_EXECUTION_TIMEOUT_MS,
    promptGuidelines: [
      "Never construct, retrieve, or execute COMPOSIO_UPSERT_RECIPE or COMPOSIO_GET_RECIPE through remote bash.",
    ],
  });

  pi.registerTool({
    name: "composio_execute_tool",
    label: "Execute Composio Tool",
    description:
      "Execute one exact ordinary Composio tool slug. Prefer a dynamically loaded typed tool when available.",
    promptSnippet: "Execute an exact ordinary Composio tool slug",
    parameters: EXECUTE_TOOL_PARAMETERS,
    async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
      const executionOptions: ExecuteComposioToolOptions = {
        timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
        cwd: ctx.cwd,
        ...(parameters.account === undefined ? {} : { account: parameters.account }),
        ...(parameters.file === undefined ? {} : { file: parameters.file }),
        ...(parameters.dry_run === undefined ? {} : { dryRun: parameters.dry_run }),
        ...(signal === undefined ? {} : { signal }),
      };
      const execution = await executeComposioTool({
        runner: options.runner,
        slug: parameters.slug,
        arguments: parameters.arguments ?? {},
        options: executionOptions,
      });
      if (execution._tag === "failure") {
        return throwComposioToolFailure(execution.error);
      }
      return formatComposioToolOutput({
        operation: `composio_execute_tool:${parameters.slug}`,
        result: execution.value,
      });
    },
  });

  pi.registerTool({
    name: "composio_list_connections",
    label: "List Composio Connections",
    description: "List current Composio connected accounts, optionally filtered by toolkit.",
    promptSnippet: "List active, pending, and failed Composio account connections",
    parameters: LIST_CONNECTIONS_PARAMETERS,
    async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
      const args = ["connections", "list"];
      if (parameters.toolkit !== undefined) {
        args.push("--toolkit", parameters.toolkit);
      }
      const result = await options.runner.run({
        args,
        cwd: ctx.cwd,
        timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      });
      if (result._tag === "failure") {
        throw new Error(result.error.message);
      }
      return formatComposioToolOutput({ operation: "composio_list_connections", result: result.value });
    },
  });

  pi.registerTool({
    name: "composio_proxy",
    label: "Composio API Proxy",
    description:
      "Call a connected toolkit's HTTP API through Composio authentication. Use documented absolute or toolkit-relative endpoints; Composio supplies authorization headers.",
    promptSnippet: "Call an authenticated toolkit HTTP API through Composio",
    parameters: PROXY_PARAMETERS,
    async execute(_toolCallId, parameters, signal, _onUpdate, ctx) {
      const policy = enforceComposioRecipePolicy(parameters);
      if (policy._tag === "failure") {
        throw new Error(policy.error.message);
      }

      assertSafeProxyEndpoint(parameters.endpoint);
      const args = [
        "proxy",
        parameters.endpoint,
        "--toolkit",
        parameters.toolkit,
        "--method",
        parameters.method ?? "GET",
      ];
      for (const [name, value] of Object.entries(parameters.headers ?? {})) {
        assertSafeProxyHeader(name, value);
        args.push("--header", `${name}: ${value}`);
      }
      if (parameters.data !== undefined) {
        args.push("--data", "-");
      }

      const result = await options.runner.run({
        args,
        cwd: ctx.cwd,
        timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
        ...(parameters.data === undefined
          ? {}
          : {
              stdin:
                typeof parameters.data === "string"
                  ? parameters.data
                  : JSON.stringify(parameters.data),
            }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (result._tag === "failure") {
        throw new Error(result.error.message);
      }
      return formatComposioToolOutput({ operation: "composio_proxy", result: result.value });
    },
  });
}
