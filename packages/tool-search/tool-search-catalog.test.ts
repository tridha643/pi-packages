import assert from "node:assert/strict";
import test from "node:test";
import { searchToolCatalog, type ToolSearchCatalogEntry } from "./tool-search-catalog.ts";

const DELEGATION_TOOLS: ToolSearchCatalogEntry[] = [
	{ name: "delegate", description: "Run a saved subagent with a strict profile" },
	{ name: "delegate_parallel", description: "Launch independent strict subagents concurrently" },
	{ name: "delegate_review", description: "Run a model-inverted review and parent-fix loop" },
	{ name: "delegate_continue", description: "Continue a completed strict subagent" },
	{ name: "delegate_freeform", description: "Run a one-off explicit subagent" },
	{ name: "delegate_chain", description: "Run sequential subagent steps" },
	{ name: "delegate_wait", description: "Wait for delegated work" },
	{ name: "delegate_check", description: "Inspect delegated work" },
	{ name: "delegate_cancel", description: "Cancel delegated work" },
	{ name: "delegate_list", description: "List delegated work" },
	{ name: "delegate_profiles", description: "Inspect delegate model task fit and tradeoffs" },
	{ name: "subagent_config", description: "Manage subagents and compute profiles" },
];

const COMPUTER_USE_TOOLS: ToolSearchCatalogEntry[] = [
	{ name: "list_apps", description: "List apps on this computer" },
	{ name: "list_windows", description: "List app windows" },
	{ name: "pin_foreground", description: "Remember the current foreground window" },
	{ name: "bring_app_to_front", description: "Bring an app window to the foreground" },
	{ name: "restore_foreground", description: "Restore a pinned foreground window" },
	{ name: "list_screens", description: "List attached screens" },
	{ name: "capture_screens_for_annotation", description: "Capture screens for visual guidance" },
	{ name: "show_screen_annotations", description: "Show visual screen guidance" },
	{ name: "clear_screen_annotations", description: "Clear visual screen guidance" },
	{ name: "get_app_state", description: "Get an app screenshot and accessibility tree" },
	{ name: "click", description: "Click an element" },
	{ name: "perform_secondary_action", description: "Invoke a secondary UI action" },
	{ name: "set_value", description: "Set a UI element value" },
	{ name: "select_text", description: "Select text in an app" },
	{ name: "scroll", description: "Scroll an element" },
	{ name: "drag", description: "Drag between coordinates" },
	{ name: "press_key", description: "Press a keyboard key" },
	{ name: "type_text", description: "Type literal text" },
];

test("tool search ranks an exact tool name first", () => {
	const matches = searchToolCatalog(
		[
			{ name: "websearch", description: "Search the public web" },
			{ name: "webfetch", description: "Fetch one URL" },
		],
		"websearch",
		1,
	);

	assert.deepEqual(
		matches.map((match) => match.name),
		["websearch", "webfetch"],
	);
});

test("tool search loads the complete registered computer-use family for a literal app task", () => {
	const matches = searchToolCatalog(
		[...COMPUTER_USE_TOOLS, { name: "glance", description: "Wait for a pasted browser screenshot" }],
		"open Slack and read all messages with Daksh",
		3,
	);

	assert.deepEqual(
		new Set(matches.map((match) => match.name)),
		new Set(COMPUTER_USE_TOOLS.map((tool) => tool.name)),
	);
});

test("tool search expands related memory operations", () => {
	const matches = searchToolCatalog(
		[
			{ name: "memory_search", description: "Search persistent memory" },
			{ name: "session_search", description: "Search past conversations" },
			{ name: "memory", description: "Save durable information" },
			{ name: "skill_manage", description: "Manage reusable procedures" },
		],
		"find a preference from past sessions",
		2,
	);

	assert.deepEqual(
		new Set(matches.map((match) => match.name)),
		new Set(["memory_search", "session_search", "memory", "skill_manage"]),
	);
});

test("tool search expands the current delegation family without the on-demand profile inspector", () => {
	const matches = searchToolCatalog(DELEGATION_TOOLS, "delegate", 1);

	assert.deepEqual(
		new Set(matches.map((match) => match.name)),
		new Set(
			DELEGATION_TOOLS.filter((tool) => tool.name !== "delegate_profiles").map(
				(tool) => tool.name,
			),
		),
	);
});

test("tool search loads only the progressive profile inspector for an exact request", () => {
	const matches = searchToolCatalog(DELEGATION_TOOLS, "delegate_profiles", 1);

	assert.deepEqual(matches.map((match) => match.name), ["delegate_profiles"]);
});

test("tool search indexes parameter names and descriptions", () => {
	const matches = searchToolCatalog(
		[
			{
				name: "deploy_service",
				description: "Run an operation",
				parameters: {
					type: "object",
					properties: { environment: { type: "string", description: "Production deployment target" } },
				},
			},
		],
		"production environment",
	);

	assert.equal(matches[0]?.name, "deploy_service");
});

test("tool search rejects queries containing only generic words", () => {
	assert.deepEqual(searchToolCatalog([{ name: "read", description: "Read a file" }], "use the tool"), []);
});
