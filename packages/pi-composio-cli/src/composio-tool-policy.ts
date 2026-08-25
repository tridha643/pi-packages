import { composioFailure, composioSuccess, type ComposioResult } from "./composio-result.ts";

/** Recipe meta-tools intentionally excluded from every Pi execution surface. */
export const FORBIDDEN_COMPOSIO_RECIPE_SLUGS = [
  "COMPOSIO_UPSERT_RECIPE",
  "COMPOSIO_GET_RECIPE",
] as const;

/** Stable non-recipe meta-tool slugs exposed as first-class Pi tools. */
export const COMPOSIO_META_TOOL_SLUGS = [
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_WAIT_FOR_CONNECTIONS",
  "COMPOSIO_REMOTE_WORKBENCH",
  "COMPOSIO_REMOTE_BASH_TOOL",
] as const;

/** A supported first-class Composio meta-tool slug. */
export type ComposioMetaToolSlug = (typeof COMPOSIO_META_TOOL_SLUGS)[number];

/** A rejected attempt to reference recipe operations through any fixed tool. */
export type ComposioRecipePolicyError = {
  readonly _tag: "ComposioRecipeOperationForbidden";
  readonly message: string;
  readonly forbiddenSlug: (typeof FORBIDDEN_COMPOSIO_RECIPE_SLUGS)[number];
};

/**
 * Catch direct recipe references at the Pi boundary. Remote tools execute arbitrary user code, so this is a model-facing policy guard rather than a hostile-code sandbox.
 */
function findForbiddenRecipeSlug(
  value: unknown,
): (typeof FORBIDDEN_COMPOSIO_RECIPE_SLUGS)[number] | undefined {
  if (typeof value === "string") {
    const normalized = value.toUpperCase();
    return FORBIDDEN_COMPOSIO_RECIPE_SLUGS.find((slug) => normalized.includes(slug));
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const forbiddenSlug = findForbiddenRecipeSlug(entry);
      if (forbiddenSlug !== undefined) {
        return forbiddenSlug;
      }
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) {
      const forbiddenSlug = findForbiddenRecipeSlug(entry);
      if (forbiddenSlug !== undefined) {
        return forbiddenSlug;
      }
    }
  }
  return undefined;
}

/** Reject recipe slugs even when nested in multi-execute, remote code, or generic arguments. */
export function enforceComposioRecipePolicy(
  value: unknown,
): ComposioResult<void, ComposioRecipePolicyError> {
  const forbiddenSlug = findForbiddenRecipeSlug(value);
  if (forbiddenSlug === undefined) {
    return composioSuccess(undefined);
  }

  return composioFailure({
    _tag: "ComposioRecipeOperationForbidden",
    message: `Composio recipe operation forbidden: ${forbiddenSlug} is intentionally excluded from this Pi extension.`,
    forbiddenSlug,
  });
}
