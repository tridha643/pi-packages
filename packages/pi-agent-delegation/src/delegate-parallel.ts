/** One successfully launched lane from a concurrent strict delegate fan-out. */
export interface ParallelDelegateLaunched<TLane, TValue> {
  readonly status: "launched";
  readonly index: number;
  readonly lane: TLane;
  readonly value: TValue;
}

/** One lane that failed during concurrent strict delegate fan-out. */
export interface ParallelDelegateFailed<TLane> {
  readonly status: "failed";
  readonly index: number;
  readonly lane: TLane;
  readonly error: string;
}

/** Per-lane outcome from a concurrent strict delegate fan-out. */
export type ParallelDelegateOutcome<TLane, TValue> =
  | ParallelDelegateLaunched<TLane, TValue>
  | ParallelDelegateFailed<TLane>;

/** Resolve every lane before concurrently launching them and retaining partial launch failures. */
export async function launchParallelDelegateLanes<TLane, TResolved, TValue>(options: {
  readonly lanes: ReadonlyArray<TLane>;
  readonly resolve: (lane: TLane, index: number) => Promise<TResolved>;
  readonly launch: (
    lane: TLane,
    resolved: TResolved,
    index: number,
  ) => Promise<TValue>;
}): Promise<ReadonlyArray<ParallelDelegateOutcome<TLane, TValue>>> {
  const prepared = await Promise.all(
    options.lanes.map(async (lane, index) => ({
      lane,
      index,
      resolved: await options.resolve(lane, index),
    })),
  );

  return Promise.all(
    prepared.map(async ({ lane, index, resolved }) => {
      try {
        return {
          status: "launched" as const,
          index,
          lane,
          value: await options.launch(lane, resolved, index),
        };
      } catch (cause) {
        return {
          status: "failed" as const,
          index,
          lane,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }),
  );
}
