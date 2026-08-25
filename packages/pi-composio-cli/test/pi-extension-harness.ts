import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** Minimal observable Pi runtime used to exercise the extension through public registrations. */
export type PiExtensionHarness = {
  readonly api: ExtensionAPI;
  readonly context: ExtensionContext;
  readonly toolNames: () => ReadonlyArray<string>;
  readonly commandNames: () => ReadonlyArray<string>;
  readonly activeToolNames: () => ReadonlyArray<string>;
  readonly notifications: ReadonlyArray<string>;
  readonly sessionEntries: ReadonlyArray<Record<string, unknown>>;
  readonly executeTool: (
    name: string,
    parameters: unknown,
  ) => Promise<AgentToolResult<unknown>>;
  readonly invokeCommand: (name: string, argumentsText?: string) => Promise<void>;
  readonly startSession: () => Promise<void>;
  readonly navigateSessionTree: (visibleEntryCount: number) => Promise<void>;
  readonly shutdownSession: () => Promise<void>;
};

/** Create a fake Pi host while leaving the Composio process boundary real. */
export function createPiExtensionHarness(
  initialActiveTools: ReadonlyArray<string> = ["read"],
): PiExtensionHarness {
  const tools = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  const handlers = new Map<string, Array<(event: unknown, context: ExtensionContext) => unknown>>();
  const activeTools = new Set(initialActiveTools);
  const notifications: string[] = [];
  const sessionEntries: Array<Record<string, unknown>> = [];
  let visibleEntryCount = Number.POSITIVE_INFINITY;

  const sessionManager = {
    getBranch: () => sessionEntries.slice(0, visibleEntryCount),
  };
  const context = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    model: { id: "test-model" },
    sessionManager,
    ui: {
      notify: (message: string) => notifications.push(message),
    },
  };

  const apiShape = {
    registerTool: (tool: { readonly name: string }) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, command: unknown) => {
      commands.set(name, command);
    },
    on: (event: string, handler: (event: unknown, extensionContext: ExtensionContext) => unknown) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools.clear();
      for (const name of names) {
        activeTools.add(name);
      }
    },
    appendEntry: (customType: string, data: unknown) => {
      sessionEntries.push({
        type: "custom",
        id: `entry-${sessionEntries.length + 1}`,
        parentId: sessionEntries.at(-1)?.id ?? null,
        timestamp: new Date(0).toISOString(),
        customType,
        data,
      });
    },
  };

  // SAFETY: Production code under test uses only the ExtensionAPI methods implemented above. Missing Pi methods are inaccessible through this harness.
  const api = apiShape as unknown as ExtensionAPI;
  // SAFETY: Production code under test reads only cwd, model.id, sessionManager.getBranch, and ui.notify, all provided above.
  const extensionContext = context as unknown as ExtensionContext;

  return {
    api,
    context: extensionContext,
    toolNames: () => [...tools.keys()],
    commandNames: () => [...commands.keys()],
    activeToolNames: () => [...activeTools],
    notifications,
    sessionEntries,
    async executeTool(name, parameters) {
      const value = tools.get(name);
      if (value === undefined) {
        throw new Error(`Pi extension harness missing tool: ${name}`);
      }
      // SAFETY: registerTool is the only writer to this map, so every stored value is a ToolDefinition.
      const tool = value as ToolDefinition;
      return tool.execute("test-call", parameters, undefined, undefined, extensionContext);
    },
    async invokeCommand(name, argumentsText = "") {
      const value = commands.get(name);
      if (typeof value !== "object" || value === null || !("handler" in value)) {
        throw new Error(`Pi extension harness missing command: ${name}`);
      }
      const handler = Reflect.get(value, "handler");
      if (typeof handler !== "function") {
        throw new Error(`Pi extension harness command has no handler: ${name}`);
      }
      await Reflect.apply(handler, value, [argumentsText, extensionContext]);
    },
    async startSession() {
      for (const handler of handlers.get("session_start") ?? []) {
        await handler({ type: "session_start", reason: "startup" }, extensionContext);
      }
    },
    async navigateSessionTree(nextVisibleEntryCount) {
      visibleEntryCount = nextVisibleEntryCount;
      for (const handler of handlers.get("session_tree") ?? []) {
        await handler({ type: "session_tree" }, extensionContext);
      }
    },
    async shutdownSession() {
      for (const handler of handlers.get("session_shutdown") ?? []) {
        await handler({ type: "session_shutdown" }, extensionContext);
      }
    },
  };
}
