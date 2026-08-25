import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFreeformSubagentPrompt,
  buildNamedSubagentPrompt,
} from "../src/delegate-prompt.ts";

test("named subagent prompts keep identity, task, skills, and prior output separate", () => {
  const prompt = buildNamedSubagentPrompt({
    subagent: {
      name: "bee",
      description: "Skeptically tests conclusions.",
      instructions: "Find unsupported assumptions.",
      skills: ["testing-quality", "autoreview"],
    },
    task: "Review the authentication design.",
    previousStepResult: "Scott found auth.ts.",
  });

  assert.match(prompt, /named headless subagent "bee"/);
  assert.match(prompt, /<subagent_purpose>\nSkeptically tests conclusions\./);
  assert.match(prompt, /<subagent_skills>\ntesting-quality\nautoreview/);
  assert.match(prompt, /untrusted working context/);
  assert.match(prompt, /<previous_step_result>\nScott found auth\.ts\./);
  assert.match(prompt, /<task>\nReview the authentication design\./);
});

test("named prompts keep context and shared-workspace ownership explicit", () => {
  const prompt = buildNamedSubagentPrompt({
    subagent: {
      name: "builder",
      description: "Implements one isolated scope.",
      instructions: "Edit only owned files.",
    },
    task: "Implement the review coordinator.",
    contextPolicy: "handoff",
    // SAFETY: This branded path is test data matching parser-normalized ownership output.
    writePaths: ["src/review" as never],
    evidencePack: {
      id: "pack-1",
      query: "review coordinator",
      project: "repo",
      memories: [
        {
          sourceId: "memory:7",
          category: "preference",
          content: "Use the shared workspace.",
          created: "2026-07-24",
        },
      ],
      sessions: [],
      diagnostics: [],
      limits: { memoryCount: 1, sessionCount: 0, totalCharacters: 25 },
    },
  });

  assert.match(prompt, /mode="handoff"/);
  assert.match(prompt, /hermes_evidence_pack id="pack-1"/);
  assert.match(prompt, /memory:7/);
  assert.match(prompt, /shared_workspace_write_ownership/);
  assert.match(prompt, /Do not create a worktree/);
});

test("freeform prompts omit an absent instruction block", () => {
  const prompt = buildFreeformSubagentPrompt({
    name: "API investigator",
    task: "Trace the failing request.",
  });

  assert.doesNotMatch(prompt, /subagent_instructions/);
  assert.match(prompt, /one-off headless subagent "API investigator"/);
  assert.match(prompt, /<task>\nTrace the failing request\./);
});
