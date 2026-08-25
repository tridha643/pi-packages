import { constants as fsConstants } from "node:fs";
import { isAbsolute } from "node:path";
import { open, type FileHandle } from "node:fs/promises";
import { isComposioJsonObject, parseComposioCliJson } from "./composio-cli-json.ts";
import { composioFailure, composioSuccess, type ComposioResult } from "./composio-result.ts";

const MAX_STORED_OUTPUT_BYTES = 20 * 1024 * 1024;

/** Failure to safely resolve a large Composio result stored in a CLI artifact. */
export type ComposioStoredOutputError = {
  readonly _tag: "ComposioStoredOutputUnavailable";
  readonly message: string;
};

/**
 * Load a CLI-spilled JSON result through a bounded, no-symlink file descriptor.
 * Small inline outputs pass through unchanged.
 */
export async function resolveComposioStoredOutput(
  parsedOutput: unknown,
): Promise<ComposioResult<unknown, ComposioStoredOutputError>> {
  if (!isComposioJsonObject(parsedOutput) || parsedOutput.storedInFile !== true) {
    return composioSuccess(parsedOutput);
  }

  const outputFilePath = parsedOutput.outputFilePath;
  if (typeof outputFilePath !== "string" || !isAbsolute(outputFilePath)) {
    return composioFailure({
      _tag: "ComposioStoredOutputUnavailable",
      message: "Composio stored output unavailable: CLI returned no absolute artifact path.",
    });
  }

  let fileHandle: FileHandle | undefined;
  try {
    fileHandle = await open(outputFilePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stats = await fileHandle.stat();
    const currentUserId = process.getuid?.();
    if (!stats.isFile()) {
      return composioFailure({
        _tag: "ComposioStoredOutputUnavailable",
        message: "Composio stored output unavailable: artifact is not a regular file.",
      });
    }
    if (currentUserId !== undefined && stats.uid !== currentUserId) {
      return composioFailure({
        _tag: "ComposioStoredOutputUnavailable",
        message: "Composio stored output unavailable: artifact is owned by another user.",
      });
    }
    if (stats.size > MAX_STORED_OUTPUT_BYTES) {
      return composioFailure({
        _tag: "ComposioStoredOutputUnavailable",
        message: `Composio stored output unavailable: artifact exceeds ${MAX_STORED_OUTPUT_BYTES} bytes.`,
      });
    }

    const rawOutput = await fileHandle.readFile({ encoding: "utf8" });
    const resolvedOutput = parseComposioCliJson(rawOutput);
    if (resolvedOutput === undefined) {
      return composioFailure({
        _tag: "ComposioStoredOutputUnavailable",
        message: "Composio stored output unavailable: artifact does not contain valid JSON.",
      });
    }
    return composioSuccess(resolvedOutput);
  } catch (cause) {
    return composioFailure({
      _tag: "ComposioStoredOutputUnavailable",
      message: `Composio stored output unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}
