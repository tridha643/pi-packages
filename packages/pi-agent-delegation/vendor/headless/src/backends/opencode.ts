/**
 * OpenCode backend over the official `@opencode-ai/sdk`.
 *
 * One scoped server process owns one persistent OpenCode session. The
 * generated v1 client supplies typed requests and SSE events; this module owns
 * process/session lifecycle and translation into normalized SubagentEvents.
 */

import {
  createOpencodeClient,
  type AssistantMessage,
  type Event,
  type EventMessageUpdated,
  type EventSessionError,
  type ToolPart,
  type ToolState,
} from "@opencode-ai/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import type {
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
} from "../domain.ts";
import {
  BackendPreflightRejectedError,
  SendError,
  SpawnError,
} from "../domain.ts";

const SERVER_START_TIMEOUT_MS = 10_000;
const SERVER_READINESS_POLL_MS = 50;
const INTERRUPT_FALLBACK_MS = 1_500;
const FORCE_KILL_AFTER_MS = 2_000;
const PREVIEW_MAX_LENGTH = 1_024;
const OPEN_CODE_ID_RANDOM_LENGTH = 14;
const OPEN_CODE_ID_COUNTER_BITS = 12n;
const OPEN_CODE_ID_TIME_MASK = (1n << 48n) - 1n;
const OPEN_CODE_ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const INSTALL_COMMAND = "npm i -g opencode-ai@1.18.5";
const AUTHENTICATION_HELP =
  "Set MOONSHOT_API_KEY or run opencode auth login --provider moonshotai.";
/**
 * Message roles outlive an individual run, but a persistent session can
 * produce indefinitely many messages. FIFO eviction bounds that bookkeeping;
 * the live run's authoritative user message is pinned separately.
 */
export const OPEN_CODE_MESSAGE_ROLE_LIMIT = 1_024;

type OpenCodeRunError = NonNullable<
  EventSessionError["properties"]["error"]
>;

interface OpenCodeToolState {
  readonly name: string;
  phase: ToolState["status"];
}

interface OpenCodeReadinessClient {
  readonly session: {
    status(options: { readonly throwOnError: true }): Promise<unknown>;
  };
}

interface OpenCodeRunQueueOptions {
  readonly isRunActive: () => boolean;
  readonly startRun: (text: string) => Promise<unknown>;
  readonly emit: (event: SubagentEvent) => void;
}

let cachedOpenCodeBinary: string | null | undefined;

function randomOpenCodeIdSuffix() {
  const bytes = randomBytes(OPEN_CODE_ID_RANDOM_LENGTH);
  let suffix = "";
  for (const byte of bytes) {
    suffix += OPEN_CODE_ID_ALPHABET[byte % OPEN_CODE_ID_ALPHABET.length];
  }
  return suffix;
}

/**
 * Create authoritative user message IDs in OpenCode's ascending ID format.
 *
 * OpenCode 1.18.5's `MessageV2.latest` compares IDs lexicographically and its
 * `MessageID.ascending()` emits `msg_`, 12 ordered hex digits, then 14 base62
 * digits. The logical ordinal advances through same-millisecond calls and
 * clock rollback so every ID from one persistent session sorts after the last.
 */
export function createOpenCodeMessageIdGenerator(
  now: () => number = Date.now,
) {
  let lastOrdinal = -1n;

  return () => {
    const timestampMs = Math.max(0, Math.trunc(now()));
    const timestampBase =
      (BigInt(timestampMs) << OPEN_CODE_ID_COUNTER_BITS) &
      OPEN_CODE_ID_TIME_MASK;
    const ordinal =
      timestampBase > lastOrdinal
        ? timestampBase + 1n
        : lastOrdinal + 1n;
    lastOrdinal = ordinal;
    const orderedHex = ordinal.toString(16).padStart(12, "0");
    return `msg_${orderedHex}${randomOpenCodeIdSuffix()}`;
  };
}

function executable(file: string) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the OpenCode executable once from PATH.
 * The explicit path preserves deterministic preflight and process ownership
 * without mutating process-wide environment state between delegates.
 */
export function resolveOpenCodeBinary() {
  if (cachedOpenCodeBinary !== undefined)
    return cachedOpenCodeBinary ?? undefined;

  const names =
    process.platform === "win32"
      ? ["opencode.exe", "opencode.cmd"]
      : ["opencode"];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (executable(candidate)) {
        cachedOpenCodeBinary = candidate;
        return candidate;
      }
    }
  }

  cachedOpenCodeBinary = null;
  return undefined;
}

/**
 * Return the fallback-friendly preflight rejection for a missing OpenCode binary.
 * The explicit argument keeps the no-binary path deterministic in protocol tests.
 */
export function openCodeBinaryPreflightError(
  binary: string | null | undefined = resolveOpenCodeBinary(),
) {
  return binary
    ? undefined
    : new BackendPreflightRejectedError({
        message: `OpenCode executable was not found. Install it with: ${INSTALL_COMMAND}`,
      });
}

/** Reserve and release a loopback TCP port for an explicitly addressed server. */
export function selectOpenCodeServerPort() {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(
          new Error("OpenCode port selection returned no numeric TCP port."),
        );
        return;
      }
      const { port } = address;
      probe.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

interface OpenCodeReadinessOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Poll the generated client's cheap status call until the owned server responds.
 * Startup-banner parsing is intentionally absent because the explicit port is
 * already known and banners are not a protocol contract.
 */
export async function waitForOpenCodeServerReady(
  client: OpenCodeReadinessClient,
  options: OpenCodeReadinessOptions = {},
) {
  const timeoutMs = options.timeoutMs ?? SERVER_START_TIMEOUT_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? SERVER_READINESS_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    if (options.signal?.aborted) {
      throw new SpawnError({
        message: "OpenCode server stopped before it became ready.",
      });
    }
    const probeTimeoutMs = Math.max(1, deadline - Date.now());
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    let abortProbe: (() => void) | undefined;
    try {
      await Promise.race([
        client.session.status({ throwOnError: true }),
        new Promise<never>((_, reject) => {
          probeTimer = setTimeout(
            () =>
              reject(
                new Error(
                  `OpenCode readiness probe exceeded ${timeoutMs}ms startup deadline.`,
                ),
              ),
            probeTimeoutMs,
          );
          abortProbe = () =>
            reject(
              new Error("OpenCode server stopped during readiness polling."),
            );
          options.signal?.addEventListener("abort", abortProbe, {
            once: true,
          });
        }),
      ]);
      return;
    } catch (error) {
      lastError = error;
    } finally {
      if (probeTimer) clearTimeout(probeTimer);
      if (abortProbe)
        options.signal?.removeEventListener("abort", abortProbe);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(
        finish,
        Math.min(Math.max(1, pollIntervalMs), remainingMs),
      );
      options.signal?.addEventListener("abort", finish, { once: true });
    });
  }

  throw new SpawnError({
    message: `OpenCode server did not become ready within ${timeoutMs}ms: ${boundedError(
      lastError ?? "no readiness response",
    )}`,
  });
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    4096,
  );
}

/**
 * Flatten an OpenCode tool value into one bounded preview line.
 * The optional bound exists for protocol tests; production uses 1,024 chars.
 */
export function boundedOpenCodePreview(
  value: unknown,
  maxLength = PREVIEW_MAX_LENGTH,
) {
  const text = typeof value === "string" ? value : safeJson(value);
  if (!text) return undefined;
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened ? flattened.slice(0, Math.max(0, maxLength)) : undefined;
}

function openCodeRunErrorText(error: OpenCodeRunError | undefined) {
  if (!error) return "OpenCode run failed";

  switch (error.name) {
    case "ProviderAuthError":
      return `OpenCode provider "${error.data.providerID}" authentication failed: ${error.data.message}. ${AUTHENTICATION_HELP}`;
    case "UnknownError":
    case "MessageAbortedError":
      return error.data.message;
    case "MessageOutputLengthError":
      return "OpenCode model output exceeded its configured length limit.";
    case "APIError": {
      const status = error.data.statusCode
        ? ` (HTTP ${error.data.statusCode})`
        : "";
      const message = `OpenCode provider request failed${status}: ${error.data.message}`;
      return error.data.statusCode === 401 ||
        error.data.statusCode === 403 ||
        /unauth|authentication|api[ _-]?key|credential|forbidden/i.test(
          error.data.message,
        )
        ? `${message}. ${AUTHENTICATION_HELP}`
        : message;
    }
  }
}

function actionableOpenCodeTransportError(error: unknown) {
  const message = boundedError(error);
  return /unauth|authentication|api[ _-]?key|credential|forbidden|401|403/i.test(
    message,
  )
    ? `OpenCode provider authentication failed: ${message}. ${AUTHENTICATION_HELP}`
    : message;
}

function openCodeSpawnError(error: unknown) {
  const message = actionableOpenCodeTransportError(error);
  if (
    /(?:^|\s)(?:ENOENT|opencode.*not found|spawn opencode)/i.test(message)
  ) {
    return new BackendPreflightRejectedError({
      message: `OpenCode executable was not found. Install it with: ${INSTALL_COMMAND}`,
    });
  }
  return /unauth|authentication|api[ _-]?key|credential|forbidden|401|403/i.test(
    message,
  )
    ? new BackendPreflightRejectedError({ message })
    : new SpawnError({ message });
}

function parseOpenCodeModel(model: string | undefined) {
  if (!model) return undefined;
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return undefined;
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

function assistantTokenTotal(message: AssistantMessage) {
  return (
    message.tokens.input +
    message.tokens.output +
    message.tokens.reasoning +
    message.tokens.cache.read +
    message.tokens.cache.write
  );
}

/**
 * Queue follow-up prompts until the current OpenCode run settles.
 *
 * OpenCode 1.18.5's SessionRunState.ensureRunning returns the existing run
 * after promptAsync appends a message, so an active run can go idle without
 * processing that appended prompt. This queue starts it as a distinct run.
 */
export function createOpenCodeRunQueue(options: OpenCodeRunQueueOptions) {
  const pendingPrompts: string[] = [];

  const queuedView = () =>
    pendingPrompts.map((text) => ({
      text,
      kind: "follow-up" as const,
    }));

  const startNextQueued = () => {
    if (options.isRunActive()) return;
    const next = pendingPrompts.shift();
    if (next === undefined) return;
    options.emit({ _tag: "QueueChanged", queued: queuedView() });
    void options.startRun(next);
  };

  return {
    send: (text: string) => {
      if (options.isRunActive()) {
        pendingPrompts.push(text);
        options.emit({ _tag: "QueueChanged", queued: queuedView() });
        return;
      }
      void options.startRun(text);
    },
    handleRunSettled: () => queueMicrotask(startNextQueued),
    clear: () => {
      pendingPrompts.splice(0);
      options.emit({ _tag: "QueueChanged", queued: [] });
    },
  };
}

/**
 * Translate typed OpenCode v1 events into normalized subagent events.
 *
 * The root SDK v1 surface is deliberate: it is the stable export used by
 * `createOpencodeClient`, and its `Event` union directly describes `/event`.
 * The v2 surface adds workspace-aware and `session.next.*` event families
 * whose lifecycle is broader than this one-session backend requires.
 */
export function createOpenCodeEventTranslator(sessionId: string) {
  const textParts = new Map<
    string,
    {
      readonly messageId: string;
      readonly text: string;
      readonly emittedText: string;
    }
  >();
  const messageRoles = new Map<string, "user" | "assistant">();
  const tools = new Map<string, OpenCodeToolState>();
  let activeRun = false;
  let activeUserMessageId: string | undefined;
  let interruptRequested = false;
  let runError: string | undefined;
  let lastFinalizedAssistantText: string | undefined;

  const textForMessageRole = (role: "assistant" | undefined) =>
    [...textParts.values()]
      .filter((part) => messageRoles.get(part.messageId) === role)
      .map((part) => part.text)
      .join("");

  const finalText = () => {
    // Settlement is deliberately two-tiered: known assistant text wins, and
    // unknown-role text is a fallback only when that tier is empty. Known user
    // text is never eligible. Buffering unknown parts until their role arrives
    // preserves every confirmed assistant byte; if no role arrives, the
    // fallback preserves possibly genuine output rather than truncating it.
    const knownAssistantText = textForMessageRole("assistant");
    return knownAssistantText || textForMessageRole(undefined);
  };

  const rememberMessageRole = (
    messageId: string,
    role: "user" | "assistant",
  ) => {
    const authoritativeRole =
      messageId === activeUserMessageId ? "user" : role;
    if (!messageRoles.has(messageId)) {
      if (messageRoles.size >= OPEN_CODE_MESSAGE_ROLE_LIMIT) {
        let oldestEvictableMessageId: string | undefined;
        for (const trackedMessageId of messageRoles.keys()) {
          if (trackedMessageId === activeUserMessageId) continue;
          oldestEvictableMessageId = trackedMessageId;
          break;
        }
        if (oldestEvictableMessageId !== undefined) {
          messageRoles.delete(oldestEvictableMessageId);
        }
      }
    }
    messageRoles.set(messageId, authoritativeRole);
  };

  const finalizedAssistantMessage = (text: string): SubagentEvent => {
    lastFinalizedAssistantText = text;
    return {
      _tag: "AssistantMessage",
      parts: [{ type: "text", text }],
    };
  };

  const purgeMessageText = (messageId: string) => {
    let removed = false;
    let removedEmittedText = false;
    for (const [partId, part] of textParts) {
      if (part.messageId !== messageId) continue;
      textParts.delete(partId);
      removed = true;
      removedEmittedText ||= Boolean(part.emittedText);
    }
    if (!removed) return [];
    if (!activeRun) {
      return [
        {
          _tag: "BackendError",
          message:
            "OpenCode received a user-role correction after the run settled; the closed assistant transcript was not rewritten.",
        } satisfies SubagentEvent,
      ];
    }
    if (!removedEmittedText) return [];
    const text = finalText();
    return text === lastFinalizedAssistantText
      ? []
      : [finalizedAssistantMessage(text)];
  };

  const settleRun = (outcome: RunOutcome) => {
    if (!activeRun) return [] as SubagentEvent[];
    activeRun = false;
    interruptRequested = false;
    tools.clear();
    const text = finalText();
    const events: SubagentEvent[] = [];
    if (text && text !== lastFinalizedAssistantText) {
      events.push(finalizedAssistantMessage(text));
    }
    events.push({ _tag: "RunSettled", outcome });
    activeUserMessageId = undefined;
    return events;
  };

  const failedSettlement = (errorText: string) => {
    const text = finalText();
    return settleRun({
      _tag: "Failed",
      errorText,
      partialText: text || undefined,
    });
  };

  const beginRun = (text: string, userMessageId: string) => {
    if (activeRun) {
      return [{ _tag: "UserMessage", text }] satisfies SubagentEvent[];
    }
    activeRun = true;
    activeUserMessageId = userMessageId;
    interruptRequested = false;
    runError = undefined;
    lastFinalizedAssistantText = undefined;
    textParts.clear();
    tools.clear();
    // The prompt request supplies this ID, so its user role is authoritative
    // before SSE delivery begins. Other unknown roles stay buffered until
    // message.updated resolves them or settlement applies the fallback tier.
    rememberMessageRole(userMessageId, "user");
    return [
      { _tag: "UserMessage", text },
      { _tag: "RunStarted" },
    ] satisfies SubagentEvent[];
  };

  const updateText = (
    partId: string,
    messageId: string,
    fullText: string,
  ) => {
    const existing = textParts.get(partId);
    const previous = existing?.text ?? "";
    if (fullText === previous) return [] as SubagentEvent[];
    textParts.set(partId, {
      messageId,
      text: fullText,
      emittedText: existing?.emittedText ?? "",
    });
    if (messageRoles.get(messageId) !== "assistant") {
      // message.part.updated can race message.updated. Keep unknown text
      // buffered so a late user role cannot leak an irreversible delta; a
      // confirmed assistant role releases the buffer, and finalText retains
      // the unknown-only fallback so genuine output is not silently lost.
      return [];
    }

    const emittedText = existing?.emittedText ?? "";
    if (fullText.startsWith(emittedText)) {
      const missing = fullText.slice(emittedText.length);
      textParts.set(partId, {
        messageId,
        text: fullText,
        emittedText: fullText,
      });
      return missing
        ? [
            {
              _tag: "AssistantDelta",
              kind: "text",
              delta: missing,
            } satisfies SubagentEvent,
          ]
        : [];
    }

    // The normalized event model cannot retract a corrupt delta buffer, so a
    // full assistant message is the only lossless reconciliation operation.
    textParts.set(partId, {
      messageId,
      text: fullText,
      emittedText: fullText,
    });
    return [
      finalizedAssistantMessage(finalText()),
    ];
  };

  const releaseBufferedAssistantText = (messageId: string) => {
    const released: SubagentEvent[] = [];
    for (const [partId, part] of textParts) {
      if (part.messageId !== messageId || part.text === part.emittedText)
        continue;
      if (part.text.startsWith(part.emittedText)) {
        const missing = part.text.slice(part.emittedText.length);
        textParts.set(partId, {
          ...part,
          emittedText: part.text,
        });
        if (missing) {
          released.push({
            _tag: "AssistantDelta",
            kind: "text",
            delta: missing,
          });
        }
        continue;
      }
      textParts.set(partId, {
        ...part,
        emittedText: part.text,
      });
      released.push(finalizedAssistantMessage(finalText()));
    }
    return released;
  };

  const updateTool = (part: ToolPart) => {
    const { callID: callId, tool: name, state } = part;
    const existing = tools.get(callId);
    const events: SubagentEvent[] = [];
    if (!existing) {
      tools.set(callId, { name, phase: state.status });
      events.push({
        _tag: "ToolStart",
        toolId: callId,
        name,
        argsPreview: boundedOpenCodePreview(state.input),
      });
    } else if (existing.phase === state.status) {
      return events;
    } else {
      existing.phase = state.status;
    }

    switch (state.status) {
      case "pending":
        break;
      case "running":
        events.push({
          _tag: "ToolUpdate",
          toolId: callId,
          outputPreview: boundedOpenCodePreview(
            state.title ?? state.metadata,
          ),
        });
        break;
      case "completed": {
        const live = tools.get(callId);
        tools.delete(callId);
        events.push({
          _tag: "ToolEnd",
          toolId: callId,
          name: live?.name ?? name,
          isError: false,
          outputPreview: boundedOpenCodePreview(state.output),
        });
        break;
      }
      case "error": {
        const live = tools.get(callId);
        tools.delete(callId);
        events.push({
          _tag: "ToolEnd",
          toolId: callId,
          name: live?.name ?? name,
          isError: true,
          outputPreview: boundedOpenCodePreview(state.error),
        });
        break;
      }
    }
    return events;
  };

  const updateMessage = (
    event: EventMessageUpdated,
  ): SubagentEvent[] => {
    const { info } = event.properties;
    if (info.sessionID !== sessionId) return [];
    rememberMessageRole(info.id, info.role);

    const modelLabel =
      info.role === "assistant"
        ? `${info.providerID}/${info.modelID}`
        : `${info.model.providerID}/${info.model.modelID}`;
    const translated: SubagentEvent[] = [
      { _tag: "MetaChanged", meta: { modelLabel } },
    ];

    if (info.role === "user") {
      translated.push(...purgeMessageText(info.id));
    } else {
      translated.push({
        _tag: "UsageChanged",
        tokens: assistantTokenTotal(info),
      });
      if (activeRun) {
        translated.push(...releaseBufferedAssistantText(info.id));
      }
      if (info.error) {
        runError = openCodeRunErrorText(info.error);
        translated.push({ _tag: "BackendError", message: runError });
        translated.push(...failedSettlement(runError));
      }
    }

    return translated;
  };

  const translate = (event: Event): SubagentEvent[] => {
    switch (event.type) {
      case "message.part.updated": {
        const { part } = event.properties;
        if (part.sessionID !== sessionId) return [];
        if (!activeRun) return [];
        if (part.type === "text") {
          if (part.ignored) {
            const removed = textParts.get(part.id);
            if (!removed) return [];
            textParts.delete(part.id);
            if (!removed.emittedText) return [];
            const text = finalText();
            return text === lastFinalizedAssistantText
              ? []
              : [finalizedAssistantMessage(text)];
          }
          if (messageRoles.get(part.messageID) === "user") return [];
          return updateText(part.id, part.messageID, part.text);
        }
        if (part.type === "tool") return updateTool(part);
        return [];
      }
      case "message.updated":
        return updateMessage(event);
      case "session.error": {
        if (event.properties.sessionID !== sessionId) return [];
        runError = openCodeRunErrorText(event.properties.error);
        return [
          { _tag: "BackendError", message: runError },
          ...failedSettlement(runError),
        ];
      }
      case "session.status": {
        if (event.properties.sessionID !== sessionId) return [];
        if (event.properties.status.type !== "idle") return [];
        const text = finalText();
        return settleRun(
          interruptRequested
            ? { _tag: "Interrupted", partialText: text || undefined }
            : runError
              ? {
                  _tag: "Failed",
                  errorText: runError,
                  partialText: text || undefined,
                }
              : { _tag: "Completed", finalText: text },
        );
      }
      case "session.idle": {
        if (event.properties.sessionID !== sessionId) return [];
        const text = finalText();
        return settleRun(
          interruptRequested
            ? { _tag: "Interrupted", partialText: text || undefined }
            : runError
              ? {
                  _tag: "Failed",
                  errorText: runError,
                  partialText: text || undefined,
                }
              : { _tag: "Completed", finalText: text },
        );
      }
      default:
        return [];
    }
  };

  return {
    beginRun,
    translate,
    isRunActive: () => activeRun,
    requestInterrupt: () => {
      interruptRequested = true;
    },
    settleInterrupted: () => {
      const text = finalText();
      return settleRun({
        _tag: "Interrupted",
        partialText: text || undefined,
      });
    },
    failRun: (error: unknown) => {
      const errorText = actionableOpenCodeTransportError(error);
      return failedSettlement(errorText);
    },
    trackedMessageRoleCount: () => messageRoles.size,
  };
}

const makeOpenCodeSession = (
  task: SpawnTask,
): Effect.Effect<
  SubagentSession,
  SpawnError | BackendPreflightRejectedError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const binary = resolveOpenCodeBinary();
    const binaryError = openCodeBinaryPreflightError(binary);
    if (binaryError) return yield* binaryError;
    if (!binary) {
      return yield* new BackendPreflightRejectedError({
        message: `OpenCode executable was not found. Install it with: ${INSTALL_COMMAND}`,
      });
    }

    const model = parseOpenCodeModel(task.model);
    if (task.model && !model) {
      return yield* new BackendPreflightRejectedError({
        message: `OpenCode model "${task.model}" must use the provider/model-id form.`,
      });
    }

    const port = yield* Effect.tryPromise({
      try: selectOpenCodeServerPort,
      catch: openCodeSpawnError,
    });
    const child = yield* Effect.try({
      try: () =>
        spawn(
          binary,
          [
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            String(port),
          ],
          {
            cwd: task.cwd,
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"],
            // A separate POSIX process group lets teardown signal OpenCode
            // and every tool subprocess it started.
            detached: process.platform !== "win32",
          },
        ),
      catch: openCodeSpawnError,
    });
    const client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      directory: task.cwd,
    });
    const startupAbort = new AbortController();
    const eventAbort = new AbortController();
    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const state = {
      closed: false,
      closing: false,
      exited: false,
      streamError: undefined as unknown,
      stderr: "",
      meta: {
        backend: "opencode",
        modelLabel: task.model,
      } satisfies SubagentMeta as SubagentMeta,
      interruptTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    let translator:
      | ReturnType<typeof createOpenCodeEventTranslator>
      | undefined;
    let runQueue: ReturnType<typeof createOpenCodeRunQueue> | undefined;

    const emit = (event: SubagentEvent) => {
      if (event._tag === "MetaChanged")
        state.meta = { ...state.meta, ...event.meta };
      Queue.offerUnsafe(events, event);
      if (event._tag === "RunSettled") runQueue?.handleRunSettled();
    };
    const emitAll = (translated: ReadonlyArray<SubagentEvent>) => {
      for (const event of translated) emit(event);
    };
    const closeServer = async () => {
      eventAbort.abort();
      startupAbort.abort();
      await terminateOpenCodeChild(child, () => state.exited);
    };
    const failSession = (detail: string) => {
      if (state.closed || state.closing) return;
      state.closed = true;
      runQueue?.clear();
      emit({ _tag: "BackendError", message: detail });
      if (translator) emitAll(translator.failRun(detail));
      void closeServer().finally(() => Queue.endUnsafe(events));
    };

    child.stdout.resume();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      state.stderr = `${state.stderr}${chunk}`.slice(-4096);
    });
    child.once("error", (error) => {
      startupAbort.abort();
      failSession(`OpenCode server failed: ${boundedError(error)}`);
    });
    child.once("exit", (code, signal) => {
      state.exited = true;
      startupAbort.abort();
      if (state.closed || state.closing) return;
      const suffix = boundedOpenCodePreview(state.stderr);
      failSession(
        `OpenCode server exited (${signal ?? `code ${code ?? "unknown"}`})${suffix ? `: ${suffix}` : ""}`,
      );
    });

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (state.closing) return;
        state.closing = true;
        if (state.interruptTimer) clearTimeout(state.interruptTimer);
        if (translator?.isRunActive())
          emitAll(translator.settleInterrupted());
        state.closed = true;
        await closeServer();
        Queue.endUnsafe(events);
      }),
    );

    yield* Effect.tryPromise({
      try: () =>
        waitForOpenCodeServerReady(client, {
          timeoutMs: SERVER_START_TIMEOUT_MS,
          pollIntervalMs: SERVER_READINESS_POLL_MS,
          signal: startupAbort.signal,
        }),
      catch: openCodeSpawnError,
    });

    if (model?.providerID === "moonshotai") {
      const providers = yield* Effect.tryPromise({
        try: () => client.provider.list({ throwOnError: true }),
        catch: openCodeSpawnError,
      });
      if (!providers.data.connected.includes("moonshotai")) {
        return yield* new BackendPreflightRejectedError({
          message: `OpenCode provider "moonshotai" is not authenticated. ${AUTHENTICATION_HELP}`,
        });
      }
    }

    const created = yield* Effect.tryPromise({
      try: () =>
        client.session.create({
          body: { title: task.title },
          throwOnError: true,
        }),
      catch: openCodeSpawnError,
    });
    const nativeSessionId = created.data.id;
    translator = createOpenCodeEventTranslator(nativeSessionId);
    const nextUserMessageId = createOpenCodeMessageIdGenerator();
    state.meta = {
      backend: "opencode",
      modelLabel: task.model,
      nativeSessionId,
    };
    emit({ _tag: "MetaChanged", meta: state.meta });

    const subscription = yield* Effect.tryPromise({
      try: () =>
        client.event.subscribe({
          signal: eventAbort.signal,
          sseMaxRetryAttempts: 1,
          onSseError: (error) => {
            state.streamError = error;
          },
        }),
      catch: openCodeSpawnError,
    });
    const eventIterator = subscription.stream[Symbol.asyncIterator]();

    // The SDK stream is lazy. Advancing it through the initial
    // `server.connected` event establishes the SSE subscription before the
    // first prompt is accepted, so an immediate text delta cannot be lost.
    const firstEvent = yield* Effect.tryPromise({
      try: async () => {
        const startupTimer = setTimeout(
          () => eventAbort.abort(),
          SERVER_START_TIMEOUT_MS,
        );
        try {
          return await eventIterator.next();
        } finally {
          clearTimeout(startupTimer);
        }
      },
      catch: openCodeSpawnError,
    });
    if (firstEvent.done) {
      return yield* openCodeSpawnError(
        state.streamError ?? "OpenCode event stream ended during startup.",
      );
    }
    emitAll(translator.translate(firstEvent.value));

    const pumpEvents = async () => {
      try {
        while (!state.closed) {
          const next = await eventIterator.next();
          if (next.done) break;
          emitAll(translator?.translate(next.value) ?? []);
        }
        if (!state.closed && !state.closing) {
          failSession(
            `OpenCode SDK event stream ended unexpectedly: ${actionableOpenCodeTransportError(
              state.streamError ?? "no stream error was reported",
            )}`,
          );
        }
      } catch (error) {
        if (state.closed || eventAbort.signal.aborted) return;
        failSession(
          `OpenCode SDK event stream failed: ${actionableOpenCodeTransportError(error)}`,
        );
      }
    };
    void pumpEvents();

    const postPrompt = async (text: string, userMessageId: string) => {
      await client.session.promptAsync({
        path: { id: nativeSessionId },
        body: {
          messageID: userMessageId,
          ...(model ? { model } : {}),
          parts: [{ type: "text", text }],
        },
        throwOnError: true,
      });
    };

    const startRun = async (text: string) => {
      if (state.closed || translator?.isRunActive()) return undefined;
      const userMessageId = nextUserMessageId();
      emitAll(translator.beginRun(text, userMessageId));
      try {
        await postPrompt(text, userMessageId);
        return undefined;
      } catch (error) {
        emitAll(translator.failRun(error));
        return error instanceof Error
          ? error
          : new Error(actionableOpenCodeTransportError(error));
      }
    };
    runQueue = createOpenCodeRunQueue({
      isRunActive: () => translator?.isRunActive() ?? false,
      startRun,
      emit,
    });

    const initialPromptError = yield* Effect.promise(() =>
      startRun(task.prompt),
    );
    if (initialPromptError) {
      return yield* openCodeSpawnError(initialPromptError);
    }

    return {
      meta: Effect.sync(() => state.meta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          if (state.closed || !translator || !runQueue) {
            return new SendError({
              message: "OpenCode subagent session is closed.",
            });
          }
          return Effect.sync(() => runQueue?.send(text));
        }),
      interrupt: Effect.promise(async () => {
        if (state.closed || !translator?.isRunActive()) return;
        runQueue?.clear();
        translator.requestInterrupt();

        const requestAbort = new AbortController();
        const requestTimer = setTimeout(
          () => requestAbort.abort(),
          INTERRUPT_FALLBACK_MS,
        );
        try {
          await client.session.abort({
            path: { id: nativeSessionId },
            signal: requestAbort.signal,
            throwOnError: true,
          });
        } catch (error) {
          emit({
            _tag: "BackendError",
            message: actionableOpenCodeTransportError(error),
          });
        } finally {
          clearTimeout(requestTimer);
        }

        if (state.interruptTimer) clearTimeout(state.interruptTimer);
        state.interruptTimer = setTimeout(() => {
          if (!translator?.isRunActive()) return;
          emitAll(translator.settleInterrupted());
          state.closed = true;
          void closeServer().finally(() => Queue.endUnsafe(events));
        }, INTERRUPT_FALLBACK_MS);
      }),
    } satisfies SubagentSession;
  });

/** Signal the OpenCode process group so tool descendants stop with the server. */
function killOpenCodeTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already be gone; fall through to the direct signal.
    }
  }
  child.kill(signal);
}

interface OpenCodeTerminationOptions {
  readonly forceKillAfterMs?: number;
  readonly killTree?: (
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ) => void;
}

/**
 * Give OpenCode a bounded graceful shutdown, then sweep its process group.
 * A leader exit triggers SIGKILL before resolution because descendants can
 * survive the leader while still holding authority to modify the workspace.
 */
export function terminateOpenCodeChild(
  child: ChildProcessWithoutNullStreams,
  exited: () => boolean,
  options: OpenCodeTerminationOptions = {},
) {
  const forceKillAfterMs =
    options.forceKillAfterMs ?? FORCE_KILL_AFTER_MS;
  const killTree = options.killTree ?? killOpenCodeTree;
  if (exited()) {
    killTree(child, "SIGKILL");
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let done = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let lastTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (lastTimer) clearTimeout(lastTimer);
      resolve();
    };
    const sweepDescendantsAndFinish = () => {
      if (done) return;
      killTree(child, "SIGKILL");
      finish();
    };
    child.once("exit", sweepDescendantsAndFinish);
    killTree(child, "SIGTERM");
    if (done) return;
    forceTimer = setTimeout(() => {
      killTree(child, "SIGKILL");
    }, forceKillAfterMs);
    lastTimer = setTimeout(
      sweepDescendantsAndFinish,
      forceKillAfterMs + 500,
    );
  });
}

/** OpenCode SDK backend with queued follow-ups and provider/model selection. */
export const opencodeBackend: SubagentBackend = {
  name: "opencode",
  capabilities: {
    // OpenCode 1.18.5's ensureRunning returns the existing run after
    // promptAsync appends a message, so that message may never be processed
    // when the current model step reaches idle. Follow-ups are queued instead.
    steering: false,
    modelSelection: true,
    // OpenCode treats reasoning effort as part of provider/model selection.
    reasoningEffort: false,
  },
  available: Effect.sync(() => resolveOpenCodeBinary() !== undefined),
  spawn: makeOpenCodeSession,
};
