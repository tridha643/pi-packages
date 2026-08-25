import { isComposioJsonObject, getComposioCliFailureMessage } from "./composio-cli-json.ts";
import type {
  ComposioCliRunError,
  ComposioCliRunner,
  ComposioCliRunSuccess,
} from "./composio-cli-runner.ts";
import { composioFailure, type ComposioResult } from "./composio-result.ts";
import {
  enforceComposioRecipePolicy,
  type ComposioRecipePolicyError,
} from "./composio-tool-policy.ts";

/** Options supported by ordinary Composio tool execution. */
export type ExecuteComposioToolOptions = {
  readonly account?: string;
  readonly dryRun?: boolean;
  readonly file?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly cwd?: string;
};

/** A successful process exit whose tool payload reports an application-level failure. */
export type ComposioToolPayloadError = {
  readonly _tag: "ComposioToolPayloadFailed";
  readonly message: string;
};

/** Refusal to silently ignore an account selector when the CLI feature is disabled. */
export type ComposioAccountSelectionError = {
  readonly _tag: "ComposioAccountSelectionUnavailable";
  readonly message: string;
};

/** Failures returned by a complete tool execution boundary. */
export type ExecuteComposioToolError =
  | ComposioCliRunError
  | ComposioRecipePolicyError
  | ComposioToolPayloadError
  | ComposioAccountSelectionError;

function classifyComposioToolPayload(
  result: ComposioCliRunSuccess,
): ComposioResult<ComposioCliRunSuccess, ComposioToolPayloadError> {
  if (!isComposioJsonObject(result.parsedOutput) || result.parsedOutput.successful !== false) {
    return { _tag: "success", value: result };
  }

  return composioFailure({
    _tag: "ComposioToolPayloadFailed",
    message:
      getComposioCliFailureMessage(result.parsedOutput) ??
      "Composio tool execution reported successful=false without an error message.",
  });
}

/** Execute a normal or supported meta-tool through `composio execute` using stdin JSON. */
export async function executeComposioTool(params: {
  readonly runner: ComposioCliRunner;
  readonly slug: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly options?: ExecuteComposioToolOptions;
}): Promise<ComposioResult<ComposioCliRunSuccess, ExecuteComposioToolError>> {
  const policyResult = enforceComposioRecipePolicy({
    slug: params.slug,
    arguments: params.arguments,
  });
  if (policyResult._tag === "failure") {
    return policyResult;
  }

  const args = ["execute", params.slug, "--data", "-"];
  if (params.options?.account !== undefined) {
    const multiAccountStatus = await params.runner.run({
      args: ["config", "experimental", "multi_account"],
      ...(params.options.cwd === undefined ? {} : { cwd: params.options.cwd }),
      ...(params.options.signal === undefined ? {} : { signal: params.options.signal }),
      timeoutMs: 30_000,
    });
    if (multiAccountStatus._tag === "failure") {
      return multiAccountStatus;
    }
    if (multiAccountStatus.value.stdout.trim().toLowerCase() !== "on") {
      return composioFailure({
        _tag: "ComposioAccountSelectionUnavailable",
        message:
          "Composio account selection unavailable: enable it with `composio config experimental multi_account on` before passing an account selector.",
      });
    }
    args.push("--account", params.options.account);
  }
  if (params.options?.file !== undefined) {
    args.push("--file", params.options.file);
  }
  if (params.options?.dryRun === true) {
    args.push("--dry-run");
  }

  const runResult = await params.runner.run({
    args,
    stdin: JSON.stringify(params.arguments),
    ...(params.options?.cwd === undefined ? {} : { cwd: params.options.cwd }),
    ...(params.options?.signal === undefined ? {} : { signal: params.options.signal }),
    ...(params.options?.timeoutMs === undefined ? {} : { timeoutMs: params.options.timeoutMs }),
  });
  if (runResult._tag === "failure") {
    return runResult;
  }

  return classifyComposioToolPayload(runResult.value);
}

/** Convert an expected execution failure into the Pi tool error boundary. */
export function throwComposioToolFailure(error: ExecuteComposioToolError): never {
  throw new Error(error.message);
}
