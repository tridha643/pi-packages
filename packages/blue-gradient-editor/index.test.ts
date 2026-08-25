import assert from "node:assert/strict";
import test from "node:test";
import {
  default as blueGradientEditor,
  findInlineSkillSuggestion,
  transformInlineSkillInvocation,
} from "./index.ts";

test("suggests the shortest matching inline skill suffix", () => {
  assert.deepEqual(
    findInlineSkillSuggestion("Use /ca", ["cache", "capture", "deploy"]),
    { skillName: "cache", suffix: "che" },
  );
});

test("moves completed inline skill tokens to their Pi command invocation", () => {
  assert.equal(
    transformInlineSkillInvocation("Please /cache inspect this", [
      { invocationName: "skill:cache", skillName: "cache" },
    ]),
    "/skill:cache Please inspect this",
  );
});

test("transforms submitted inline skills through Pi's input event", () => {
  const eventHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    getCommands: () => [{ name: "skill:cache", source: "skill" }],
    on: (eventName: string, handler: unknown) => {
      eventHandlers.set(
        eventName,
        handler as (event: unknown, ctx: unknown) => unknown,
      );
    },
  };

  blueGradientEditor(pi as never);
  eventHandlers.get("session_start")?.(undefined, {
    mode: "tui",
    ui: { setEditorComponent: () => undefined },
  });

  assert.deepEqual(eventHandlers.get("input")?.({ text: "Review /cache now" }, undefined), {
    action: "transform",
    text: "/skill:cache Review now",
  });
});
