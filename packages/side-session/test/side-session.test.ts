import assert from "node:assert/strict";
import test from "node:test";
import { buildParentHandoff, parseStartedPaneId } from "../index.ts";

test("parseStartedPaneId reads the Herdr agent-start envelope", () => {
  assert.equal(
    parseStartedPaneId(JSON.stringify({ result: { agent: { pane_id: "pane-123" } } })),
    "pane-123",
  );
  assert.equal(parseStartedPaneId("not json"), undefined);
  assert.equal(parseStartedPaneId(JSON.stringify({ result: { agent: { pane_id: 123 } } })), undefined);
});

test("buildParentHandoff preserves the completed side-session summary", () => {
  assert.equal(
    buildParentHandoff("  Updated packages/side-session/index.ts  "),
    [
      "A side session forked from this conversation has finished and returned the following handoff.",
      "Treat it as additional context from work performed in the sibling pane, incorporate its results, and continue normally.",
      "",
      "<side-session-handoff>",
      "Updated packages/side-session/index.ts",
      "</side-session-handoff>",
    ].join("\n"),
  );
});
