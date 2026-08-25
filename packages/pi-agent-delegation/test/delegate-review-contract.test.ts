import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDelegateReviewJson,
  transitionDelegateReviewFinding,
  type DelegateReviewFinding,
} from "../src/delegate-review-contract.ts";

test("structured findings receive stable fingerprints independent of evidence wording", () => {
  const first = requireFinding(
    reviewJson({
      evidence: "The first failing call is at line 12.",
    }),
  );
  const repeated = requireFinding(
    reviewJson({
      path: " SRC/WORKER.TS ",
      consequence: "  requests can be silently dropped. ",
      evidence: "A new trace demonstrates the same defect.",
    }),
  );

  assert.equal(first.fingerprint, repeated.fingerprint);
  assert.equal(first.state, "open");
  assert.ok(Object.isFrozen(first));
});

test("accepts a final review object after reviewer explanation", () => {
  const result = parseDelegateReviewJson(
    'Review completed. The example object {not-json} was ignored.\n\n{"verdict":"clean","findings":[]}',
  );

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.report.verdict, "clean");
});

test("rejects non-whitespace output after the review object", () => {
  const result = parseDelegateReviewJson(
    '{"verdict":"clean","findings":[]}\nReview completed.',
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid-json");
});

test("finding lifecycle requires new evidence before a rejected finding reopens", () => {
  const finding = requireFinding(reviewJson({}));
  const rejected = requireTransition(finding, {
    type: "reject",
    reason: "The caller already guards this branch.",
  });
  assert.equal(rejected.state, "rejected");

  const duplicateEvidence = transitionDelegateReviewFinding(rejected, {
    type: "reopen",
    evidence: finding.evidence,
  });
  assert.equal(duplicateEvidence.ok, false);
  if (!duplicateEvidence.ok) {
    assert.equal(duplicateEvidence.error.code, "evidence-not-new");
  }

  const reopened = requireTransition(rejected, {
    type: "reopen",
    evidence: "The unguarded retry caller reaches this branch.",
  });
  assert.equal(reopened.state, "open");
  assert.equal(reopened.fingerprint, finding.fingerprint);
});

test("accepted findings advance through fixed and verified in order", () => {
  const finding = requireFinding(reviewJson({}));
  const accepted = requireTransition(finding, { type: "accept" });
  const fixed = requireTransition(accepted, {
    type: "mark-fixed",
    evidence: "Added the missing retry guard.",
  });
  const verified = requireTransition(fixed, {
    type: "verify",
    evidence: "The focused regression test now passes.",
  });

  assert.equal(verified.state, "verified");
  assert.equal(
    transitionDelegateReviewFinding(finding, {
      type: "mark-fixed",
      evidence: "Skipped acceptance.",
    }).ok,
    false,
  );
});

function reviewJson(
  overrides: Partial<{
    severity: string;
    path: string;
    symbol: string;
    evidence: string;
    consequence: string;
    verification: string;
  }>,
): string {
  return JSON.stringify({
    verdict: "findings",
    findings: [
      {
        severity: "high",
        path: "src/worker.ts",
        symbol: "dispatchRequest",
        evidence: "The first failing call is at line 12.",
        consequence: "Requests can be silently dropped.",
        verification: "Run the retry regression test.",
        ...overrides,
      },
    ],
  });
}

function requireFinding(json: string): DelegateReviewFinding {
  const result = parseDelegateReviewJson(json);
  if (!result.ok) assert.fail(result.error.message);
  if (result.report.verdict !== "findings") {
    throw new Error("Expected a parsed findings report.");
  }
  const finding = result.report.findings[0];
  if (!finding) throw new Error("Expected one parsed finding.");
  return finding;
}

function requireTransition(
  finding: DelegateReviewFinding,
  transition: Parameters<typeof transitionDelegateReviewFinding>[1],
): DelegateReviewFinding {
  const result = transitionDelegateReviewFinding(finding, transition);
  if (!result.ok) assert.fail(result.error.message);
  return result.finding;
}
