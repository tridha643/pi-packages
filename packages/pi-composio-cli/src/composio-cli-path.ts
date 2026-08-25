import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { composioFailure, composioSuccess, type ComposioResult } from "./composio-result.ts";

/** The executable Composio CLI path accepted after an execute-access check. */
export type ComposioCliPath = string & { readonly __brand: "ComposioCliPath" };

/** Failure to find an executable Composio CLI binary without inspecting credential files. */
export type ComposioCliPathError = {
  readonly _tag: "ComposioCliNotFound";
  readonly message: string;
  readonly searchedPaths: ReadonlyArray<string>;
};

/** Inputs that control Composio CLI binary discovery. */
export type ResolveComposioCliPathOptions = {
  readonly explicitPath?: string;
  readonly pathEnvironment?: string;
  readonly homeDirectory?: string;
  readonly baseDirectory?: string;
};

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateComposioCliPaths(options: ResolveComposioCliPathOptions): ReadonlyArray<string> {
  const baseDirectory = options.baseDirectory ?? process.cwd();
  const candidates: string[] = [];
  if (options.explicitPath?.trim()) {
    candidates.push(resolve(baseDirectory, options.explicitPath.trim()));
  }

  const pathEnvironment = options.pathEnvironment ?? process.env.PATH ?? "";
  for (const directory of pathEnvironment.split(delimiter)) {
    if (directory.trim()) {
      candidates.push(resolve(baseDirectory, directory, "composio"));
    }
  }

  const homeDirectory = resolve(baseDirectory, options.homeDirectory ?? homedir());
  candidates.push(join(homeDirectory, ".composio", "composio"));
  candidates.push(join(homeDirectory, ".npm-global", "bin", "composio"));

  return [...new Set(candidates)];
}

/** Resolve the official Composio CLI from an override, PATH, or known installer locations. */
export async function resolveComposioCliPath(
  options: ResolveComposioCliPathOptions = {},
): Promise<ComposioResult<ComposioCliPath, ComposioCliPathError>> {
  const searchedPaths = candidateComposioCliPaths(options);
  for (const path of searchedPaths) {
    if (await isExecutableFile(path)) {
      // SAFETY: The execute-access check above is the only constructor for this branded path.
      return composioSuccess(path as ComposioCliPath);
    }
  }

  return composioFailure({
    _tag: "ComposioCliNotFound",
    message:
      "Composio CLI not found. Install it or set COMPOSIO_CLI_PATH to an executable binary.",
    searchedPaths,
  });
}
