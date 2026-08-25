/** Metadata indexed by the dynamic Pi tool search loader. */
export interface ToolSearchCatalogEntry {
	name: string;
	description: string;
	parameters?: unknown;
	sourceInfo?: {
		source?: string;
		path?: string;
	};
}

/** A registered Pi tool selected by capability search or family expansion. */
export interface ToolSearchMatch {
	name: string;
	description: string;
	score: number;
	reason: "match" | "family";
}

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"for",
	"from",
	"in",
	"into",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"tool",
	"tools",
	"use",
	"with",
]);

const TOOL_ALIASES: Record<string, string[]> = {
	askUserQuestion: ["ask", "clarify", "clarification", "choice", "question", "questions", "user input"],
	delegate: [
		"agent",
		"builder",
		"fan out",
		"fan-out",
		"independent investigation",
		"multi agent",
		"parallel research",
		"reviewer",
		"scout",
		"subagent",
	],
	delegate_continue: ["continue agent", "continue delegate", "follow up", "resume agent", "resume delegate"],
	delegate_profiles: [
		"compare delegate models",
		"delegate model tradeoffs",
		"inspect delegate profile",
		"model benefits limitations",
		"profile strengths weaknesses",
	],
	delegate_review: [
		"code review loop",
		"fresh reviewer",
		"inverted review",
		"model inversion",
		"parent fixes",
		"review until clean",
	],
	delegate_parallel: [
		"break down task",
		"concurrent agents",
		"fan out",
		"fan-out",
		"independent chunks",
		"multi agent",
		"parallel agents",
		"parallel delegates",
	],
	get_app_state: [
		"app ui",
		"automation",
		"browser",
		"computer",
		"control app",
		"desktop",
		"open app",
		"read app",
		"screenshot",
		"use app",
		"window",
	],
	glance: ["browser screenshot", "error dialog", "paste screenshot", "screen", "visual"],
	invoke_modem_agent: ["company", "customer feedback", "modem", "people", "topic"],
	list_modem_mcp_tools: ["connected tools", "modem mcp", "oauth"],
	manage_todo_list: ["plan", "planning", "progress", "task list", "todo"],
	memory: ["remember", "save preference", "persistent memory"],
	memory_search: ["past context", "preference", "project memory", "remembered"],
	session_search: ["earlier conversation", "past session", "previous discussion"],
	skill_manage: ["procedure", "procedural memory", "reusable workflow", "skill"],
	workflow: ["fan out", "fan-out", "multi agent", "orchestration", "parallel agents", "pipeline"],
	webfetch: ["download page", "fetch url", "http", "website"],
	websearch: ["current information", "internet", "online research", "search web"],
};

const TOOL_FAMILIES: readonly (readonly string[])[] = [
	[
		"list_apps",
		"list_windows",
		"pin_foreground",
		"bring_app_to_front",
		"restore_foreground",
		"list_screens",
		"capture_screens_for_annotation",
		"show_screen_annotations",
		"clear_screen_annotations",
		"get_app_state",
		"click",
		"perform_secondary_action",
		"set_value",
		"select_text",
		"scroll",
		"drag",
		"press_key",
		"type_text",
	],
	["websearch", "webfetch"],
	["memory_search", "session_search", "memory", "skill_manage"],
	[
		"delegate",
		"delegate_parallel",
		"delegate_review",
		"delegate_continue",
		"delegate_freeform",
		"delegate_chain",
		"delegate_wait",
		"delegate_check",
		"delegate_cancel",
		"delegate_list",
		"subagent_config",
	],
	["invoke_modem_agent", "list_modem_mcp_tools"],
];

function stemToken(token: string): string {
	if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
	if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
	if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
	if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
	return token;
}

function normalizeText(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function tokenize(value: string): string[] {
	return normalizeText(value)
		.split(/\s+/)
		.map(stemToken)
		.filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function collectSchemaText(value: unknown, depth = 0, seen = new Set<object>()): string {
	if (depth > 6 || value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value !== "object") return "";
	if (seen.has(value)) return "";
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((item) => collectSchemaText(item, depth + 1, seen)).join(" ");
	}

	return Object.entries(value as Record<string, unknown>)
		.flatMap(([key, child]) => [key, collectSchemaText(child, depth + 1, seen)])
		.join(" ");
}

function scoreTool(tool: ToolSearchCatalogEntry, query: string, queryTokens: string[]): number {
	const normalizedQuery = normalizeText(query);
	const normalizedName = normalizeText(tool.name);
	const nameTokens = new Set(tokenize(tool.name));
	const descriptionTokens = new Set(tokenize(tool.description));
	const aliasText = TOOL_ALIASES[tool.name]?.join(" ") ?? "";
	const aliasTokens = new Set(tokenize(aliasText));
	const schemaTokens = new Set(tokenize(collectSchemaText(tool.parameters).slice(0, 8_000)));
	const sourceTokens = new Set(tokenize(`${tool.sourceInfo?.source ?? ""} ${tool.sourceInfo?.path ?? ""}`));

	let score = 0;
	if (normalizedQuery === normalizedName) score += 100;
	if (normalizedName.includes(normalizedQuery) && normalizedQuery.length > 2) score += 30;
	if (normalizeText(tool.description).includes(normalizedQuery) && normalizedQuery.length > 3) score += 12;
	if (normalizeText(aliasText).includes(normalizedQuery) && normalizedQuery.length > 3) score += 16;

	for (const token of queryTokens) {
		if (nameTokens.has(token)) score += 15;
		if (aliasTokens.has(token)) score += 10;
		if (descriptionTokens.has(token)) score += 5;
		if (schemaTokens.has(token)) score += 2;
		if (sourceTokens.has(token)) score += 1;
	}

	return score;
}

function familyForTool(name: string): readonly string[] | undefined {
	return TOOL_FAMILIES.find((family) => family.includes(name));
}

/** Rank registered tools for a plain-language capability query and include dependent tool families. */
export function searchToolCatalog(
	tools: readonly ToolSearchCatalogEntry[],
	query: string,
	limit = 5,
): ToolSearchMatch[] {
	const queryTokens = [...new Set(tokenize(query))];
	if (queryTokens.length === 0) return [];

	const ranked = tools
		.map((tool) => ({ tool, score: scoreTool(tool, query, queryTokens) }))
		.filter(({ score }) => score > 0)
		.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));

	if (ranked.length === 0) return [];

	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	const topFamily = familyForTool(ranked[0].tool.name);
	const selected = new Map<string, ToolSearchMatch>();

	if (topFamily) {
		for (const name of topFamily) {
			const tool = byName.get(name);
			if (!tool) continue;
			const direct = ranked.find((candidate) => candidate.tool.name === name);
			selected.set(name, {
				name,
				description: tool.description,
				score: direct?.score ?? 0,
				reason: direct ? "match" : "family",
			});
		}
	}

	if (topFamily) return [...selected.values()];

	const minimumRelevantScore = Math.max(3, ranked[0].score * 0.5);
	for (const candidate of ranked) {
		if (selected.size >= limit || candidate.score < minimumRelevantScore) break;
		selected.set(candidate.tool.name, {
			name: candidate.tool.name,
			description: candidate.tool.description,
			score: candidate.score,
			reason: "match",
		});
	}

	return [...selected.values()];
}
