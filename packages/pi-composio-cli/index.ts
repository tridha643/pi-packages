import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerComposioCliExtension } from "./src/composio-extension.ts";

/** Pi package entry point for the first-class Composio CLI integration. */
export default function composioCliPiPackage(pi: ExtensionAPI): void {
  registerComposioCliExtension(pi);
}
