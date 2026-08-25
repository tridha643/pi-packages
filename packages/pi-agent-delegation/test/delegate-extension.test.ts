import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import registerDelegateExtension, {
  formatConfigurationList,
} from "../src/delegate-extension.ts";

interface CapturedTool {
  readonly name: string;
  readonly parameters: TSchema;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ExtensionContext,
  ): Promise<unknown>;
}

interface CapturedCommand {
  readonly description: string;
  readonly handler: (...arguments_: never[]) => Promise<void>;
}

interface CapturedExtensionRegistrations {
  readonly tools: Map<string, CapturedTool>;
  readonly commands: Map<string, CapturedCommand>;
}

function captureExtensionRegistrations(): CapturedExtensionRegistrations {
  const tools = new Map<string, CapturedTool>();
  const commands = new Map<string, CapturedCommand>();
  const extensionApiShape = {
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: CapturedCommand) {
      commands.set(name, command);
    },
    registerMessageRenderer() {},
    on() {},
    sendMessage() {},
    getThinkingLevel() {
      return "high" as const;
    },
  };
  // SAFETY: Registration only calls the methods above. Tool and command handlers
  // are not given this object as their runtime API in these boundary tests.
  registerDelegateExtension(extensionApiShape as unknown as ExtensionAPI);
  return { tools, commands };
}

function captureTools(): Map<string, CapturedTool> {
  return captureExtensionRegistrations().tools;
}

test("registers the strict /review command", () => {
  const { commands } = captureExtensionRegistrations();

  assert.deepEqual([...commands.keys()], ["review", "subagents"]);
  assert.match(commands.get("review")?.description ?? "", /frozen-revision/);
});

test("registers only the delegate-only public tool surface", () => {
  const tools = captureTools();

  assert.deepEqual([...tools.keys()], [
    "delegate",
    "delegate_parallel",
    "delegate_review",
    "delegate_continue",
    "delegate_freeform",
    "delegate_chain",
    "delegate_wait",
    "delegate_cancel",
    "delegate_check",
    "delegate_list",
    "delegate_profiles",
    "subagent_config",
  ]);
  assert.equal(tools.has("open_agent"), false);
  assert.equal(tools.has("subagent_wait"), false);
});

test("delegate_parallel requires two to four strict lanes", () => {
  const schema = captureTools().get("delegate_parallel")?.parameters;
  assert.ok(schema);
  const lane = {
    subagent: "scout",
    profile: "fast",
    task: "Inspect one independent subsystem.",
  };

  assert.equal(Value.Check(schema, { tasks: [lane, { ...lane, subagent: "reviewer" }] }), true);
  assert.equal(Value.Check(schema, { tasks: [lane] }), false);
  assert.equal(Value.Check(schema, { tasks: [lane, lane, lane, lane, lane] }), false);
  assert.equal(
    Value.Check(schema, { tasks: [lane, { ...lane, unknown: true }] }),
    false,
  );
});

test("delegate_review automatically selects its structured reviewer profile", () => {
  const schema = captureTools().get("delegate_review")?.parameters;
  assert.ok(schema);

  assert.equal(
    Value.Check(schema, {
      action: "start",
      task: "Review the complete implementation.",
      review_budget: 3,
    }),
    true,
  );
  assert.equal(
    Value.Check(schema, {
      action: "resume",
      id: "review-1",
      dispositions: [
        { fingerprint: "abc", decision: "fixed", evidence: "Added a regression test." },
      ],
    }),
    true,
  );
  assert.equal(Value.Check(schema, { action: "status", id: "review-1" }), true);
  assert.equal(Value.Check(schema, { action: "resume", id: "review-1" }), false);
  assert.equal(
    Value.Check(schema, {
      action: "start",
      task: "Review without an explicit profile.",
    }),
    true,
  );
  assert.equal(
    Value.Check(schema, { action: "start", profile: "review-claude", task: "Review." }),
    false,
  );
});

test("delegate_profiles requires a bounded unique exact-name request", () => {
  const schema = captureTools().get("delegate_profiles")?.parameters;
  assert.ok(schema);
  assert.equal(Value.Check(schema, { profiles: ["fast"] }), true);
  assert.equal(Value.Check(schema, { profiles: [] }), false);
  assert.equal(Value.Check(schema, { profiles: ["fast", "fast"] }), false);
  assert.equal(Value.Check(schema, { profiles: ["fast"], unexpected: true }), false);
});

test("delegate_profiles returns requested metadata and names unknown profiles", async () => {
  const tool = captureTools().get("delegate_profiles");
  assert.ok(tool);
  const cwd = await mkdtemp(join(tmpdir(), "delegate-profiles-"));
  try {
    const profileDir = join(cwd, ".pi", "delegate-profiles");
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, "fast.yaml"),
      "name: fast\ndescription: Low-latency investigation\nbestFor:\n  - Repository scans\nstrengths:\n  - Fast feedback\nlimitations:\n  - Less depth\ntarget:\n  harness: codex\n  model: gpt-5.6-terra\n  reasoning: medium\n",
    );
    const context = {
      cwd,
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext;
    const result = await tool.execute(
      "tool-profiles",
      { profiles: ["fast"] },
      undefined,
      undefined,
      context,
    );
    assert.match(JSON.stringify(result), /Low-latency investigation/);
    await assert.rejects(
      tool.execute(
        "tool-profiles-unknown",
        { profiles: ["missing"] },
        undefined,
        undefined,
        context,
      ),
      /Unknown delegate profile name\(s\): missing\. Available:/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("delegate_continue accepts only an id and related task", () => {
  const schema = captureTools().get("delegate_continue")?.parameters;
  assert.ok(schema);

  assert.equal(Value.Check(schema, { id: "sa-1", task: "Inspect the failing test." }), true);
  assert.equal(Value.Check(schema, { id: "sa-1" }), false);
  assert.equal(
    Value.Check(schema, { id: "sa-1", task: "Continue.", profile: "fast" }),
    false,
  );
});

test("subagent_config uses action-specific discriminated schemas", () => {
  const schema = captureTools().get("subagent_config")?.parameters;
  assert.ok(schema);

  assert.equal(Value.Check(schema, { action: "list" }), true);
  assert.equal(Value.Check(schema, { action: "save_subagent" }), false);
  assert.equal(
    Value.Check(schema, {
      action: "save_subagent",
      scope: "global",
      name: "bee",
      description: "Skeptical reviewer",
      instructions: "Challenge assumptions.",
    }),
    true,
  );
  assert.equal(
    Value.Check(schema, {
      action: "save_profile",
      scope: "global",
      name: "empty",
      description: "Exact target",
      bestFor: ["Implementation"],
      strengths: ["Reliable edits"],
      limitations: ["Higher latency"],
      target: { harness: "pi", model: "provider/model", reasoning: "high" },
    }),
    true,
  );
  assert.equal(
    Value.Check(schema, {
      action: "save_profile",
      scope: "global",
      name: "legacy",
      description: "Legacy fallback",
      candidates: [],
    }),
    false,
  );
  assert.equal(
    Value.Check(schema, {
      action: "delete",
      scope: "global",
      name: "bee",
    }),
    false,
  );
});

test("configuration listing exposes exact profile task-fit metadata", () => {
  const text = formatConfigurationList({
    subagents: {
      definitions: [],
      errors: [],
      diagnostics: [],
    },
    profiles: {
      profiles: [
        {
          name: "balanced",
          description: "Balanced implementation target",
          bestFor: ["Normal feature work"],
          strengths: ["Reliable editing"],
          limitations: ["Slower than fast"],
          target: {
            harness: "codex",
            model: "gpt-5.6-sol",
            reasoning: "medium",
          },
          source: "global",
          filePath: "/profiles/balanced.yaml",
        },
      ],
      errors: [],
      diagnostics: [],
    },
  });

  assert.match(text, /target=codex\/gpt-5\.6-sol:medium/);
  assert.match(text, /description: Balanced implementation target/);
  assert.match(text, /best for: Normal feature work/);
  assert.match(text, /strengths: Reliable editing/);
  assert.match(text, /limitations: Slower than fast/);
});

test("delegate_chain rejects cancellation before resolving or spawning steps", async () => {
  const tool = captureTools().get("delegate_chain");
  assert.ok(tool);
  const abort = new AbortController();
  abort.abort();
  const contextShape = {
    cwd: "/tmp/aborted-chain",
    isProjectTrusted: () => false,
  };
  // SAFETY: The handler checks the aborted signal before using other context APIs.
  const context = contextShape as unknown as ExtensionContext;

  await assert.rejects(
    tool.execute(
      "tool-chain",
      {
        name: "cancelled",
        steps: [
          {
            subagent: "bee",
            profile: "fast",
            task: "Must never start.",
          },
        ],
      },
      abort.signal,
      undefined,
      context,
    ),
    /creation was aborted/,
  );
});

test("subagent_config rejects project writes when the project is untrusted", async () => {
  const tool = captureTools().get("subagent_config");
  assert.ok(tool);
  const contextShape = {
    cwd: "/tmp/untrusted-project",
    isProjectTrusted: () => false,
  };
  // SAFETY: The handler rejects on trust before reading any other context API.
  const context = contextShape as unknown as ExtensionContext;

  await assert.rejects(
    tool.execute(
      "tool-1",
      {
        action: "save_subagent",
        scope: "project",
        name: "bee",
        description: "Reviewer",
        instructions: "Review.",
      },
      undefined,
      undefined,
      context,
    ),
    /requires a trusted project/,
  );
});
