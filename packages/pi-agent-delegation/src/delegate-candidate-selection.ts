import { Data, Effect, Result } from "effect";
import type { SubagentManagerShape } from "../vendor/headless/src/manager.ts";
import type {
  ConcurrencyLimitError,
  SpawnError,
  SpawnTask,
  SubagentSnapshot,
} from "../vendor/headless/src/domain.ts";
import type { DelegateProfileCandidate } from "./delegate-profiles.ts";

/**
 * Harnesses that cannot enforce a named subagent's Pi-compatible tool
 * allowlist, because their tool surface is owned by the external agent rather
 * than by Pi. A candidate on one of these harnesses is skipped whenever the
 * subagent declares `tools:`, so an allowlist is never silently ignored.
 */
const HARNESSES_WITHOUT_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "codex",
  "cursor",
  "opencode",
]);

const HARNESS_ALLOWLIST_LABEL: Readonly<Record<string, string>> = {
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};

/** One explicit delegate candidate rejected before its task began. */
export interface DelegateCandidateRejection {
  readonly candidate: DelegateProfileCandidate;
  readonly reason: string;
}

/** Successful explicit candidate selection and spawned subagent snapshot. */
export interface DelegateCandidateSelection {
  readonly snapshot: SubagentSnapshot;
  readonly selected: DelegateProfileCandidate;
  readonly rejected: ReadonlyArray<DelegateCandidateRejection>;
}

/** Every explicit candidate failed before execution could begin. */
export class DelegateCandidatesUnavailableError extends Data.TaggedError(
  "DelegateCandidatesUnavailableError",
)<{
  readonly message: string;
  readonly rejected: ReadonlyArray<DelegateCandidateRejection>;
}> {}

/**
 * Spawn the first compatible explicit candidate, falling back only when spawn
 * fails before a backend session begins executing the task.
 */
export function selectAndSpawnDelegateCandidate(options: {
  readonly spawn: SubagentManagerShape["spawn"];
  readonly candidates: ReadonlyArray<DelegateProfileCandidate>;
  readonly task: Omit<SpawnTask, "model" | "reasoningEffort">;
}): Effect.Effect<
  DelegateCandidateSelection,
  DelegateCandidatesUnavailableError | ConcurrencyLimitError | SpawnError
> {
  return Effect.gen(function* () {
    const rejected: DelegateCandidateRejection[] = [];

    for (const candidate of options.candidates) {
      if (
        HARNESSES_WITHOUT_TOOL_ALLOWLIST.has(candidate.harness) &&
        options.task.allowedTools !== undefined
      ) {
        const label =
          HARNESS_ALLOWLIST_LABEL[candidate.harness] ?? candidate.harness;
        rejected.push({
          candidate,
          reason: `${label} cannot enforce the named subagent's Pi-compatible tool allowlist.`,
        });
        continue;
      }

      const spawnResult = yield* options
        .spawn(candidate.harness, {
          ...options.task,
          model: candidate.model,
          reasoningEffort: candidate.reasoning,
        })
        .pipe(Effect.result);

      if (Result.isSuccess(spawnResult)) {
        return {
          snapshot: spawnResult.success,
          selected: candidate,
          rejected,
        };
      }

      const failure = spawnResult.failure;
      if (
        failure._tag === "ConcurrencyLimitError" ||
        failure._tag === "SpawnError"
      ) {
        return yield* failure;
      }
      rejected.push({ candidate, reason: failure.message });
    }

    const summary = rejected
      .map(
        ({ candidate, reason }) =>
          `${candidate.harness}/${candidate.model}: ${reason}`,
      )
      .join("; ");
    if (options.candidates.length === 1) {
      const target = options.candidates[0]!;
      return yield* new DelegateCandidatesUnavailableError({
        message:
          `Delegate profile target ${target.harness}/${target.model}:${target.reasoning} was unavailable before execution` +
          `${summary ? `: ${summary}` : "."}`,
        rejected,
      });
    }
    return yield* new DelegateCandidatesUnavailableError({
      message: `No explicit delegate candidate was available before execution${summary ? `: ${summary}` : "."}`,
      rejected,
    });
  });
}
