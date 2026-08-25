import assert from "node:assert/strict";
import test from "node:test";
import { forceOpenAiServiceTier } from "./src/backends/openai-fast.ts";

test("OpenAI child payloads always use the priority service tier", () => {
  assert.deepEqual(
    forceOpenAiServiceTier("openai", {
      model: "gpt-5.4",
      service_tier: "default",
    }),
    { model: "gpt-5.4", service_tier: "priority" },
  );
  assert.deepEqual(
    forceOpenAiServiceTier("openai-codex", { input: "hello" }),
    { input: "hello", service_tier: "priority" },
  );
});

test("OpenAI fast mode leaves unrelated providers and invalid payload shapes untouched", () => {
  const anthropicPayload = { model: "claude-opus-4-6" };
  const arrayPayload = [{ input: "hello" }];

  assert.equal(
    forceOpenAiServiceTier("anthropic", anthropicPayload),
    anthropicPayload,
  );
  assert.equal(forceOpenAiServiceTier("openai", null), null);
  assert.equal(forceOpenAiServiceTier("openai", "payload"), "payload");
  assert.equal(forceOpenAiServiceTier("openai", arrayPayload), arrayPayload);
});
