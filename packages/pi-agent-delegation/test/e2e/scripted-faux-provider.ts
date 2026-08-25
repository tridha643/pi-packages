import { appendFileSync } from "node:fs";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Context,
  type FauxResponseFactory,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const E2E_PROVIDER = "delegation-e2e-faux";
const E2E_MODEL = "delegation-e2e-model";
const E2E_API = "delegation-e2e-faux-api";
const E2E_RESPONSE_CAPACITY = 32;

function recordE2eEvidence(event: string, details: Record<string, unknown> = {}): void {
  const evidencePath = process.env.PI_DELEGATION_E2E_EVIDENCE_PATH;
  if (!evidencePath) {
    throw new Error("Delegation E2E fixture requires PI_DELEGATION_E2E_EVIDENCE_PATH.");
  }
  appendFileSync(evidencePath, `${JSON.stringify({ event, ...details })}\n`, "utf8");
}

function messageText(message: Context["messages"][number]): string {
  if (message.role === "assistant") {
    return message.content
      .map((block) =>
        block.type === "text"
          ? block.text
          : block.type === "thinking"
            ? block.thinking
            : `${block.name} ${JSON.stringify(block.arguments)}`,
      )
      .join("\n");
  }
  if (message.role === "toolResult") {
    return message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
  }
  return typeof message.content === "string"
    ? message.content
    : message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
}

function latestUserText(context: Context): string {
  const latestUserMessage = [...context.messages]
    .reverse()
    .find((message) => message.role === "user");
  return latestUserMessage ? messageText(latestUserMessage) : "";
}

function toolResults(context: Context): ToolResultMessage[] {
  return context.messages.filter(
    (message): message is ToolResultMessage => message.role === "toolResult",
  );
}

function toolResultText(result: ToolResultMessage): string {
  return messageText(result);
}

function idsFromToolResult(result: ToolResultMessage): string[] {
  return [...new Set(toolResultText(result).match(/sa-\d+/g) ?? [])];
}

function toolCall(name: string, arguments_: Record<string, unknown>) {
  recordE2eEvidence("parent-tool-call", { name, arguments: arguments_ });
  return fauxAssistantMessage(fauxToolCall(name, arguments_), {
    stopReason: "toolUse",
  });
}

function parentResponse(context: Context) {
  const results = toolResults(context);
  const resultsNamed = (name: string) =>
    results.filter((result) => result.toolName === name);
  const directResult = resultsNamed("delegate")[0];
  const directIds = directResult ? idsFromToolResult(directResult) : [];
  const directId = directIds[0];

  if (!directResult) {
    return toolCall("delegate", {
      subagent: "builder",
      profile: "strict-faux",
      name: "direct child",
      task: "DIRECT_CHILD: Return exactly DIRECT_OK.",
      context_policy: "fresh",
      write_paths: ["e2e-direct"],
    });
  }
  if (resultsNamed("delegate_wait").length === 0) {
    return toolCall("delegate_wait", { ids: directIds });
  }
  if (resultsNamed("delegate_continue").length === 0) {
    return toolCall("delegate_continue", {
      id: directId,
      task: "FOLLOWUP_CHILD: Prove the existing child context contains DIRECT_OK.",
    });
  }
  if (resultsNamed("delegate_wait").length === 1) {
    return toolCall("delegate_wait", { ids: directIds });
  }
  if (resultsNamed("delegate_parallel").length === 0) {
    return toolCall("delegate_parallel", {
      tasks: [
        {
          subagent: "builder",
          profile: "strict-faux",
          name: "parallel lane A",
          task: "PARALLEL_A: Wait at the shared barrier, then return PARALLEL_A_OK.",
          context_policy: "fresh",
          write_paths: ["e2e-parallel-a"],
        },
        {
          subagent: "builder",
          profile: "strict-faux",
          name: "parallel lane B",
          task: "PARALLEL_B: Wait at the shared barrier, then return PARALLEL_B_OK.",
          context_policy: "fresh",
          write_paths: ["e2e-parallel-b"],
        },
      ],
    });
  }
  if (resultsNamed("delegate_wait").length === 2) {
    const parallelResult = resultsNamed("delegate_parallel")[0];
    return toolCall("delegate_wait", {
      ids: parallelResult ? idsFromToolResult(parallelResult) : [],
    });
  }

  const continuationWait = resultsNamed("delegate_wait")[1];
  const parallelWait = resultsNamed("delegate_wait")[2];
  const proof = [continuationWait, parallelWait]
    .filter((result): result is ToolResultMessage => result !== undefined)
    .map(toolResultText)
    .join("\n");
  const expectedProof = ["DIRECT_OK", "CONTINUE_OK saw DIRECT_OK", "PARALLEL_A_OK", "PARALLEL_B_OK"];
  const missing = expectedProof.filter((marker) => !proof.includes(marker));
  if (missing.length > 0) {
    recordE2eEvidence("parent-final-failed", { missing });
    return fauxAssistantMessage(fauxText(`E2E_FAILED missing ${missing.join(", ")}`));
  }
  recordE2eEvidence("parent-final", { result: "E2E_OK" });
  return fauxAssistantMessage(fauxText("E2E_OK"));
}

function createParallelBarrier() {
  const arrived = new Set<string>();
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async (lane: "A" | "B"): Promise<void> => {
    arrived.add(lane);
    recordE2eEvidence("parallel-enter", { lane, arrived: [...arrived].sort() });
    if (arrived.size === 2) {
      recordE2eEvidence("parallel-release", { arrived: [...arrived].sort() });
      release?.();
    }
    await released;
  };
}

/** Register the credential-free scripted model used by the packaged-process E2E. */
export default function registerScriptedFauxProvider(pi: ExtensionAPI): void {
  const waitAtParallelBarrier = createParallelBarrier();
  const faux = registerFauxProvider({
    api: E2E_API,
    provider: E2E_PROVIDER,
    models: [{ id: E2E_MODEL, name: "Delegation E2E Faux", reasoning: false }],
    tokensPerSecond: 40,
  });

  const dispatch: FauxResponseFactory = async (context) => {
    const userText = latestUserText(context);
    if (userText.includes("FOLLOWUP_CHILD")) {
      const priorContext = context.messages.map(messageText).join("\n");
      const result = priorContext.includes("DIRECT_OK")
        ? "CONTINUE_OK saw DIRECT_OK"
        : "CONTINUE_FAILED missing DIRECT_OK";
      recordE2eEvidence("continuation-result", { result });
      return fauxAssistantMessage(fauxText(result));
    }
    if (userText.includes("DIRECT_CHILD")) {
      recordE2eEvidence("direct-result", { result: "DIRECT_OK" });
      return fauxAssistantMessage(fauxText("DIRECT_OK"));
    }
    if (userText.includes("PARALLEL_A")) {
      await waitAtParallelBarrier("A");
      recordE2eEvidence("parallel-result", { lane: "A" });
      return fauxAssistantMessage(fauxText("PARALLEL_A_OK"));
    }
    if (userText.includes("PARALLEL_B")) {
      await waitAtParallelBarrier("B");
      recordE2eEvidence("parallel-result", { lane: "B" });
      return fauxAssistantMessage(fauxText("PARALLEL_B_OK"));
    }
    if (userText.includes("PARENT_E2E_SCRIPT") || toolResults(context).length > 0) {
      return parentResponse(context);
    }
    recordE2eEvidence("unexpected-model-context", { userText });
    return fauxAssistantMessage(fauxText("E2E_FAILED unexpected model context"));
  };

  faux.setResponses(Array.from({ length: E2E_RESPONSE_CAPACITY }, () => dispatch));
  pi.on("session_start", () => recordE2eEvidence("session-start"));
  pi.on("session_shutdown", () => {
    recordE2eEvidence("session-shutdown");
    faux.unregister();
  });
  recordE2eEvidence("extension-loaded", {
    provider: E2E_PROVIDER,
    model: E2E_MODEL,
  });
}
