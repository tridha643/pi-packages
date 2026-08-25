import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Effect, Layer, ManagedRuntime, Result } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { claudeBackend } from "./src/backends/claude.ts";
import {
  BackendPreflightRejectedError,
  type BackendName,
  type ParentContext,
  type SpawnTask,
} from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

test("Claude remains available through the SDK-bundled executable", async () => {
  assert.equal(await Effect.runPromise(claudeBackend.available), true);
});

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string, model?: string): SpawnTask {
  return {
    prompt,
    title: "Codex preflight test",
    cwd: process.cwd(),
    ...(model ? { model } : {}),
    parent,
  };
}

const fakeCodexSource = `#!/usr/bin/env node
import fs from "node:fs";

const log = process.env.FAKE_CODEX_LOG;
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (log && message.method) fs.appendFileSync(log, message.method + "\\n");
    if (message.method === "initialize") {
      write({ id: message.id, result: {} });
    } else if (message.method === "model/list") {
      write({
        id: message.id,
        result: {
          data: [{
            id: "known-model",
            model: "known-model",
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          }],
          nextCursor: null,
        },
      });
    } else if (message.method === "thread/start") {
      if (message.params?.serviceTier !== "fast") {
        write({
          id: message.id,
          error: { code: -32000, message: "thread/start requires fast service tier" },
        });
      } else {
        write({
          id: message.id,
          result: {
            thread: { id: "thread-1", path: "/tmp/fake-codex-rollout.jsonl" },
            model: message.params.model ?? "known-model",
          },
        });
      }
    } else if (message.method === "turn/start") {
      const prompt = message.params.input?.[0]?.text ?? "";
      if (prompt.includes("reject turn")) {
        write({
          id: message.id,
          error: { code: -32000, message: "turn rejected before start" },
        });
      } else {
        write({ id: message.id, result: { turn: { id: "turn-1" } } });
        write({
          method: "turn/started",
          params: { turn: { id: "turn-1" } },
        });
        if (prompt.includes("fail later")) {
          setTimeout(() => {
            write({
              method: "turn/completed",
              params: {
                turn: {
                  id: "turn-1",
                  status: "failed",
                  error: { message: "failure after turn acceptance" },
                },
              },
            });
          }, 10);
        }
      }
    }
  }
});
`;

test("Codex preflight rejects only before initial turn acceptance", async (t) => {
  const tempDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "headless-codex-preflight-"),
  );
  const binary = path.join(tempDirectory, "codex");
  const logFile = path.join(tempDirectory, "requests.log");
  fs.writeFileSync(binary, fakeCodexSource, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalLog = process.env.FAKE_CODEX_LOG;
  process.env.PATH = `${tempDirectory}${path.delimiter}${originalPath ?? ""}`;
  process.env.FAKE_CODEX_LOG = logFile;

  try {
    const { codexBackend } = await import("./src/backends/codex.ts");

    await t.test("unknown requested model is fallback-safe", async () => {
      fs.writeFileSync(logFile, "");
      const result = await Effect.runPromise(
        Effect.scoped(
          codexBackend
            .spawn(task("do not start", "missing-model"))
            .pipe(Effect.result),
        ),
      );
      assert.ok(Result.isFailure(result));
      assert.ok(result.failure instanceof BackendPreflightRejectedError);
      assert.match(result.failure.message, /Unknown Codex model/);
      assert.doesNotMatch(fs.readFileSync(logFile, "utf8"), /thread\/start/);
      assert.doesNotMatch(fs.readFileSync(logFile, "utf8"), /turn\/start/);
    });

    await t.test("explicit turn rejection is fallback-safe", async () => {
      const result = await Effect.runPromise(
        Effect.scoped(
          codexBackend.spawn(task("reject turn")).pipe(Effect.result),
        ),
      );
      assert.ok(Result.isFailure(result));
      assert.ok(result.failure instanceof BackendPreflightRejectedError);
      assert.match(result.failure.message, /turn rejected before start/);
    });

    await t.test(
      "failure after turn acceptance is a normal settled run",
      async () => {
        const RegistryLive = Layer.sync(BackendRegistry, () => {
          const backends: SubagentBackend[] = [codexBackend];
          return new Map<BackendName, SubagentBackend>(
            backends.map((backend) => [backend.name, backend]),
          );
        });
        const runtime = ManagedRuntime.make(
          SubagentManagerLive.pipe(Layer.provide(RegistryLive)),
        );
        try {
          const manager = await runtime.runPromise(SubagentManager);
          const spawned = await runTool(
            runtime,
            manager.spawn("codex", task("fail later")),
          );
          assert.equal(spawned.status, "running");
          await runTool(runtime, manager.waitFor([spawned.id]));
          const settled = manager.view.get(spawned.id);
          assert.equal(settled?.status, "error");
          assert.match(settled?.errorText ?? "", /failure after turn acceptance/);
        } finally {
          await runtime.dispose();
        }
      },
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = originalLog;
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});
