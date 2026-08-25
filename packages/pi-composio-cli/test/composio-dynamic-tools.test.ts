import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composioDynamicToolName,
  extractComposioDynamicToolDescriptors,
} from "../src/composio-dynamic-tools.ts";

describe("Composio dynamic tool contracts", () => {
  it("creates deterministic provider-safe names no longer than 64 characters", () => {
    const slug =
      "GITHUB_A_VERY_LONG_TOOL_NAME_THAT_EXCEEDS_PROVIDER_LIMITS_AND_STILL_NEEDS_A_STABLE_ID";
    const firstName = composioDynamicToolName(slug);
    const secondName = composioDynamicToolName(slug);

    assert.equal(firstName, secondName);
    assert.ok(firstName.length <= 64);
    assert.match(firstName, /^[a-z0-9_]+$/u);
  });

  it("extracts ordinary schemas while filtering recipe descriptors", () => {
    const descriptors = extractComposioDynamicToolDescriptors({
      successful: true,
      data: {
        tool_schemas: {
          GITHUB_GET_USER: {
            toolkit: "GITHUB",
            tool_slug: "GITHUB_GET_USER",
            description: "Get a user.",
            input_schema: {
              type: "object",
              properties: { username: { type: "string" } },
              required: ["username"],
            },
          },
          COMPOSIO_GET_RECIPE: {
            toolkit: "COMPOSIO",
            tool_slug: "COMPOSIO_GET_RECIPE",
            description: "Excluded.",
            input_schema: { type: "object", properties: {} },
          },
        },
      },
    });

    assert.deepEqual(descriptors.map((descriptor) => descriptor.slug), ["GITHUB_GET_USER"]);
  });
});
