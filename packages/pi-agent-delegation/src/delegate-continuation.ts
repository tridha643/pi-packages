import type { SubagentSnapshot } from "../vendor/headless/src/domain.ts";

/** Expected reason that a tracked subagent cannot accept strict continuation. */
export interface DelegateContinuationError {
  readonly code:
    | "unknown-delegate"
    | "delegate-running"
    | "delegate-failed"
    | "delegate-not-strict"
    | "delegate-managed";
  readonly message: string;
}

/** Result of validating that a completed direct strict delegate can continue. */
export type DelegateContinuationValidation =
  | { readonly ok: true; readonly value: SubagentSnapshot }
  | { readonly ok: false; readonly error: DelegateContinuationError };

/** Validate continuation without admitting freeform delegates or chain-owned children. */
export function validateDelegateContinuation(
  id: string,
  snapshot: SubagentSnapshot | undefined,
): DelegateContinuationValidation {
  if (!snapshot) {
    return {
      ok: false,
      error: {
        code: "unknown-delegate",
        message: `Unknown delegate id "${id}".`,
      },
    };
  }
  if (snapshot.status === "running") {
    return {
      ok: false,
      error: {
        code: "delegate-running",
        message: `Delegate "${id}" is still running; continue only after its current turn finishes.`,
      },
    };
  }
  if (snapshot.status === "error") {
    return {
      ok: false,
      error: {
        code: "delegate-failed",
        message: `Delegate "${id}" failed; start a fresh delegate instead of continuing failed context.`,
      },
    };
  }
  if (!snapshot.subagentName || !snapshot.profileName) {
    return {
      ok: false,
      error: {
        code: "delegate-not-strict",
        message: `Delegate "${id}" is not a named strict delegate and cannot be continued with delegate_continue.`,
      },
    };
  }
  if (snapshot.resultDelivery !== "automatic") {
    return {
      ok: false,
      error: {
        code: "delegate-managed",
        message: `Delegate "${id}" is owned by a chain and cannot be continued independently.`,
      },
    };
  }
  return { ok: true, value: snapshot };
}
