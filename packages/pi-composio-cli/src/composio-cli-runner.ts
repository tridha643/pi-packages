import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  getComposioCliFailureMessage,
  parseComposioCliJson,
  sanitizeComposioCliError,
} from "./composio-cli-json.ts";
import {
  resolveComposioCliPath,
  type ComposioCliPath,
  type ResolveComposioCliPathOptions,
} from "./composio-cli-path.ts";
import { composioFailure, composioSuccess, type ComposioResult } from "./composio-result.ts";

const DEFAULT_MAX_CAPTURE_BYTES = 20 * 1024 * 1024;
const FORCE_KILL_DELAY_MS = 5_000;

/** A safe, shell-free invocation of the Composio CLI. */
export type ComposioCliRunRequest = {
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxCaptureBytes?: number;
};

/** Successful Composio CLI output, including parsed JSON when one was emitted. */
export type ComposioCliRunSuccess = {
  readonly binaryPath: ComposioCliPath;
  readonly stdout: string;
  readonly stderr: string;
  readonly parsedOutput: unknown | undefined;
};

/** Expected failure classifications from binary discovery or command execution. */
export type ComposioCliRunError = {
  readonly _tag:
    | "ComposioCliNotFound"
    | "ComposioCliSpawnFailed"
    | "ComposioCliExited"
    | "ComposioCliAborted"
    | "ComposioCliTimedOut"
    | "ComposioCliOutputLimitExceeded";
  readonly message: string;
  readonly exitCode?: number;
  readonly safeStdout?: string;
  readonly safeStderr?: string;
};

/** Injectable process boundary used by every Pi tool and command. */
export interface ComposioCliRunner {
  /** Run one official CLI command without exposing JSON arguments in the process list. */
  run(
    request: ComposioCliRunRequest,
  ): Promise<ComposioResult<ComposioCliRunSuccess, ComposioCliRunError>>;
}

/** Configuration for the local process-backed Composio CLI runner. */
export type NodeComposioCliRunnerOptions = ResolveComposioCliPathOptions;

type TerminationReason = "aborted" | "timeout" | "output-limit";

function appendCapturedChunk(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maxBytes: number,
): { readonly bytes: number; readonly exceeded: boolean } {
  const nextBytes = currentBytes + chunk.byteLength;
  if (nextBytes <= maxBytes) {
    chunks.push(Buffer.from(chunk));
  }
  return { bytes: nextBytes, exceeded: nextBytes > maxBytes };
}

function terminateCliProcess(process: ChildProcessWithoutNullStreams): void {
  process.kill("SIGTERM");
  const forceKillTimer = setTimeout(() => {
    if (process.exitCode === null && process.signalCode === null) {
      process.kill("SIGKILL");
    }
  }, FORCE_KILL_DELAY_MS);
  forceKillTimer.unref();
}

function executionErrorFromExit(params: {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}): ComposioCliRunError {
  const parsed = parseComposioCliJson(params.stdout);
  const parsedMessage = getComposioCliFailureMessage(parsed);
  const safeStdout = truncateComposioCliDiagnostic(sanitizeComposioCliError(params.stdout));
  const safeStderr = truncateComposioCliDiagnostic(sanitizeComposioCliError(params.stderr));
  const diagnostic =
    (parsedMessage === undefined ? undefined : truncateComposioCliDiagnostic(parsedMessage)) ??
    (safeStderr || safeStdout || `exit code ${params.code}`);

  return {
    _tag: "ComposioCliExited",
    message: `Composio CLI command failed: ${diagnostic}`,
    exitCode: params.code,
    safeStdout,
    safeStderr,
  };
}

/** Create the process-backed runner used by the Pi extension in production. */
export function createNodeComposioCliRunner(
  options: NodeComposioCliRunnerOptions = {},
): ComposioCliRunner {
  return {
    async run(request) {
      if (request.signal?.aborted) {
        return composioFailure({
          _tag: "ComposioCliAborted",
          message: "Composio CLI command aborted before launch.",
        });
      }

      const explicitPath = options.explicitPath ?? process.env.COMPOSIO_CLI_PATH;
      const resolvedPath = await resolveComposioCliPath({
        ...options,
        ...(explicitPath === undefined ? {} : { explicitPath }),
      });
      if (resolvedPath._tag === "failure") {
        return composioFailure({
          _tag: resolvedPath.error._tag,
          message: resolvedPath.error.message,
        });
      }
      if (request.signal?.aborted) {
        return composioFailure({
          _tag: "ComposioCliAborted",
          message: "Composio CLI command aborted during binary resolution.",
        });
      }

      return runResolvedComposioCli(resolvedPath.value, request);
    },
  };
}

function truncateComposioCliDiagnostic(value: string, maxCharacters = 16_000): string {
  if (value.length <= maxCharacters) {
    return value;
  }
  return `${value.slice(0, maxCharacters)}\n[Composio CLI failure output truncated]`;
}

async function runResolvedComposioCli(
  binaryPath: ComposioCliPath,
  request: ComposioCliRunRequest,
): Promise<ComposioResult<ComposioCliRunSuccess, ComposioCliRunError>> {
  return new Promise((resolve) => {
    const spawnOptions = {
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        TERM: "dumb",
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binaryPath, [...request.args], spawnOptions);
    } catch (cause) {
      resolve(
        composioFailure({
          _tag: "ComposioCliSpawnFailed",
          message: `Composio CLI failed to launch: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const maxCaptureBytes = request.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
    let capturedBytes = 0;
    let terminationReason: TerminationReason | undefined;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const terminate = (reason: TerminationReason): void => {
      if (terminationReason !== undefined) {
        return;
      }
      const processHasExited = child.exitCode !== null || child.signalCode !== null;
      if (processHasExited && reason !== "output-limit") {
        return;
      }
      terminationReason = reason;
      if (!processHasExited) {
        terminateCliProcess(child);
      }
    };

    const abortListener = (): void => terminate("aborted");
    request.signal?.addEventListener("abort", abortListener, { once: true });
    if (request.signal?.aborted) {
      terminate("aborted");
    }

    if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
      timeout = setTimeout(() => terminate("timeout"), request.timeoutMs);
    }

    // A fast CLI failure can close stdin before `.end()` flushes; the process exit remains the authoritative error.
    child.stdin.on("error", () => undefined);

    child.stdout.on("data", (chunk: Buffer) => {
      const capture = appendCapturedChunk(stdoutChunks, chunk, capturedBytes, maxCaptureBytes);
      capturedBytes = capture.bytes;
      if (capture.exceeded) {
        terminate("output-limit");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const capture = appendCapturedChunk(stderrChunks, chunk, capturedBytes, maxCaptureBytes);
      capturedBytes = capture.bytes;
      if (capture.exceeded) {
        terminate("output-limit");
      }
    });

    child.on("error", (cause) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      request.signal?.removeEventListener("abort", abortListener);
      resolve(
        composioFailure({
          _tag: "ComposioCliSpawnFailed",
          message: `Composio CLI failed to launch: ${cause.message}`,
        }),
      );
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      request.signal?.removeEventListener("abort", abortListener);

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (terminationReason === "aborted") {
        resolve(
          composioFailure({
            _tag: "ComposioCliAborted",
            message: "Composio CLI command aborted.",
          }),
        );
        return;
      }
      if (terminationReason === "timeout") {
        resolve(
          composioFailure({
            _tag: "ComposioCliTimedOut",
            message: `Composio CLI command timed out after ${request.timeoutMs ?? 0}ms.`,
          }),
        );
        return;
      }
      if (terminationReason === "output-limit") {
        resolve(
          composioFailure({
            _tag: "ComposioCliOutputLimitExceeded",
            message: `Composio CLI output exceeded ${maxCaptureBytes} bytes and was terminated.`,
          }),
        );
        return;
      }
      if (code !== 0) {
        resolve(composioFailure(executionErrorFromExit({ code: code ?? 1, stdout, stderr })));
        return;
      }

      resolve(
        composioSuccess({
          binaryPath,
          stdout,
          stderr,
          parsedOutput: parseComposioCliJson(stdout),
        }),
      );
    });

    if (request.stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(request.stdin, "utf8");
    }
  });
}
