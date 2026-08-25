import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderDelegateStatusWidgetLines } from "../src/delegate-status-widget.ts";

const now = new Date("2026-07-14T23:33:19Z").getTime();

function assertWidth(lines: ReadonlyArray<string>, width: number): void {
  for (const line of lines) assert.equal(visibleWidth(line), width);
}

test("renders the Herdr-style box with strict subagent and profile identity", () => {
  const lines = renderDelegateStatusWidgetLines(
    [
      {
        title: "Config registry",
        subagent: "scott",
        profile: "fast",
        startTime: now - 316_000,
        status: "working",
      },
      {
        title: "Runtime design scout",
        subagent: "bee",
        profile: "deep-thinker",
        startTime: now - 316_000,
        status: "read",
      },
    ],
    now,
    80,
  );

  assert.match(lines[0] ?? "", /^╭─ Subagents ─+ 2 running ─╮$/);
  assert.match(lines[1] ?? "", /05:16  Config registry \(scott\[fast\]\).*working · 05:16/);
  assert.match(lines[2] ?? "", /05:16  Runtime design scout \(bee\[deep-thinker\]\).*read · 05:16/);
  assert.equal(lines.at(-1), `╰${"─".repeat(78)}╯`);
  assertWidth(lines, 80);
});

test("truncates narrow rows while preserving status and elapsed time", () => {
  const lines = renderDelegateStatusWidgetLines(
    [
      {
        title: "A very long delegate task title that cannot fit",
        harness: "codex",
        startTime: now - 5_000,
        status: "working",
      },
    ],
    now,
    44,
  );

  assert.match(lines[1] ?? "", /working · 00:05 │$/);
  assertWidth(lines, 44);
});

test("renders only borders when no delegates are running", () => {
  const lines = renderDelegateStatusWidgetLines([], now, 44);

  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /^╭─ Subagents ─+ 0 running ─╮$/);
  assertWidth(lines, 44);
});
