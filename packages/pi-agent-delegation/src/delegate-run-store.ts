import { appendFile, chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { DelegateContextPolicy } from "./delegate-context-policy.ts";
import type { DelegateWritePath } from "./delegate-writer-ownership.ts";

const DEFAULT_DELEGATION_RUN_ROOT = join(
  homedir(),
  ".pi",
  "agent",
  "pi-hermes-memory",
  "delegation-runs",
);

/** Metadata common to append-only delegation run events. */
export interface DelegateRunEventBase {
  readonly schemaVersion: 1;
  readonly timestamp: string;
  readonly parentSessionId: string;
  readonly delegateId: string;
  readonly runGeneration: number;
  readonly project: string;
  readonly cwd: string;
}

/** A strict delegate was accepted by a concrete runtime candidate. */
export interface DelegateRunLaunchedEvent extends DelegateRunEventBase {
  readonly event: "launched";
  readonly subagent: string;
  readonly profile: string;
  readonly harness: string;
  readonly model: string;
  readonly reasoning: string;
  readonly contextPolicy: DelegateContextPolicy;
  readonly evidencePackId?: string;
  readonly evidenceSourceIds: ReadonlyArray<string>;
  readonly writePaths: ReadonlyArray<DelegateWritePath>;
}

/** A delegate continuation reused a successful child transcript. */
export interface DelegateRunContinuedEvent extends DelegateRunEventBase {
  readonly event: "continued";
  readonly subagent: string;
  readonly profile: string;
  readonly contextPolicy: "continue";
}

/** A concrete delegate run generation reached a terminal state. */
export interface DelegateRunSettledEvent extends DelegateRunEventBase {
  readonly event: "settled";
  readonly status: "done" | "error";
  readonly durationMs: number;
  readonly tokenCount?: number;
  readonly changedPaths: ReadonlyArray<string>;
}

/** A hash-bound review loop changed state or recorded finding dispositions. */
export interface DelegateReviewStateEvent extends DelegateRunEventBase {
  readonly event: "review-state";
  readonly loopId: string;
  readonly revisionHash: string;
  readonly status:
    | "review-running"
    | "awaiting-parent-fixes"
    | "ready-for-review"
    | "clean"
    | "blocked";
  readonly reviewerProfile: string;
  readonly findings: ReadonlyArray<{
    readonly fingerprint: string;
    readonly severity: string;
    readonly path: string;
    readonly symbol?: string;
    readonly state: string;
  }>;
  readonly blockedReason?: string;
}

/** One append-only structured delegation event stored beside Hermes history. */
export type DelegateRunEvent =
  | DelegateRunLaunchedEvent
  | DelegateRunContinuedEvent
  | DelegateRunSettledEvent
  | DelegateReviewStateEvent;

/** Expected durable run event append failure. */
export interface DelegateRunStoreError {
  readonly code: "write-failed";
  readonly message: string;
}

/** Result of appending one durable delegation run event. */
export type DelegateRunStoreResult =
  | { readonly ok: true; readonly filePath: string }
  | { readonly ok: false; readonly error: DelegateRunStoreError };

function safePathSegment(value: string): string {
  const sanitized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return sanitized || "global";
}

function monthlyFileName(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return "unknown-month.jsonl";
  return `${date.toISOString().slice(0, 7)}.jsonl`;
}

/** Append minimal structured run events without storing prompts, transcripts, or tool output. */
export class DelegateRunStore {
  readonly #rootDirectory: string;
  #pendingWrite: Promise<void> = Promise.resolve();

  constructor(rootDirectory = DEFAULT_DELEGATION_RUN_ROOT) {
    this.#rootDirectory = resolve(rootDirectory);
  }

  /** Append one run event serially with owner-only filesystem permissions. */
  async append(event: DelegateRunEvent): Promise<DelegateRunStoreResult> {
    const projectDirectory = join(
      this.#rootDirectory,
      safePathSegment(event.project || basename(event.cwd)),
    );
    const filePath = join(projectDirectory, monthlyFileName(event.timestamp));
    let result: DelegateRunStoreResult = { ok: true, filePath };
    const write = async () => {
      try {
        await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
        await chmod(projectDirectory, 0o700);
        await appendFile(filePath, `${JSON.stringify(event)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await chmod(filePath, 0o600);
      } catch (cause) {
        result = {
          ok: false,
          error: {
            code: "write-failed",
            message: `Delegate run store append failed for "${filePath}": ${cause instanceof Error ? cause.message : String(cause)}`,
          },
        };
      }
    };
    this.#pendingWrite = this.#pendingWrite.then(write, write);
    await this.#pendingWrite;
    return result;
  }
}
