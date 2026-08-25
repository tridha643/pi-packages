import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { registerComposioCliExtension } from "../src/composio-extension.ts";
import { createFakeComposioCli, type FakeComposioCli } from "./fake-composio-cli.ts";
import { createPiExtensionHarness } from "./pi-extension-harness.ts";

const FIXED_TOOL_NAMES = [
  "composio_search_tools",
  "composio_get_tool_schemas",
  "composio_multi_execute_tool",
  "composio_manage_connections",
  "composio_wait_for_connections",
  "composio_remote_workbench",
  "composio_remote_bash_tool",
  "composio_execute_tool",
  "composio_list_connections",
  "composio_proxy",
] as const;

async function waitForFakeInvocation(
  fakeCli: FakeComposioCli,
  predicate: (argv: ReadonlyArray<string>) => boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const invocations = await fakeCli.readInvocations();
    if (invocations.some((invocation) => predicate(invocation.argv))) {
      return;
    }
    await delay(10);
  }
  throw new Error("Timed out waiting for fake Composio CLI invocation.");
}

const COMMAND_NAMES = [
  "composio-login",
  "composio-whoami",
  "composio-link",
  "composio-connections",
  "composio-reset-tools",
  "composio-doctor",
] as const;

describe("Composio Pi extension", () => {
  let fakeCli: FakeComposioCli;
  let previousCliPath: string | undefined;
  let previousLogPath: string | undefined;
  let previousArtifactPath: string | undefined;
  let previousMultiAccountStatus: string | undefined;
  let previousSlowLogin: string | undefined;

  beforeEach(async () => {
    fakeCli = await createFakeComposioCli();
    previousCliPath = process.env.COMPOSIO_CLI_PATH;
    previousLogPath = process.env.FAKE_COMPOSIO_LOG;
    previousArtifactPath = process.env.FAKE_COMPOSIO_ARTIFACT;
    previousMultiAccountStatus = process.env.FAKE_COMPOSIO_MULTI_ACCOUNT;
    previousSlowLogin = process.env.FAKE_COMPOSIO_SLOW_LOGIN;
    process.env.COMPOSIO_CLI_PATH = fakeCli.executablePath;
    process.env.FAKE_COMPOSIO_LOG = fakeCli.logPath;
  });

  afterEach(async () => {
    if (previousCliPath === undefined) delete process.env.COMPOSIO_CLI_PATH;
    else process.env.COMPOSIO_CLI_PATH = previousCliPath;
    if (previousLogPath === undefined) delete process.env.FAKE_COMPOSIO_LOG;
    else process.env.FAKE_COMPOSIO_LOG = previousLogPath;
    if (previousArtifactPath === undefined) delete process.env.FAKE_COMPOSIO_ARTIFACT;
    else process.env.FAKE_COMPOSIO_ARTIFACT = previousArtifactPath;
    if (previousMultiAccountStatus === undefined) delete process.env.FAKE_COMPOSIO_MULTI_ACCOUNT;
    else process.env.FAKE_COMPOSIO_MULTI_ACCOUNT = previousMultiAccountStatus;
    if (previousSlowLogin === undefined) delete process.env.FAKE_COMPOSIO_SLOW_LOGIN;
    else process.env.FAKE_COMPOSIO_SLOW_LOGIN = previousSlowLogin;
    await fakeCli.cleanup();
  });

  it("registers the complete non-recipe fixed surface and account commands", () => {
    const harness = createPiExtensionHarness();
    registerComposioCliExtension(harness.api);

    assert.deepEqual(harness.toolNames().toSorted(), [...FIXED_TOOL_NAMES].sort());
    assert.deepEqual(harness.commandNames().toSorted(), [...COMMAND_NAMES].sort());
    assert.equal(harness.toolNames().some((name) => name.includes("recipe")), false);
  });

  it("searches through the CLI, loads a typed ordinary tool, and preserves active Pi tools", async () => {
    const harness = createPiExtensionHarness(["read", "bash"]);
    registerComposioCliExtension(harness.api);

    const searchResult = await harness.executeTool("composio_search_tools", {
      queries: [{ use_case: "read the authenticated GitHub user" }],
    });

    const dynamicToolName = "composio_github_get_the_authenticated_user";
    assert.ok(harness.toolNames().includes(dynamicToolName));
    assert.ok(harness.activeToolNames().includes("read"));
    assert.ok(harness.activeToolNames().includes("bash"));
    assert.ok(harness.activeToolNames().includes(dynamicToolName));
    assert.deepEqual(searchResult.addedToolNames, [dynamicToolName]);
    assert.equal(searchResult.content[0]?.type, "text");
    if (searchResult.content[0]?.type === "text") {
      assert.match(searchResult.content[0].text, new RegExp(`Loaded Pi tools: ${dynamicToolName}`, "u"));
    }

    await harness.executeTool(dynamicToolName, {
      __pi_composio_account: "default",
      __pi_composio_dry_run: true,
      __pi_composio_file: "/tmp/upload.txt",
    });
    const invocations = await fakeCli.readInvocations();
    const dynamicInvocation = invocations.find(
      (invocation) => invocation.argv[0] === "execute" && invocation.argv[1] === "GITHUB_GET_THE_AUTHENTICATED_USER",
    );
    assert.ok(dynamicInvocation);
    assert.ok(dynamicInvocation.argv.includes("--account"));
    assert.ok(dynamicInvocation.argv.includes("default"));
    assert.ok(dynamicInvocation.argv.includes("--dry-run"));
    assert.ok(dynamicInvocation.argv.includes("--file"));
    assert.ok(dynamicInvocation.argv.includes("/tmp/upload.txt"));
    assert.deepEqual(JSON.parse(dynamicInvocation.stdin), {});

    await harness.startSession();
    assert.ok(harness.activeToolNames().includes(dynamicToolName));

    await harness.navigateSessionTree(0);
    assert.equal(harness.activeToolNames().includes(dynamicToolName), false);
    await harness.navigateSessionTree(harness.sessionEntries.length);
    assert.ok(harness.activeToolNames().includes(dynamicToolName));
  });

  it("refuses account selectors when the CLI multi-account feature is off", async () => {
    const harness = createPiExtensionHarness();
    registerComposioCliExtension(harness.api);
    process.env.FAKE_COMPOSIO_MULTI_ACCOUNT = "off";

    await assert.rejects(
      harness.executeTool("composio_execute_tool", {
        slug: "GITHUB_GET_THE_AUTHENTICATED_USER",
        arguments: {},
        account: "secondary",
      }),
      /account selection unavailable/u,
    );
    await harness.invokeCommand("composio-link", "github secondary");

    const invocations = await fakeCli.readInvocations();
    assert.equal(
      invocations.some(
        (invocation) =>
          (invocation.argv[0] === "execute" &&
            invocation.argv[1] === "GITHUB_GET_THE_AUTHENTICATED_USER") ||
          invocation.argv[0] === "link",
      ),
      false,
    );
    assert.ok(harness.notifications.some((message) => message.includes("account alias unavailable")));
  });

  it("loads schemas from a large-result CLI artifact", async () => {
    const harness = createPiExtensionHarness(["read"]);
    registerComposioCliExtension(harness.api);
    process.env.FAKE_COMPOSIO_ARTIFACT = await fakeCli.writeArtifact({
      successful: true,
      error: null,
      data: {
        session: { id: "stored-session-id" },
        tool_schemas: {
          GITHUB_GET_THE_AUTHENTICATED_USER: {
            toolkit: "GITHUB",
            tool_slug: "GITHUB_GET_THE_AUTHENTICATED_USER",
            description: "Get the authenticated GitHub user.",
            input_schema: { type: "object", properties: {} },
          },
        },
      },
    });

    const result = await harness.executeTool("composio_search_tools", {
      queries: [{ use_case: "spill a large schema response" }],
    });

    assert.ok(harness.activeToolNames().includes("composio_github_get_the_authenticated_user"));
    assert.equal(result.content[0]?.type, "text");
    if (result.content[0]?.type === "text") {
      assert.match(result.content[0].text, /stored-session-id/u);
      assert.equal(result.content[0].text.includes("storedInFile"), false);
    }
  });

  it("blocks recipes inside multi-execute before invoking the CLI", async () => {
    const harness = createPiExtensionHarness();
    registerComposioCliExtension(harness.api);
    const before = await fakeCli.readInvocations();

    await assert.rejects(
      harness.executeTool("composio_multi_execute_tool", {
        tools: [{ tool_slug: "COMPOSIO_UPSERT_RECIPE", arguments: {} }],
        sync_response_to_workbench: false,
      }),
      /recipe operation forbidden/u,
    );

    assert.deepEqual(await fakeCli.readInvocations(), before);
  });

  it("resets only dynamically loaded Composio tools", async () => {
    const harness = createPiExtensionHarness(["read"]);
    registerComposioCliExtension(harness.api);
    await harness.executeTool("composio_search_tools", {
      queries: [{ use_case: "read the authenticated GitHub user" }],
    });

    await harness.invokeCommand("composio-reset-tools");

    assert.deepEqual(harness.activeToolNames(), ["read"]);
    assert.match(harness.notifications.at(-1) ?? "", /Deactivated 1/u);
  });

  it("rejects secret-bearing proxy headers before they reach process arguments", async () => {
    const harness = createPiExtensionHarness();
    registerComposioCliExtension(harness.api);

    for (const headers of [
      { "X-Goog-Api-Key": "process-list-secret" },
      { "X-Custom-Auth": "Basic process-list-secret" },
      { "X-License-Key": "sk_live_process-list-secret" },
    ]) {
      await assert.rejects(
        harness.executeTool("composio_proxy", {
          endpoint: "/user",
          toolkit: "github",
          headers,
        }),
        /sensitive header forbidden|header not allowed/u,
      );
    }
    await assert.rejects(
      harness.executeTool("composio_proxy", {
        endpoint: "/user",
        toolkit: "github",
        headers: { "X-Trace": "ok\r\nAuthorization: Bearer process-list-secret" },
      }),
      /header invalid/u,
    );
    for (const endpoint of [
      "https://user:password@api.example.test/user",
      "/user?access_token=process-list-secret",
      "/user?accessToken=process-list-secret",
      "/user?key=process-list-secret",
      "/user?clientSecret=process-list-secret",
      "/user?privateKey=process-list-secret",
      "/user?x-amz-signature=process-list-secret",
      "/user?sig=process-list-secret",
      "https://api.example.test/user#access_token=process-list-secret",
    ]) {
      await assert.rejects(
        harness.executeTool("composio_proxy", { endpoint, toolkit: "github" }),
        /endpoint credentials forbidden|sensitive query parameter forbidden|endpoint fragment forbidden/u,
      );
    }
    assert.deepEqual(await fakeCli.readInvocations(), []);
  });

  it("aborts a command-spawned login poll on session shutdown", async () => {
    const harness = createPiExtensionHarness();
    registerComposioCliExtension(harness.api);
    process.env.FAKE_COMPOSIO_SLOW_LOGIN = "1";

    const pendingLogin = harness.invokeCommand("composio-login");
    await waitForFakeInvocation(
      fakeCli,
      (argv) => argv[0] === "login" && argv.includes("--poll"),
    );
    await harness.shutdownSession();
    await pendingLogin;

    assert.ok(harness.notifications.some((message) => message.includes("command aborted")));
  });

  it("runs login and doctor workflows without exposing the pending key separately", async () => {
    const harness = createPiExtensionHarness();
    registerComposioCliExtension(harness.api);

    await harness.invokeCommand("composio-login");
    await harness.invokeCommand("composio-doctor");

    assert.ok(
      harness.notifications.some((message) =>
        message.includes("https://platform.example.test/login?cliKey=test-key"),
      ),
    );
    assert.ok(harness.notifications.some((message) => message.includes("Version gate: pass")));
    assert.ok(harness.notifications.some((message) => message.includes("Authentication: pass")));
  });
});
