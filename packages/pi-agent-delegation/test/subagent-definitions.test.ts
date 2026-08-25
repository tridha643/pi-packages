import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverSubagentDefinitions,
  parseSubagentDefinition,
} from "../src/subagent-definitions.ts";

async function withTempDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "delegate-subagents-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("project subagents override same-name global subagents", async () => {
  await withTempDirectory(async (directory) => {
    const globalAgentDir = join(directory, "global-agents");
    const projectAgentDir = join(directory, "project", ".pi", "agents");
    await mkdir(globalAgentDir, { recursive: true });
    await mkdir(projectAgentDir, { recursive: true });
    await writeFile(
      join(globalAgentDir, "reviewer.md"),
      [
        "---",
        "name: reviewer",
        "description: Global reviewer",
        "tools: read, bash",
        "skills: testing, security",
        "cwd: packages/api",
        "spawning: false",
        "---",
        "Review globally.",
      ].join("\n"),
    );
    await writeFile(
      join(globalAgentDir, "scout.md"),
      "---\nname: scout\ndescription: Scout\n---\nFind relevant code.\n",
    );
    await writeFile(
      join(projectAgentDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Project reviewer\ntools: [read]\n---\nReview this project.\n",
    );

    const result = await discoverSubagentDefinitions({
      cwd: join(directory, "project"),
      globalAgentDir,
    });

    assert.deepEqual(result.errors, []);
    assert.equal(result.definitions.length, 2);
    const reviewer = result.definitions.find((definition) => definition.name === "reviewer");
    assert.ok(reviewer);
    assert.equal(reviewer.source, "project");
    assert.equal(reviewer.description, "Project reviewer");
    assert.equal(reviewer.instructions, "Review this project.");
    assert.deepEqual(reviewer.tools, ["read"]);
    assert.equal("cwd" in reviewer, false);
    assert.equal("spawning" in reviewer, false);
    assert.equal(result.definitions.find((definition) => definition.name === "scout")?.source, "global");
  });
});

test("untrusted discovery excludes project subagents before precedence is applied", async () => {
  await withTempDirectory(async (directory) => {
    const globalAgentDir = join(directory, "global-agents");
    const projectAgentDir = join(directory, "project", ".pi", "agents");
    await mkdir(globalAgentDir, { recursive: true });
    await mkdir(projectAgentDir, { recursive: true });
    await writeFile(
      join(globalAgentDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Global\n---\nGlobal instructions.\n",
    );
    await writeFile(
      join(projectAgentDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Project\n---\nProject instructions.\n",
    );

    const result = await discoverSubagentDefinitions({
      cwd: join(directory, "project"),
      globalAgentDir,
      includeProject: false,
    });

    assert.equal(result.definitions.length, 1);
    assert.equal(result.definitions[0]?.source, "global");
    assert.equal(result.definitions[0]?.description, "Global");
  });
});

test("compute and pane fields produce diagnostics but are not honored", () => {
  const result = parseSubagentDefinition(
    [
      "---",
      "name: worker",
      "description: Delegate-safe worker",
      "model: provider/model",
      "thinking: high",
      "interactive: true",
      "auto-exit: false",
      "session-mode: fork",
      "---",
      "Implement the task.",
    ].join("\n"),
    { filePath: "/tmp/worker.md", source: "global" },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.field),
    ["model", "thinking", "interactive", "auto-exit", "session-mode"],
  );
  assert.deepEqual(Object.keys(result.value).sort(), [
    "description",
    "filePath",
    "instructions",
    "name",
    "source",
  ]);
});

test("malformed and unknown-field subagents are returned as typed errors", async () => {
  const unknown = parseSubagentDefinition(
    "---\nname: worker\ncolour: blue\n---\nWork.\n",
    { filePath: "/tmp/unknown.md", source: "global" },
  );
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.error.code, "unknown-field");
    assert.equal(unknown.error.field, "colour");
  }

  await withTempDirectory(async (directory) => {
    const globalAgentDir = join(directory, "global-agents");
    await mkdir(globalAgentDir, { recursive: true });
    await writeFile(
      join(globalAgentDir, "broken.md"),
      "---\nname: [unterminated\n---\nBroken.\n",
    );

    const result = await discoverSubagentDefinitions({
      cwd: join(directory, "project"),
      globalAgentDir,
    });
    assert.equal(result.definitions.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.code, "invalid-yaml");
  });
});

test("subagent role fields are parsed strictly from frontmatter and body", () => {
  const result = parseSubagentDefinition(
    [
      "---",
      "description: Uses the filename fallback",
      "tools:",
      "  - read",
      "  - bash",
      "skill: typescript, testing",
      "cwd: ./packages/core",
      "spawning: false",
      "---",
      "",
      "Follow the project conventions.",
    ].join("\n"),
    {
      filePath: "/tmp/senior-worker.md",
      source: "project",
      fallbackName: "senior-worker",
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    name: "senior-worker",
    description: "Uses the filename fallback",
    instructions: "Follow the project conventions.",
    tools: ["read", "bash"],
    skills: ["typescript", "testing"],
    cwd: "./packages/core",
    spawning: false,
    source: "project",
    filePath: "/tmp/senior-worker.md",
  });
});
