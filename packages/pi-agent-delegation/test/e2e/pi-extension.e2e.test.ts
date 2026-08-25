import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const INSTALLED_PI_VERSION = "0.84.3";
const PROCESS_TIMEOUT_MS = 30_000;
const FORCE_KILL_DELAY_MS = 2_000;
const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIRECTORY, "..", "..");
const FIXTURE_PACKAGE_ROOT = TEST_DIRECTORY;

interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly processGroupCleaned: boolean;
}

interface JsonEvent {
  readonly type?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

interface RunStoreEvent {
  readonly event: "launched" | "continued" | "settled";
  readonly delegateId: string;
  readonly runGeneration: number;
  readonly status?: "done" | "error";
}

function isolatedProcessEnvironment(paths: {
  readonly home: string;
  readonly agentDirectory: string;
  readonly xdgConfig: string;
  readonly xdgCache: string;
  readonly xdgData: string;
  readonly xdgState: string;
  readonly evidencePath: string;
}): NodeJS.ProcessEnv {
  return {
    HOME: paths.home,
    PATH: process.env.PATH,
    TMPDIR: tmpdir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    PI_CODING_AGENT_DIR: paths.agentDirectory,
    PI_DELEGATION_E2E_EVIDENCE_PATH: paths.evidencePath,
    PI_OFFLINE: "1",
    PI_SKIP_RUNTIME_DEP_REPAIR: "1",
    PI_TELEMETRY: "0",
    XDG_CACHE_HOME: paths.xdgCache,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_DATA_HOME: paths.xdgData,
    XDG_STATE_HOME: paths.xdgState,
  };
}

function processGroupExists(processId: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function terminateProcessGroup(processId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? processId : -processId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function runInstalledPi(
  arguments_: string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  const child = spawn("pi", arguments_, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) terminateProcessGroup(child.pid, "SIGTERM");
  }, PROCESS_TIMEOUT_MS);
  const forceKill = setTimeout(() => {
    if (timedOut && child.pid !== undefined && processGroupExists(child.pid)) {
      terminateProcessGroup(child.pid, "SIGKILL");
    }
  }, PROCESS_TIMEOUT_MS + FORCE_KILL_DELAY_MS);

  const result = await new Promise<ProcessResult>((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
      const processGroupCleaned =
        child.pid === undefined || !processGroupExists(child.pid);
      resolveResult({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        processGroupCleaned,
      });
    });
  });
  return result;
}

function parseJsonEvents(stdout: string): JsonEvent[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as JsonEvent);
}

function assertSuccessfulToolLifecycle(
  events: JsonEvent[],
  toolName: string,
  expectedCount: number,
): void {
  const starts = events.filter(
    (event) => event.type === "tool_execution_start" && event.toolName === toolName,
  );
  const ends = events.filter(
    (event) => event.type === "tool_execution_end" && event.toolName === toolName,
  );
  assert.equal(starts.length, expectedCount, `unexpected ${toolName} start count`);
  assert.equal(ends.length, expectedCount, `unexpected ${toolName} end count`);
  assert.equal(
    ends.every((event) => event.isError === false),
    true,
    `${toolName} ended with an error`,
  );
}

function assistantMessageText(event: JsonEvent): string | undefined {
  if (event.type !== "message_end") return undefined;
  const message = event.message;
  if (!message || typeof message !== "object") return undefined;
  const record = message as {
    readonly role?: string;
    readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
  };
  if (record.role !== "assistant" || !Array.isArray(record.content)) return undefined;
  return record.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

async function readJsonLines(path: string): Promise<Record<string, unknown>[]> {
  const contents = await readFile(path, "utf8");
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test(
  "packaged Pi extension delegates, waits, continues, and runs overlapping lanes in a real process",
  { timeout: PROCESS_TIMEOUT_MS + FORCE_KILL_DELAY_MS + 10_000 },
  async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-delegation-e2e-"));
    const home = join(temporaryRoot, "home");
    // Saved delegate definitions currently follow HOME/.pi/agent, while Pi's
    // settings root follows PI_CODING_AGENT_DIR. Keep both isolated and aligned.
    const agentDirectory = join(home, ".pi", "agent");
    const workspace = join(temporaryRoot, "workspace");
    const evidencePath = join(temporaryRoot, "faux-evidence.jsonl");
    const paths = {
      home,
      agentDirectory,
      workspace,
      evidencePath,
      xdgConfig: join(temporaryRoot, "xdg-config"),
      xdgCache: join(temporaryRoot, "xdg-cache"),
      xdgData: join(temporaryRoot, "xdg-data"),
      xdgState: join(temporaryRoot, "xdg-state"),
    };

    try {
      await Promise.all([
        mkdir(join(agentDirectory, "agents"), { recursive: true }),
        mkdir(join(agentDirectory, "delegate-profiles"), { recursive: true }),
        mkdir(workspace, { recursive: true }),
        mkdir(home, { recursive: true }),
        mkdir(paths.xdgConfig, { recursive: true }),
        mkdir(paths.xdgCache, { recursive: true }),
        mkdir(paths.xdgData, { recursive: true }),
        mkdir(paths.xdgState, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(agentDirectory, "settings.json"),
          `${JSON.stringify(
            {
              defaultProvider: "delegation-e2e-faux",
              defaultModel: "delegation-e2e-model",
              quietStartup: true,
              packages: [PACKAGE_ROOT, FIXTURE_PACKAGE_ROOT],
            },
            null,
            2,
          )}\n`,
        ),
        writeFile(
          join(agentDirectory, "models.json"),
          `${JSON.stringify(
            {
              providers: {
                "delegation-e2e-faux": {
                  baseUrl: "http://localhost:0",
                  api: "delegation-e2e-faux-api",
                  apiKey: "unused-local-test-placeholder",
                  models: [
                    {
                      id: "delegation-e2e-model",
                      name: "Delegation E2E Faux",
                      reasoning: false,
                      input: ["text"],
                      cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                      },
                      contextWindow: 32_000,
                      maxTokens: 4_096,
                    },
                  ],
                },
              },
            },
            null,
            2,
          )}\n`,
        ),
        writeFile(
          join(agentDirectory, "agents", "builder.md"),
          [
            "---",
            "name: builder",
            "description: Deterministic E2E child",
            "---",
            "Follow the task exactly and return only the requested marker.",
            "",
          ].join("\n"),
        ),
        writeFile(
          join(agentDirectory, "delegate-profiles", "strict-faux.yaml"),
          [
            "name: strict-faux",
            "description: Exact credential-free Pi faux target",
            "bestFor:",
            "  - Deterministic process tests",
            "strengths:",
            "  - Scripted local responses",
            "limitations:",
            "  - Test-only behavior",
            "target:",
            "  harness: pi",
            "  model: delegation-e2e-faux/delegation-e2e-model",
            "  reasoning: off",
            "",
          ].join("\n"),
        ),
      ]);

      const env = isolatedProcessEnvironment(paths);
      const version = await runInstalledPi(["--version"], { cwd: workspace, env });
      assert.equal(version.timedOut, false, "pi --version timed out");
      assert.equal(version.exitCode, 0, version.stderr);
      assert.equal(version.stdout.trim(), INSTALLED_PI_VERSION);
      assert.equal(version.processGroupCleaned, true, "pi --version left its process group alive");

      const result = await runInstalledPi(
        [
          "--mode",
          "json",
          "--print",
          "--offline",
          "--no-session",
          "--no-builtin-tools",
          "--tools",
          "delegate,delegate_wait,delegate_continue,delegate_parallel",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--approve",
          "--provider",
          "delegation-e2e-faux",
          "--model",
          "delegation-e2e-model",
          "PARENT_E2E_SCRIPT: Execute the scripted delegation lifecycle.",
        ],
        { cwd: workspace, env },
      );

      assert.equal(result.timedOut, false, `real pi process timed out\n${result.stderr}`);
      assert.equal(result.signal, null, `real pi process exited by ${result.signal}`);
      assert.equal(result.exitCode, 0, `real pi process failed\n${result.stderr}\n${result.stdout}`);
      assert.equal(result.processGroupCleaned, true, "real pi process left its process group alive");

      const jsonEvents = parseJsonEvents(result.stdout);
      const toolCallCounts = new Map([
        ["delegate", 1],
        ["delegate_wait", 3],
        ["delegate_continue", 1],
        ["delegate_parallel", 1],
      ]);
      for (const [toolName, expectedCount] of toolCallCounts) {
        assertSuccessfulToolLifecycle(jsonEvents, toolName, expectedCount);
      }
      const assistantMessages = jsonEvents
        .map(assistantMessageText)
        .filter((text): text is string => text !== undefined && text.length > 0);
      assert.equal(assistantMessages.at(-1), "E2E_OK");
      assert.equal(jsonEvents.some((event) => event.type === "agent_end"), true);

      const fixtureEvidence = await readJsonLines(evidencePath);
      const evidenceEvents = fixtureEvidence.map((entry) => entry.event);
      assert.equal(evidenceEvents.includes("session-start"), true);
      assert.equal(evidenceEvents.at(-1), "session-shutdown");
      assert.equal(
        fixtureEvidence.some(
          (entry) =>
            entry.event === "continuation-result" &&
            entry.result === "CONTINUE_OK saw DIRECT_OK",
        ),
        true,
      );
      const parallelEntryIndexes = fixtureEvidence
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.event === "parallel-enter")
        .map(({ index }) => index);
      const parallelReleaseIndex = fixtureEvidence.findIndex(
        (entry) => entry.event === "parallel-release",
      );
      assert.equal(parallelEntryIndexes.length, 2);
      assert.equal(
        parallelEntryIndexes.every((index) => index < parallelReleaseIndex),
        true,
        "both parallel children must enter before the barrier releases",
      );

      const runStoreRoot = join(
        home,
        ".pi",
        "agent",
        "pi-hermes-memory",
        "delegation-runs",
      );
      const runStoreFiles = (await readdir(runStoreRoot, { recursive: true }))
        .filter((path) => path.endsWith(".jsonl"))
        .map((path) => join(runStoreRoot, path));
      assert.equal(runStoreFiles.length, 1);
      const runEvents = (await readJsonLines(runStoreFiles[0]!)) as unknown as RunStoreEvent[];
      const continued = runEvents.find((event) => event.event === "continued");
      assert.ok(continued, "missing generation 2 continued event");
      assert.equal(continued.runGeneration, 2);
      const directEvents = runEvents.filter(
        (event) => event.delegateId === continued.delegateId,
      );
      assert.equal(
        directEvents.some(
          (event) => event.event === "launched" && event.runGeneration === 1,
        ),
        true,
      );
      assert.equal(
        directEvents.some(
          (event) =>
            event.event === "settled" &&
            event.runGeneration === 1 &&
            event.status === "done",
        ),
        true,
      );
      assert.equal(
        directEvents.some(
          (event) =>
            event.event === "settled" &&
            event.runGeneration === 2 &&
            event.status === "done",
        ),
        true,
      );
      const parallelLaunches = runEvents.filter(
        (event) =>
          event.event === "launched" &&
          event.runGeneration === 1 &&
          event.delegateId !== continued.delegateId,
      );
      assert.equal(parallelLaunches.length, 2);
      for (const launch of parallelLaunches) {
        assert.equal(
          runEvents.some(
            (event) =>
              event.event === "settled" &&
              event.delegateId === launch.delegateId &&
              event.runGeneration === 1 &&
              event.status === "done",
          ),
          true,
          `missing settled event for ${launch.delegateId}`,
        );
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);
