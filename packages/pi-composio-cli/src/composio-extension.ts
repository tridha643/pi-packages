import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerComposioCommands } from "./composio-commands.ts";
import { createNodeComposioCliRunner } from "./composio-cli-runner.ts";
import { ComposioDynamicToolRegistry } from "./composio-dynamic-tools.ts";
import { registerComposioFixedTools } from "./composio-fixed-tools.ts";

/** Register the CLI-backed Composio tools, dynamic registry, and account commands. */
export function registerComposioCliExtension(pi: ExtensionAPI): void {
  const runner = createNodeComposioCliRunner();
  const dynamicTools = new ComposioDynamicToolRegistry(pi, runner);

  registerComposioFixedTools(pi, {
    runner,
    loadDiscoveredTools: (parsedOutput) => dynamicTools.loadDiscoveredTools(parsedOutput),
  });
  registerComposioCommands(pi, { runner, dynamicTools });

  pi.on("session_start", (_event, ctx) => {
    dynamicTools.restoreSessionTools(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    dynamicTools.restoreSessionTools(ctx);
  });
}
