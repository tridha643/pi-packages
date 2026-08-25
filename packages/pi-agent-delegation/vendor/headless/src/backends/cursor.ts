/**
 * Cursor backend — one long-lived SDK agent per scoped subagent session.
 *
 * Cursor's SDK owns conversation continuity and local tool execution. This
 * adapter owns explicit JSONL persistence, normalized event translation, and
 * the lifecycle rule that every accepted run settles exactly once.
 */

import * as path from "node:path";
import type {
  InteractionUpdate,
  ModelSelection,
  Run,
  RunResult,
  TokenUsage,
  ToolCall,
} from "@cursor/sdk";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import { loadCursorSdk } from "./cursor-ripgrep.ts";
import type {
  ReasoningEffort,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  TranscriptPart,
} from "../domain.ts";
import {
  BackendPreflightRejectedError,
  SendError,
  SpawnError,
} from "../domain.ts";

const DEFAULT_CURSOR_MODEL = "composer-2.5";
const INTERRUPT_TIMEOUT_MS = 2_000;
const DISPOSE_TIMEOUT_MS = 2_000;
const CURSOR_STORE_DIRECTORY = "pi-agent-delegation-jsonl";

type CursorSdkModule = Awaited<ReturnType<typeof loadCursorSdk>>;

/** Cursor argument and result previews are bounded before entering the UI. */
export const CURSOR_PREVIEW_MAX_LENGTH = 1_024;

/** Mutable buffers and live tool identity for one Cursor SDK run. */
export interface CursorSdkTranslationState {
  assistantText: string;
  thinkingText: string;
  readonly activeTools: Map<string, ToolCall>;
}

/**
 * Cursor's `ShellOutputDeltaUpdate` carries no `callId`, so shell output can
 * only be attributed when exactly one shell call is live. Deriving that from
 * the live tool map rather than tracking the most recently started shell keeps
 * two failure modes out of the transcript: output from one concurrent shell
 * being shown under another, and a completed shell clearing an identifier that
 * a still-running shell depends on. When the attribution is ambiguous the
 * output is dropped, because a bounded gap in a live preview is recoverable
 * and a confident misattribution is not. Terminal `ToolEnd` results carry
 * their own `callId` and stay exact either way.
 */
export function soleActiveShellToolId(
  state: CursorSdkTranslationState,
): string | undefined {
  let onlyShellToolId: string | undefined;
  for (const [callId, toolCall] of state.activeTools) {
    if (toolCall.type !== "shell") continue;
    if (onlyShellToolId !== undefined) return undefined;
    onlyShellToolId = callId;
  }
  return onlyShellToolId;
}

function boundedCursorError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    4_096,
  );
}

/** Flatten and bound a Cursor tool preview to one UI-safe line. */
export function cursorPreview(
  value: unknown,
  maxLength = CURSOR_PREVIEW_MAX_LENGTH,
) {
  let text: string | undefined;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  if (text === undefined) return undefined;
  return text
    .replace(/\r\n?|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(0, maxLength));
}

/** Create isolated translation state for one accepted Cursor SDK run. */
export function createCursorSdkTranslationState(): CursorSdkTranslationState {
  return {
    assistantText: "",
    thinkingText: "",
    activeTools: new Map(),
  };
}

function cursorToolResultIsError(toolCall: ToolCall) {
  const result = toolCall.result;
  if (!result) return false;
  if (result.status === "error") return true;
  return (
    "isError" in result.value &&
    result.value.isError === true
  );
}

function cursorToolOutput(toolCall: ToolCall) {
  const result = toolCall.result;
  if (!result) return undefined;
  return result.status === "success" ? result.value : result.error;
}

function cursorUsageEvent(usage: TokenUsage): SubagentEvent {
  return { _tag: "UsageChanged", tokens: usage.totalTokens };
}

/**
 * Translate one typed Cursor interaction update into normalized activity.
 *
 * `onDelta` is deliberate here: unlike `run.stream()`, it retains the typed
 * ToolCall union and incremental tool updates. `run.wait()` remains the sole
 * terminal source, so callback activity can never produce a second settlement.
 */
export function translateCursorInteractionUpdate(
  state: CursorSdkTranslationState,
  update: InteractionUpdate,
): ReadonlyArray<SubagentEvent> {
  switch (update.type) {
    case "text-delta":
      state.assistantText += update.text;
      return [
        { _tag: "AssistantDelta", kind: "text", delta: update.text },
      ];

    case "thinking-delta":
      state.thinkingText += update.text;
      return [
        { _tag: "AssistantDelta", kind: "thinking", delta: update.text },
      ];

    case "thinking-completed":
      // The SDK completion signal contains duration only. The normalized
      // protocol has no thinking-completed event, so preserve it as an empty
      // thinking delta without inventing text or leaking it into final output.
      return [{ _tag: "AssistantDelta", kind: "thinking", delta: "" }];

    case "tool-call-started": {
      state.activeTools.set(update.callId, update.toolCall);
      return [
        {
          _tag: "ToolStart",
          toolId: update.callId,
          name: update.toolCall.type,
          argsPreview: cursorPreview(update.toolCall.args),
        },
      ];
    }

    case "partial-tool-call":
      state.activeTools.set(update.callId, update.toolCall);
      return [
        {
          _tag: "ToolUpdate",
          toolId: update.callId,
          outputPreview: cursorPreview(update.toolCall.args),
        },
      ];

    case "tool-call-delta":
      return [
        {
          _tag: "ToolUpdate",
          toolId: update.callId,
          outputPreview: cursorPreview(update.taskUpdate),
        },
      ];

    case "shell-output-delta": {
      const toolId = soleActiveShellToolId(state);
      return toolId
        ? [
            {
              _tag: "ToolUpdate",
              toolId,
              outputPreview: cursorPreview(update.event),
            },
          ]
        : [];
    }

    case "tool-call-completed": {
      state.activeTools.delete(update.callId);
      return [
        {
          _tag: "ToolEnd",
          toolId: update.callId,
          name: update.toolCall.type,
          isError: cursorToolResultIsError(update.toolCall),
          outputPreview: cursorPreview(cursorToolOutput(update.toolCall)),
        },
      ];
    }

    case "token-delta":
      return [{ _tag: "UsageChanged", tokens: update.tokens }];

    case "user-message-appended":
    case "summary":
    case "summary-started":
    case "summary-completed":
    case "step-started":
    case "step-completed":
    case "turn-ended":
      return [];

    default:
      // Forward-compatible: a newer SDK update must not crash an active run.
      return [];
  }
}

function cursorAssistantParts(
  state: CursorSdkTranslationState,
  finalText: string,
): ReadonlyArray<TranscriptPart> {
  const parts: TranscriptPart[] = [];
  if (state.thinkingText) {
    parts.push({ type: "thinking", text: state.thinkingText });
  }
  if (finalText) parts.push({ type: "text", text: finalText });
  return parts;
}

/**
 * Translate one terminal SDK result, always producing exactly one RunSettled.
 */
export function translateCursorRunResult(
  state: CursorSdkTranslationState,
  result: RunResult,
): ReadonlyArray<SubagentEvent> {
  const finalText = result.result ?? state.assistantText;
  const events: SubagentEvent[] = [];
  if (result.usage) events.push(cursorUsageEvent(result.usage));

  const parts = cursorAssistantParts(state, finalText);
  if (parts.length > 0) {
    events.push({ _tag: "AssistantMessage", parts });
  }

  if (result.status === "finished") {
    events.push({
      _tag: "RunSettled",
      outcome: { _tag: "Completed", finalText },
    });
  } else if (result.status === "cancelled") {
    events.push({
      _tag: "RunSettled",
      outcome: {
        _tag: "Interrupted",
        ...(finalText ? { partialText: finalText } : {}),
      },
    });
  } else {
    events.push({
      _tag: "RunSettled",
      outcome: {
        _tag: "Failed",
        errorText:
          result.error?.message ??
          result.result ??
          "Cursor SDK run ended with an error.",
        ...(finalText ? { partialText: finalText } : {}),
      },
    });
  }
  return events;
}

function cursorModelLabel(model: ModelSelection | undefined) {
  return model?.id;
}

/** Select a canonical Cursor model with fast mode and supported reasoning parameters. */
export function selectCursorModel(
  modelId: string | undefined,
  reasoningEffort: ReasoningEffort | undefined,
): ModelSelection {
  const id = modelId ?? DEFAULT_CURSOR_MODEL;
  if (id === "grok-4.5") {
    const effort = (() => {
      switch (reasoningEffort) {
        case "off":
        case "minimal":
        case "low":
          return "low";
        case "medium":
          return "medium";
        case "high":
        case "xhigh":
        case "max":
        case undefined:
          return "high";
      }
    })();
    return {
      id,
      params: [
        { id: "effort", value: effort },
        { id: "fast", value: "true" },
      ],
    };
  }
  if (id === "composer-2.5") {
    return { id, params: [{ id: "fast", value: "true" }] };
  }
  return { id };
}

function cursorApiKey() {
  const value = process.env.CURSOR_API_KEY?.trim();
  return value || undefined;
}

/** Return the actionable fallback-safe rejection for a missing Cursor API key. */
export function cursorMissingApiKeyRejection() {
  return new BackendPreflightRejectedError({
    message:
      'Cursor SDK authentication requires CURSOR_API_KEY. Run "cursor-agent login" to access Cursor, then create and export a Cursor API key.',
  });
}

function cursorSdkPreflightRejection(
  cursorSdk: CursorSdkModule,
  error: unknown,
) {
  if (
    error instanceof cursorSdk.AuthenticationError ||
    error instanceof cursorSdk.ConfigurationError
  ) {
    return new BackendPreflightRejectedError({
      message: `Cursor SDK preflight rejected the session: ${boundedCursorError(error)}. Verify the requested model and CURSOR_API_KEY; run "cursor-agent login" if the account needs authentication.`,
    });
  }
  return undefined;
}

function cursorSendError(
  cursorSdk: CursorSdkModule,
  error: unknown,
) {
  if (error instanceof cursorSdk.AgentBusyError) {
    return new SendError({
      message:
        "Cursor SDK rejected the message because this agent already has an active run.",
    });
  }
  if (
    error instanceof cursorSdk.AuthenticationError ||
    error instanceof cursorSdk.ConfigurationError
  ) {
    return new SendError({
      message: `Cursor SDK rejected the message: ${boundedCursorError(error)}. Verify CURSOR_API_KEY and the requested model.`,
    });
  }
  if (error instanceof cursorSdk.RateLimitError) {
    return new SendError({
      message: `Cursor SDK rate limit: ${boundedCursorError(error)}`,
    });
  }
  if (error instanceof cursorSdk.NetworkError) {
    return new SendError({
      message: `Cursor SDK network failure: ${boundedCursorError(error)}`,
    });
  }
  return new SendError({
    message: `Cursor SDK failed to send the message: ${boundedCursorError(error)}`,
  });
}

function cursorSpawnError(
  cursorSdk: CursorSdkModule,
  error: unknown,
) {
  const preflight = cursorSdkPreflightRejection(cursorSdk, error);
  return (
    preflight ??
    new SpawnError({
      message: `Cursor SDK failed to start the session: ${boundedCursorError(error)}`,
    })
  );
}

interface BoundedOperationResult {
  readonly timedOut: boolean;
  readonly error?: unknown;
}

async function waitForCursorOperation(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<BoundedOperationResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedOperationResult>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const completed = operation.then(
    () => ({ timedOut: false }) satisfies BoundedOperationResult,
    (error) => ({ timedOut: false, error }) satisfies BoundedOperationResult,
  );
  return Promise.race([completed, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

let cachedCursorAvailability: boolean | undefined;

function probeCursorAvailability() {
  if (cachedCursorAvailability === undefined) {
    // Local Agent.create still authenticates its backend connection. A Pi
    // auth.json Cursor OAuth token is not a Cursor API key and is not read.
    cachedCursorAvailability = cursorApiKey() !== undefined;
  }
  return cachedCursorAvailability;
}

const makeCursorSession = (
  task: SpawnTask,
): Effect.Effect<
  SubagentSession,
  SpawnError | BackendPreflightRejectedError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const apiKey = cursorApiKey();
    if (!apiKey) return yield* cursorMissingApiKeyRejection();

    // The cached loader configures Cursor's process-wide ripgrep path before
    // the first SDK module evaluation, which is earlier than Agent.create.
    const cursorSdk = yield* Effect.promise(loadCursorSdk);

    const storeRoot = path.join(
      cursorSdk.getDefaultSdkStateRoot(task.cwd),
      CURSOR_STORE_DIRECTORY,
    );
    const store = new cursorSdk.JsonlLocalAgentStore(storeRoot);
    // The same explicit store is also passed to Agent.create. Configuring the
    // SDK prevents helper paths from silently selecting optional native SQLite.
    cursorSdk.configureCursorSdk({ local: { store } });

    const selectedModel = selectCursorModel(
      task.model,
      task.reasoningEffort,
    );

    const agent = yield* Effect.tryPromise({
      try: () =>
        cursorSdk.Agent.create({
          model: selectedModel,
          apiKey,
          name: task.title,
          local: { cwd: task.cwd, store },
        }),
      catch: (error) => cursorSpawnError(cursorSdk, error),
    });

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit = (event: SubagentEvent) => {
      Queue.offerUnsafe(events, event);
    };
    const state = {
      closed: false,
      closing: false,
      dispatching: false,
      activeRun: false,
      interruptRequested: false,
      runSerial: 0,
      currentRun: undefined as Run | undefined,
      translation: undefined as CursorSdkTranslationState | undefined,
      meta: {
        backend: "cursor",
        nativeSessionId: agent.agentId,
        modelLabel: cursorModelLabel(agent.model) ?? selectedModel.id,
      } satisfies SubagentMeta as SubagentMeta,
    };

    const updateMeta = (patch: Partial<SubagentMeta>) => {
      state.meta = { ...state.meta, ...patch };
      emit({ _tag: "MetaChanged", meta: patch });
    };

    const settleRun = (
      serial: number,
      result: RunResult,
      translation = state.translation,
    ) => {
      if (
        !state.activeRun ||
        serial !== state.runSerial ||
        !translation
      ) {
        return;
      }
      state.activeRun = false;
      state.interruptRequested = false;
      state.currentRun = undefined;
      for (const event of translateCursorRunResult(translation, result)) {
        emit(event);
      }
    };

    const failedRunResult = (
      run: Run,
      message: string,
    ): RunResult => ({
      id: run.id,
      requestId: run.requestId,
      status: "error",
      error: { message },
      model: run.model,
      usage: run.usage,
    });

    const cancelledRunResult = (run: Run): RunResult => ({
      id: run.id,
      requestId: run.requestId,
      status: "cancelled",
      result: run.result,
      model: run.model,
      usage: run.usage,
    });

    const monitorRun = async (
      run: Run,
      serial: number,
      translation: CursorSdkTranslationState,
    ) => {
      try {
        const result = await run.wait();
        const modelLabel = cursorModelLabel(
          result.model ?? run.model ?? agent.model,
        );
        if (modelLabel && modelLabel !== state.meta.modelLabel) {
          updateMeta({ modelLabel });
        }
        settleRun(
          serial,
          state.interruptRequested
            ? { ...result, status: "cancelled" }
            : result,
          translation,
        );
      } catch (error) {
        settleRun(
          serial,
          failedRunResult(run, boundedCursorError(error)),
          translation,
        );
      }
    };

    const submitRun = async (text: string) => {
      // `closing` is set before the finalizer awaits run.cancel(), and `closed`
      // only after. Checking `closed` alone leaves a window where a racing
      // continuation is accepted, emits RunStarted, and is then abandoned by a
      // finalizer that has already settled everything it knew about.
      if (state.closing || state.closed) {
        throw new SendError({ message: "Cursor SDK session is closing." });
      }
      if (state.dispatching || state.activeRun) {
        throw new cursorSdk.AgentBusyError(
          "Cursor SDK agent already has an active run.",
        );
      }

      state.dispatching = true;
      const serial = ++state.runSerial;
      const translation = createCursorSdkTranslationState();
      const bufferedEvents: SubagentEvent[] = [];
      try {
        const run = await agent.send(text, {
          // The SDK awaits these callbacks while applying interaction updates.
          // Buffering until send() accepts the run prevents rejected sends from
          // exposing a RunStarted that can never receive a native Run handle.
          onDelta: ({ update }) => {
            const translated = translateCursorInteractionUpdate(
              translation,
              update,
            );
            if (state.activeRun && serial === state.runSerial) {
              for (const event of translated) emit(event);
            } else {
              bufferedEvents.push(...translated);
            }
          },
        });

        if (state.closing || state.closed) {
          void run.cancel();
          throw new SendError({
            message: "Cursor SDK session closed while accepting the run.",
          });
        }
        state.currentRun = run;
        state.translation = translation;
        state.activeRun = true;
        state.interruptRequested = false;
        emit({ _tag: "UserMessage", text });
        emit({ _tag: "RunStarted" });
        for (const event of bufferedEvents) emit(event);

        const modelLabel = cursorModelLabel(run.model ?? agent.model);
        if (modelLabel && modelLabel !== state.meta.modelLabel) {
          updateMeta({ modelLabel });
        }
        void monitorRun(run, serial, translation);
      } finally {
        state.dispatching = false;
      }
    };

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (state.closing) return;
        state.closing = true;
        const run = state.currentRun;
        if (state.activeRun && run) {
          settleRun(
            state.runSerial,
            cancelledRunResult(run),
            state.translation,
          );
          await waitForCursorOperation(run.cancel(), INTERRUPT_TIMEOUT_MS);
        }
        state.closed = true;
        // `SDKAgent.close()` is void: it starts the executor-lease release
        // without awaiting it and clears the stored lease, so calling it first
        // leaves `asyncDispose` with nothing left to await and teardown returns
        // while native resources are still releasing. Await disposal alone, so
        // the events stream never ends before the lease is actually gone.
        const disposal = await waitForCursorOperation(
          agent[Symbol.asyncDispose](),
          DISPOSE_TIMEOUT_MS,
        );
        // The SDK exposes no hard-termination handle for an in-process
        // executor, so a failed or timed-out disposal cannot be escalated the
        // way a child process can be killed. Ending the stream anyway keeps
        // scope close bounded, but the condition must be visible rather than
        // swallowed, because native work may still be running.
        if (disposal.error || disposal.timedOut) {
          emit({
            _tag: "BackendError",
            message: disposal.timedOut
              ? `Cursor SDK disposal timed out after ${DISPOSE_TIMEOUT_MS}ms; the executor lease may still be releasing.`
              : `Cursor SDK disposal failed: ${boundedCursorError(disposal.error)}`,
          });
        }
        Queue.endUnsafe(events);
      }),
    );

    emit({ _tag: "MetaChanged", meta: state.meta });
    const initialStart = yield* Effect.tryPromise({
      try: () => submitRun(task.prompt),
      catch: (error) => cursorSpawnError(cursorSdk, error),
    });
    void initialStart;

    return {
      meta: Effect.sync(() => state.meta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.tryPromise({
          try: () => submitRun(text),
          catch: (error) => cursorSendError(cursorSdk, error),
        }),
      interrupt: Effect.promise(async () => {
        if (state.closed || !state.activeRun) return;
        const run = state.currentRun;
        const serial = state.runSerial;
        state.interruptRequested = true;
        if (!run) return;

        const cancellation = await waitForCursorOperation(
          run.cancel(),
          INTERRUPT_TIMEOUT_MS,
        );
        if (cancellation.error) {
          emit({
            _tag: "BackendError",
            message: `Cursor SDK cancel failed: ${boundedCursorError(cancellation.error)}`,
          });
        } else if (cancellation.timedOut) {
          emit({
            _tag: "BackendError",
            message: `Cursor SDK cancel timed out after ${INTERRUPT_TIMEOUT_MS}ms.`,
          });
        }
        settleRun(serial, cancelledRunResult(run), state.translation);

        if (cancellation.error || cancellation.timedOut) {
          // A missing cancellation acknowledgement means native work may still
          // be running. Dispose this SDK agent so the manager cannot report an
          // idle reusable session while an unobserved run remains live. Await
          // disposal rather than calling the void `close()`, so the stream does
          // not end while the executor lease is still releasing.
          state.closed = true;
          const disposal = await waitForCursorOperation(
            agent[Symbol.asyncDispose](),
            DISPOSE_TIMEOUT_MS,
          );
          if (disposal.error || disposal.timedOut) {
            emit({
              _tag: "BackendError",
              message: disposal.timedOut
                ? `Cursor SDK disposal timed out after ${DISPOSE_TIMEOUT_MS}ms; the executor lease may still be releasing.`
                : `Cursor SDK disposal failed: ${boundedCursorError(disposal.error)}`,
            });
          }
          Queue.endUnsafe(events);
        }
      }),
    } satisfies SubagentSession;
  });

/** Cursor Agent SDK backend with idle-only follow-up runs. */
export const cursorBackend: SubagentBackend = {
  name: "cursor",
  capabilities: {
    steering: false,
    modelSelection: true,
    // grok-4.5 exposes reasoning effort as a model parameter; models without
    // that parameter retain their explicitly selected/default behavior.
    reasoningEffort: true,
  },
  available: Effect.sync(probeCursorAvailability),
  spawn: makeCursorSession,
};
