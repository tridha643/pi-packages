/**
 * Output Style Extension
 *
 * Claude Code-style switchable output styles for Pi.
 *
 * Styles are Markdown files with YAML frontmatter, discovered from:
 *   - ~/.pi/agent/output-styles/*.md        (global)
 *   - <cwd>/.pi/output-styles/*.md          (project, wins on slug collision)
 *
 * The active style body is appended to the system prompt on every turn through
 * `before_agent_start`, wrapped in a block that declares precedence over earlier
 * writing-style guidance (AGENTS.md, SYSTEM.md) while leaving engineering,
 * verification, and safety rules untouched.
 *
 * Selection is persisted in ~/.pi/agent/output-style.json:
 *   { "active": "adhd-eli", "byProject": { "/abs/path": "terse" }, "showIndicator": true }
 *
 * Usage:
 *   /output-style                 open the picker
 *   /output-style adhd-eli        activate globally
 *   /output-style terse --project activate for this project only
 *   /output-style none            deactivate (add --project to pin "off" here)
 *   /output-style show            print the active style and its source file
 *   /output-style reload          rescan style directories
 *   pi --output-style adhd-eli    session-only override, nothing persisted
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

const NONE = "(none)";
const STATUS_KEY = "output-style";

export interface OutputStyle {
	slug: string;
	name: string;
	description: string;
	body: string;
	path: string;
	scope: "global" | "project";
}

interface OutputStyleConfig {
	active?: string;
	byProject: Record<string, string>;
	showIndicator: boolean;
}

/** Splits `---` frontmatter from the style body without pulling in a YAML dependency. */
export function parseOutputStyleFile(slug: string, path: string, raw: string, scope: "global" | "project"): OutputStyle {
	let name = slug;
	let description = "";
	let body = raw.trim();

	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	if (match) {
		body = raw.slice(match[0].length).trim();
		for (const line of match[1].split(/\r?\n/)) {
			const field = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim());
			if (!field) continue;
			const key = field[1].toLowerCase();
			const value = field[2].trim().replace(/^["'](.*)["']$/, "$1");
			if (key === "name" && value) name = value;
			if (key === "description" && value) description = value;
		}
	}

	return { slug, name, description, body, path, scope };
}

function readStyleDirectory(dir: string, scope: "global" | "project"): OutputStyle[] {
	if (!existsSync(dir)) return [];
	const styles: OutputStyle[] = [];
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".md")) continue;
		const path = join(dir, entry);
		try {
			const raw = readFileSync(path, "utf-8");
			const style = parseOutputStyleFile(basename(entry, ".md"), path, raw, scope);
			if (style.body) styles.push(style);
		} catch {
			// A single unreadable style file must never break session startup.
		}
	}
	return styles;
}

/** Loads global then project styles; a project style shadows a global style with the same slug. */
export function loadOutputStyles(cwd: string): Map<string, OutputStyle> {
	const byslug = new Map<string, OutputStyle>();
	for (const style of readStyleDirectory(globalStyleDir(), "global")) byslug.set(style.slug, style);
	for (const style of readStyleDirectory(join(cwd, CONFIG_DIR_NAME, "output-styles"), "project")) byslug.set(style.slug, style);
	return byslug;
}

function globalStyleDir(): string {
	return join(getAgentDir(), "output-styles");
}

function configPath(): string {
	return join(getAgentDir(), "output-style.json");
}

export function loadConfig(): OutputStyleConfig {
	try {
		const parsed = JSON.parse(readFileSync(configPath(), "utf-8")) as Partial<OutputStyleConfig>;
		return {
			active: typeof parsed.active === "string" ? parsed.active : undefined,
			byProject:
				parsed.byProject && typeof parsed.byProject === "object" ? (parsed.byProject as Record<string, string>) : {},
			showIndicator: parsed.showIndicator !== false,
		};
	} catch {
		return { byProject: {}, showIndicator: true };
	}
}

function saveConfig(config: OutputStyleConfig): void {
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(configPath(), `${JSON.stringify(config, null, 4)}\n`, "utf-8");
}

/** Project pin wins over the global selection; `NONE` pins "no style" for this project. */
export function resolveActiveSlug(config: OutputStyleConfig, cwd: string): string | undefined {
	const pinned = config.byProject[resolve(cwd)];
	const slug = pinned ?? config.active;
	return !slug || slug === NONE ? undefined : slug;
}

/** Wraps a style body so it outranks earlier prose guidance without touching engineering rules. */
export function buildStyleInstructions(style: OutputStyle): string {
	return [
		`<output-style name="${style.name}">`,
		"The rules below define how you communicate in this session. Where they conflict with any earlier writing-style,",
		"tone, formatting, or response-length guidance in this prompt, these rules win. They do not change tool use,",
		"delegation, verification, safety, or engineering requirements — only how the reply itself reads.",
		"",
		style.body,
		"</output-style>",
	].join("\n");
}

export default function outputStyleExtension(pi: ExtensionAPI) {
	let styles = new Map<string, OutputStyle>();
	let config: OutputStyleConfig = { byProject: {}, showIndicator: true };
	let sessionOverride: string | undefined;
	let cwd = process.cwd();

	pi.registerFlag("output-style", {
		description: "Output style slug to use for this session (not persisted)",
		type: "string",
	});

	function activeStyle(): OutputStyle | undefined {
		const slug = sessionOverride ?? resolveActiveSlug(config, cwd);
		return slug ? styles.get(slug) : undefined;
	}

	function updateStatus(ctx: ExtensionContext): void {
		const style = activeStyle();
		ctx.ui.setStatus(
			STATUS_KEY,
			style && config.showIndicator ? ctx.ui.theme.fg("accent", `style:${style.slug}`) : undefined,
		);
	}

	function describe(style: OutputStyle): string {
		const scope = style.scope === "project" ? "project" : "global";
		return style.description ? `${style.description} (${scope})` : scope;
	}

	function apply(slug: string | undefined, scopeToProject: boolean, ctx: ExtensionContext): void {
		const value = slug ?? NONE;
		if (scopeToProject) {
			config.byProject[resolve(cwd)] = value;
		} else {
			config.active = slug;
			delete config.byProject[resolve(cwd)];
		}
		sessionOverride = undefined;
		saveConfig(config);
		updateStatus(ctx);

		const where = scopeToProject ? "this project" : "globally";
		ctx.ui.notify(
			slug ? `Output style "${styles.get(slug)?.name ?? slug}" active ${where}` : `Output style cleared ${where}`,
			"info",
		);
	}

	async function showPicker(ctx: ExtensionContext, scopeToProject: boolean): Promise<void> {
		if (styles.size === 0) {
			ctx.ui.notify(`No output styles found. Add Markdown files to ${globalStyleDir()}`, "warning");
			return;
		}

		const current = activeStyle()?.slug;
		const items: SelectItem[] = [...styles.values()]
			.sort((a, b) => a.slug.localeCompare(b.slug))
			.map((style) => ({
				value: style.slug,
				label: style.slug === current ? `${style.name} (active)` : style.name,
				description: describe(style),
			}));
		items.push({ value: NONE, label: NONE, description: "Use Pi's default voice with no style overlay" });

		const selected = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
			container.addChild(
				new Text(theme.fg("accent", theme.bold(scopeToProject ? "Output Style (project)" : "Output Style"))),
			);

			const list = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
			container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!selected) return;
		apply(selected === NONE ? undefined : selected, scopeToProject, ctx);
	}

	pi.registerCommand("output-style", {
		description: "Switch the agent's output style (Markdown styles in ~/.pi/agent/output-styles)",
		getArgumentCompletions: (prefix) => {
			const items = [...styles.values()]
				.map((style) => ({ value: style.slug, label: style.slug, description: describe(style) }))
				.concat([{ value: "none", label: "none", description: "Clear the active output style" }])
				.filter((item) => item.value.startsWith(prefix.trim()));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			cwd = ctx.cwd;
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const scopeToProject = tokens.includes("--project");
			const [target] = tokens.filter((token) => !token.startsWith("--"));

			if (!target) {
				await showPicker(ctx, scopeToProject);
				return;
			}

			if (target === "show") {
				const style = activeStyle();
				ctx.ui.notify(
					style
						? `Active output style: ${style.name} (${style.slug}) — ${style.path}`
						: "No output style active; Pi is using its default voice",
					"info",
				);
				return;
			}

			if (target === "reload") {
				styles = loadOutputStyles(ctx.cwd);
				updateStatus(ctx);
				ctx.ui.notify(`Reloaded ${styles.size} output style(s)`, "info");
				return;
			}

			if (target === "none" || target === "off" || target === NONE) {
				apply(undefined, scopeToProject, ctx);
				return;
			}

			if (!styles.has(target)) {
				const available = [...styles.keys()].sort().join(", ") || "(none found)";
				ctx.ui.notify(`Unknown output style "${target}". Available: ${available}`, "error");
				return;
			}

			apply(target, scopeToProject, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		styles = loadOutputStyles(cwd);
		config = loadConfig();

		const flag = pi.getFlag("output-style");
		if (typeof flag === "string" && flag.trim()) {
			const slug = flag.trim();
			if (styles.has(slug)) {
				sessionOverride = slug;
			} else {
				ctx.ui.notify(`Unknown output style "${slug}" from --output-style`, "warning");
			}
		}

		updateStatus(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		const style = activeStyle();
		if (!style) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildStyleInstructions(style)}` };
	});
}
