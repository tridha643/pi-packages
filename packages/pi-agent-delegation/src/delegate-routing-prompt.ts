import type {
  DelegateProfileDiscoveryResult,
  DelegateProfileTarget,
} from "./delegate-profiles.ts";
import type { SubagentDefinitionDiscoveryResult } from "./subagent-definitions.ts";

const MAX_ROUTING_ENTRIES = 16;

const DELEGATION_SUPERVISION_POLICY = [
  "<delegation_supervision>",
  "Classify the current user turn as answer, research, implementation, fix, review, or external operation. Research and explanation requests do not authorize edits or external side effects.",
  "For a clear implementation, fix, or review request, own the requested outcome end-to-end. For external operations, own only the specifically authorized action. Do not stop at analysis, planning, delegation, or a partial fix.",
  "Delegation transfers execution, not responsibility. A settled child result is evidence for the parent, not completion of the user's task.",
  "Keep role, compute profile, context policy, and control flow orthogonal. Use fresh context for scouts, bounded Hermes handoffs for builders, continuation only for related corrections, and frozen-revision review context for reviewers.",
  "Choose an exact non-review saved profile from the brief routing catalog. When that summary does not make the choice clear, use search_tools to load delegate_profiles, then compare detailed bestFor, strengths, and limitations for only the plausible candidates. Never infer an ordinary profile from the subagent role or parent model.",
  "A saved profile has one exact model target and no implicit fallback. If that target is unavailable, inspect the failure and consciously choose a different profile; never substitute another model automatically.",
  "While children run, continue only useful non-overlapping work. In the shared current workspace, parallel builders require declared disjoint write_paths; the parent must not edit a child-owned path until that run settles. Do not create worktrees unless the user explicitly approves one.",
  "When results arrive, assess them against the original request and repository constraints; integrate valid work, continue a related delegate with concrete feedback, or launch fresh independent verification.",
  "Verify code changes with the repository's own tests, type checks, and targeted reproduction. That verification is the completion bar; an external review pass is not required and must not be run by default.",
  "Exercise the change, do not just compile it. Type checks and unit tests over pure helpers prove the pieces parse; wiring, lifecycle, teardown, and real I/O are exactly what they miss, and a reviewer reading source cannot substitute for running the code. Prefer the narrowest verification that actually executes the changed path end-to-end over more assertions against fixtures you wrote yourself.",
  "When an end-to-end run is genuinely blocked by a missing credential, an uninstalled binary, or no network, state that plainly and name every path left unverified. Do not launch reviewer rounds to compensate for missing runtime evidence, because a reviewer cannot verify runtime behavior either. Require the same of children: a builder must separate what it actually ran from what it only type-checked.",
  "Delegate a reviewer only when the user asks for review, or when a change is risky enough that you would genuinely expect a second pair of eyes to catch something tests cannot. When you do, run a single fresh read-only reviewer pass, triage its findings yourself, and stop. Do not open a repeating review-and-refix loop, and do not chain additional rounds to confirm your own fixes; cover each fix with a test instead.",
  "Retry failed work only with new evidence or a changed approach. After repeated failures, surface the blocker instead of looping blindly.",
  "Finish when required tests and type checks pass on the latest revision, no writer remains active, and no edits occurred afterward. Git commits, pushes, pull requests, merges, deployments, and external replies still require explicit authorization from the user or an applicable trusted project instruction.",
  "</delegation_supervision>",
].join("\n");

function formatProfileTarget(target: DelegateProfileTarget): string {
  return `${target.harness}/${target.model}:${target.reasoning}`;
}

function formatOmittedCount(total: number): string | undefined {
  const omitted = total - MAX_ROUTING_ENTRIES;
  return omitted > 0 ? `- ... ${omitted} more available through subagent_config` : undefined;
}

/** Format autonomous parent supervision policy and the live delegate routing catalog. */
export function formatDelegateRoutingPrompt(options: {
  readonly subagents: SubagentDefinitionDiscoveryResult;
  readonly profiles: DelegateProfileDiscoveryResult;
}): string {
  const subagentLines = options.subagents.definitions
    .slice(0, MAX_ROUTING_ENTRIES)
    .map(
      (subagent) =>
        `- ${subagent.name} (${subagent.source}): ${subagent.description ?? "No routing description"}`,
    );
  const omittedSubagents = formatOmittedCount(options.subagents.definitions.length);
  if (omittedSubagents) subagentLines.push(omittedSubagents);

  const ordinaryProfiles = options.profiles.profiles.filter(
    (profile) => !profile.name.startsWith("review-"),
  );
  const profileLines = ordinaryProfiles
    .slice(0, MAX_ROUTING_ENTRIES)
    .map((profile) =>
      `- ${profile.name}: target=${formatProfileTarget(profile.target)} — ${profile.description}`,
    );
  const omittedProfiles = formatOmittedCount(ordinaryProfiles.length);
  if (omittedProfiles) profileLines.push(omittedProfiles);

  return [
    DELEGATION_SUPERVISION_POLICY,
    "<available_subagents>",
    "Strict delegate routing uses exact saved subagent and profile names.",
    "Axes: role=scout|builder|reviewer; profile=one exact model target chosen from live tradeoffs; context=fresh|handoff|continue|review; control=parallel|single-pass review|cancellation|budgets.",
    "For 2-4 independent lanes, prefer delegate_parallel so they launch concurrently.",
    "Subagents:",
    subagentLines.join("\n") || "- none",
    "Ordinary profiles (exact targets; no implicit fallback; detailed tradeoffs available progressively through delegate_profiles):",
    profileLines.join("\n") || "- none",
    "delegate_review selects dedicated exact review-* profiles automatically from author provenance.",
    "</available_subagents>",
  ].join("\n");
}
