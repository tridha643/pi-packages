import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { searchToolCatalog } from "./tool-search-catalog.ts";

const TOOL_SEARCH_NAME = "search_tools";

// Keep core editing, memory lookup, and strict single/parallel delegation available without discovery.
const DEFAULT_ALWAYS_ACTIVE_TOOLS = new Set([
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
	TOOL_SEARCH_NAME,
]);

export default function dynamicToolSearchExtension(pi: ExtensionAPI) {
	let sessionBaselineTools: string[] = [];
	let initialToolPruneComplete = false;

	function calculateSessionBaseline(): string[] {
		// Intersect with the current set so explicit --tools/--no-tools CLI choices remain authoritative.
		return pi.getActiveTools().filter((name) => DEFAULT_ALWAYS_ACTIVE_TOOLS.has(name));
	}

	function resetToSessionBaseline(): void {
		pi.setActiveTools(sessionBaselineTools);
	}

	pi.registerTool({
		name: TOOL_SEARCH_NAME,
		label: "Search Tools",
		description:
			"Search all registered but inactive Pi tools by capability and enable the relevant tools for the current session.",
		promptSnippet: "Search for and enable additional tools only when the active tools cannot perform the task",
		promptGuidelines: [
			"Use search_tools when a task needs a capability that is not in the current active tool set.",
			"After search_tools loads tools, call the newly available tool on the following turn.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Plain-language capability or task to find, such as browser automation or past sessions",
			}),
			limit: Type.Optional(
				Type.Integer({
					description: "Maximum direct matches to load; dependent tool families may be included together",
					minimum: 1,
					maximum: 10,
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const activeTools = pi.getActiveTools();
			const activeNames = new Set(activeTools);
			const allSearchableTools = pi.getAllTools().filter((tool) => tool.name !== TOOL_SEARCH_NAME);
			const inactiveTools = allSearchableTools.filter((tool) => !activeNames.has(tool.name));

			let matches = searchToolCatalog(inactiveTools, params.query, params.limit ?? 3);
			if (matches.length === 0) {
				matches = searchToolCatalog(allSearchableTools, params.query, params.limit ?? 3);
			}

			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: `No registered tools matched: ${params.query}` }],
					details: { query: params.query, matches: [], added: [] },
				};
			}

			const matchedNames = matches.map((match) => match.name);
			const addedNames = matchedNames.filter((name) => !activeNames.has(name));
			if (addedNames.length > 0) {
				pi.setActiveTools([...new Set([...activeTools, ...addedNames])]);
			}

			const text =
				addedNames.length > 0
					? `Loaded tools: ${addedNames.join(", ")}`
					: `Matching tools already active: ${matchedNames.join(", ")}`;

			return {
				content: [{ type: "text", text }],
				details: {
					query: params.query,
					matches: matches.map(({ name, score, reason }) => ({ name, score, reason })),
					added: addedNames,
				},
			};
		},
	});

	pi.registerCommand("tool-search-status", {
		description: "Show active and inactive registered Pi tools",
		handler: async (_args, ctx) => {
			const active = pi.getActiveTools();
			const activeNames = new Set(active);
			const inactive = pi
				.getAllTools()
				.map((tool) => tool.name)
				.filter((name) => !activeNames.has(name));
			ctx.ui.notify(`Active: ${active.join(", ")}\nInactive: ${inactive.join(", ")}`, "info");
		},
	});

	pi.registerCommand("tool-search-reset", {
		description: "Unload lazily added tools and restore the minimal session baseline",
		handler: async (_args, ctx) => {
			resetToSessionBaseline();
			ctx.ui.notify(`Restored tools: ${sessionBaselineTools.join(", ") || "none"}`, "info");
		},
	});

	pi.on("session_start", () => {
		sessionBaselineTools = calculateSessionBaseline();
		initialToolPruneComplete = false;
		resetToSessionBaseline();
	});

	pi.on("before_agent_start", () => {
		if (initialToolPruneComplete) return;

		// Some package extensions reactivate their tools in later session_start handlers.
		// Prune once more before the first provider request, after every startup handler has run.
		resetToSessionBaseline();
		initialToolPruneComplete = true;
	});
}
