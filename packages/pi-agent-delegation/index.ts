import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerDelegateSubagents from "./src/delegate-extension.ts";

/** Register headless Pi, Claude Code, Codex, Cursor, and OpenCode subagent delegation. */
export default function registerAgentDelegation(pi: ExtensionAPI): void {
  registerDelegateSubagents(pi);
}
