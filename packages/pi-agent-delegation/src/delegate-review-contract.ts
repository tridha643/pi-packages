import { createHash } from "node:crypto";

/** Supported urgency levels for one structured delegate review finding. */
export type DelegateReviewSeverity = "critical" | "high" | "medium" | "low";

/** Stable identity shared by repeated reports of the same review concern. */
export type DelegateReviewFindingFingerprint = string & {
  readonly __delegateReviewFindingFingerprint: unique symbol;
};

interface DelegateReviewFindingContent {
  readonly fingerprint: DelegateReviewFindingFingerprint;
  readonly severity: DelegateReviewSeverity;
  readonly path: string;
  readonly symbol?: string;
  readonly evidence: string;
  readonly consequence: string;
  readonly verification: string;
}

/** Immutable lifecycle for a structured review finding. */
export type DelegateReviewFinding =
  | (DelegateReviewFindingContent & { readonly state: "open" })
  | (DelegateReviewFindingContent & { readonly state: "accepted" })
  | (DelegateReviewFindingContent & {
      readonly state: "rejected";
      readonly rejectionReason: string;
    })
  | (DelegateReviewFindingContent & {
      readonly state: "fixed";
      readonly fixEvidence: string;
    })
  | (DelegateReviewFindingContent & {
      readonly state: "verified";
      readonly fixEvidence: string;
      readonly verificationEvidence: string;
    });

/** Hash-bound structured output from an extension-agnostic reviewer. */
export type DelegateReviewReport =
  | {
      readonly verdict: "clean";
      readonly findings: readonly [];
    }
  | {
      readonly verdict: "findings";
      readonly findings: ReadonlyArray<DelegateReviewFinding>;
    };

/** Searchable parse failure for malformed reviewer JSON. */
export interface DelegateReviewParseError {
  readonly code: "invalid-json" | "invalid-review";
  readonly message: string;
}

/** Safe result of parsing and validating structured reviewer JSON. */
export type DelegateReviewParseResult =
  | { readonly ok: true; readonly report: DelegateReviewReport }
  | { readonly ok: false; readonly error: DelegateReviewParseError };

/** Allowed explicit transitions through the review finding lifecycle. */
export type DelegateReviewFindingTransition =
  | { readonly type: "accept" }
  | { readonly type: "reject"; readonly reason: string }
  | { readonly type: "reopen"; readonly evidence: string }
  | { readonly type: "mark-fixed"; readonly evidence: string }
  | { readonly type: "verify"; readonly evidence: string };

/** Searchable rejection of an invalid review finding lifecycle transition. */
export interface DelegateReviewFindingTransitionError {
  readonly code: "invalid-finding-transition" | "evidence-not-new";
  readonly message: string;
}

/** Safe result of applying one immutable review finding transition. */
export type DelegateReviewFindingTransitionResult =
  | { readonly ok: true; readonly finding: DelegateReviewFinding }
  | {
      readonly ok: false;
      readonly error: DelegateReviewFindingTransitionError;
    };

/** Parse reviewer JSON, tolerating explanatory text only before a final JSON object. */
export function parseDelegateReviewJson(
  reviewerJson: string,
): DelegateReviewParseResult {
  let value: unknown;
  try {
    value = parseDelegateReviewJsonValue(reviewerJson);
  } catch (error) {
    return reviewParseFailure(
      "invalid-json",
      `Delegate review JSON is invalid: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(value)) {
    return reviewParseFailure(
      "invalid-review",
      "Delegate review JSON must be an object.",
    );
  }
  if (value.verdict !== "clean" && value.verdict !== "findings") {
    return reviewParseFailure(
      "invalid-review",
      'Delegate review JSON verdict must be "clean" or "findings".',
    );
  }
  if (!Array.isArray(value.findings)) {
    return reviewParseFailure(
      "invalid-review",
      "Delegate review JSON findings must be an array.",
    );
  }
  if (value.verdict === "clean" && value.findings.length !== 0) {
    return reviewParseFailure(
      "invalid-review",
      "Delegate review JSON cannot declare clean while reporting findings.",
    );
  }
  if (value.verdict === "findings" && value.findings.length === 0) {
    return reviewParseFailure(
      "invalid-review",
      "Delegate review JSON must report at least one finding for a findings verdict.",
    );
  }

  const findings: DelegateReviewFinding[] = [];
  for (const [index, candidate] of value.findings.entries()) {
    const parsed = parseReviewFinding(candidate, index);
    if (!parsed.ok) return parsed;
    findings.push(parsed.finding);
  }
  if (value.verdict === "clean") {
    return Object.freeze({
      ok: true,
      report: Object.freeze({
        verdict: "clean",
        findings: Object.freeze([]) as readonly [],
      }),
    });
  }
  return Object.freeze({
    ok: true,
    report: Object.freeze({
      verdict: "findings",
      findings: Object.freeze(findings),
    }),
  });
}

/** Apply open, accepted, rejected, fixed, and verified lifecycle constraints. */
export function transitionDelegateReviewFinding(
  finding: DelegateReviewFinding,
  transition: DelegateReviewFindingTransition,
): DelegateReviewFindingTransitionResult {
  if (finding.state === "open" && transition.type === "accept") {
    return findingTransitionSuccess({ ...finding, state: "accepted" });
  }
  if (finding.state === "open" && transition.type === "reject") {
    if (transition.reason.trim() === "") {
      return findingTransitionFailure(
        "invalid-finding-transition",
        "Delegate review finding rejection requires a reason.",
      );
    }
    return findingTransitionSuccess({
      ...finding,
      state: "rejected",
      rejectionReason: transition.reason.trim(),
    });
  }
  if (finding.state === "accepted" && transition.type === "mark-fixed") {
    if (transition.evidence.trim() === "") {
      return findingTransitionFailure(
        "invalid-finding-transition",
        "Delegate review finding fix requires evidence.",
      );
    }
    return findingTransitionSuccess({
      ...finding,
      state: "fixed",
      fixEvidence: transition.evidence.trim(),
    });
  }
  if (finding.state === "fixed" && transition.type === "verify") {
    if (transition.evidence.trim() === "") {
      return findingTransitionFailure(
        "invalid-finding-transition",
        "Delegate review finding verification requires evidence.",
      );
    }
    return findingTransitionSuccess({
      ...finding,
      state: "verified",
      verificationEvidence: transition.evidence.trim(),
    });
  }
  if (finding.state === "rejected" && transition.type === "reopen") {
    const evidence = transition.evidence.trim();
    if (
      evidence === "" ||
      normalizeFingerprintText(evidence) ===
        normalizeFingerprintText(finding.evidence)
    ) {
      return findingTransitionFailure(
        "evidence-not-new",
        "Delegate review finding can reopen only with new evidence.",
      );
    }
    const reopened: DelegateReviewFinding = {
      fingerprint: finding.fingerprint,
      severity: finding.severity,
      path: finding.path,
      ...(finding.symbol !== undefined ? { symbol: finding.symbol } : {}),
      evidence,
      consequence: finding.consequence,
      verification: finding.verification,
      state: "open",
    };
    return findingTransitionSuccess(reopened);
  }
  return findingTransitionFailure(
    "invalid-finding-transition",
    `Delegate review finding cannot apply "${transition.type}" while ${finding.state}.`,
  );
}

function parseReviewFinding(
  value: unknown,
  index: number,
):
  | { readonly ok: true; readonly finding: DelegateReviewFinding }
  | { readonly ok: false; readonly error: DelegateReviewParseError } {
  if (!isRecord(value)) {
    return reviewParseFailure(
      "invalid-review",
      `Delegate review finding ${index} must be an object.`,
    );
  }
  const severity = value.severity;
  if (
    severity !== "critical" &&
    severity !== "high" &&
    severity !== "medium" &&
    severity !== "low"
  ) {
    return reviewParseFailure(
      "invalid-review",
      `Delegate review finding ${index} has an invalid severity.`,
    );
  }
  const path = readRequiredString(value, "path", index);
  if (!path.ok) return path;
  const evidence = readRequiredString(value, "evidence", index);
  if (!evidence.ok) return evidence;
  const consequence = readRequiredString(value, "consequence", index);
  if (!consequence.ok) return consequence;
  const verification = readRequiredString(value, "verification", index);
  if (!verification.ok) return verification;
  if (value.symbol !== undefined && !isNonEmptyString(value.symbol)) {
    return reviewParseFailure(
      "invalid-review",
      `Delegate review finding ${index} field "symbol" must be a non-empty string when present.`,
    );
  }

  const symbol =
    typeof value.symbol === "string" ? value.symbol.trim() : undefined;
  const fingerprint = createFindingFingerprint({
    path: path.value,
    symbol,
    consequence: consequence.value,
  });
  const finding: DelegateReviewFinding = Object.freeze({
    fingerprint,
    severity,
    path: path.value,
    ...(symbol !== undefined ? { symbol } : {}),
    evidence: evidence.value,
    consequence: consequence.value,
    verification: verification.value,
    state: "open",
  });
  return Object.freeze({ ok: true, finding });
}

function createFindingFingerprint(input: {
  readonly path: string;
  readonly symbol?: string;
  readonly consequence: string;
}): DelegateReviewFindingFingerprint {
  const canonical = [
    normalizeFingerprintText(input.path),
    normalizeFingerprintText(input.symbol ?? ""),
    normalizeFingerprintText(input.consequence),
  ];
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex") as DelegateReviewFindingFingerprint;
}

function normalizeFingerprintText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function readRequiredString(
  value: Readonly<Record<string, unknown>>,
  field: string,
  index: number,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: DelegateReviewParseError } {
  const candidate = value[field];
  if (!isNonEmptyString(candidate)) {
    return reviewParseFailure(
      "invalid-review",
      `Delegate review finding ${index} field "${field}" must be a non-empty string.`,
    );
  }
  return Object.freeze({ ok: true, value: candidate.trim() });
}

function parseDelegateReviewJsonValue(reviewerOutput: string): unknown {
  const normalizedOutput = stripSingleJsonFence(reviewerOutput);
  try {
    return JSON.parse(normalizedOutput);
  } catch (directParseError) {
    let objectStart = normalizedOutput.lastIndexOf("{");
    while (objectStart >= 0) {
      const trailingCandidate = normalizedOutput.slice(objectStart).trim();
      try {
        return JSON.parse(trailingCandidate);
      } catch {
        // Continue toward the outermost object. A candidate is accepted only
        // when the complete non-whitespace suffix is one valid JSON value.
      }
      if (objectStart === 0) break;
      objectStart = normalizedOutput.lastIndexOf("{", objectStart - 1);
    }
    throw directParseError;
  }
}

function stripSingleJsonFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/iu.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function reviewParseFailure(
  code: DelegateReviewParseError["code"],
  message: string,
): {
  readonly ok: false;
  readonly error: DelegateReviewParseError;
} {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message }),
  });
}

function findingTransitionSuccess(
  finding: DelegateReviewFinding,
): DelegateReviewFindingTransitionResult {
  return Object.freeze({ ok: true, finding: Object.freeze(finding) });
}

function findingTransitionFailure(
  code: DelegateReviewFindingTransitionError["code"],
  message: string,
): DelegateReviewFindingTransitionResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message }),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
