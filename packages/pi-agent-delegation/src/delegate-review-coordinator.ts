import type {
  DelegateReviewFinding,
  DelegateReviewFindingTransition,
  DelegateReviewReport,
} from "./delegate-review-contract.ts";
import { transitionDelegateReviewFinding } from "./delegate-review-contract.ts";
import type { DelegateWorkspaceRevisionHash } from "./delegate-workspace-revision.ts";

type DelegateReviewModelFamily = "anthropic" | "openai" | "xai";

const DELEGATE_REVIEW_MODEL_FAMILY_PATTERNS: ReadonlyArray<
  readonly [DelegateReviewModelFamily, RegExp]
> = [
  ["anthropic", /\b(?:anthropic|claude|sonnet|opus|haiku)\b/u],
  ["openai", /\b(?:openai|codex|gpt)\b/u],
  ["xai", /\b(?:xai|grok)\b/u],
];

/** Select the dedicated review profile whose model family is absent from provenance. */
export function selectDelegateReviewProfile(
  provenance: ReadonlyArray<string>,
): "review-claude" | "review-codex" | "review-grok" {
  const authorFamilies = new Set<DelegateReviewModelFamily>();
  for (const entry of provenance) {
    const normalized = entry.toLowerCase();
    for (const [family, pattern] of DELEGATE_REVIEW_MODEL_FAMILY_PATTERNS) {
      if (pattern.test(normalized)) authorFamilies.add(family);
    }
  }

  if (!authorFamilies.has("anthropic")) return "review-claude";
  if (!authorFamilies.has("openai")) return "review-codex";
  if (!authorFamilies.has("xai")) return "review-grok";
  return "review-claude";
}

interface DelegateReviewBudget {
  /** Undefined means no arbitrary review round cap. */
  readonly remainingReviews?: number;
}

interface DelegateReviewStateBase {
  readonly revisionHash: DelegateWorkspaceRevisionHash;
  readonly findings: ReadonlyArray<DelegateReviewFinding>;
  readonly budget: DelegateReviewBudget;
}

/** Immutable state machine for a hash-bound delegate review and fix loop. */
export type DelegateReviewCoordinatorState =
  | (DelegateReviewStateBase & {
      readonly status: "review-running";
    })
  | (DelegateReviewStateBase & {
      readonly status: "awaiting-parent-fixes";
    })
  | (DelegateReviewStateBase & {
      readonly status: "ready-for-review";
    })
  | (DelegateReviewStateBase & {
      readonly status: "clean";
    })
  | (DelegateReviewStateBase & {
      readonly status: "blocked";
      readonly blockedReason: string;
    });

/** Searchable rejection of an invalid review coordinator transition. */
export interface DelegateReviewCoordinatorError {
  readonly code:
    | "invalid-review-transition"
    | "stale-review"
    | "unknown-finding"
    | "unresolved-findings";
  readonly message: string;
}

/** Safe result of applying one review coordinator transition. */
export type DelegateReviewCoordinatorResult =
  | { readonly ok: true; readonly state: DelegateReviewCoordinatorState }
  | { readonly ok: false; readonly error: DelegateReviewCoordinatorError };

/** Start the first review, blocking immediately only when an explicit budget is empty. */
export function createDelegateReviewCoordinator(
  revisionHash: DelegateWorkspaceRevisionHash,
  options: { readonly reviewBudget?: number } = {},
): DelegateReviewCoordinatorState {
  const reviewBudget = options.reviewBudget;
  if (
    reviewBudget !== undefined &&
    (!Number.isSafeInteger(reviewBudget) || reviewBudget < 0)
  ) {
    throw new Error(
      "Delegate review coordinator budget must be a non-negative safe integer.",
    );
  }
  if (reviewBudget === 0) {
    return freezeCoordinatorState({
      status: "blocked",
      revisionHash,
      findings: [],
      budget: { remainingReviews: 0 },
      blockedReason: "Delegate review budget was exhausted before review.",
    });
  }
  return freezeCoordinatorState({
    status: "review-running",
    revisionHash,
    findings: [],
    budget:
      reviewBudget === undefined
        ? {}
        : { remainingReviews: reviewBudget - 1 },
  });
}

/** Record a review only when it describes the exact revision that was requested. */
export function recordDelegateReviewReport(
  state: DelegateReviewCoordinatorState,
  reviewedRevisionHash: DelegateWorkspaceRevisionHash,
  currentRevisionHash: DelegateWorkspaceRevisionHash,
  report: DelegateReviewReport,
): DelegateReviewCoordinatorResult {
  if (state.status !== "review-running") {
    return coordinatorFailure(
      "invalid-review-transition",
      `Delegate review report cannot complete while ${state.status}.`,
    );
  }
  if (
    reviewedRevisionHash !== state.revisionHash ||
    currentRevisionHash !== state.revisionHash
  ) {
    return coordinatorFailure(
      "stale-review",
      "Delegate review report is stale because the workspace revision changed.",
    );
  }
  if (report.verdict === "clean") {
    return coordinatorSuccess({
      ...state,
      status: "clean",
      findings: [],
    });
  }
  return coordinatorSuccess({
    ...state,
    status: "awaiting-parent-fixes",
    findings: report.findings,
  });
}

/** Update one finding while the parent is accepting, rejecting, or fixing findings. */
export function updateDelegateReviewFinding(
  state: DelegateReviewCoordinatorState,
  fingerprint: DelegateReviewFinding["fingerprint"],
  transition: DelegateReviewFindingTransition,
): DelegateReviewCoordinatorResult {
  if (state.status !== "awaiting-parent-fixes") {
    return coordinatorFailure(
      "invalid-review-transition",
      `Delegate review finding cannot update while ${state.status}.`,
    );
  }
  const index = state.findings.findIndex(
    (finding) => finding.fingerprint === fingerprint,
  );
  if (index < 0) {
    return coordinatorFailure(
      "unknown-finding",
      `Delegate review finding "${fingerprint}" is not active.`,
    );
  }
  const transitioned = transitionDelegateReviewFinding(
    state.findings[index]!,
    transition,
  );
  if (!transitioned.ok) {
    return coordinatorFailure(
      "invalid-review-transition",
      transitioned.error.message,
    );
  }
  const findings = [...state.findings];
  findings[index] = transitioned.finding;
  return coordinatorSuccess({ ...state, findings });
}

/** Bind completed parent fixes to the current workspace revision for another review. */
export function markDelegateReviewReady(
  state: DelegateReviewCoordinatorState,
  currentRevisionHash: DelegateWorkspaceRevisionHash,
): DelegateReviewCoordinatorResult {
  if (state.status !== "awaiting-parent-fixes") {
    return coordinatorFailure(
      "invalid-review-transition",
      `Delegate review fixes cannot become ready while ${state.status}.`,
    );
  }
  const unresolved = state.findings.filter(
    (finding) =>
      finding.state !== "fixed" &&
      finding.state !== "verified" &&
      finding.state !== "rejected",
  );
  if (unresolved.length > 0) {
    return coordinatorFailure(
      "unresolved-findings",
      `Delegate review has ${unresolved.length} unresolved finding(s).`,
    );
  }
  return coordinatorSuccess({
    ...state,
    status: "ready-for-review",
    revisionHash: currentRevisionHash,
  });
}

/** Start another review without a cap unless the caller supplied and exhausted a budget. */
export function startNextDelegateReview(
  state: DelegateReviewCoordinatorState,
  currentRevisionHash: DelegateWorkspaceRevisionHash,
): DelegateReviewCoordinatorResult {
  if (state.status !== "ready-for-review") {
    return coordinatorFailure(
      "invalid-review-transition",
      `Delegate review cannot restart while ${state.status}.`,
    );
  }
  if (state.revisionHash !== currentRevisionHash) {
    return coordinatorFailure(
      "stale-review",
      "Delegate review ready state is stale because the workspace revision changed.",
    );
  }
  if (state.budget.remainingReviews === 0) {
    return coordinatorSuccess({
      ...state,
      status: "blocked",
      blockedReason: "Delegate review budget was exhausted before another review.",
    });
  }
  return coordinatorSuccess({
    ...state,
    status: "review-running",
    budget:
      state.budget.remainingReviews === undefined
        ? {}
        : { remainingReviews: state.budget.remainingReviews - 1 },
  });
}

/** Invalidate a terminal clean result when any later workspace edit changes its hash. */
export function validateDelegateReviewClean(
  state: DelegateReviewCoordinatorState,
  currentRevisionHash: DelegateWorkspaceRevisionHash,
): DelegateReviewCoordinatorResult {
  if (state.status !== "clean") {
    return coordinatorFailure(
      "invalid-review-transition",
      `Delegate review clean validation cannot run while ${state.status}.`,
    );
  }
  if (state.revisionHash !== currentRevisionHash) {
    return coordinatorFailure(
      "stale-review",
      "Delegate review clean result is stale because the workspace revision changed.",
    );
  }
  return coordinatorSuccess(state);
}

function coordinatorSuccess(
  state: DelegateReviewCoordinatorState,
): DelegateReviewCoordinatorResult {
  return Object.freeze({ ok: true, state: freezeCoordinatorState(state) });
}

function coordinatorFailure(
  code: DelegateReviewCoordinatorError["code"],
  message: string,
): DelegateReviewCoordinatorResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message }),
  });
}

function freezeCoordinatorState(
  state: DelegateReviewCoordinatorState,
): DelegateReviewCoordinatorState {
  const findings = Object.freeze([...state.findings]);
  const budget = Object.freeze({ ...state.budget });
  return Object.freeze({ ...state, findings, budget });
}
