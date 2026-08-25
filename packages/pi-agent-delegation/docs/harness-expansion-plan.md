# Harness expansion plan — Grok, Cursor, OpenCode

Goal: let the parent Pi agent delegate to more than `pi`, `claude`, and `codex`.
Specifically Grok models, Cursor's Composer harness, and OpenCode (as a way to
reach Kimi).

Status: **plan only from here on.** Some groundwork already landed on disk; see
[Already landed](#already-landed). Nothing new is registered, so runtime
behavior is unchanged.

Decided: Grok rides Pi's own harness via xAI subscription login, Cursor uses
`@cursor/sdk`, and OpenCode uses `@opencode-ai/sdk`. The Cursor SDK's dependency
weight is accepted.

---

## Decision 1 — Grok needs no new harness and no API key

The installed Pi 0.82.0 ships an xAI provider with a **subscription OAuth login**
alongside the API-key path, and it is already in Pi's default provider list. So
this needs neither code nor a purchased key — just a sign-in.

From the running runtime at
`~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/xai.js`:

```js
auth: {
  apiKey: envApiKeyAuth("xAI API key", ["XAI_API_KEY"]),
  oauth: lazyOAuth({
    name: "xAI (Grok/X subscription)",
    loginLabel: "Sign in with SuperGrok or X Premium",
    load: loadXaiOAuth,
  }),
},
```

`auth/oauth/xai.js` implements a standard OAuth device-code flow against
`https://auth.x.ai/oauth2/device/code` with scope
`openid profile email offline_access grok-cli:access api:access`, refreshing
ahead of expiry. That's the SuperGrok / X Premium entitlement, so a SuperGrok or
X Premium subscription is sufficient and `XAI_API_KEY` becomes optional.

**Models actually available in 0.82.0** (read from the installed
`xai.models.js`, not the docs):

| Model | Context | API |
|---|---|---|
| `xai/grok-4.5` | 500k | `openai-responses` |
| `xai/grok-4.3` | 1M | `openai-completions` |
| `xai/grok-build-0.1` | 256k | `openai-completions` |

The `pi` backend resolves `provider/model-id` by splitting at the first `/` and
calling `registry.find(provider, id)` (`vendor/headless/src/backends/pi.ts:74`),
against the **parent process's** live `ModelRegistry` passed through
`ParentContext`. So `harness: pi, model: xai/grok-4.5` resolves against whatever
the host Pi has, and the OAuth credential applies automatically.

Going through the Pi harness is the right call regardless: Pi owns the agent
loop, tool execution, transcript normalization, interruption, and cost
accounting. A dedicated `xai` backend would only supply completions and would
have to reimplement all of that.

**Work required:** run the xAI OAuth login once from Pi's provider/login UI, then
add a delegate profile. No source changes.

```yaml
# ~/.pi/agent/delegate-profiles/grok.yaml
name: grok
description: Grok reasoning compute through Pi's own tool loop, on the xAI subscription login
candidates:
  - harness: pi
    model: xai/grok-4.5
    reasoning: high
  - harness: pi
    model: xai/grok-4.3
    reasoning: high
  - harness: pi
    model: xai/grok-build-0.1
    reasoning: high
```

**Stale-copy hazard, worth knowing before anyone re-derives this.** The
delegation package vendors its own older `@earendil-works/pi-ai` under
`node_modules/`, and that copy has no xAI OAuth and advertises a longer,
out-of-date model list (`grok-4.20-*`, `grok-3*`, `grok-code-fast-1`). It is
types-only for this package — the `pi` backend uses the parent's registry at
runtime — but reading it instead of the installed runtime is exactly how the
earlier "needs an API key" conclusion happened. Always check the installed
`pi-coding-agent` tree.

**Minor open item:** all three xAI models leave `supportsReasoningEffort`
undefined, while xAI documents `low`/`medium`/`high` for Grok 4.5. The
`reasoning:` field in that profile may therefore be inert. If effort forwarding
turns out to matter, the fix is a corrected model definition registered via
`pi.registerProvider(...)` — the same runtime hook `pi-cursor-provider` uses —
not a new backend.

**Optional extra:** `pi-xai@0.17.1` (npm, by `luxus`) adds Grok Build protocol
support, agentic APIs, image/video tools, and usage QoL on top of the built-in
provider. Not required for delegation; evaluate separately if the Grok Build
agentic API becomes interesting.

### Aside — Kimi K3 is also available without OpenCode

The same runtime ships a `kimi-coding` provider with its own subscription OAuth
("Sign in with Kimi Code") against `https://api.kimi.com/coding` over the
`anthropic-messages` API, exposing `kimi-coding/k3` (1M context),
`kimi-coding/kimi-for-coding`, and `kimi-coding/kimi-for-coding-highspeed`.

That means Kimi K3 as a *model* is one login away via `harness: pi`, with none
of the OpenCode install, Moonshot key, or SDK work below. Keep the OpenCode
backend only for what it uniquely provides — OpenCode's own agent harness,
agents, and tool loop. If the goal for a given profile is just "delegate to
K3", prefer `harness: pi, model: kimi-coding/k3`.

---

## Decision 2 — Cursor is a real new harness

The user wants Cursor's *harness* (Composer's speed, Cursor's own tool loop),
not merely Cursor's models. Cursor's models are separately already reachable
through `pi-cursor-provider`, which registers `composer-2-fast`, `grok-4-20`,
`grok-4-20-thinking`, and `kimi-k2.5` as Pi models — worth knowing, because it
means "run Composer under Pi's loop" and "run Composer under Cursor's loop" are
two different capabilities and only the second one needs this backend.

**Decided approach: `@cursor/sdk@1.0.24`, not the `cursor-agent` CLI.** The SDK
embeds the Cursor agent runtime in-process (the tarball ships webpack chunks
plus per-platform native packages), so this really is Cursor's harness rather
than a wrapper around a text protocol.

**Shape:** one long-lived agent handle per subagent session, many runs on it.

```ts
const agent = await Agent.create({
  model: { id: "composer-2.5-fast" },
  apiKey,
  local: { cwd, store: new JsonlLocalAgentStore(...) },
});
const run = await agent.send(prompt, { mode, onDelta, onStep });
for await (const message of run.stream()) { /* SDKMessage */ }
const result = await run.wait();   // { status, result, error, usage, durationMs }
```

`Run` exposes `stream()`, `wait()`, `cancel()`, `conversation()`, `status`,
`onDidChangeStatus()`, and `usage`. `agent.close()` / `Symbol.asyncDispose`
give the scoped teardown the backend contract needs.

**Why this beats the CLI, concretely:**

- **Thinking and token usage are exposed.** The CLI suppresses thinking in print
  output and emits no usage at all; the SDK's `InteractionUpdate` union includes
  `ThinkingDeltaUpdate`, `ThinkingCompletedUpdate`, and `TokenDeltaUpdate`, plus
  `RunResult.usage: TokenUsage`. That fills in `AssistantDelta{kind:"thinking"}`
  and `UsageChanged`, which the CLI path had to leave permanently blank.
- **Tool calls are a typed enum, not a naming heuristic.** `ToolCall` covers
  Read, Write, Edit, Delete, Glob, Grep, Ls, Shell, SemSearch, Task, CreatePlan,
  UpdateTodos, ReadLints, and Mcp with typed args and results, so `ToolStart` /
  `ToolEnd` previews stop depending on stripping a `ToolCall` suffix off a
  wrapper key.
- **Multi-turn is native.** The agent handle persists and `send()` starts
  another run, replacing the CLI's process-per-turn plus `--resume <chatId>`
  dance — which was itself an untested assumption.
- **Errors are typed.** `AuthenticationError`, `AgentBusyError`,
  `RateLimitError`, and `IntegrationNotConnectedError` map cleanly onto
  `BackendPreflightRejectedError` and `SendError` instead of being recovered by
  string-matching stderr.

**Translation table** (SDK `InteractionUpdate` → normalized event):

| Cursor SDK signal | Normalized event |
|---|---|
| `TextDeltaUpdate` | `AssistantDelta{kind:"text"}` |
| `ThinkingDeltaUpdate` / `ThinkingCompletedUpdate` | `AssistantDelta{kind:"thinking"}` |
| `ToolCallStartedUpdate` | `ToolStart` |
| `ToolCallDeltaUpdate` / `ShellOutputDeltaUpdate` | `ToolUpdate` |
| `ToolCallCompletedUpdate` | `ToolEnd` |
| `TokenDeltaUpdate`, `RunResult.usage` | `UsageChanged` |
| `Agent.create()` resolution | `MetaChanged` (`nativeSessionId: agentId`, `modelLabel`) |
| `run.wait()` → `finished` / `error` / `cancelled` | `RunSettled{Completed \| Failed \| Interrupted}` |

**Steering:** `send()` on a busy agent throws `AgentBusyError`, so
`capabilities.steering` stays `false`. `LocalSendOptions.force` expires a wedged
persisted run and is the recovery path after a crash, not a steering mechanism.

**Costs, accepted:**

- **Weight.** 20.8 MB unpacked, 303 files, plus optional native packages
  (`@cursor/sdk-darwin-arm64` and siblings) carrying ripgrep and a sandbox
  helper. The vendored tree is currently near-dependency-free, so this is the
  single biggest dependency the package would take on.
- **Transitive deps.** `@bufbuild/protobuf`, `@connectrpc/connect{,-node,-web}`,
  `@statsig/js-client`, and `zod@^3` — note Statsig means the SDK phones home for
  feature flags, which is worth a deliberate decision rather than a shrug.
- **Node ≥ 22.13** per the package's `engines`.
- **Persistence backend.** Local agents persist to SQLite when the optional
  `@cursor/sdk/sqlite` module is available and fall back to
  `JsonlLocalAgentStore` otherwise. Configure the JSONL store explicitly via
  `configureCursorSdk({ local: { store } })` so behavior doesn't silently depend
  on whether a native module happened to build.

**Blocker, unchanged by the SDK switch:** headless auth is broken on this
machine. `cursor-agent --list-models` prints exactly `No models available for
this account.`, and a real `-p` run exits 1 with `Error: Authentication
required.` Pi's `auth.json` `cursor` OAuth token is **not** a valid Cursor API
key. `AgentOptions.apiKey` needs a genuine key; the SDK surfaces the failure as
a typed `AuthenticationError` rather than parsed stderr, but it does not supply
credentials.

**Already-written code to discard:** `vendor/headless/src/backends/cursor.ts`
targets the CLI, so its NDJSON buffering, wrapper-key tool naming, stderr
auth-string matching, and `--resume` continuation are all superseded. Keep the
file only as a reference for the Effect scoping and preview-bounding patterns.

---

## Decision 3 — OpenCode is a real new harness

**There is an official SDK: `@opencode-ai/sdk@1.18.5`.** Use it. The earlier
plan to hand-roll `fetch` plus an SSE parser is superseded.

**The one thing the SDK does not do is remove the binary.** It is a generated
(hey-api) typed HTTP client plus a launcher; the OpenCode agent runtime *is* the
`opencode` binary, and `createOpencodeServer` simply spawns it. There is no
SDK-only, binary-free path, so the install below stays mandatory either way.

```ts
import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";

const server = await createOpencodeServer({ hostname: "127.0.0.1", port: 0 });
const client = createOpencodeClient({ baseUrl: server.url });
// or createOpencode() for both at once
```

`OpencodeClient` exposes namespaced, fully typed endpoints. The ones this
backend needs:

| Call | Use |
|---|---|
| `client.session.create()` | create session |
| `client.event.subscribe()` | typed SSE stream, filtered by session id |
| `client.session.promptAsync()` | initial prompt, continuation, and steering |
| `client.session.abort()` | interrupt |
| `client.session.status()` | readiness and busy/idle polling |
| `server.close()` | scoped teardown |

There are also `provider`, `auth`, `config`, `tool`, `file`, `find`, `mcp`,
`lsp`, and `project` namespaces, plus a newer `@opencode-ai/sdk/v2` export whose
surface should be compared before committing to v1.

| OpenCode event | Normalized event |
|---|---|
| text `message.part.updated` | `AssistantDelta`, reconciled against full text |
| tool part `pending`/`running`/`completed`/`error` | `ToolStart`/`ToolUpdate`/`ToolEnd` |
| `session.status` idle, `session.idle` | exactly one `RunSettled` |
| `session.error` | `BackendError`, then failed settlement |
| `message.updated` model info | `MetaChanged` |
| unknown or foreign-session | ignored |

Because `promptAsync` can be delivered while busy (the server labels delivery
`steer` or `queue`), this is the one new harness with `capabilities.steering:
true`. Bind to `127.0.0.1` on an ephemeral port so concurrent delegates never
collide.

**What the SDK buys over hand-rolling:** generated types for every endpoint and
event payload, which removes three of the four unverified guesses in the
hand-rolled backend outright — `createOpencodeServer` returns the resolved `url`
directly, so the startup-banner parsing guess disappears, and the `session.next.*`
field names and error shapes come from published types instead of inference. The
cost is one small dependency and coupling to an SDK version, which is mild next
to the Cursor SDK's weight.

**Blockers:** the binary is gone — absent from PATH, `~/.opencode`,
`/usr/local/bin`, `/opt/homebrew/bin`, `~/.bun/bin`, `~/.npm-global/bin`,
`~/.local/bin`, and mise/asdf shims. Only orphaned config
(`~/.config/opencode/opencode.jsonc`, containing just a `$schema` key) and data
(`~/.local/share/opencode/opencode.db`) remain. Reinstall with `npm i -g
opencode-ai@1.18.5` or `curl -fsSL https://opencode.ai/install | bash`.

Kimi then needs the `moonshotai` provider — `MOONSHOT_API_KEY` in the server
child's environment, or `opencode auth login --provider moonshotai`. Model
strings are `moonshotai/kimi-k2.7-code`, `moonshotai/kimi-k2.6`, etc.

**Already-written code to revise:** `vendor/headless/src/backends/opencode.ts`
hand-rolls the HTTP and SSE layer. Its session lifecycle, event translation, and
settlement logic survive; the transport, the banner parsing, and the
defensively-guessed payload shapes get replaced with SDK calls and generated
types.

---

## Already landed

These are on disk now, typecheck clean, and the full suite passes (131 tests).

**Wired and active:**

- `vendor/headless/src/domain.ts` — `BACKEND_NAMES` now includes `cursor` and
  `opencode`; comments updated for the new model-hint and reasoning semantics.
  This flows automatically into `DELEGATE_HARNESSES` in
  `src/delegate-profiles.ts`, so profiles accept the new harness names.
- `src/delegate-candidate-selection.ts` — the Codex-only tool-allowlist guard is
  now a set covering `codex`, `cursor`, and `opencode`, with per-harness
  rejection messages. Any harness that doesn't own a Pi-compatible tool surface
  is skipped when a named subagent declares `tools:`, so an allowlist is never
  silently ignored.
- `test/delegate-candidate-selection.test.ts` — two new tests: all external
  harnesses are rejected under an allowlist, and an external harness stays
  eligible without one.
- `src/delegate-extension.ts`, `index.ts`, `package.json`, `README.md` — harness
  names in the `delegate_freeform` schema description and package docs.

**Written but inert (not registered in `vendor/headless/src/runtime.ts`), and
now partly superseded by the SDK decisions above:**

- `vendor/headless/src/backends/cursor.ts` + `vendor/headless/cursor-protocol.test.ts` (8 tests) — CLI-based, to be rewritten
- `vendor/headless/src/backends/opencode.ts` + `vendor/headless/opencode-protocol.test.ts` (9 tests) — hand-rolled transport, to be retargeted

Because `runtime.ts` still builds its registry from `[piBackend,
claudeBackend, codexBackend]`, asking for `harness: cursor` today fails cleanly
with `BackendUnavailableError` (`manager.ts:454`). That is a safe intermediate
state — the names are accepted by validation and rejected at spawn with a clear
error — but it is also a real inconsistency, so it should not sit here
indefinitely.

---

## Remaining work, in order

1. **Unblock credentials and installs.** For Grok, run Pi's xAI OAuth login
   (SuperGrok / X Premium) — no key needed, and this alone completes Decision 1.
   For Cursor, a genuine Cursor API key, since Pi's stored OAuth token will not
   do. For OpenCode, `npm i -g opencode-ai@1.18.5` plus `MOONSHOT_API_KEY`.
   Optionally the Kimi Code login if `kimi-coding/k3` via `harness: pi` is worth
   having alongside the OpenCode harness.
2. **Add the SDK dependencies** — `@cursor/sdk@^1.0.24` and
   `@opencode-ai/sdk@^1.18.5` — and confirm the package's Node floor clears the
   Cursor SDK's `engines: node >= 22.13`. Decide at the same time whether to
   pull in the optional `@cursor/sdk/sqlite` native module or force
   `JsonlLocalAgentStore`, because leaving it implicit makes persistence depend
   on whether a native build happened to succeed.
3. **Rewrite `cursor.ts` against `@cursor/sdk`** and **retarget `opencode.ts` at
   `@opencode-ai/sdk`**, replacing the hand-rolled transports. Compare
   `@opencode-ai/sdk/v2` against v1 before committing.
4. **Validate against live runs.** Confirm the SDK event unions arrive as typed,
   especially thinking, usage, and tool-call completion payloads, and correct
   the translation tables against what actually shows up.
5. **Register the backends** in `vendor/headless/src/runtime.ts`, closing the
   validation/registry inconsistency described above.
6. **Add live smoke tests** in the `test:live` script alongside
   `vendor/headless/claude.test.ts` and `codex.test.ts`.
7. **Add delegate profiles** for the three new routes — `grok.yaml`,
   `composer.yaml` (harness `cursor`, model `composer-2.5-fast`), `kimi.yaml`
   (harness `opencode`, model `moonshotai/kimi-k2.7-code`) — each with a
   sensible fallback candidate so an unavailable harness degrades instead of
   failing the delegation.
8. **Decide the review-inversion policy.** `src/delegate-review-coordinator.ts`
   currently routes provenance by matching `codex|openai` and `claude|anthropic`
   in model names. Grok, Composer, and Kimi match neither, so today they fall
   through to whatever the default branch is. Either add explicit families or
   deliberately route unknown provenance to `deep`.
9. **Update `README.md`'s model/harness section** once the above is real.

## Unverified assumptions to check in step 4

Both SDK surfaces were read from published type declarations, not from live
runs, so the shapes are trustworthy but the runtime behavior is not yet proven.

Cursor:

- Whether `Agent.create({ local: { cwd } })` genuinely runs the full Composer
  tool loop in-process, and what it writes to disk while doing so.
- Whether the local run store falls back to `JsonlLocalAgentStore` cleanly when
  the native SQLite optional dependency is unavailable.
- Which model ids the account actually exposes via `Cursor.models.list()` —
  `composer-2.5-fast` is assumed from cached local CLI config, not confirmed.
- Whether `@statsig/js-client` makes network calls that need to be disabled in a
  delegation context.

OpenCode:

- Whether `createOpencodeServer({ port: 0 })` reliably returns a resolved
  ephemeral URL, which is the entire reason the banner-parsing guess goes away.
- Whether the v1 or v2 SDK surface is the right target.
- Whether `promptAsync` while busy actually steers rather than queueing, which
  is the sole justification for `capabilities.steering: true`.
