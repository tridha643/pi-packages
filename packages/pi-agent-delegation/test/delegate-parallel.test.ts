import assert from "node:assert/strict";
import test from "node:test";
import { launchParallelDelegateLanes } from "../src/delegate-parallel.ts";

test("resolves every lane before launching any lane", async () => {
  let launchCount = 0;

  await assert.rejects(
    launchParallelDelegateLanes({
      lanes: ["valid", "invalid"],
      async resolve(lane) {
        if (lane === "invalid") throw new Error("invalid lane");
        return `${lane}-resolved`;
      },
      async launch() {
        launchCount++;
        return "launched";
      },
    }),
    /invalid lane/,
  );
  assert.equal(launchCount, 0);
});

test("launches prepared lanes concurrently", async () => {
  let started = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observeAllStarted: (() => void) | undefined;
  const allStarted = new Promise<void>((resolve) => {
    observeAllStarted = resolve;
  });

  const running = launchParallelDelegateLanes({
    lanes: ["first", "second"],
    async resolve(lane) {
      return lane;
    },
    async launch(lane) {
      started++;
      if (started === 2) observeAllStarted?.();
      await gate;
      return `${lane}-launched`;
    },
  });

  const concurrent = await Promise.race([
    allStarted.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
  ]);
  release?.();
  const outcomes = await running;

  assert.equal(concurrent, true);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ["launched", "launched"],
  );
});

test("retains successful lane ids when a sibling launch fails", async () => {
  const outcomes = await launchParallelDelegateLanes({
    lanes: ["first", "second", "third"],
    async resolve(lane) {
      return lane;
    },
    async launch(lane) {
      if (lane === "second") throw new Error("capacity unavailable");
      return `sa-${lane}`;
    },
  });

  assert.deepEqual(outcomes, [
    { status: "launched", index: 0, lane: "first", value: "sa-first" },
    {
      status: "failed",
      index: 1,
      lane: "second",
      error: "capacity unavailable",
    },
    { status: "launched", index: 2, lane: "third", value: "sa-third" },
  ]);
});
