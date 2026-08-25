import assert from "node:assert/strict";
import test from "node:test";
import { formatDelegateRoutingPrompt } from "../src/delegate-routing-prompt.ts";
import type { DelegateProfileDiscoveryResult } from "../src/delegate-profiles.ts";
import type { SubagentDefinitionDiscoveryResult } from "../src/subagent-definitions.ts";

const subagents: SubagentDefinitionDiscoveryResult = {
  definitions: [
    {
      name: "scout",
      description: "Open-ended repository investigator; parent selects the exact model profile",
      source: "global",
      filePath: "/agents/scout.md",
    },
    {
      name: "reviewer",
      description: "Independent reviewer; parent selects the exact model profile",
      source: "project",
      filePath: "/project/.pi/agents/reviewer.md",
    },
  ],
  errors: [],
  diagnostics: [],
};

const profiles: DelegateProfileDiscoveryResult = {
  profiles: [
    {
      name: "fast",
      description: "Low-latency investigation",
      bestFor: ["Repository scans", "Bounded research"],
      strengths: ["Fast feedback", "Good tool use"],
      limitations: ["Less suitable for high-risk architecture"],
      target: { harness: "codex", model: "gpt-5.6-terra", reasoning: "medium" },
      source: "global",
      filePath: "/profiles/fast.yaml",
    },
    {
      name: "review-claude",
      description: "Dedicated Anthropic review target",
      bestFor: ["Review"],
      strengths: ["Independent perspective"],
      limitations: ["Review only"],
      target: { harness: "claude", model: "claude-opus", reasoning: "high" },
      source: "global",
      filePath: "/profiles/review-claude.yaml",
    },
  ],
  errors: [],
  diagnostics: [],
};

test("formats exact runtime subagent and profile routing metadata", () => {
  const prompt = formatDelegateRoutingPrompt({ subagents, profiles });

  assert.match(prompt, /<delegation_supervision>/);
  assert.match(prompt, /Classify the current user turn as answer, research, implementation, fix, review, or external operation/);
  assert.match(prompt, /For external operations, own only the specifically authorized action/);
  assert.match(prompt, /Delegation transfers execution, not responsibility/);
  assert.match(prompt, /A settled child result is evidence for the parent, not completion of the user's task/);
  assert.match(prompt, /role, compute profile, context policy, and control flow orthogonal/);
  assert.match(prompt, /Never infer an ordinary profile from the subagent role or parent model/);
  assert.match(prompt, /consciously choose a different profile/);
  assert.match(prompt, /shared current workspace/);
  assert.match(prompt, /Do not create worktrees unless the user explicitly approves one/);
  assert.match(prompt, /an external review pass is not required and must not be run by default/);
  assert.match(prompt, /run a single fresh read-only reviewer pass/);
  assert.match(prompt, /Do not open a repeating review-and-refix loop/);
  assert.match(prompt, /Retry failed work only with new evidence or a changed approach/);
  assert.match(prompt, /Finish when required tests and type checks pass on the latest revision/);
  // The old policy mandated an inverted review loop as the completion bar; it must stay gone,
  // because repeated rounds were by far the largest token cost in a normal session.
  assert.doesNotMatch(prompt, /iterative model-inverted review protocol/);
  assert.doesNotMatch(prompt, /clean inverted review/);
  assert.match(prompt, /Git commits, pushes, pull requests, merges, deployments, and external replies still require explicit authorization/);
  assert.match(prompt, /<\/delegation_supervision>/);
  assert.match(prompt, /<available_subagents>/);
  assert.match(prompt, /prefer delegate_parallel so they launch concurrently/);
  assert.match(prompt, /profile=one exact model target chosen from live tradeoffs/);
  assert.doesNotMatch(prompt, /compute=fast\|balanced\|deep/);
  assert.match(prompt, /scout \(global\): Open-ended repository investigator/);
  assert.match(prompt, /reviewer \(project\): Independent reviewer/);
  assert.match(
    prompt,
    /fast: target=codex\/gpt-5\.6-terra:medium — Low-latency investigation/,
  );
  assert.match(prompt, /detailed tradeoffs available progressively through delegate_profiles/);
  assert.match(prompt, /use search_tools to load delegate_profiles/);
  assert.match(prompt, /only the plausible candidates/);
  assert.match(prompt, /delegate_review selects dedicated exact review-\* profiles automatically from author provenance/);
  assert.doesNotMatch(prompt, /review-claude/);
  assert.doesNotMatch(prompt, /best for: Repository scans/);
  assert.doesNotMatch(prompt, /strengths: Fast feedback/);
  assert.doesNotMatch(prompt, /limitations: Less suitable/);
  assert.match(prompt, /exact targets; no implicit fallback/);
  assert.doesNotMatch(prompt, /ordered fallback candidates/);
  assert.match(prompt, /<\/available_subagents>/);
});
