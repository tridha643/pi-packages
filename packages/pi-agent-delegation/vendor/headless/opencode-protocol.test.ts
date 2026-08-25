import type {
  AssistantMessage,
  Event,
  EventMessagePartUpdated,
  EventSessionError,
  EventSessionIdle,
  EventSessionStatus,
  TextPart,
  ToolPart,
  ToolState,
  UserMessage,
} from "@opencode-ai/sdk";
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as net from "node:net";
import test from "node:test";
import type { SubagentEvent } from "./src/domain.ts";
import {
  OPEN_CODE_MESSAGE_ROLE_LIMIT,
  boundedOpenCodePreview,
  createOpenCodeEventTranslator,
  createOpenCodeMessageIdGenerator,
  createOpenCodeRunQueue,
  opencodeBackend,
  openCodeBinaryPreflightError,
  selectOpenCodeServerPort,
  terminateOpenCodeChild,
  waitForOpenCodeServerReady,
} from "./src/backends/opencode.ts";

const SESSION_ID = "session-owned";

function textPart(
  text: string,
  sessionID = SESSION_ID,
  messageID = "message-assistant",
  options: Pick<TextPart, "ignored" | "synthetic"> = {},
): TextPart {
  return {
    id: `part-${messageID}`,
    sessionID,
    messageID,
    type: "text",
    text,
    ...options,
  };
}

function textEvent(
  text: string,
  delta?: string,
  sessionID = SESSION_ID,
  messageID = "message-assistant",
  options: Pick<TextPart, "ignored" | "synthetic"> = {},
): EventMessagePartUpdated {
  return {
    type: "message.part.updated",
    properties: {
      part: textPart(text, sessionID, messageID, options),
      ...(delta === undefined ? {} : { delta }),
    },
  };
}

function userMessage(
  id: string,
  sessionID = SESSION_ID,
): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: {
      providerID: "moonshotai",
      modelID: "kimi-k2.7-code",
    },
  };
}

function assistantMessage(
  id = "message-assistant",
  sessionID = SESSION_ID,
): AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 1 },
    parentID: "message-user",
    modelID: "kimi-k2.7-code",
    providerID: "moonshotai",
    mode: "build",
    path: { cwd: "/workspace", root: "/workspace" },
    cost: 0,
    tokens: {
      input: 10,
      output: 4,
      reasoning: 2,
      cache: { read: 3, write: 1 },
    },
  };
}

function toolState(status: ToolState["status"]): ToolState {
  switch (status) {
    case "pending":
      return {
        status,
        input: { command: "printf 'hello'" },
        raw: "",
      };
    case "running":
      return {
        status,
        input: { command: "printf 'hello'" },
        title: "first line\nsecond line",
        time: { start: 1 },
      };
    case "completed":
      return {
        status,
        input: { command: "printf 'hello'" },
        output: "done\ncleanly",
        title: "complete",
        metadata: {},
        time: { start: 1, end: 2 },
      };
    case "error":
      return {
        status,
        input: { command: "false" },
        error: "exit\n1",
        time: { start: 1, end: 2 },
      };
  }
}

function toolEvent(
  callID: string,
  state: ToolState,
): EventMessagePartUpdated {
  const part: ToolPart = {
    id: `part-${callID}`,
    sessionID: SESSION_ID,
    messageID: "message-assistant",
    type: "tool",
    callID,
    tool: "shell",
    state,
  };
  return {
    type: "message.part.updated",
    properties: { part },
  };
}

test("text deltas accumulate and absent-delta full text reconciles missed output", () => {
  const translator = createOpenCodeEventTranslator(SESSION_ID);
  translator.beginRun("hello", "message-user");
  translator.translate({
    type: "message.updated",
    properties: { info: assistantMessage() },
  });

  assert.deepEqual(translator.translate(textEvent("Hello", "Hello")), [
    { _tag: "AssistantDelta", kind: "text", delta: "Hello" },
  ]);
  assert.deepEqual(translator.translate(textEvent("Hello, world")), [
    { _tag: "AssistantDelta", kind: "text", delta: ", world" },
  ]);
});

test("known user text never enters assistant output while assistant text remains intact", () => {
  const translator = createOpenCodeEventTranslator(SESSION_ID);
  translator.beginRun("private prompt", "message-user");
  const translated: SubagentEvent[] = [];
  translated.push(
    ...translator.translate({
      type: "message.updated",
      properties: { info: userMessage("message-user") },
    }),
  );
  translated.push(
    ...translator.translate(
      textEvent(
        "private prompt",
        "private prompt",
        SESSION_ID,
        "message-user",
      ),
    ),
  );
  translated.push(
    ...translator.translate({
      type: "message.updated",
      properties: { info: assistantMessage() },
    }),
  );
  translated.push(
    ...translator.translate(
      textEvent(
        "public answer",
        "public answer",
        SESSION_ID,
        "message-assistant",
      ),
    ),
  );
  translated.push(
    ...translator.translate({
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    }),
  );

  const assistantText = translated.flatMap((event) => {
    if (event._tag === "AssistantDelta") return [event.delta];
    if (event._tag !== "AssistantMessage") return [];
    return event.parts.flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    );
  });
  assert.equal(assistantText.some((text) => text.includes("private prompt")), false);
  assert.equal(assistantText.some((text) => text.includes("public answer")), true);
  const settled = translated.findLast((event) => event._tag === "RunSettled");
  assert.deepEqual(
    settled?._tag === "RunSettled" ? settled.outcome : undefined,
    { _tag: "Completed", finalText: "public answer" },
  );
});

test("unknown text stays buffered when a late role identifies it as user text", () => {
  const translator = createOpenCodeEventTranslator(SESSION_ID);
  translator.beginRun("private prompt", "current-message-user");

  assert.deepEqual(
    translator.translate(
      textEvent(
        "private prompt",
        "private prompt",
        SESSION_ID,
        "message-user",
      ),
    ),
    [],
  );
  const correction = translator.translate({
    type: "message.updated",
    properties: { info: userMessage("message-user") },
  });
  assert.equal(
    correction.some((event) => event._tag === "AssistantMessage"),
    false,
  );
  assert.deepEqual(
    translator.translate({
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    }),
    [
      {
        _tag: "RunSettled",
        outcome: { _tag: "Completed", finalText: "" },
      },
    ],
  );
});

test("a user-role correction after idle cannot reopen the finalized assistant turn", () => {
  const translator = createOpenCodeEventTranslator(SESSION_ID);
  translator.beginRun("private prompt", "current-message-user");
  const translated: SubagentEvent[] = [];

  translated.push(
    ...translator.translate({
      type: "message.updated",
      properties: { info: assistantMessage() },
    }),
  );
  translated.push(
    ...translator.translate(
      textEvent(
        "public answer",
        "public answer",
        SESSION_ID,
        "message-assistant",
      ),
    ),
  );
  translated.push(
    ...translator.translate(
      textEvent(
        "private server text",
        "private server text",
        SESSION_ID,
        "message-late-user",
      ),
    ),
  );
  translated.push(
    ...translator.translate({
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    }),
  );
  translated.push(
    ...translator.translate({
      type: "message.updated",
      properties: { info: userMessage("message-late-user") },
    }),
  );

  const deltas = translated.flatMap((event) =>
    event._tag === "AssistantDelta" ? [event.delta] : [],
  );
  const finalized = translated.filter(
    (event) => event._tag === "AssistantMessage",
  );
  const settled = translated.filter(
    (event) => event._tag === "RunSettled",
  );
  assert.deepEqual(deltas, ["public answer"]);
  assert.deepEqual(finalized, [
    {
      _tag: "AssistantMessage",
      parts: [{ type: "text", text: "public answer" }],
    },
  ]);
  assert.deepEqual(settled, [
    {
      _tag: "RunSettled",
      outcome: { _tag: "Completed", finalText: "public answer" },
    },
  ]);
  assert.equal(
    translated.some(
      (event) =>
        event._tag === "BackendError" &&
        event.message.includes("after the run settled"),
    ),
    true,
  );
  assert.equal(
    JSON.stringify([...deltas, ...finalized, ...settled]).includes(
      "private server text",
    ),
    false,
  );
});

test("final text prefers known assistant, falls back to unknown, and excludes known user", () => {
  const knownAssistant = createOpenCodeEventTranslator(SESSION_ID);
  knownAssistant.beginRun("prompt", "message-current-user");
  assert.deepEqual(
    knownAssistant.translate(
      textEvent(
        "unresolved text",
        "unresolved text",
        SESSION_ID,
        "message-unknown",
      ),
    ),
    [],
  );
  knownAssistant.translate({
    type: "message.updated",
    properties: { info: assistantMessage() },
  });
  knownAssistant.translate(
    textEvent(
      "known answer",
      "known answer",
      SESSION_ID,
      "message-assistant",
    ),
  );
  assert.deepEqual(
    knownAssistant.translate({
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    }).at(-1),
    {
      _tag: "RunSettled",
      outcome: { _tag: "Completed", finalText: "known answer" },
    },
  );

  const unknownOnly = createOpenCodeEventTranslator(SESSION_ID);
  unknownOnly.beginRun("prompt", "message-current-user");
  assert.deepEqual(
    unknownOnly.translate(
      textEvent(
        "unresolved answer",
        "unresolved answer",
        SESSION_ID,
        "message-unknown",
      ),
    ),
    [],
  );
  assert.deepEqual(
    unknownOnly.translate({
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    }),
    [
      {
        _tag: "AssistantMessage",
        parts: [{ type: "text", text: "unresolved answer" }],
      },
      {
        _tag: "RunSettled",
        outcome: {
          _tag: "Completed",
          finalText: "unresolved answer",
        },
      },
    ],
  );

  const knownUser = createOpenCodeEventTranslator(SESSION_ID);
  knownUser.beginRun("prompt", "message-current-user");
  knownUser.translate({
    type: "message.updated",
    properties: { info: userMessage("message-other-user") },
  });
  assert.deepEqual(
    knownUser.translate(
      textEvent(
        "private user text",
        "private user text",
        SESSION_ID,
        "message-other-user",
      ),
    ),
    [],
  );
  assert.deepEqual(
    knownUser.translate({
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    }),
    [
      {
        _tag: "RunSettled",
        outcome: { _tag: "Completed", finalText: "" },
      },
    ],
  );
});

test("an authoritative prompt id prevents a user role arriving after idle from leaking", () => {
  const translator = createOpenCodeEventTranslator(SESSION_ID);
  const prompt = "private prompt";
  const promptMessageId = "message-user-late-role";
  translator.beginRun(prompt, promptMessageId);
  const translated: SubagentEvent[] = [];

  translated.push(
    ...translator.translate(
      textEvent(
        prompt,
        prompt,
        SESSION_ID,
        promptMessageId,
      ),
    ),
  );
  translated.push(
    ...translator.translate({
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    }),
  );
  translated.push(
    ...translator.translate({
      type: "message.updated",
      properties: { info: userMessage(promptMessageId) },
    }),
  );

  const reportedAssistantText = translated.flatMap((event) => {
    if (event._tag === "AssistantDelta") return [event.delta];
    if (event._tag === "AssistantMessage") {
      return event.parts.flatMap((part) =>
        part.type === "text" ? [part.text] : [],
      );
    }
    if (
      event._tag === "RunSettled" &&
      event.outcome._tag === "Completed"
    ) {
      return [event.outcome.finalText];
    }
    return [];
  });
  assert.equal(
    reportedAssistantText.some((text) => text.includes(prompt)),
    false,
  );
});

test("a user-role correction before idle finalizes assistant output exactly once", () => {
  const translator = createOpenCodeEventTranslator(SESSION_ID);
  translator.beginRun("current prompt", "message-current-user");
  const translated: SubagentEvent[] = [];

  translated.push(
    ...translator.translate({
      type: "message.updated",
      properties: { info: assistantMessage() },
    }),
  );
  translated.push(
    ...translator.translate(
      textEvent(
        "public answer",
        "public answer",
        SESSION_ID,
        "message-assistant",
      ),
    ),
  );
  translated.push(
    ...translator.translate(
      textEvent(
        "historical prompt",
        "historical prompt",
        SESSION_ID,
        "message-historical-user",
      ),
    ),
  );
  translated.push(
    ...translator.translate({
      type: "message.updated",
      properties: { info: userMessage("message-historical-user") },
    }),
  );
  translated.push(
    ...translator.translate({
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    }),
  );

  const finalized = translated.filter(
    (event) => event._tag === "AssistantMessage",
  );
  const settled = translated.filter(
    (event) => event._tag === "RunSettled",
  );
  assert.deepEqual(finalized, [
    {
      _tag: "AssistantMessage",
      parts: [{ type: "text", text: "public answer" }],
    },
  ]);
  assert.deepEqual(settled, [
    {
      _tag: "RunSettled",
      outcome: { _tag: "Completed", finalText: "public answer" },
    },
  ]);
});

test("ignored text parts are excluded from deltas and final output", () => {
  const translator = createOpenCodeEventTranslator(SESSION_ID);
  translator.beginRun("ignore", "message-user");

  assert.deepEqual(
    translator.translate(
      textEvent(
        "hidden",
        "hidden",
        SESSION_ID,
        "message-assistant",
        { ignored: true },
      ),
    ),
    [],
  );
  assert.deepEqual(
    translator.translate({
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    }),
    [
      {
        _tag: "RunSettled",
        outcome: { _tag: "Completed", finalText: "" },
      },
    ],
  );
});

test("message-role tracking evicts the oldest unpinned entry at its fixed bound", () => {
  const translator = createOpenCodeEventTranslator(SESSION_ID);
  translator.beginRun("bounded roles", "message-user-0");
  for (let index = 0; index <= OPEN_CODE_MESSAGE_ROLE_LIMIT; index += 1) {
    translator.translate({
      type: "message.updated",
      properties: { info: userMessage(`message-user-${index}`) },
    });
  }

  assert.equal(
    translator.trackedMessageRoleCount(),
    OPEN_CODE_MESSAGE_ROLE_LIMIT,
  );
  assert.deepEqual(
    translator.translate(
      textEvent(
        "delayed current prompt",
        "delayed current prompt",
        SESSION_ID,
        "message-user-0",
      ),
    ),
    [],
  );
});

test("tool pending, running, completed, and error states produce bounded lifecycle events", () => {
  const translator = createOpenCodeEventTranslator(SESSION_ID);
  translator.beginRun("tools", "message-user");

  assert.deepEqual(
    translator.translate(toolEvent("call-ok", toolState("pending"))),
    [
      {
        _tag: "ToolStart",
        toolId: "call-ok",
        name: "shell",
        argsPreview: "{\"command\":\"printf 'hello'\"}",
      },
    ],
  );
  assert.deepEqual(
    translator.translate(toolEvent("call-ok", toolState("running"))),
    [
      {
        _tag: "ToolUpdate",
        toolId: "call-ok",
        outputPreview: "first line second line",
      },
    ],
  );
  assert.deepEqual(
    translator.translate(toolEvent("call-ok", toolState("completed"))),
    [
      {
        _tag: "ToolEnd",
        toolId: "call-ok",
        name: "shell",
        isError: false,
        outputPreview: "done cleanly",
      },
    ],
  );

  const failed = translator.translate(
    toolEvent("call-error", toolState("error")),
  );
  assert.equal(failed[0]?._tag, "ToolStart");
  assert.deepEqual(failed[1], {
    _tag: "ToolEnd",
    toolId: "call-error",
    name: "shell",
    isError: true,
    outputPreview: "exit 1",
  });
});

test("events belonging to a different OpenCode session are filtered out", () => {
  const translator = createOpenCodeEventTranslator(SESSION_ID);
  translator.beginRun("hello", "message-user");

  assert.deepEqual(
    translator.translate(textEvent("wrong session", "wrong session", "other")),
    [],
  );
});

test("busy then idle settles an active run exactly once", () => {
  const translator = createOpenCodeEventTranslator(SESSION_ID);
  translator.beginRun("finish", "message-user");
  const busy: EventSessionStatus = {
    type: "session.status",
    properties: {
      sessionID: SESSION_ID,
      status: { type: "busy" },
    },
  };
  const idle: EventSessionStatus = {
    type: "session.status",
    properties: {
      sessionID: SESSION_ID,
      status: { type: "idle" },
    },
  };
  const duplicateIdle: EventSessionIdle = {
    type: "session.idle",
    properties: { sessionID: SESSION_ID },
  };

  assert.deepEqual(translator.translate(busy), []);
  assert.deepEqual(translator.translate(idle), [
    {
      _tag: "RunSettled",
      outcome: { _tag: "Completed", finalText: "" },
    },
  ]);
  assert.deepEqual(translator.translate(duplicateIdle), []);
});

test("session errors emit a diagnostic followed by one failed settlement", () => {
  const translator = createOpenCodeEventTranslator(SESSION_ID);
  translator.beginRun("fail", "message-user");
  const sessionError: EventSessionError = {
    type: "session.error",
    properties: {
      sessionID: SESSION_ID,
      error: {
        name: "ProviderAuthError",
        data: {
          providerID: "moonshotai",
          message: "API key is missing",
        },
      },
    },
  };

  const translated = translator.translate(sessionError);
  assert.equal(translated[0]?._tag, "BackendError");
  assert.match(
    translated[0]?._tag === "BackendError" ? translated[0].message : "",
    /MOONSHOT_API_KEY/,
  );
  assert.equal(translated[1]?._tag, "RunSettled");
  assert.equal(
    translated[1]?._tag === "RunSettled"
      ? translated[1].outcome._tag
      : undefined,
    "Failed",
  );
  assert.deepEqual(
    translator.translate({
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    }),
    [],
  );
});

test("resolved model metadata and generated assistant usage are translated", () => {
  const translator = createOpenCodeEventTranslator(SESSION_ID);
  translator.beginRun("metadata", "message-user");
  const info: AssistantMessage = {
    id: "message-assistant",
    sessionID: SESSION_ID,
    role: "assistant",
    time: { created: 1 },
    parentID: "message-user",
    modelID: "kimi-k2.7-code",
    providerID: "moonshotai",
    mode: "build",
    path: { cwd: "/workspace", root: "/workspace" },
    cost: 0,
    tokens: {
      input: 10,
      output: 4,
      reasoning: 2,
      cache: { read: 3, write: 1 },
    },
  };

  assert.deepEqual(
    translator.translate({
      type: "message.updated",
      properties: { info },
    }),
    [
      {
        _tag: "MetaChanged",
        meta: { modelLabel: "moonshotai/kimi-k2.7-code" },
      },
      { _tag: "UsageChanged", tokens: 20 },
    ],
  );
});

test("unknown event types are no-ops", () => {
  const translator = createOpenCodeEventTranslator(SESSION_ID);
  translator.beginRun("unknown", "message-user");
  const futureEvent = {
    type: "future.protocol.event",
    properties: { sessionID: SESSION_ID },
  } as unknown as Event;

  assert.deepEqual(translator.translate(futureEvent), []);
});

test("previews flatten whitespace and respect the requested bound", () => {
  assert.equal(boundedOpenCodePreview("one\n two\tthree", 9), "one two t");
  assert.equal(boundedOpenCodePreview("\n\n", 20), undefined);
});

test("a missing binary returns a preflight rejection naming the install command", () => {
  const error = openCodeBinaryPreflightError(null);
  assert.equal(error?._tag, "BackendPreflightRejectedError");
  assert.match(error?.message ?? "", /npm i -g opencode-ai@1\.18\.5/);
});

test("generated message ids stay lexicographically ascending through rapid calls and clock rollback", () => {
  let timestampMs = 1_800_000_000_000;
  const nextMessageId = createOpenCodeMessageIdGenerator(
    () => timestampMs,
  );
  const messageIds = Array.from({ length: 5_000 }, () =>
    nextMessageId(),
  );
  timestampMs -= 10_000;
  messageIds.push(nextMessageId(), nextMessageId());
  timestampMs += 20_000;
  messageIds.push(nextMessageId());

  for (const [index, messageId] of messageIds.entries()) {
    assert.match(messageId, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    if (index === 0) continue;
    assert.equal(messageIds[index - 1]! < messageId, true);
  }
});

test("queued second and third prompts receive ids that sort after the first", async () => {
  const translator = createOpenCodeEventTranslator(SESSION_ID);
  const events: SubagentEvent[] = [];
  const postedPrompts: string[] = [];
  const postedMessageIds: string[] = [];
  const nextMessageId = createOpenCodeMessageIdGenerator(() => 1_000);
  let runQueue: ReturnType<typeof createOpenCodeRunQueue>;
  const emit = (event: SubagentEvent) => {
    events.push(event);
    if (event._tag === "RunSettled") runQueue.handleRunSettled();
  };
  const emitAll = (translated: ReadonlyArray<SubagentEvent>) => {
    for (const event of translated) emit(event);
  };
  runQueue = createOpenCodeRunQueue({
    isRunActive: translator.isRunActive,
    startRun: async (text) => {
      const messageId = nextMessageId();
      emitAll(translator.beginRun(text, messageId));
      postedPrompts.push(text);
      postedMessageIds.push(messageId);
    },
    emit,
  });

  const initialMessageId = nextMessageId();
  emitAll(translator.beginRun("initial", initialMessageId));
  postedPrompts.push("initial");
  postedMessageIds.push(initialMessageId);
  runQueue.send("second");
  runQueue.send("third");
  assert.equal(opencodeBackend.capabilities.steering, false);
  assert.deepEqual(events.at(-1), {
    _tag: "QueueChanged",
    queued: [
      { text: "second", kind: "follow-up" },
      { text: "third", kind: "follow-up" },
    ],
  });

  emitAll(
    translator.translate({
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(postedPrompts, ["initial", "second"]);

  emitAll(
    translator.translate({
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(postedPrompts, ["initial", "second", "third"]);

  emitAll(
    translator.translate({
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    }),
  );
  assert.equal(postedMessageIds[0]! < postedMessageIds[1]!, true);
  assert.equal(postedMessageIds[1]! < postedMessageIds[2]!, true);
  assert.equal(
    events.filter((event) => event._tag === "RunStarted").length,
    3,
  );
  assert.equal(
    events.filter((event) => event._tag === "RunSettled").length,
    3,
  );
});

test("ephemeral port selection releases a usable loopback port", async () => {
  const port = await selectOpenCodeServerPort();
  assert.equal(Number.isInteger(port) && port > 0, true);

  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

test("leader exit sweeps SIGTERM-ignoring descendants before teardown resolves", async () => {
  let leaderExited = false;
  let exitListener:
    | ((
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => void)
    | undefined;
  const child = {
    pid: 42_424,
    once: (
      event: string,
      listener: (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => void,
    ) => {
      assert.equal(event, "exit");
      exitListener = listener;
      return child;
    },
    kill: () => true,
  } as unknown as ChildProcessWithoutNullStreams;
  const groupSignals: NodeJS.Signals[] = [];
  const startedAt = Date.now();

  const teardown = terminateOpenCodeChild(
    child,
    () => leaderExited,
    {
      forceKillAfterMs: 20,
      killTree: (_ownedChild, signal) => {
        groupSignals.push(signal);
        if (signal === "SIGTERM") {
          queueMicrotask(() => {
            leaderExited = true;
            exitListener?.(0, "SIGTERM");
          });
        }
      },
    },
  );
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    teardown,
    new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error("OpenCode teardown exceeded test deadline.")),
        200,
      );
    }),
  ]);
  if (deadlineTimer) clearTimeout(deadlineTimer);

  assert.deepEqual(groupSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(Date.now() - startedAt < 200, true);
});

test("readiness polling fails with SpawnError within its configured bound", async () => {
  const isSpawnError = (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "SpawnError";
  let attempts = 0;
  const startedAt = Date.now();
  await assert.rejects(
    waitForOpenCodeServerReady(
      {
        session: {
          status: async () => {
            attempts += 1;
            throw new Error("connection refused");
          },
        },
      },
      { timeoutMs: 25, pollIntervalMs: 5 },
    ),
    isSpawnError,
  );
  assert.equal(attempts > 1, true);
  assert.equal(Date.now() - startedAt < 250, true);

  const hangingStartedAt = Date.now();
  await assert.rejects(
    waitForOpenCodeServerReady(
      {
        session: {
          status: () => new Promise<never>(() => undefined),
        },
      },
      { timeoutMs: 15, pollIntervalMs: 5 },
    ),
    isSpawnError,
  );
  assert.equal(Date.now() - hangingStartedAt < 250, true);
});

test("translated events remain assignable to the normalized event union", () => {
  const translator = createOpenCodeEventTranslator(SESSION_ID);
  const events: SubagentEvent[] = translator.beginRun(
    "typed",
    "message-user",
  );
  assert.deepEqual(events.map((event) => event._tag), [
    "UserMessage",
    "RunStarted",
  ]);
});
