import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultDelegateContextPolicy,
  formatDelegateContextPolicy,
} from "../src/delegate-context-policy.ts";

test("context policy defaults stay independent from compute profiles", () => {
  assert.equal(defaultDelegateContextPolicy("scout"), "fresh");
  assert.equal(defaultDelegateContextPolicy("builder"), "handoff");
  assert.equal(defaultDelegateContextPolicy("reviewer"), "review");
  assert.match(formatDelegateContextPolicy("review"), /frozen workspace revision/);
  assert.match(formatDelegateContextPolicy("handoff"), /bounded, untrusted/);
});
