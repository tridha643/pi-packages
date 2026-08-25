import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SIDE_PARENT_PANE_ENV = "PI_SIDE_PARENT_PANE";
const SIDE_BRANCH_ENTRY_ENV = "PI_SIDE_BRANCH_ENTRY_ID";
const SIDE_PARENT_SESSION_ENV = "PI_SIDE_PARENT_SESSION";

/** Extracts the created side pane ID from a Herdr agent-start JSON envelope. */
export function parseStartedPaneId(stdout: string): string | undefined {
  try {
    const envelope = JSON.parse(stdout) as {
      result?: { agent?: { pane_id?: unknown } };
    };
    const paneId = envelope.result?.agent?.pane_id;
    return typeof paneId === "string" && paneId ? paneId : undefined;
  } catch {
    return undefined;
  }
}

/** Wraps a side-session summary as context for the originating parent agent. */
export function buildParentHandoff(summary: string): string {
  return [
    "A side session forked from this conversation has finished and returned the following handoff.",
    "Treat it as additional context from work performed in the sibling pane, incorporate its results, and continue normally.",
    "",
    "<side-session-handoff>",
    summary.trim(),
    "</side-session-handoff>",
  ].join("\n");
}

function createEmptySideSessionFile(
  sourceSessionFile: string,
  sessionDir: string,
  cwd: string,
): string {
  const emptySession = SessionManager.create(cwd, sessionDir, {
    parentSession: sourceSessionFile,
  });
  const sideSessionFile = emptySession.getSessionFile();
  const header = emptySession.getHeader();
  if (!sideSessionFile || !header) {
    throw new Error("Pi did not create an empty side-session path");
  }

  // New Pi sessions stay in memory until their first assistant response. Write
  // the header so `pi --session` can open this intentional empty clone now.
  writeFileSync(sideSessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
  return sideSessionFile;
}

function closePaneSoon(paneId: string): void {
  const timer = setTimeout(() => {
    const child = spawn(process.env.HERDR_BIN_PATH ?? "herdr", ["pane", "close", paneId], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  }, 300);
  timer.unref?.();
}

async function openSideSession(
  pi: ExtensionAPI,
  prompt: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (
    process.env.HERDR_ENV !== "1" ||
    !process.env.HERDR_PANE_ID ||
    !process.env.HERDR_TAB_ID
  ) {
    ctx.ui.notify("/side requires Pi to be running inside Herdr", "error");
    return;
  }

  await ctx.waitForIdle();

  const sourceSessionFile = ctx.sessionManager.getSessionFile();
  const branchEntryId = ctx.sessionManager.getLeafId();
  if (!sourceSessionFile || !branchEntryId) {
    ctx.ui.notify("/side needs an initialized Pi session", "warning");
    return;
  }

  let sideSessionFile: string | undefined;
  try {
    const sourceBranch = ctx.sessionManager.getBranch(branchEntryId);
    const hasAssistantResponse = sourceBranch.some(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );

    if (hasAssistantResponse) {
      const clone = SessionManager.open(
        sourceSessionFile,
        ctx.sessionManager.getSessionDir(),
        ctx.cwd,
      );
      sideSessionFile = clone.createBranchedSession(branchEntryId);
      if (!sideSessionFile) throw new Error("Pi did not create a persisted cloned session");
    } else {
      sideSessionFile = createEmptySideSessionFile(
        sourceSessionFile,
        ctx.sessionManager.getSessionDir(),
        ctx.cwd,
      );
    }

    const launchArgs = [
      "agent",
      "start",
      "Side",
      "--cwd",
      ctx.cwd,
      "--tab",
      process.env.HERDR_TAB_ID,
      "--split",
      "right",
      "--env",
      `${SIDE_PARENT_PANE_ENV}=${process.env.HERDR_PANE_ID}`,
      "--env",
      `${SIDE_BRANCH_ENTRY_ENV}=${branchEntryId}`,
      "--env",
      `${SIDE_PARENT_SESSION_ENV}=${sourceSessionFile}`,
      prompt ? "--no-focus" : "--focus",
      "--",
      process.env.PI_HERDR_PI_BIN ?? "pi",
      "--session",
      sideSessionFile,
    ];
    if (prompt) launchArgs.push(prompt);

    const result = await pi.exec(process.env.HERDR_BIN_PATH ?? "herdr", launchArgs, {
      cwd: ctx.cwd,
    });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "Herdr failed to start the pane");
    }

    const paneId = parseStartedPaneId(result.stdout);
    if (!paneId) throw new Error("Herdr started the side session but returned no pane ID");

    ctx.ui.notify(
      prompt ? `Side session started in ${paneId}` : `Side session opened in ${paneId}`,
      "info",
    );
  } catch (error) {
    if (sideSessionFile) rmSync(sideSessionFile, { force: true });
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

function registerSideEndCommand(pi: ExtensionAPI): void {
  const parentPaneId = process.env[SIDE_PARENT_PANE_ENV];
  const branchEntryId = process.env[SIDE_BRANCH_ENTRY_ENV];
  const currentPaneId = process.env.HERDR_PANE_ID;
  if (!parentPaneId || !branchEntryId || !currentPaneId) return;

  let handoffRequested = false;

  pi.registerTool({
    name: "complete_side_session",
    label: "Complete Side Session",
    description:
      "Return the final side-session summary to the parent pane and close this pane. " +
      "Call this exactly once, and only after the user invokes /side-end.",
    parameters: Type.Object({
      summary: Type.String({
        description:
          "Concise self-contained handoff covering the side goal, completed work, decisions, files, tests, unresolved issues, and next steps.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!handoffRequested) {
        throw new Error("The user has not invoked /side-end in this side session");
      }

      const result = await pi.exec(
        process.env.HERDR_BIN_PATH ?? "herdr",
        ["pane", "run", parentPaneId, buildParentHandoff(params.summary)],
        { cwd: ctx.cwd },
      );
      if (result.code !== 0) {
        throw new Error(
          result.stderr.trim() || result.stdout.trim() || "Herdr could not deliver the handoff",
        );
      }

      handoffRequested = false;
      closePaneSoon(currentPaneId);
      return {
        content: [{ type: "text", text: "Handoff delivered. Closing the side pane." }],
        details: { parentPaneId, branchEntryId },
        terminate: true,
      };
    },
  });

  pi.registerCommand("side-end", {
    description: "Summarize this side session, return it to the parent, and close this pane",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      handoffRequested = true;

      const notes = args.trim();
      const prompt = [
        "The user invoked /side-end. Summarize the work performed in this side session for the parent agent.",
        "Focus on the work after this session forked; include inherited parent context only when needed to explain the result.",
        "The summary must be concise and self-contained, covering the goal, completed work, decisions, concrete findings, changed files or symbols, commands and tests, unresolved issues, and exact next steps.",
        "You must finish by calling complete_side_session exactly once with the final summary. Do not merely print the summary.",
        notes ? `Additional handoff notes from the user: ${notes}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      pi.sendUserMessage(prompt);
    },
  });
}

/** Registers the /side command and side-only handoff lifecycle. */
export default function sideSession(pi: ExtensionAPI): void {
  pi.registerCommand("side", {
    description: "Open a cloned Pi session beside this pane: /side [prompt]",
    handler: async (args, ctx) => openSideSession(pi, args.trim(), ctx),
  });

  registerSideEndCommand(pi);
}
