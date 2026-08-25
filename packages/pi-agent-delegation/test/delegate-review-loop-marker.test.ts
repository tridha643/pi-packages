import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  DELEGATE_REVIEW_FIX_SUMMARY_INSTRUCTIONS,
  DELEGATE_REVIEW_LOOP_BOUNDARY_ENTRY,
  DELEGATE_REVIEW_LOOP_MARKER_LABEL,
  DELEGATE_REVIEW_LOOP_STATE_ENTRY,
  findDelegateReviewSemanticLeafId,
  parseDelegateReviewArguments,
  placeDelegateReviewLoopMarker,
  readDelegateReviewLoopMarker,
  summarizeDelegateReviewFixInterval,
} from "../src/delegate-review-loop-marker.ts";

interface NavigateCall {
  readonly targetId: string;
  readonly options: Parameters<ExtensionCommandContext["navigateTree"]>[1];
}

function createReviewSession(options: { cancelNavigation?: boolean } = {}) {
  const sessionManager = SessionManager.inMemory("/tmp/review-project");
  const navigateCalls: NavigateCall[] = [];
  const extension = {
    appendEntry(customType: string, data?: unknown) {
      sessionManager.appendCustomEntry(customType, data);
    },
    setLabel(entryId: string, label: string | undefined) {
      sessionManager.appendLabelChange(entryId, label);
    },
  } satisfies Pick<ExtensionAPI, "appendEntry" | "setLabel">;
  const context = {
    sessionManager,
    async navigateTree(
      targetId: string,
      navigationOptions?: Parameters<
        ExtensionCommandContext["navigateTree"]
      >[1],
    ) {
      navigateCalls.push({ targetId, options: navigationOptions });
      if (options.cancelNavigation) return { cancelled: true };
      sessionManager.branchWithSummary(
        targetId,
        "Durable summary of accepted review fixes.",
        undefined,
        true,
      );
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;

  return { sessionManager, extension, context, navigateCalls };
}

test("parses automatic /review routing and preserves a multi-word focus", () => {
  assert.deepEqual(parseDelegateReviewArguments(""), {
    startLoop: false,
    focus: "",
  });
  assert.deepEqual(parseDelegateReviewArguments("security and error handling"), {
    startLoop: false,
    focus: "security and error handling",
  });
  assert.deepEqual(
    parseDelegateReviewArguments("  LOOP   concurrency\nand cleanup  "),
    {
      startLoop: true,
      focus: "concurrency\nand cleanup",
    },
  );
  assert.deepEqual(parseDelegateReviewArguments("loopholes only"), {
    startLoop: false,
    focus: "loopholes only",
  });
});

test("persists a labeled custom boundary while retaining the semantic leaf", () => {
  const { sessionManager, extension, context } = createReviewSession();
  const semanticLeafId = sessionManager.appendCustomMessageEntry(
    "test-parent-message",
    "Review findings were fixed.",
    false,
  );
  sessionManager.appendCustomEntry("unrelated-extension-state", {
    ignored: true,
  });
  sessionManager.appendLabelChange(semanticLeafId, "user-bookmark");

  assert.equal(findDelegateReviewSemanticLeafId(context), semanticLeafId);
  const placement = placeDelegateReviewLoopMarker(extension, context);
  assert.equal(placement.status, "placed");
  if (placement.status !== "placed") return;

  assert.equal(
    sessionManager.getEntry(placement.marker.markerId)?.type,
    "custom",
  );
  assert.equal(
    (
      sessionManager.getEntry(placement.marker.markerId) as {
        customType?: string;
      }
    ).customType,
    DELEGATE_REVIEW_LOOP_BOUNDARY_ENTRY,
  );
  assert.equal(
    sessionManager.getLabel(placement.marker.markerId),
    DELEGATE_REVIEW_LOOP_MARKER_LABEL,
  );
  assert.equal(sessionManager.getLabel(semanticLeafId), "user-bookmark");
  assert.deepEqual(readDelegateReviewLoopMarker(context), placement.marker);
  assert.equal(placement.marker.semanticBaselineId, semanticLeafId);
  assert.equal(findDelegateReviewSemanticLeafId(context), semanticLeafId);
  assert.ok(
    sessionManager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === DELEGATE_REVIEW_LOOP_STATE_ENTRY,
      ),
  );
});

test("summarizes a completed fix interval and advances its owned marker", async () => {
  const { sessionManager, extension, context, navigateCalls } =
    createReviewSession();
  sessionManager.appendCustomMessageEntry(
    "test-review-findings",
    "Finding: validate the input.",
    false,
  );
  const initialPlacement = placeDelegateReviewLoopMarker(extension, context);
  assert.equal(initialPlacement.status, "placed");
  if (initialPlacement.status !== "placed") return;

  const fixedLeafId = sessionManager.appendCustomMessageEntry(
    "test-parent-fix",
    "Validated the input and added a regression test.",
    false,
  );
  sessionManager.appendCustomEntry("other-extension-state", { active: true });
  assert.equal(findDelegateReviewSemanticLeafId(context), fixedLeafId);

  const result = await summarizeDelegateReviewFixInterval(extension, context);
  assert.equal(result.status, "summarized");
  if (result.status !== "summarized") return;

  assert.equal(result.previousMarkerId, initialPlacement.marker.markerId);
  assert.notEqual(result.nextMarkerId, result.previousMarkerId);
  assert.equal(navigateCalls.length, 1);
  assert.equal(navigateCalls[0]?.targetId, result.previousMarkerId);
  assert.deepEqual(navigateCalls[0]?.options, {
    summarize: true,
    customInstructions: DELEGATE_REVIEW_FIX_SUMMARY_INSTRUCTIONS,
    replaceInstructions: false,
  });
  assert.equal(
    sessionManager.getLabel(result.previousMarkerId),
    undefined,
  );
  assert.equal(
    sessionManager.getLabel(result.nextMarkerId),
    DELEGATE_REVIEW_LOOP_MARKER_LABEL,
  );
  assert.equal(readDelegateReviewLoopMarker(context)?.markerId, result.nextMarkerId);
});

test("returns skipped for an empty interval without navigating", async () => {
  const { sessionManager, extension, context, navigateCalls } =
    createReviewSession();
  sessionManager.appendCustomMessageEntry(
    "test-review-findings",
    "No fix has been made yet.",
    false,
  );
  placeDelegateReviewLoopMarker(extension, context);

  assert.deepEqual(
    await summarizeDelegateReviewFixInterval(extension, context),
    { status: "skipped", reason: "no-fix-interval" },
  );
  assert.equal(navigateCalls.length, 0);
});

test("returns skipped without state and cancelled without advancing state", async () => {
  const emptySession = createReviewSession();
  assert.deepEqual(
    await summarizeDelegateReviewFixInterval(
      emptySession.extension,
      emptySession.context,
    ),
    { status: "skipped", reason: "no-marker" },
  );

  const cancelledSession = createReviewSession({ cancelNavigation: true });
  cancelledSession.sessionManager.appendCustomMessageEntry(
    "test-review-findings",
    "Finding: handle cancellation.",
    false,
  );
  const placement = placeDelegateReviewLoopMarker(
    cancelledSession.extension,
    cancelledSession.context,
  );
  assert.equal(placement.status, "placed");
  if (placement.status !== "placed") return;
  cancelledSession.sessionManager.appendCustomMessageEntry(
    "test-parent-fix",
    "Cancellation is now handled.",
    false,
  );

  assert.deepEqual(
    await summarizeDelegateReviewFixInterval(
      cancelledSession.extension,
      cancelledSession.context,
    ),
    { status: "cancelled", markerId: placement.marker.markerId },
  );
  assert.equal(
    readDelegateReviewLoopMarker(cancelledSession.context)?.markerId,
    placement.marker.markerId,
  );
  assert.equal(
    cancelledSession.sessionManager.getLabel(placement.marker.markerId),
    DELEGATE_REVIEW_LOOP_MARKER_LABEL,
  );
});
