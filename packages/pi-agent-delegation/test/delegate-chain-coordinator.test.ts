import assert from "node:assert/strict";
import test from "node:test";
import {
  DelegateChainCoordinator,
  type DelegateChainStepOutcome,
} from "../src/delegate-chain-coordinator.ts";

test("successful terminal output deterministically starts the next chain step", async () => {
  const previousInputs: Array<string | undefined> = [];
  const coordinator = new DelegateChainCoordinator({
    async executeStep(step, _stepIndex, previous, control): Promise<DelegateChainStepOutcome> {
      previousInputs.push(previous);
      control.setActiveSubagentId(`sa-${previousInputs.length}`);
      return {
        status: "done",
        subagentId: `sa-${previousInputs.length}`,
        output: `${step.subagent}-output`,
        harness: "pi",
        model: "provider/model",
      };
    },
    async cancelSubagent() {},
  });

  const chain = coordinator.start("review chain", [
    { subagent: "scott", profile: "fast", task: "Discover." },
    { subagent: "bee", profile: "deep", task: "Analyze." },
  ]);
  await coordinator.waitFor([chain.id]);

  assert.deepEqual(previousInputs, [undefined, "scott-output"]);
  const settled = coordinator.get(chain.id);
  assert.equal(settled?.status, "done");
  assert.equal(settled?.finalText, "bee-output");
  assert.deepEqual(
    settled?.steps.map((step) => step.status),
    ["done", "done"],
  );
});

test("a failed step stops the chain before later subagents start", async () => {
  const started: string[] = [];
  const coordinator = new DelegateChainCoordinator({
    async executeStep(step, _stepIndex, _previous, control) {
      started.push(step.subagent);
      control.setActiveSubagentId(`sa-${started.length}`);
      if (step.subagent === "bee") {
        return {
          status: "error" as const,
          subagentId: "sa-2",
          errorText: "analysis failed",
        };
      }
      return {
        status: "done" as const,
        subagentId: "sa-1",
        output: "discovery",
        harness: "pi",
        model: "provider/model",
      };
    },
    async cancelSubagent() {},
  });

  const chain = coordinator.start("failing chain", [
    { subagent: "scott", profile: "fast", task: "Discover." },
    { subagent: "bee", profile: "deep", task: "Analyze." },
    { subagent: "reviewer", profile: "max", task: "Decide." },
  ]);
  await coordinator.waitFor([chain.id]);

  assert.deepEqual(started, ["scott", "bee"]);
  assert.equal(coordinator.get(chain.id)?.status, "error");
  assert.equal(coordinator.get(chain.id)?.steps[2]?.status, "pending");
});

test("aborting a chain wait releases immediately while the chain keeps running", async () => {
  const coordinator = new DelegateChainCoordinator({
    async executeStep(_step, _stepIndex, _previous, control) {
      control.setActiveSubagentId("sa-running");
      return new Promise<DelegateChainStepOutcome>(() => {});
    },
    async cancelSubagent() {},
  });
  const chain = coordinator.start("wait abort", [
    { subagent: "bee", profile: "deep", task: "Analyze." },
  ]);
  await Promise.resolve();
  const abort = new AbortController();
  const waiting = coordinator.waitFor([chain.id], abort.signal);
  abort.abort();

  await assert.rejects(waiting, /wait was aborted/);
  assert.equal(coordinator.get(chain.id)?.status, "running");
  await coordinator.cancel([chain.id]);
  await coordinator.waitFor([chain.id]);
});

test("cancelling an active chain interrupts its child exactly once", async () => {
  const cancelled: string[] = [];
  const coordinator = new DelegateChainCoordinator({
    async executeStep(_step, _stepIndex, _previous, control) {
      control.setActiveSubagentId("sa-active");
      return new Promise<DelegateChainStepOutcome>(() => {});
    },
    async cancelSubagent(id) {
      cancelled.push(id);
    },
  });

  const chain = coordinator.start("active cancellation", [
    { subagent: "bee", profile: "deep", task: "Analyze." },
  ]);
  await Promise.resolve();
  await coordinator.cancel([chain.id]);
  await coordinator.waitFor([chain.id]);

  assert.deepEqual(cancelled, ["sa-active"]);
  assert.equal(coordinator.get(chain.id)?.status, "cancelled");
});

test("cancellation aborts pre-spawn work and cancels an id published after the race", async () => {
  let publishLateSubagent: (() => void) | undefined;
  const cancelled: string[] = [];
  const coordinator = new DelegateChainCoordinator({
    async executeStep(_step, _stepIndex, _previous, control) {
      return new Promise<DelegateChainStepOutcome>((resolve) => {
        publishLateSubagent = () => {
          control.setActiveSubagentId("sa-late");
          resolve({
            status: "done",
            subagentId: "sa-late",
            output: "must not advance",
            harness: "pi",
            model: "provider/model",
          });
        };
      });
    },
    async cancelSubagent(id) {
      cancelled.push(id);
    },
  });

  const chain = coordinator.start("cancel race", [
    { subagent: "bee", profile: "deep", task: "Analyze." },
    { subagent: "reviewer", profile: "max", task: "Decide." },
  ]);
  await Promise.resolve();
  await coordinator.cancel([chain.id]);
  await coordinator.waitFor([chain.id]);
  publishLateSubagent?.();
  await Promise.resolve();

  assert.deepEqual(cancelled, ["sa-late"]);
  assert.equal(coordinator.get(chain.id)?.status, "cancelled");
  assert.equal(coordinator.get(chain.id)?.steps[1]?.status, "pending");
});

test("the hard deadline cancels a wedged child and settles instead of hanging", async () => {
  let fireDeadline: (() => void) | undefined;
  const cancelled: string[] = [];
  const coordinator = new DelegateChainCoordinator({
    async executeStep(_step, _stepIndex, _previous, control) {
      control.setActiveSubagentId("sa-1");
      return new Promise<DelegateChainStepOutcome>(() => {});
    },
    async cancelSubagent(id) {
      cancelled.push(id);
      return new Promise<void>(() => {});
    },
    defaultStepTimeoutMs: 10_000,
    scheduleDeadline(onDeadline, timeoutMs) {
      assert.equal(timeoutMs, 10_000);
      fireDeadline = onDeadline;
      return () => {
        fireDeadline = undefined;
      };
    },
  });

  const chain = coordinator.start("wedged chain", [
    { subagent: "bee", profile: "deep", task: "Analyze." },
  ]);
  await Promise.resolve();
  assert.ok(fireDeadline);
  fireDeadline();
  await coordinator.waitFor([chain.id]);

  assert.deepEqual(cancelled, ["sa-1"]);
  const settled = coordinator.get(chain.id);
  assert.equal(settled?.status, "error");
  assert.match(settled?.errorText ?? "", /exceeded its 10 second deadline/);
});
