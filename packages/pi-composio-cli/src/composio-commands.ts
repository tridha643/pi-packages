import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripComposioCliAnsi } from "./composio-cli-json.ts";
import type { ComposioCliRunner, ComposioCliRunSuccess } from "./composio-cli-runner.ts";
import type { ComposioDynamicToolRegistry } from "./composio-dynamic-tools.ts";

const COMMAND_TIMEOUT_MS = 5 * 60 * 1_000;
const LOGIN_POLL_TIMEOUT_MS = 11 * 60 * 1_000;
const MINIMUM_COMPOSIO_CLI_VERSION = [0, 2, 31] as const;
const URL_PATTERN = /https:\/\/[^\s]+/u;

/** Dependencies needed by user-invoked Composio account and diagnostic commands. */
export type RegisterComposioCommandsOptions = {
  readonly runner: ComposioCliRunner;
  readonly dynamicTools: ComposioDynamicToolRegistry;
};

async function runComposioCommand(params: {
  readonly runner: ComposioCliRunner;
  readonly args: ReadonlyArray<string>;
  readonly ctx: ExtensionContext;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<ComposioCliRunSuccess | undefined> {
  const result = await params.runner.run({
    args: params.args,
    cwd: params.ctx.cwd,
    timeoutMs: params.timeoutMs ?? COMMAND_TIMEOUT_MS,
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  });
  if (result._tag === "failure") {
    params.ctx.ui.notify(result.error.message, "error");
    return undefined;
  }
  return result.value;
}

function displayComposioCommandOutput(
  ctx: ExtensionContext,
  result: ComposioCliRunSuccess,
  fallback: string,
): void {
  const output = stripComposioCliAnsi(result.stdout).trim();
  ctx.ui.notify(output || fallback, "info");
}

function parseVersionTuple(value: string): readonly [number, number, number] | undefined {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return undefined;
  }
  return [major, minor, patch];
}

function isSupportedVersion(version: readonly [number, number, number]): boolean {
  for (let index = 0; index < version.length; index += 1) {
    const actual = version[index];
    const minimum = MINIMUM_COMPOSIO_CLI_VERSION[index];
    if (actual === undefined || minimum === undefined) {
      return false;
    }
    if (actual > minimum) {
      return true;
    }
    if (actual < minimum) {
      return false;
    }
  }
  return true;
}

/** Register login, account linking, connection, reset, identity, and doctor slash commands. */
export function registerComposioCommands(
  pi: ExtensionAPI,
  registrationOptions: RegisterComposioCommandsOptions,
): void {
  const commandAbortController = new AbortController();
  const inFlightCommandProcesses = new Set<Promise<unknown>>();
  const commandRunner: ComposioCliRunner = {
    run(request) {
      const pendingProcess = registrationOptions.runner.run(request);
      inFlightCommandProcesses.add(pendingProcess);
      void pendingProcess.then(
        () => inFlightCommandProcesses.delete(pendingProcess),
        () => inFlightCommandProcesses.delete(pendingProcess),
      );
      return pendingProcess;
    },
  };
  const options: RegisterComposioCommandsOptions = {
    ...registrationOptions,
    runner: commandRunner,
  };

  pi.on("session_shutdown", async () => {
    commandAbortController.abort();
    while (inFlightCommandProcesses.size > 0) {
      await Promise.allSettled(inFlightCommandProcesses);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  pi.registerCommand("composio-login", {
    description: "Open Composio browser login and poll until credentials are saved",
    handler: async (_args, ctx) => {
      const login = await runComposioCommand({
        runner: options.runner,
        args: ["login", "--no-wait", "--no-skill-install"],
        ctx,
        signal: commandAbortController.signal,
      });
      if (login === undefined) {
        return;
      }

      const output = stripComposioCliAnsi(login.stdout).trim();
      const loginUrl = URL_PATTERN.exec(output)?.[0];
      ctx.ui.notify(
        loginUrl === undefined
          ? output || "Composio login started."
          : `Open this Composio login URL:\n${loginUrl}`,
        "info",
      );

      const completed = await runComposioCommand({
        runner: options.runner,
        args: ["login", "--poll", "--no-skill-install"],
        ctx,
        timeoutMs: LOGIN_POLL_TIMEOUT_MS,
        signal: commandAbortController.signal,
      });
      if (completed !== undefined) {
        displayComposioCommandOutput(ctx, completed, "Composio login completed.");
      }
    },
  });

  pi.registerCommand("composio-whoami", {
    description: "Show the identity and organization used by the Composio CLI",
    handler: async (_args, ctx) => {
      const result = await runComposioCommand({
        runner: options.runner,
        args: ["whoami"],
        ctx,
        signal: commandAbortController.signal,
      });
      if (result !== undefined) {
        displayComposioCommandOutput(ctx, result, "Composio CLI is authenticated.");
      }
    },
  });

  pi.registerCommand("composio-link", {
    description: "Create an OAuth link: /composio-link <toolkit> [account-alias]",
    handler: async (rawArguments, ctx) => {
      const [toolkit, alias, ...extraArguments] = rawArguments.trim().split(/\s+/u).filter(Boolean);
      if (toolkit === undefined || extraArguments.length > 0) {
        ctx.ui.notify("Usage: /composio-link <toolkit> [account-alias]", "warning");
        return;
      }

      const args = ["link", toolkit, "--no-wait"];
      if (alias !== undefined) {
        const multiAccountStatus = await runComposioCommand({
          runner: options.runner,
          args: ["config", "experimental", "multi_account"],
          ctx,
          signal: commandAbortController.signal,
        });
        if (multiAccountStatus === undefined) {
          return;
        }
        if (multiAccountStatus.stdout.trim().toLowerCase() !== "on") {
          ctx.ui.notify(
            "Composio account alias unavailable: enable it with `composio config experimental multi_account on` before linking with an alias.",
            "error",
          );
          return;
        }
        args.push("--alias", alias);
      }
      const result = await runComposioCommand({
        runner: options.runner,
        args,
        ctx,
        signal: commandAbortController.signal,
      });
      if (result !== undefined) {
        displayComposioCommandOutput(ctx, result, `Composio OAuth link created for ${toolkit}.`);
      }
    },
  });

  pi.registerCommand("composio-connections", {
    description: "List connected Composio accounts: /composio-connections [toolkit]",
    handler: async (rawArguments, ctx) => {
      const toolkit = rawArguments.trim();
      if (/\s/u.test(toolkit)) {
        ctx.ui.notify("Usage: /composio-connections [toolkit]", "warning");
        return;
      }
      const args = ["connections", "list"];
      if (toolkit) {
        args.push("--toolkit", toolkit);
      }
      const result = await runComposioCommand({
        runner: options.runner,
        args,
        ctx,
        signal: commandAbortController.signal,
      });
      if (result !== undefined) {
        displayComposioCommandOutput(ctx, result, "No Composio connections found.");
      }
    },
  });

  pi.registerCommand("composio-reset-tools", {
    description: "Deactivate ordinary Composio tools loaded in the current Pi session",
    handler: async (_args, ctx) => {
      const deactivatedCount = options.dynamicTools.resetSessionTools();
      ctx.ui.notify(`Deactivated ${deactivatedCount} dynamically loaded Composio tools.`, "info");
    },
  });

  pi.registerCommand("composio-doctor", {
    description: "Check the Composio CLI version, authentication, and meta-tool schema access",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      const versionResult = await options.runner.run({
        args: ["--version"],
        cwd: ctx.cwd,
        timeoutMs: COMMAND_TIMEOUT_MS,
        signal: commandAbortController.signal,
      });
      if (versionResult._tag === "failure") {
        ctx.ui.notify(`Composio doctor failed: ${versionResult.error.message}`, "error");
        return;
      }

      const versionText = stripComposioCliAnsi(versionResult.value.stdout).trim();
      const version = parseVersionTuple(versionText);
      lines.push(`Binary: ${versionResult.value.binaryPath}`);
      lines.push(`Version: ${versionText || "unknown"}`);
      lines.push(
        `Version gate: ${version !== undefined && isSupportedVersion(version) ? "pass" : "fail (requires >=0.2.31)"}`,
      );

      const identityResult = await options.runner.run({
        args: ["whoami"],
        cwd: ctx.cwd,
        timeoutMs: COMMAND_TIMEOUT_MS,
        signal: commandAbortController.signal,
      });
      lines.push(`Authentication: ${identityResult._tag === "success" ? "pass" : "fail"}`);

      const schemaResult = await options.runner.run({
        args: ["execute", "COMPOSIO_SEARCH_TOOLS", "--get-schema"],
        cwd: ctx.cwd,
        timeoutMs: COMMAND_TIMEOUT_MS,
        signal: commandAbortController.signal,
      });
      lines.push(`Meta-tool schemas: ${schemaResult._tag === "success" ? "pass" : "fail"}`);
      lines.push("Credential storage: CLI-owned and intentionally not inspected by this extension");

      ctx.ui.notify(lines.join("\n"), lines.some((line) => line.includes("fail")) ? "warning" : "info");
    },
  });
}
