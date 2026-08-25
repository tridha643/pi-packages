/** Runtime specification for one ephemeral strict delegate chain step. */
export interface DelegateChainStepSpec {
  readonly subagent: string;
  readonly profile: string;
  readonly task: string;
  readonly workingDir?: string;
  /** Hard deadline for this step; defaults to the coordinator setting. */
  readonly timeoutSeconds?: number;
}

/** Terminal outcome returned by the chain's single-step executor. */
export type DelegateChainStepOutcome =
  | {
      readonly status: "done";
      readonly subagentId: string;
      readonly output: string;
      readonly harness: string;
      readonly model: string;
    }
  | {
      readonly status: "error";
      readonly subagentId?: string;
      readonly errorText: string;
      readonly partialOutput?: string;
      readonly harness?: string;
      readonly model?: string;
    };

/** Stored progress and result for one chain step. */
export interface DelegateChainStepSnapshot extends DelegateChainStepSpec {
  readonly index: number;
  readonly status: "pending" | "running" | "done" | "error" | "cancelled";
  readonly subagentId?: string;
  readonly output?: string;
  readonly errorText?: string;
  readonly harness?: string;
  readonly model?: string;
}

/** Live snapshot for one parent-created ephemeral delegate chain. */
export interface DelegateChainSnapshot {
  readonly id: string;
  readonly title: string;
  readonly status: "running" | "done" | "error" | "cancelled";
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly activeSubagentId?: string;
  readonly steps: ReadonlyArray<DelegateChainStepSnapshot>;
  readonly finalText: string;
  readonly errorText?: string;
}

interface MutableChainStepSnapshot {
  index: number;
  subagent: string;
  profile: string;
  task: string;
  workingDir?: string;
  timeoutSeconds?: number;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  subagentId?: string;
  output?: string;
  errorText?: string;
  harness?: string;
  model?: string;
}

interface MutableChainSnapshot {
  id: string;
  title: string;
  status: "running" | "done" | "error" | "cancelled";
  createdAt: number;
  settledAt?: number;
  activeSubagentId?: string;
  steps: MutableChainStepSnapshot[];
  finalText: string;
  errorText?: string;
  cancelRequested: boolean;
}

/** Callback controls exposed while one chain step is launching or running. */
export interface DelegateChainStepControl {
  readonly signal: AbortSignal;
  setActiveSubagentId(id: string): void;
}

/** Executes one chain step against the headless subagent manager. */
export type DelegateChainStepExecutor = (
  step: DelegateChainStepSpec,
  stepIndex: number,
  previousStepResult: string | undefined,
  control: DelegateChainStepControl,
) => Promise<DelegateChainStepOutcome>;

/** Dependencies that connect chain orchestration to the headless manager. */
export interface DelegateChainCoordinatorOptions {
  readonly executeStep: DelegateChainStepExecutor;
  cancelSubagent(id: string): Promise<void>;
  /** Default hard deadline for one chain step. */
  readonly defaultStepTimeoutMs?: number;
  /** Injectable deterministic deadline scheduler used by tests. */
  scheduleDeadline?(onDeadline: () => void, timeoutMs: number): () => void;
}

/** Coordinates ephemeral sequential chains without persisting workflow specs. */
export class DelegateChainCoordinator {
  private readonly options: DelegateChainCoordinatorOptions;
  private readonly chains = new Map<string, MutableChainSnapshot>();
  private readonly chainExecutors = new Map<string, DelegateChainStepExecutor>();
  private readonly activeStepAborts = new Map<string, AbortController>();
  private readonly cancellationBySubagentId = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly waitInterest = new Map<string, number>();
  private counter = 0;
  private onSettled:
    | ((snapshot: DelegateChainSnapshot, consumed: boolean) => void)
    | undefined;

  constructor(options: DelegateChainCoordinatorOptions) {
    this.options = options;
  }

  /** Start a chain and return immediately with its tracked snapshot. */
  start(
    title: string,
    steps: ReadonlyArray<DelegateChainStepSpec>,
    executeStep: DelegateChainStepExecutor = this.options.executeStep,
  ): DelegateChainSnapshot {
    const id = `chain-${++this.counter}`;
    const chain: MutableChainSnapshot = {
      id,
      title,
      status: "running",
      createdAt: Date.now(),
      steps: steps.map((step, index) => ({
        index,
        subagent: step.subagent,
        profile: step.profile,
        task: step.task,
        ...(step.workingDir !== undefined ? { workingDir: step.workingDir } : {}),
        ...(step.timeoutSeconds !== undefined
          ? { timeoutSeconds: step.timeoutSeconds }
          : {}),
        status: "pending",
      })),
      finalText: "",
      cancelRequested: false,
    };
    this.chains.set(id, chain);
    this.chainExecutors.set(id, executeStep);
    this.notify();
    void this.runChain(chain);
    return chain;
  }

  /** Return all currently tracked chains in creation order. */
  list(): ReadonlyArray<DelegateChainSnapshot> {
    return [...this.chains.values()];
  }

  /** Return one tracked chain, if present. */
  get(id: string): DelegateChainSnapshot | undefined {
    return this.chains.get(id);
  }

  /** Subscribe to chain progress changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Register terminal delivery for chains that were not explicitly awaited. */
  setOnSettled(
    hook: ((snapshot: DelegateChainSnapshot, consumed: boolean) => void) | undefined,
  ): void {
    this.onSettled = hook;
  }

  /** Wait until every known chain id reaches a terminal state. */
  async waitFor(
    ids: ReadonlyArray<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    const unique = [...new Set(ids)];
    for (const id of unique) {
      this.waitInterest.set(id, (this.waitInterest.get(id) ?? 0) + 1);
    }
    try {
      while (
        unique.some((id) => this.chains.get(id)?.status === "running")
      ) {
        if (signal?.aborted) throw new Error("Delegate chain wait was aborted.");
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            unsubscribe();
            reject(new Error("Delegate chain wait was aborted."));
          };
          const unsubscribe = this.subscribe(() => {
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
            resolve();
          });
          signal?.addEventListener("abort", onAbort, { once: true });
          // Close the check-to-listener race: AbortSignal does not replay an
          // abort that happened just before addEventListener completed.
          if (signal?.aborted) onAbort();
        });
      }
    } finally {
      for (const id of unique) {
        const count = (this.waitInterest.get(id) ?? 1) - 1;
        if (count <= 0) this.waitInterest.delete(id);
        else this.waitInterest.set(id, count);
      }
    }
  }

  /** Cancel chains and their currently active subagent, if any. */
  async cancel(ids: ReadonlyArray<string>): Promise<void> {
    const work: Promise<void>[] = [];
    for (const id of new Set(ids)) {
      const chain = this.chains.get(id);
      if (!chain || chain.status !== "running") continue;
      chain.cancelRequested = true;
      this.activeStepAborts.get(id)?.abort();
      if (chain.activeSubagentId) {
        work.push(this.cancelSubagentOnce(chain.activeSubagentId));
      }
    }
    this.notify();
    await Promise.all(work);
  }

  private async runChain(chain: MutableChainSnapshot): Promise<void> {
    let previousStepResult: string | undefined;

    for (const step of chain.steps) {
      if (chain.cancelRequested) {
        step.status = "cancelled";
        this.settleChain(chain, "cancelled", "Chain was cancelled.");
        return;
      }

      step.status = "running";
      this.notify();
      let outcome: DelegateChainStepOutcome;
      const stepAbort = new AbortController();
      this.activeStepAborts.set(chain.id, stepAbort);
      const timeoutMs =
        step.timeoutSeconds !== undefined
          ? step.timeoutSeconds * 1_000
          : (this.options.defaultStepTimeoutMs ?? 30 * 60 * 1_000);
      let cancelDeadline: (() => void) | undefined;
      let stepOpen = true;
      let cancellationAfterPublish: Promise<void> | undefined;
      try {
        const executeStep =
          this.chainExecutors.get(chain.id) ?? this.options.executeStep;
        const execution = executeStep(
          step,
          step.index,
          previousStepResult,
          {
            signal: stepAbort.signal,
            setActiveSubagentId: (id) => {
              step.subagentId = id;
              if (
                !stepOpen ||
                chain.cancelRequested ||
                stepAbort.signal.aborted
              ) {
                cancellationAfterPublish = this.cancelSubagentOnce(id).catch(
                  () => undefined,
                );
                return;
              }
              chain.activeSubagentId = id;
              this.notify();
            },
          },
        );
        const deadline = new Promise<DelegateChainStepOutcome>((resolve) => {
          const onDeadline = () => {
            resolve({
              status: "error",
              ...(step.subagentId !== undefined
                ? { subagentId: step.subagentId }
                : {}),
              errorText: `Delegate chain step ${step.index + 1} exceeded its ${Math.round(timeoutMs / 1_000)} second deadline.`,
            });
            // Resolve the deadline outcome before broadcasting abort so the
            // cancellation listener cannot replace the more precise reason.
            stepAbort.abort();
          };
          cancelDeadline = this.options.scheduleDeadline
            ? this.options.scheduleDeadline(onDeadline, timeoutMs)
            : (() => {
                const timer = setTimeout(onDeadline, timeoutMs);
                return () => clearTimeout(timer);
              })();
        });
        const cancellation = new Promise<DelegateChainStepOutcome>((resolve) => {
          const resolveCancellation = () =>
            resolve({
              status: "error",
              ...(step.subagentId !== undefined
                ? { subagentId: step.subagentId }
                : {}),
              errorText: "Delegate chain step was cancelled.",
            });
          if (stepAbort.signal.aborted) resolveCancellation();
          else {
            stepAbort.signal.addEventListener("abort", resolveCancellation, {
              once: true,
            });
          }
        });
        outcome = await Promise.race([execution, deadline, cancellation]);
        if (stepAbort.signal.aborted && step.subagentId) {
          void this.cancelSubagentOnce(step.subagentId).catch(() => undefined);
        }
        // Cancellation is bounded best-effort cleanup owned by the backend;
        // it must never delay or replace the chain's terminal deadline result.
        void cancellationAfterPublish?.catch(() => undefined);
      } catch (error) {
        outcome = {
          status: "error",
          errorText: error instanceof Error ? error.message : String(error),
        };
      } finally {
        stepOpen = false;
        this.activeStepAborts.delete(chain.id);
        cancelDeadline?.();
      }
      chain.activeSubagentId = undefined;

      if (chain.cancelRequested) {
        step.status = "cancelled";
        step.errorText = "Chain was cancelled.";
        this.settleChain(chain, "cancelled", "Chain was cancelled.");
        return;
      }

      step.subagentId = outcome.subagentId;
      step.harness = outcome.harness;
      step.model = outcome.model;
      if (outcome.status === "error") {
        step.status = "error";
        step.errorText = outcome.errorText;
        step.output = outcome.partialOutput;
        this.settleChain(chain, "error", outcome.errorText);
        return;
      }

      step.status = "done";
      step.output = outcome.output;
      previousStepResult = outcome.output;
      chain.finalText = outcome.output;
      this.notify();
    }

    this.settleChain(chain, "done");
  }

  private settleChain(
    chain: MutableChainSnapshot,
    status: "done" | "error" | "cancelled",
    errorText?: string,
  ): void {
    chain.status = status;
    chain.settledAt = Date.now();
    chain.activeSubagentId = undefined;
    chain.errorText = errorText;
    this.chainExecutors.delete(chain.id);
    this.notify();
    this.onSettled?.(chain, (this.waitInterest.get(chain.id) ?? 0) > 0);
  }

  private cancelSubagentOnce(id: string): Promise<void> {
    const existing = this.cancellationBySubagentId.get(id);
    if (existing) return existing;
    const cancellation = this.options.cancelSubagent(id);
    this.cancellationBySubagentId.set(id, cancellation);
    return cancellation;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
