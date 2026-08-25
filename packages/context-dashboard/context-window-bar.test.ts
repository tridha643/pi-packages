import assert from "node:assert/strict";
import test from "node:test";
import {
  createContextWindowBarLayout,
  formatPlainContextWindowBar,
  type ContextWindowBarUsage,
} from "./context-window-bar.ts";

const usage = (overrides: Partial<ContextWindowBarUsage> = {}): ContextWindowBarUsage => ({
  contextTokens: 46_000,
  contextWindow: 272_000,
  contextPercent: 17,
  cost: 0.42,
  tokensPerSecond: 31,
  ...overrides,
});

test("renders occupied context like the Codex usage bar", () => {
  const layout = createContextWindowBarLayout(usage(), 80);

  assert.equal(layout.label, "Context ›");
  assert.equal(layout.filledTrack, "━━━");
  assert.equal(layout.emptyTrack, "───────────────");
  assert.equal(layout.percentLabel, "17%");
  assert.equal(layout.details, " · 46k/272k · $0.42 · 31 tok/s");
  assert.equal(layout.tone, "success");
});

test("preserves the bar and drops secondary details on narrow footers", () => {
  const output = formatPlainContextWindowBar(createContextWindowBarLayout(usage(), 35));

  assert.equal(output, "Context › ━━━─────────────── 17%");
  assert.equal([...output].length, 32);
});

test("uses warning and error tones near context exhaustion", () => {
  assert.equal(createContextWindowBarLayout(usage({ contextPercent: 70 }), 40).tone, "warning");
  assert.equal(createContextWindowBarLayout(usage({ contextPercent: 90 }), 40).tone, "error");
});

test("clamps malformed percentages and handles unknown context usage", () => {
  const overfull = createContextWindowBarLayout(usage({ contextPercent: 180 }), 40);
  const unknown = createContextWindowBarLayout(usage({ contextPercent: null }), 40);

  assert.equal(overfull.percentLabel, "100%");
  assert.equal(overfull.emptyTrack, "");
  assert.equal(unknown.percentLabel, "?%");
  assert.equal(unknown.filledTrack, "");
  assert.equal(unknown.tone, "muted");
});

test("never exceeds the available width", () => {
  for (const width of [0, 1, 5, 10, 16, 24, 35, 50, 80]) {
    const output = formatPlainContextWindowBar(createContextWindowBarLayout(usage(), width));
    assert.ok([...output].length <= width, `${width}-column output was ${[...output].length} columns: ${output}`);
  }
});
