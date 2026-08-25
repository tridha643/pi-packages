import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { basename, dirname } from "node:path";
import { parseComposioCliJson, sanitizeComposioCliError } from "../src/composio-cli-json.ts";
import { resolveComposioCliPath } from "../src/composio-cli-path.ts";
import { createNodeComposioCliRunner } from "../src/composio-cli-runner.ts";
import { createFakeComposioCli, type FakeComposioCli } from "./fake-composio-cli.ts";

describe("Composio CLI process boundary", () => {
  let fakeCli: FakeComposioCli;
  let previousLogPath: string | undefined;

  beforeEach(async () => {
    fakeCli = await createFakeComposioCli();
    previousLogPath = process.env.FAKE_COMPOSIO_LOG;
    process.env.FAKE_COMPOSIO_LOG = fakeCli.logPath;
  });

  afterEach(async () => {
    if (previousLogPath === undefined) {
      delete process.env.FAKE_COMPOSIO_LOG;
    } else {
      process.env.FAKE_COMPOSIO_LOG = previousLogPath;
    }
    await fakeCli.cleanup();
  });

  it("resolves a relative binary override before a different command cwd can be applied", async () => {
    const result = await resolveComposioCliPath({
      explicitPath: `./${basename(fakeCli.executablePath)}`,
      baseDirectory: dirname(fakeCli.executablePath),
      pathEnvironment: "",
      homeDirectory: dirname(fakeCli.executablePath),
    });

    assert.equal(result._tag, "success");
    if (result._tag === "success") {
      assert.equal(result.value, fakeCli.executablePath);
    }
  });

  it("sends tool JSON through stdin rather than process arguments", async () => {
    const runner = createNodeComposioCliRunner({ explicitPath: fakeCli.executablePath });
    const sensitiveArguments = JSON.stringify({ message: "private body", token: "not-in-argv" });

    const result = await runner.run({
      args: ["execute", "GITHUB_TEST", "--data", "-"],
      stdin: sensitiveArguments,
    });

    assert.equal(result._tag, "success");
    const [invocation] = await fakeCli.readInvocations();
    assert.deepEqual(invocation?.argv, ["execute", "GITHUB_TEST", "--data", "-"]);
    assert.equal(invocation?.stdin, sensitiveArguments);
    assert.equal(invocation?.argv.join(" ").includes("private body"), false);
  });

  it("decodes multibyte JSON safely when stdout splits a UTF-8 character", async () => {
    const runner = createNodeComposioCliRunner({ explicitPath: fakeCli.executablePath });
    const result = await runner.run({ args: ["split-utf8"] });

    assert.equal(result._tag, "success");
    if (result._tag === "success") {
      assert.deepEqual(result.value.parsedOutput, { text: "café" });
    }
  });

  it("redacts bearer credentials from failed process diagnostics", async () => {
    const runner = createNodeComposioCliRunner({ explicitPath: fakeCli.executablePath });
    const result = await runner.run({ args: ["fail"] });

    assert.equal(result._tag, "failure");
    if (result._tag === "failure") {
      assert.equal(result.error._tag, "ComposioCliExited");
      assert.match(result.error.message, /\[REDACTED\]/u);
      assert.equal(result.error.message.includes("secret-token-value"), false);
    }
  });

  it("bounds failed-command diagnostics before returning them to Pi", async () => {
    const runner = createNodeComposioCliRunner({ explicitPath: fakeCli.executablePath });
    const result = await runner.run({ args: ["large-fail"] });

    assert.equal(result._tag, "failure");
    if (result._tag === "failure") {
      assert.ok(result.error.message.length < 17_000);
      assert.match(result.error.message, /failure output truncated/u);
    }
  });

  it("fails rather than returning silently truncated successful output", async () => {
    const runner = createNodeComposioCliRunner({ explicitPath: fakeCli.executablePath });
    const result = await runner.run({ args: ["large-success"], maxCaptureBytes: 1_000 });

    assert.equal(result._tag, "failure");
    if (result._tag === "failure") {
      assert.equal(result.error._tag, "ComposioCliOutputLimitExceeded");
    }
  });

  it("honors an already-aborted signal without launching the CLI", async () => {
    const runner = createNodeComposioCliRunner({ explicitPath: fakeCli.executablePath });
    const abortController = new AbortController();
    abortController.abort();

    const result = await runner.run({ args: ["sleep"], signal: abortController.signal });

    assert.equal(result._tag, "failure");
    if (result._tag === "failure") {
      assert.equal(result.error._tag, "ComposioCliAborted");
    }
    assert.deepEqual(await fakeCli.readInvocations(), []);
  });

  it("rechecks cancellation after asynchronous binary resolution", async () => {
    const runner = createNodeComposioCliRunner({ explicitPath: fakeCli.executablePath });
    const abortController = new AbortController();
    const pendingResult = runner.run({ args: ["sleep"], signal: abortController.signal });
    queueMicrotask(() => abortController.abort());

    const result = await pendingResult;

    assert.equal(result._tag, "failure");
    if (result._tag === "failure") {
      assert.equal(result.error._tag, "ComposioCliAborted");
    }
    assert.deepEqual(await fakeCli.readInvocations(), []);
  });
});

describe("Composio CLI output parsing", () => {
  it("extracts the last JSON value from mixed OAuth output", () => {
    const parsed = parseComposioCliJson(
      "Open https://example.test/login\n{\"pending\":true}\nDone\n{\"connected\":true}\n",
    );
    assert.deepEqual(parsed, { connected: true });
  });

  it("redacts JSON and header credential forms", () => {
    const sanitized = sanitizeComposioCliError(
      [
        "Authorization: Basic dXNlcjpwYXNz",
        'api_key="secret-key", access_token=access-value',
        'password="password-value", client_secret="client-value", private_key="private-value"',
        'cookie="cookie-value", session_token="session-value"',
        'token="generic-token-value", secret="generic-secret-value"',
      ].join("\n"),
    );
    assert.equal(sanitized.includes("dXNlcjpwYXNz"), false);
    assert.equal(sanitized.includes("secret-key"), false);
    assert.equal(sanitized.includes("access-value"), false);
    assert.equal(sanitized.includes("password-value"), false);
    assert.equal(sanitized.includes("client-value"), false);
    assert.equal(sanitized.includes("private-value"), false);
    assert.equal(sanitized.includes("cookie-value"), false);
    assert.equal(sanitized.includes("session-value"), false);
    assert.equal(sanitized.includes("generic-token-value"), false);
    assert.equal(sanitized.includes("generic-secret-value"), false);
  });

  it("redacts escaped and embedded secret values in structured JSON", () => {
    const sanitized = sanitizeComposioCliError(
      JSON.stringify({
        nested: { password: 'abc"remaining-secret', safe: "visible" },
        error: "Authorization: Bearer embedded-token-value",
        headers: {
          "x-api-key": "prefixed-api-key-value",
          "x-auth-token": "prefixed-auth-token-value",
          "set-cookie": "prefixed-cookie-value",
          aws_access_key_id: "prefixed-aws-key-value",
        },
      }),
    );
    assert.equal(sanitized.includes("remaining-secret"), false);
    assert.equal(sanitized.includes("embedded-token-value"), false);
    assert.equal(sanitized.includes("prefixed-api-key-value"), false);
    assert.equal(sanitized.includes("prefixed-auth-token-value"), false);
    assert.equal(sanitized.includes("prefixed-cookie-value"), false);
    assert.equal(sanitized.includes("prefixed-aws-key-value"), false);
    assert.match(sanitized, /\[REDACTED\]/u);
    assert.match(sanitized, /visible/u);
  });
});
