import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const CURSOR_RIPGREP_ENVIRONMENT_VARIABLE = "CURSOR_RIPGREP_PATH";

type CursorPlatformPackageJson = {
  readonly bin?: {
    readonly rg?: unknown;
  };
};

let cursorSdkModulePromise: Promise<typeof import("@cursor/sdk")> | undefined;

/**
 * Configure the absolute ripgrep path before Cursor initializes ignore files.
 *
 * Cursor SDK 1.0.24 can start ignore-map discovery before its own bundled
 * ripgrep resolver has populated the SDK-global path. Supplying the documented
 * environment override makes that initialization deterministic, including
 * when several Cursor agents start in the same host process.
 */
export function configureCursorRipgrepPath(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configuredPath = environment[CURSOR_RIPGREP_ENVIRONMENT_VARIABLE];
  if (
    configuredPath !== undefined &&
    isAbsolute(configuredPath) &&
    existsSync(configuredPath)
  ) {
    return configuredPath;
  }

  const resolvedPath =
    resolveBundledCursorRipgrepPath() ??
    resolveRipgrepFromEnvironmentPath(environment);
  if (resolvedPath !== undefined) {
    environment[CURSOR_RIPGREP_ENVIRONMENT_VARIABLE] = resolvedPath;
  }
  return resolvedPath;
}

/** Load the Cursor SDK once, after its process-wide ripgrep path is ready. */
export function loadCursorSdk(): Promise<typeof import("@cursor/sdk")> {
  if (cursorSdkModulePromise === undefined) {
    configureCursorRipgrepPath();
    cursorSdkModulePromise = import("@cursor/sdk");
  }
  return cursorSdkModulePromise;
}

/** Resolve the ripgrep executable shipped by Cursor's current platform package. */
export function resolveBundledCursorRipgrepPath(): string | undefined {
  const packageName = `@cursor/sdk-${process.platform}-${process.arch}`;
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const packageJson: unknown = JSON.parse(
      readFileSync(packageJsonPath, "utf8"),
    );
    if (!isCursorPlatformPackageJson(packageJson)) return undefined;

    const ripgrepPath = resolve(dirname(packageJsonPath), packageJson.bin.rg);
    return existsSync(ripgrepPath) ? ripgrepPath : undefined;
  } catch {
    return undefined;
  }
}

function resolveRipgrepFromEnvironmentPath(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const executableName = process.platform === "win32" ? "rg.exe" : "rg";
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, executableName);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function isCursorPlatformPackageJson(
  value: unknown,
): value is CursorPlatformPackageJson & { bin: { rg: string } } {
  if (typeof value !== "object" || value === null || !("bin" in value)) {
    return false;
  }
  const bin = value.bin;
  return (
    typeof bin === "object" &&
    bin !== null &&
    "rg" in bin &&
    typeof bin.rg === "string" &&
    bin.rg.length > 0
  );
}
