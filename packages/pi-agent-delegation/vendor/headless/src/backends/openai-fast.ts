import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

function isProviderPayload(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Force the OpenAI priority service tier while preserving unrelated provider payloads. */
export function forceOpenAiServiceTier(
  provider: string | undefined,
  payload: unknown,
): unknown {
  if (
    (provider !== "openai" && provider !== "openai-codex") ||
    !isProviderPayload(payload)
  ) {
    return payload;
  }
  return { ...payload, service_tier: "priority" };
}

/** Register the narrow fast-mode hook used only by in-process child delegates. */
export const openAiFastExtension: ExtensionFactory = (pi) => {
  pi.on("before_provider_request", (event, context) =>
    forceOpenAiServiceTier(context.model?.provider, event.payload));
};
