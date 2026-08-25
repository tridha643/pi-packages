import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

/** Custom entry that persists the active parent-session review loop marker. */
export const DELEGATE_REVIEW_LOOP_STATE_ENTRY =
  "delegate-review-loop-marker-state";

/** Custom entry used as the tree-navigation boundary for one review-fix interval. */
export const DELEGATE_REVIEW_LOOP_BOUNDARY_ENTRY =
  "delegate-review-loop-marker-boundary";

/** Review-specific tree label that cannot be confused with a generic review bookmark. */
export const DELEGATE_REVIEW_LOOP_MARKER_LABEL =
  "delegate-review-loop:fix-boundary";

/** Instructions for compacting one completed review-fix interval before the next review. */
export const DELEGATE_REVIEW_FIX_SUMMARY_INSTRUCTIONS = [
  "Summarize the completed review-fix interval before the next isolated review pass.",
  "Preserve the final accepted fixes, the review findings they address, intentionally skipped or deferred findings, files changed, decisions that constrain later work, checks run, and remaining risks.",
  "Discard abandoned attempts, temporary debugging details, incidental churn, and repeated review transcript.",
  "Write durable continuation context for the parent session so another review can begin immediately.",
].join("\n");

/** Parsed arguments for `/review`, including the optional persistent loop request. */
export interface DelegateReviewArguments {
  readonly startLoop: boolean;
  readonly focus: string;
}

/** Persistent state connecting a review-specific boundary to its semantic baseline. */
export interface DelegateReviewLoopMarkerState {
  readonly version: 1;
  readonly markerId: string;
  readonly semanticBaselineId?: string;
}

/** Outcome of placing or advancing a parent-session review loop marker. */
export type DelegateReviewMarkerPlacement =
  | {
      readonly status: "placed";
      readonly marker: DelegateReviewLoopMarkerState;
    }
  | {
      readonly status: "skipped";
      readonly reason: "marker-entry-not-appended";
    };

/** Explicit result of compacting the completed fixes before a later `/review`. */
export type DelegateReviewFixSummaryResult =
  | {
      readonly status: "summarized";
      readonly previousMarkerId: string;
      readonly nextMarkerId: string;
    }
  | {
      readonly status: "skipped";
      readonly reason:
        | "no-marker"
        | "marker-missing"
        | "no-semantic-leaf"
        | "no-fix-interval"
        | "next-marker-not-appended";
    }
  | {
      readonly status: "cancelled";
      readonly markerId: string;
    };

function isDelegateReviewLoopMarkerState(
  value: unknown,
): value is DelegateReviewLoopMarkerState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    version?: unknown;
    markerId?: unknown;
    semanticBaselineId?: unknown;
  };
  return (
    candidate.version === 1 &&
    typeof candidate.markerId === "string" &&
    (candidate.semanticBaselineId === undefined ||
      typeof candidate.semanticBaselineId === "string")
  );
}

/** Parse `/review [loop] [focus]`; dedicated reviewer routing is automatic. */
export function parseDelegateReviewArguments(
  argumentsText: string,
): DelegateReviewArguments {
  const trimmedArguments = argumentsText.trim();
  if (!trimmedArguments) return { startLoop: false, focus: "" };

  const loopMatch = /^loop(?:\s+([\s\S]*))?$/i.exec(trimmedArguments);

  return {
    startLoop: loopMatch !== null,
    focus: (loopMatch?.[1] ?? trimmedArguments).trim(),
  };
}

/** Read the latest valid review loop marker state on the active session branch. */
export function readDelegateReviewLoopMarker(
  context: ExtensionCommandContext,
): DelegateReviewLoopMarkerState | undefined {
  let latestMarker: DelegateReviewLoopMarkerState | undefined;
  for (const entry of context.sessionManager.getBranch()) {
    if (
      entry.type === "custom" &&
      entry.customType === DELEGATE_REVIEW_LOOP_STATE_ENTRY &&
      isDelegateReviewLoopMarkerState(entry.data)
    ) {
      latestMarker = entry.data;
    }
  }
  return latestMarker;
}

/** Find the current semantic leaf while ignoring extension state and label bookkeeping. */
export function findDelegateReviewSemanticLeafId(
  context: ExtensionCommandContext,
): string | undefined {
  let candidateId: string | null = context.sessionManager.getLeafId();
  while (candidateId) {
    const candidateEntry = context.sessionManager.getEntry(candidateId);
    if (!candidateEntry) return undefined;
    if (candidateEntry.type !== "custom" && candidateEntry.type !== "label") {
      return candidateEntry.id;
    }
    candidateId = candidateEntry.parentId;
  }
  return undefined;
}

/** Place a labeled custom boundary without overwriting labels on semantic conversation entries. */
export function placeDelegateReviewLoopMarker(
  extension: Pick<ExtensionAPI, "appendEntry" | "setLabel">,
  context: ExtensionCommandContext,
  previousMarker?: DelegateReviewLoopMarkerState,
): DelegateReviewMarkerPlacement {
  const semanticBaselineId = findDelegateReviewSemanticLeafId(context);

  if (
    previousMarker &&
    context.sessionManager.getLabel(previousMarker.markerId) ===
      DELEGATE_REVIEW_LOOP_MARKER_LABEL
  ) {
    extension.setLabel(previousMarker.markerId, undefined);
  }

  const leafBeforeBoundary = context.sessionManager.getLeafId();
  extension.appendEntry(DELEGATE_REVIEW_LOOP_BOUNDARY_ENTRY, { version: 1 });
  const markerId = context.sessionManager.getLeafId();
  if (!markerId || markerId === leafBeforeBoundary) {
    return { status: "skipped", reason: "marker-entry-not-appended" };
  }

  extension.setLabel(markerId, DELEGATE_REVIEW_LOOP_MARKER_LABEL);
  const marker = {
    version: 1,
    markerId,
    semanticBaselineId,
  } satisfies DelegateReviewLoopMarkerState;
  extension.appendEntry(DELEGATE_REVIEW_LOOP_STATE_ENTRY, marker);
  return { status: "placed", marker };
}

/** Compact completed review fixes through `navigateTree`, then advance the persistent marker. */
export async function summarizeDelegateReviewFixInterval(
  extension: Pick<ExtensionAPI, "appendEntry" | "setLabel">,
  context: ExtensionCommandContext,
): Promise<DelegateReviewFixSummaryResult> {
  const marker = readDelegateReviewLoopMarker(context);
  if (!marker) return { status: "skipped", reason: "no-marker" };
  if (!context.sessionManager.getEntry(marker.markerId)) {
    return { status: "skipped", reason: "marker-missing" };
  }

  const currentSemanticLeafId = findDelegateReviewSemanticLeafId(context);
  if (!currentSemanticLeafId) {
    return { status: "skipped", reason: "no-semantic-leaf" };
  }
  if (currentSemanticLeafId === marker.semanticBaselineId) {
    return { status: "skipped", reason: "no-fix-interval" };
  }

  const navigationResult = await context.navigateTree(marker.markerId, {
    summarize: true,
    customInstructions: DELEGATE_REVIEW_FIX_SUMMARY_INSTRUCTIONS,
    replaceInstructions: false,
  });
  if (navigationResult.cancelled) {
    return { status: "cancelled", markerId: marker.markerId };
  }

  const nextPlacement = placeDelegateReviewLoopMarker(
    extension,
    context,
    marker,
  );
  if (nextPlacement.status === "skipped") {
    return { status: "skipped", reason: "next-marker-not-appended" };
  }
  return {
    status: "summarized",
    previousMarkerId: marker.markerId,
    nextMarkerId: nextPlacement.marker.markerId,
  };
}
