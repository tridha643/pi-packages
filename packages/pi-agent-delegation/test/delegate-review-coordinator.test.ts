import assert from "node:assert/strict";
import test from "node:test";
import { parseDelegateReviewJson } from "../src/delegate-review-contract.ts";
import {
  createDelegateReviewCoordinator,
  markDelegateReviewReady,
  recordDelegateReviewReport,
  selectDelegateReviewProfile,
  startNextDelegateReview,
  updateDelegateReviewFinding,
  validateDelegateReviewClean,
  type DelegateReviewCoordinatorResult,
  type DelegateReviewCoordinatorState,
} from "../src/delegate-review-coordinator.ts";
import {
  parseDelegateWorkspaceRevisionHash,
  type DelegateWorkspaceRevisionHash,
} from "../src/delegate-workspace-revision.ts";

const REVISION_A = revisionHash("a");
const REVISION_B = revisionHash("b");

test("selects a dedicated review profile by author-family inversion", () => {
  assert.equal(selectDelegateReviewProfile([]), "review-claude");
  assert.equal(selectDelegateReviewProfile(["anthropic/claude-opus"]), "review-codex");
  assert.equal(selectDelegateReviewProfile(["claude/claude-sonnet-5"]), "review-codex");
  assert.equal(selectDelegateReviewProfile(["codex/gpt-5.6-sol"]), "review-claude");
  assert.equal(selectDelegateReviewProfile(["cursor/grok-4.5"]), "review-claude");
  assert.equal(selectDelegateReviewProfile(["anthropic/claude", "openai/gpt"]), "review-grok");
  assert.equal(
    selectDelegateReviewProfile(["anthropic/claude", "openai/gpt", "xai/grok"]),
    "review-claude",
  );
  assert.equal(selectDelegateReviewProfile(["cursor/composer", "kimi/k3"]), "review-claude");
});

test("a clean report is accepted only for the exact unchanged workspace hash", () => {
  const initial = createDelegateReviewCoordinator(REVISION_A);
  const cleanReport = requireCleanReport();

  const staleAtCompletion = recordDelegateReviewReport(
    initial,
    REVISION_A,
    REVISION_B,
    cleanReport,
  );
  assert.equal(staleAtCompletion.ok, false);
  if (!staleAtCompletion.ok) {
    assert.equal(staleAtCompletion.error.code, "stale-review");
  }

  const clean = requireState(
    recordDelegateReviewReport(
      initial,
      REVISION_A,
      REVISION_A,
      cleanReport,
    ),
  );
  assert.equal(clean.status, "clean");
  const invalidated = validateDelegateReviewClean(clean, REVISION_B);
  assert.equal(invalidated.ok, false);
  if (!invalidated.ok) assert.equal(invalidated.error.code, "stale-review");
});

test("finding fixes move through awaiting, ready, and another review without a default cap", () => {
  const initial = createDelegateReviewCoordinator(REVISION_A);
  const findingsReport = requireFindingsReport();
  const awaiting = requireState(
    recordDelegateReviewReport(
      initial,
      REVISION_A,
      REVISION_A,
      findingsReport,
    ),
  );
  assert.equal(awaiting.status, "awaiting-parent-fixes");

  const finding = awaiting.findings[0];
  if (!finding) throw new Error("Expected an active finding.");
  const accepted = requireState(
    updateDelegateReviewFinding(awaiting, finding.fingerprint, {
      type: "accept",
    }),
  );
  const fixed = requireState(
    updateDelegateReviewFinding(accepted, finding.fingerprint, {
      type: "mark-fixed",
      evidence: "The parent added a guarded retry.",
    }),
  );
  const verified = requireState(
    updateDelegateReviewFinding(fixed, finding.fingerprint, {
      type: "verify",
      evidence: "The idempotency regression test passes.",
    }),
  );
  const ready = requireState(markDelegateReviewReady(verified, REVISION_B));
  assert.equal(ready.status, "ready-for-review");
  const reviewingAgain = requireState(
    startNextDelegateReview(ready, REVISION_B),
  );
  assert.equal(reviewingAgain.status, "review-running");
});

test("explicit review budget exhaustion yields blocked instead of imposing a round cap", () => {
  const initial = createDelegateReviewCoordinator(REVISION_A, {
    reviewBudget: 1,
  });
  const awaiting = requireState(
    recordDelegateReviewReport(
      initial,
      REVISION_A,
      REVISION_A,
      requireFindingsReport(),
    ),
  );
  const finding = awaiting.findings[0];
  if (!finding) throw new Error("Expected an active finding.");
  const rejected = requireState(
    updateDelegateReviewFinding(awaiting, finding.fingerprint, {
      type: "reject",
      reason: "The evidence describes unreachable code.",
    }),
  );
  const ready = requireState(markDelegateReviewReady(rejected, REVISION_A));
  const blocked = requireState(startNextDelegateReview(ready, REVISION_A));

  assert.equal(blocked.status, "blocked");
  if (blocked.status === "blocked") {
    assert.match(blocked.blockedReason, /budget was exhausted/);
  }
  assert.equal(
    createDelegateReviewCoordinator(REVISION_A, { reviewBudget: 0 }).status,
    "blocked",
  );
});

function requireCleanReport() {
  const parsed = parseDelegateReviewJson(
    JSON.stringify({ verdict: "clean", findings: [] }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.report;
}

function requireFindingsReport() {
  const parsed = parseDelegateReviewJson(
    JSON.stringify({
      verdict: "findings",
      findings: [
        {
          severity: "high",
          path: "src/worker.ts",
          symbol: "dispatchRequest",
          evidence: "A retry can enter the branch twice.",
          consequence: "The request can be delivered twice.",
          verification: "Run the idempotency regression test.",
        },
      ],
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.report;
}

function revisionHash(character: string): DelegateWorkspaceRevisionHash {
  const parsed = parseDelegateWorkspaceRevisionHash(character.repeat(64));
  if (!parsed) throw new Error("Test workspace revision hash is invalid.");
  return parsed;
}

function requireState(
  result: DelegateReviewCoordinatorResult,
): DelegateReviewCoordinatorState {
  if (!result.ok) assert.fail(result.error.message);
  return result.state;
}
