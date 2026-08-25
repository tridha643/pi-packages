import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute } from "node:path";
import test from "node:test";
import type {
  InteractionUpdate,
  ReadToolCall,
  RunResult,
  ShellToolCall,
  ToolCall,
} from "@cursor/sdk";
import { Effect, Result } from "effect";
import {
  createCursorSdkTranslationState,
  cursorBackend,
  cursorPreview,
  CURSOR_PREVIEW_MAX_LENGTH,
  selectCursorModel,
  translateCursorInteractionUpdate,
  translateCursorRunResult,
} from "./src/backends/cursor.ts";
import {
  configureCursorRipgrepPath,
  loadCursorSdk,
  resolveBundledCursorRipgrepPath,
} from "./src/backends/cursor-ripgrep.ts";
import {
  BackendPreflightRejectedError,
  type ReasoningEffort,
  type SpawnTask,
} from "./src/domain.ts";

test("Cursor grok-4.5 selection maps every reasoning effort and enables fast mode", () => {
  const mappings: ReadonlyArray<
    readonly [ReasoningEffort | undefined, "low" | "medium" | "high"]
  > = [
    [undefined, "high"],
    ["off", "low"],
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "high"],
    ["max", "high"],
  ];

  for (const [reasoningEffort, expectedEffort] of mappings) {
    assert.deepEqual(selectCursorModel("grok-4.5", reasoningEffort), {
      id: "grok-4.5",
      params: [
        { id: "effort", value: expectedEffort },
        { id: "fast", value: "true" },
      ],
    });
  }
});

test("Cursor composer-2.5 selection enables fast mode without an effort parameter", () => {
  assert.deepEqual(selectCursorModel("composer-2.5", "max"), {
    id: "composer-2.5",
    params: [{ id: "fast", value: "true" }],
  });
  assert.deepEqual(selectCursorModel(undefined, "low"), {
    id: "composer-2.5",
    params: [{ id: "fast", value: "true" }],
  });
});

test("Cursor preserves unknown model IDs without guessed parameters", () => {
  assert.deepEqual(selectCursorModel("future-model", "high"), {
    id: "future-model",
  });
});

function readToolCall(
  result?: ReadToolCall["result"],
): ReadToolCall {
  return {
    type: "read",
    args: { path: "src/file.ts" },
    ...(result ? { result } : {}),
  };
}

function interaction(update: InteractionUpdate) {
  return update;
}

function shellToolCall(command: string): ShellToolCall {
  return { type: "shell", args: { command } };
}

function startShell(
  state: ReturnType<typeof createCursorSdkTranslationState>,
  callId: string,
  command: string,
) {
  translateCursorInteractionUpdate(
    state,
    interaction({
      type: "tool-call-started",
      callId,
      toolCall: shellToolCall(command),
      modelCallId: `model-${callId}`,
    }),
  );
}

function shellOutput(
  state: ReturnType<typeof createCursorSdkTranslationState>,
  text: string,
) {
  return translateCursorInteractionUpdate(
    state,
    interaction({ type: "shell-output-delta", event: { text } }),
  );
}

function terminal(
  status: RunResult["status"],
  overrides: Partial<RunResult> = {},
): RunResult {
  return {
    id: "run-1",
    status,
    ...overrides,
  };
}

test("Cursor text deltas accumulate into one finalized assistant message", () => {
  const state = createCursorSdkTranslationState();
  const first = translateCursorInteractionUpdate(
    state,
    interaction({ type: "text-delta", text: "Hello " }),
  );
  const second = translateCursorInteractionUpdate(
    state,
    interaction({ type: "text-delta", text: "world" }),
  );

  assert.deepEqual([...first, ...second], [
    { _tag: "AssistantDelta", kind: "text", delta: "Hello " },
    { _tag: "AssistantDelta", kind: "text", delta: "world" },
  ]);
  assert.equal(state.assistantText, "Hello world");

  const settled = translateCursorRunResult(
    state,
    terminal("finished"),
  );
  assert.deepEqual(settled, [
    {
      _tag: "AssistantMessage",
      parts: [{ type: "text", text: "Hello world" }],
    },
    {
      _tag: "RunSettled",
      outcome: { _tag: "Completed", finalText: "Hello world" },
    },
  ]);
});

test("Cursor thinking deltas stay separate from assistant text", () => {
  const state = createCursorSdkTranslationState();
  const thinking = translateCursorInteractionUpdate(
    state,
    interaction({ type: "thinking-delta", text: "considering" }),
  );
  const completed = translateCursorInteractionUpdate(
    state,
    interaction({
      type: "thinking-completed",
      thinkingDurationMs: 25,
    }),
  );

  assert.deepEqual(thinking, [
    {
      _tag: "AssistantDelta",
      kind: "thinking",
      delta: "considering",
    },
  ]);
  assert.deepEqual(completed, [
    { _tag: "AssistantDelta", kind: "thinking", delta: "" },
  ]);
  assert.equal(state.thinkingText, "considering");
  assert.equal(state.assistantText, "");

  assert.deepEqual(
    translateCursorRunResult(
      state,
      terminal("finished", { result: "answer" }),
    )[0],
    {
      _tag: "AssistantMessage",
      parts: [
        { type: "thinking", text: "considering" },
        { type: "text", text: "answer" },
      ],
    },
  );
});

test("Cursor typed tool activity maps start, update, and completed events", () => {
  const state = createCursorSdkTranslationState();
  const startedTool: ToolCall = readToolCall();
  const completedTool: ToolCall = readToolCall({
    status: "success",
    value: { content: "source", totalLines: 1, fileSize: 6 },
  });

  const started = translateCursorInteractionUpdate(
    state,
    interaction({
      type: "tool-call-started",
      callId: "call-1",
      toolCall: startedTool,
      modelCallId: "model-call-1",
    }),
  );
  const updated = translateCursorInteractionUpdate(
    state,
    interaction({
      type: "tool-call-delta",
      callId: "call-1",
      modelCallId: "model-call-1",
      taskUpdate: { type: "text-delta", text: "reading" },
    }),
  );
  const completed = translateCursorInteractionUpdate(
    state,
    interaction({
      type: "tool-call-completed",
      callId: "call-1",
      toolCall: completedTool,
      modelCallId: "model-call-1",
    }),
  );

  assert.deepEqual(started, [
    {
      _tag: "ToolStart",
      toolId: "call-1",
      name: "read",
      argsPreview: '{"path":"src/file.ts"}',
    },
  ]);
  assert.deepEqual(updated, [
    {
      _tag: "ToolUpdate",
      toolId: "call-1",
      outputPreview: '{"type":"text-delta","text":"reading"}',
    },
  ]);
  assert.deepEqual(completed, [
    {
      _tag: "ToolEnd",
      toolId: "call-1",
      name: "read",
      isError: false,
      outputPreview:
        '{"content":"source","totalLines":1,"fileSize":6}',
    },
  ]);
});

test("Cursor failed typed tool results set isError", () => {
  const state = createCursorSdkTranslationState();
  const failedTool: ToolCall = readToolCall({
    status: "error",
    error: { message: "permission denied" },
  });
  const events = translateCursorInteractionUpdate(
    state,
    interaction({
      type: "tool-call-completed",
      callId: "call-2",
      toolCall: failedTool,
      modelCallId: "model-call-2",
    }),
  );

  assert.equal(events[0]?._tag, "ToolEnd");
  if (events[0]?._tag !== "ToolEnd") assert.fail("expected ToolEnd");
  assert.equal(events[0].name, "read");
  assert.equal(events[0].isError, true);
  assert.match(events[0].outputPreview ?? "", /permission denied/);
});

test("Cursor token updates and terminal usage map to UsageChanged", () => {
  const state = createCursorSdkTranslationState();
  assert.deepEqual(
    translateCursorInteractionUpdate(
      state,
      interaction({ type: "token-delta", tokens: 41 }),
    ),
    [{ _tag: "UsageChanged", tokens: 41 }],
  );

  assert.deepEqual(
    translateCursorRunResult(
      state,
      terminal("finished", {
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          totalTokens: 18,
        },
      }),
    )[0],
    { _tag: "UsageChanged", tokens: 18 },
  );
});

test("Cursor terminal statuses each produce exactly one correct settlement", () => {
  const cases: ReadonlyArray<{
    readonly result: RunResult;
    readonly expected: unknown;
  }> = [
    {
      result: terminal("finished", { result: "done" }),
      expected: { _tag: "Completed", finalText: "done" },
    },
    {
      result: terminal("error", {
        error: { message: "request failed", code: "failure" },
      }),
      expected: {
        _tag: "Failed",
        errorText: "request failed",
      },
    },
    {
      result: terminal("cancelled", { result: "partial" }),
      expected: { _tag: "Interrupted", partialText: "partial" },
    },
  ];

  for (const { result, expected } of cases) {
    const events = translateCursorRunResult(
      createCursorSdkTranslationState(),
      result,
    );
    const settlements = events.filter(
      (event) => event._tag === "RunSettled",
    );
    assert.equal(settlements.length, 1);
    assert.deepEqual(settlements[0], {
      _tag: "RunSettled",
      outcome: expected,
    });
  }
});

test("Cursor unrecognized interaction updates are no-ops", () => {
  const unknownUpdate = {
    type: "future-cursor-update",
    payload: "ignored",
  } as unknown as InteractionUpdate;
  assert.deepEqual(
    translateCursorInteractionUpdate(
      createCursorSdkTranslationState(),
      unknownUpdate,
    ),
    [],
  );
});

test("Cursor shell output is dropped rather than misattributed when ambiguous", () => {
  // ShellOutputDeltaUpdate carries no callId, so attribution is only safe while
  // exactly one shell call is live.
  const state = createCursorSdkTranslationState();

  assert.deepEqual(
    shellOutput(state, "orphan"),
    [],
    "output with no live shell has nothing to attach to",
  );

  startShell(state, "call-1", "sleep 1");
  assert.deepEqual(shellOutput(state, "from A"), [
    {
      _tag: "ToolUpdate",
      toolId: "call-1",
      outputPreview: '{"text":"from A"}',
    },
  ]);

  startShell(state, "call-2", "sleep 2");
  assert.deepEqual(
    shellOutput(state, "ambiguous"),
    [],
    "two live shells make attribution unsafe, so the delta is dropped",
  );

  translateCursorInteractionUpdate(
    state,
    interaction({
      type: "tool-call-completed",
      callId: "call-2",
      toolCall: shellToolCall("sleep 2"),
      modelCallId: "model-call-2",
    }),
  );

  // Regression: completing the most recently started shell must not strand the
  // shell that is still running.
  assert.deepEqual(shellOutput(state, "from A again"), [
    {
      _tag: "ToolUpdate",
      toolId: "call-1",
      outputPreview: '{"text":"from A again"}',
    },
  ]);

  translateCursorInteractionUpdate(
    state,
    interaction({
      type: "tool-call-completed",
      callId: "call-1",
      toolCall: shellToolCall("sleep 1"),
      modelCallId: "model-call-1",
    }),
  );
  assert.deepEqual(
    shellOutput(state, "after all shells ended"),
    [],
    "no live shell remains, so late output is dropped",
  );
});

test("Cursor shell output ignores non-shell tools when resolving attribution", () => {
  const state = createCursorSdkTranslationState();
  translateCursorInteractionUpdate(
    state,
    interaction({
      type: "tool-call-started",
      callId: "read-1",
      toolCall: readToolCall(),
      modelCallId: "model-read-1",
    }),
  );
  startShell(state, "call-1", "ls");

  assert.deepEqual(shellOutput(state, "listing"), [
    {
      _tag: "ToolUpdate",
      toolId: "call-1",
      outputPreview: '{"text":"listing"}',
    },
  ]);
});

test("Cursor configures its bundled ripgrep before local agent startup", () => {
  const environment: NodeJS.ProcessEnv = {};

  const resolvedPath = configureCursorRipgrepPath(environment);

  assert.equal(resolvedPath, resolveBundledCursorRipgrepPath());
  assert.ok(resolvedPath !== undefined);
  assert.ok(isAbsolute(resolvedPath));
  assert.ok(existsSync(resolvedPath));
  assert.equal(environment.CURSOR_RIPGREP_PATH, resolvedPath);
});

test("Cursor configures ripgrep before the first cached SDK evaluation", async () => {
  const sdkFixtureUrl = new URL(
    "data:text/javascript," +
      encodeURIComponent(`
        const ripgrepPathAtEvaluation = process.env.CURSOR_RIPGREP_PATH;
        if (!ripgrepPathAtEvaluation) {
          throw new Error("Cursor SDK fixture evaluated before ripgrep configuration");
        }
        export { ripgrepPathAtEvaluation };
      `),
  ).href;
  let sdkEvaluationCount = 0;
  const moduleHooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== "@cursor/sdk") {
        return nextResolve(specifier, context);
      }
      sdkEvaluationCount += 1;
      return { shortCircuit: true, url: sdkFixtureUrl };
    },
  });

  const originalRipgrepPath = process.env.CURSOR_RIPGREP_PATH;
  delete process.env.CURSOR_RIPGREP_PATH;
  try {
    const firstSdkModule = await loadCursorSdk();
    const secondSdkModule = await loadCursorSdk();
    const loadedFixture = firstSdkModule as unknown as {
      readonly ripgrepPathAtEvaluation: string;
    };

    assert.equal(firstSdkModule, secondSdkModule);
    assert.equal(sdkEvaluationCount, 1);
    assert.equal(
      loadedFixture.ripgrepPathAtEvaluation,
      process.env.CURSOR_RIPGREP_PATH,
    );
    assert.ok(isAbsolute(loadedFixture.ripgrepPathAtEvaluation));
    assert.ok(existsSync(loadedFixture.ripgrepPathAtEvaluation));
  } finally {
    moduleHooks.deregister();
    if (originalRipgrepPath === undefined) {
      delete process.env.CURSOR_RIPGREP_PATH;
    } else {
      process.env.CURSOR_RIPGREP_PATH = originalRipgrepPath;
    }
  }
});

test("Cursor preserves an existing valid absolute ripgrep override", () => {
  const environment: NodeJS.ProcessEnv = {
    CURSOR_RIPGREP_PATH: process.execPath,
  };

  assert.equal(configureCursorRipgrepPath(environment), process.execPath);
  assert.equal(environment.CURSOR_RIPGREP_PATH, process.execPath);
});

test("Cursor previews flatten newlines and respect the configured bound", () => {
  const preview = cursorPreview(
    "first line\nsecond line\r\nthird line",
    18,
  );
  assert.equal(preview?.includes("\n"), false);
  assert.equal(preview?.includes("\r"), false);
  assert.ok((preview?.length ?? 0) <= 18);

  const defaultBound = cursorPreview(
    "x".repeat(CURSOR_PREVIEW_MAX_LENGTH + 50),
  );
  assert.equal(defaultBound?.length, CURSOR_PREVIEW_MAX_LENGTH);
});

test("Cursor spawn without an API key is a clear preflight rejection", async () => {
  const originalApiKey = process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_KEY;
  const task: SpawnTask = {
    prompt: "do work",
    title: "Cursor preflight test",
    cwd: process.cwd(),
    parent: {
      parentCwd: process.cwd(),
      projectTrusted: false,
    },
  };

  try {
    const result = await Effect.runPromise(
      Effect.scoped(cursorBackend.spawn(task).pipe(Effect.result)),
    );
    assert.ok(Result.isFailure(result));
    assert.ok(
      result.failure instanceof BackendPreflightRejectedError,
    );
    assert.match(result.failure.message, /CURSOR_API_KEY/);
  } finally {
    if (originalApiKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = originalApiKey;
  }
});
