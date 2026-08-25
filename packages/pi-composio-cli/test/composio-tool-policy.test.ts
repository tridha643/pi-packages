import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enforceComposioRecipePolicy } from "../src/composio-tool-policy.ts";

describe("Composio recipe exclusion", () => {
  it("rejects a recipe slug nested inside multi-execute arguments", () => {
    const result = enforceComposioRecipePolicy({
      tools: [{ tool_slug: "COMPOSIO_UPSERT_RECIPE", arguments: {} }],
    });

    assert.equal(result._tag, "failure");
    if (result._tag === "failure") {
      assert.equal(result.error.forbiddenSlug, "COMPOSIO_UPSERT_RECIPE");
      assert.match(result.error.message, /recipe operation forbidden/u);
    }
  });

  it("rejects recipe references embedded in remote code", () => {
    const result = enforceComposioRecipePolicy({
      code_to_execute: 'run_composio_tool(tool_slug="COMPOSIO_GET_RECIPE", arguments={})',
    });

    assert.equal(result._tag, "failure");
  });

  it("allows ordinary tools and every supported non-recipe meta-tool", () => {
    const result = enforceComposioRecipePolicy({
      slug: "COMPOSIO_MULTI_EXECUTE_TOOL",
      tools: [{ tool_slug: "GITHUB_GET_THE_AUTHENTICATED_USER", arguments: {} }],
    });

    assert.deepEqual(result, { _tag: "success", value: undefined });
  });
});
