import assert from "node:assert/strict";
import test from "node:test";
import dynamicToolSearchExtension from "./index.ts";
import type { ToolSearchCatalogEntry } from "./tool-search-catalog.ts";

interface CapturedSearchTool {
	name: string;
	execute(toolCallId: string, params: { query: string; limit?: number }): Promise<{
		content: Array<{ type: string; text: string }>;
		details: { added: string[] };
	}>;
}

interface FakeExtensionRuntime {
	activeTools: string[];
	allTools: ToolSearchCatalogEntry[];
	searchTool?: CapturedSearchTool;
	handlers: Map<string, Array<() => void>>;
	setActiveCalls: string[][];
}

function createFakeExtensionApi(runtime: FakeExtensionRuntime) {
	return {
		registerTool(tool: CapturedSearchTool) {
			runtime.searchTool = tool;
			runtime.allTools.push({ name: tool.name, description: "Search tools" });
			runtime.activeTools.push(tool.name);
		},
		registerCommand() {},
		on(event: string, handler: () => void) {
			const handlers = runtime.handlers.get(event) ?? [];
			handlers.push(handler);
			runtime.handlers.set(event, handlers);
		},
		getActiveTools() {
			return [...runtime.activeTools];
		},
		getAllTools() {
			return [...runtime.allTools];
		},
		setActiveTools(names: string[]) {
			runtime.activeTools = [...names];
			runtime.setActiveCalls.push([...names]);
		},
	};
}

function invokeHandlers(runtime: FakeExtensionRuntime, event: string): void {
	for (const handler of runtime.handlers.get(event) ?? []) handler();
}

test("extension keeps the high-frequency baseline and prunes late startup additions", () => {
	const runtime: FakeExtensionRuntime = {
		activeTools: [
			"read",
			"bash",
			"edit",
			"write",
			"manage_todo_list",
			"memory_search",
			"session_search",
			"delegate",
			"delegate_parallel",
			"delegate_review",
			"set_task_label",
			"memory",
			"skill_manage",
			"workflow",
			"glance",
		],
		allTools: [],
		handlers: new Map(),
		setActiveCalls: [],
	};
	dynamicToolSearchExtension(createFakeExtensionApi(runtime) as never);

	invokeHandlers(runtime, "session_start");
	runtime.activeTools.push("workflow");
	invokeHandlers(runtime, "before_agent_start");

	assert.deepEqual(runtime.activeTools, [
		"read",
		"bash",
		"edit",
		"write",
		"manage_todo_list",
		"memory_search",
		"session_search",
		"delegate",
		"delegate_parallel",
		"delegate_review",
		"set_task_label",
		"search_tools",
	]);
});

test("search tool additively loads every registered computer-use tool for a literal app task", async () => {
	const computerTools: ToolSearchCatalogEntry[] = [
		{ name: "list_apps", description: "List apps" },
		{ name: "list_windows", description: "List app windows" },
		{ name: "pin_foreground", description: "Pin the current foreground window" },
		{ name: "bring_app_to_front", description: "Bring an app window to the foreground" },
		{ name: "restore_foreground", description: "Restore the pinned foreground window" },
		{ name: "list_screens", description: "List screens" },
		{ name: "capture_screens_for_annotation", description: "Capture screens for visual guidance" },
		{ name: "show_screen_annotations", description: "Show visual screen guidance" },
		{ name: "clear_screen_annotations", description: "Clear visual screen guidance" },
		{ name: "get_app_state", description: "Get app state" },
		{ name: "click", description: "Click UI" },
		{ name: "perform_secondary_action", description: "Secondary UI action" },
		{ name: "set_value", description: "Set UI value" },
		{ name: "select_text", description: "Select UI text" },
		{ name: "scroll", description: "Scroll UI" },
		{ name: "drag", description: "Drag UI" },
		{ name: "press_key", description: "Press keyboard key" },
		{ name: "type_text", description: "Type UI text" },
	];
	const runtime: FakeExtensionRuntime = {
		activeTools: ["read", "bash", "edit", "write", "manage_todo_list"],
		allTools: [...computerTools],
		handlers: new Map(),
		setActiveCalls: [],
	};
	dynamicToolSearchExtension(createFakeExtensionApi(runtime) as never);
	invokeHandlers(runtime, "session_start");
	invokeHandlers(runtime, "before_agent_start");

	const result = await runtime.searchTool?.execute("call-1", {
		query: "open Slack and read all messages with Daksh",
		limit: 3,
	});

	assert.ok(result);
	assert.deepEqual(new Set(result.details.added), new Set(computerTools.map((tool) => tool.name)));
	assert.deepEqual(
		new Set(runtime.activeTools),
		new Set(["read", "bash", "edit", "write", "manage_todo_list", "search_tools", ...computerTools.map((tool) => tool.name)]),
	);
});
