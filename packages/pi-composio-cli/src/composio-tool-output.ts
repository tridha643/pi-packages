import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type AgentToolResult,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type { ComposioCliRunSuccess } from "./composio-cli-runner.ts";

/** Safe execution metadata shown without tool arguments or credentials. */
export type ComposioToolOutputDetails = {
  readonly operation: string;
  readonly binaryPath: string;
  readonly truncation?: TruncationResult;
  readonly fullOutputPath?: string;
  readonly loadedToolNames?: ReadonlyArray<string>;
};

function printableComposioOutput(result: ComposioCliRunSuccess): string {
  if (result.parsedOutput !== undefined) {
    return JSON.stringify(result.parsedOutput, null, 2);
  }

  const stdout = result.stdout.trim();
  if (stdout) {
    return stdout;
  }

  return "Composio CLI completed successfully with no output.";
}

/** Convert captured CLI output into a bounded Pi tool result with a private overflow file. */
export async function formatComposioToolOutput(params: {
  readonly operation: string;
  readonly result: ComposioCliRunSuccess;
  readonly loadedToolNames?: ReadonlyArray<string>;
}): Promise<AgentToolResult<ComposioToolOutputDetails>> {
  const output = printableComposioOutput(params.result);
  const truncation = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });

  let text = truncation.content;
  let fullOutputPath: string | undefined;
  if (truncation.truncated) {
    const outputDirectory = await mkdtemp(join(tmpdir(), "pi-composio-cli-"));
    fullOutputPath = join(outputDirectory, "output.json");
    await writeFile(fullOutputPath, output, { encoding: "utf8", mode: 0o600 });
    text += `\n\n[Composio output truncated to ${truncation.outputLines}/${truncation.totalLines} lines and ${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}. Full output: ${fullOutputPath}]`;
  }

  if (params.loadedToolNames !== undefined && params.loadedToolNames.length > 0) {
    text = `Loaded Pi tools: ${params.loadedToolNames.join(", ")}\n\n${text}`;
  }

  const details: ComposioToolOutputDetails = {
    operation: params.operation,
    binaryPath: params.result.binaryPath,
    ...(truncation.truncated ? { truncation } : {}),
    ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
    ...(params.loadedToolNames === undefined ? {} : { loadedToolNames: params.loadedToolNames }),
  };

  return {
    content: [{ type: "text", text }],
    details,
    ...(params.loadedToolNames === undefined || params.loadedToolNames.length === 0
      ? {}
      : { addedToolNames: [...params.loadedToolNames] }),
  };
}
