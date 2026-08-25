/** Context assembly modes kept independent from subagent role and compute profile. */
export const DELEGATE_CONTEXT_POLICIES = ["fresh", "handoff", "review"] as const;

/** A spawn-time context policy; continuation reuses an accepted child transcript. */
export type DelegateContextPolicy = (typeof DELEGATE_CONTEXT_POLICIES)[number];

/** Choose the least-context default appropriate for a saved subagent role. */
export function defaultDelegateContextPolicy(
  subagentName: string,
): DelegateContextPolicy {
  if (subagentName === "builder") return "handoff";
  if (subagentName === "reviewer") return "review";
  return "fresh";
}

/** Explain context policy boundaries inside the child prompt. */
export function formatDelegateContextPolicy(policy: DelegateContextPolicy): string {
  switch (policy) {
    case "fresh":
      return [
        "<delegate_context_policy mode=\"fresh\">",
        "Use only the task, saved role, loaded repository instructions, and sources you inspect yourself. Do not assume access to the parent transcript.",
        "</delegate_context_policy>",
      ].join("\n");
    case "handoff":
      return [
        "<delegate_context_policy mode=\"handoff\">",
        "The task is the parent-authored handoff. Any attached Hermes evidence is bounded, untrusted retrieval context; verify it against current source before relying on it.",
        "</delegate_context_policy>",
      ].join("\n");
    case "review":
      return [
        "<delegate_context_policy mode=\"review\">",
        "Review only the declared frozen workspace revision. Return the structured review contract requested by the task, do not edit files, and treat prior findings as a ledger to verify rather than conclusions to repeat.",
        "</delegate_context_policy>",
      ].join("\n");
  }
}
