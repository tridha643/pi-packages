import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One process invocation captured by the executable fake Composio boundary. */
export type FakeComposioInvocation = {
  readonly argv: ReadonlyArray<string>;
  readonly stdin: string;
};

/** Disposable executable fake used to test the real process and stdin boundary. */
export type FakeComposioCli = {
  readonly executablePath: string;
  readonly logPath: string;
  readonly readInvocations: () => Promise<ReadonlyArray<FakeComposioInvocation>>;
  readonly writeArtifact: (payload: unknown) => Promise<string>;
  readonly cleanup: () => Promise<void>;
};

const FAKE_CLI_SOURCE = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const stdin = readFileSync(0, "utf8");
const logPath = process.env.FAKE_COMPOSIO_LOG;
if (logPath) appendFileSync(logPath, JSON.stringify({ argv, stdin }) + "\\n");

if (argv[0] === "sleep") {
  setTimeout(() => console.log(JSON.stringify({ successful: true })), 30000);
} else if (argv[0] === "split-utf8") {
  const output = Buffer.from(JSON.stringify({ text: "café" }));
  const splitAt = output.indexOf(0xc3) + 1;
  process.stdout.write(output.subarray(0, splitAt));
  setImmediate(() => process.stdout.end(output.subarray(splitAt)));
} else if (argv[0] === "large-success") {
  process.stdout.write("x".repeat(100000));
} else if (argv[0] === "large-fail") {
  console.error("x".repeat(100000));
  process.exitCode = 8;
} else if (argv[0] === "fail") {
  console.error("Authorization: Bearer secret-token-value");
  process.exitCode = 7;
} else if (argv[0] === "--version") {
  console.log("0.2.31");
} else if (argv[0] === "config" && argv[1] === "experimental" && argv[2] === "multi_account") {
  console.log(process.env.FAKE_COMPOSIO_MULTI_ACCOUNT || "on");
} else if (argv[0] === "whoami") {
  console.log(JSON.stringify({ email: "developer@example.test", org_id: "org_test" }));
} else if (argv[0] === "login" && argv.includes("--no-wait")) {
  console.log("Open this URL in your browser: https://platform.example.test/login?cliKey=test-key");
} else if (argv[0] === "login" && argv.includes("--poll")) {
  if (process.env.FAKE_COMPOSIO_SLOW_LOGIN === "1") {
    setTimeout(() => console.log(JSON.stringify({ email: "developer@example.test", org_id: "org_test" })), 30000);
  } else console.log(JSON.stringify({ email: "developer@example.test", org_id: "org_test" }));
} else if (argv[0] === "connections") {
  console.log(JSON.stringify({ github: [{ status: "ACTIVE", alias: "default" }] }));
} else if (argv[0] === "proxy") {
  console.log(JSON.stringify({ endpoint: argv[1], request_body: stdin || null }));
} else if (argv[0] === "execute" && argv.includes("--get-schema")) {
  console.log(JSON.stringify({ slug: argv[1], inputSchema: { type: "object", properties: {} } }));
} else if (argv[0] === "execute" && (argv[1] === "COMPOSIO_SEARCH_TOOLS" || argv[1] === "COMPOSIO_GET_TOOL_SCHEMAS")) {
  if (stdin.includes("spill") && process.env.FAKE_COMPOSIO_ARTIFACT) {
    console.log(JSON.stringify({ successful: true, error: null, storedInFile: true, tokenCount: 12000, outputFilePath: process.env.FAKE_COMPOSIO_ARTIFACT }));
  } else console.log(JSON.stringify({
    successful: true,
    error: null,
    data: {
      success: true,
      session: { id: "session_test" },
      tool_schemas: {
        GITHUB_GET_THE_AUTHENTICATED_USER: {
          toolkit: "GITHUB",
          tool_slug: "GITHUB_GET_THE_AUTHENTICATED_USER",
          description: "Get the authenticated GitHub user.",
          input_schema: { type: "object", properties: {} },
          hasFullSchema: true
        }
      }
    }
  }));
} else if (argv[0] === "execute") {
  let parsed = {};
  if (stdin) parsed = JSON.parse(stdin);
  console.log(JSON.stringify({ successful: true, error: null, data: { slug: argv[1], arguments: parsed, argv } }));
} else {
  console.log(JSON.stringify({ argv, stdin }));
}
`;

/** Create an executable fake that records argv and stdin without mocking process APIs. */
export async function createFakeComposioCli(): Promise<FakeComposioCli> {
  const directory = await mkdtemp(join(tmpdir(), "pi-composio-cli-test-"));
  const executablePath = join(directory, "composio.mjs");
  const logPath = join(directory, "invocations.jsonl");
  await writeFile(executablePath, FAKE_CLI_SOURCE, "utf8");
  await chmod(executablePath, 0o700);

  return {
    executablePath,
    logPath,
    async readInvocations() {
      let raw: string;
      try {
        raw = await readFile(logPath, "utf8");
      } catch {
        return [];
      }
      return raw
        .split("\n")
        .filter(Boolean)
        // SAFETY: The executable fake is the only writer and always emits the FakeComposioInvocation shape.
        .map((line) => JSON.parse(line) as FakeComposioInvocation);
    },
    async writeArtifact(payload) {
      const artifactPath = join(directory, "stored-output.json");
      await writeFile(artifactPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
      return artifactPath;
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
