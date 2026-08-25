# Pi Agent Delegation

A public Git-only Pi package for named, headless subagents across Pi, Claude Code, Codex, Cursor, and OpenCode. It remains `private: true`, so npm will not publish it.

## Model

- A **subagent** is a stable role stored in Pi's native `agents/*.md` format.
- A **harness** is the runtime that owns the agent loop: `pi`, `claude`, `codex`, `cursor`, or `opencode`.
- A **profile** is one exact harness/model/reasoning target plus concise task-fit metadata.
- A **context policy** is `fresh`, bounded Hermes `handoff`, transcript-preserving `continue`, or frozen-revision `review`.
- A **task** is the one-off instruction supplied by the parent.
- A **control flow** is direct, parallel, continued, chained, or frozen-revision review.

Profiles are strict and never fall back to another model. Calls that need direct harness/model/reasoning settings use `delegate_freeform` instead of overriding a profile.

## Harnesses

| Harness | Runtime | Steering | Requires |
|---|---|---|---|
| `pi` | in-process Pi session | yes | nothing beyond the parent's model registry |
| `claude` | `@anthropic-ai/claude-agent-sdk` | yes | Anthropic credentials |
| `codex` | `codex app-server` child process | no | `codex` on `PATH` |
| `cursor` | `@cursor/sdk`, agent runs in-process | no | a Cursor API key |
| `opencode` | `opencode serve` child, driven through `@opencode-ai/sdk` | no | `npm i -g opencode-ai` |

Only `pi` and `claude` can enforce a named subagent's Pi-compatible tool allowlist. A profile targeting `codex`, `cursor`, or `opencode` is rejected whenever the subagent declares `tools:`, so an allowlist is never silently ignored and another target is never substituted.

Choosing a harness is a question about whose agent loop you want, not which model you want. Many models are reachable through more than one harness, and the cheapest route is usually `harness: pi` with a provider login:

- Grok needs no dedicated harness. Pi ships an xAI provider with a SuperGrok / X Premium OAuth device-code login, so `harness: pi, model: xai/grok-4.5` works after a single sign-in.
- Kimi K3 is likewise one login away through Pi's `kimi-coding` provider (`harness: pi, model: kimi-coding/k3`). Reach for `harness: opencode` only when you specifically want OpenCode's own agent loop, agents, and tool surface.
- Cursor's models are separately available as Pi models through `pi-cursor-provider`. Use `harness: cursor` when you want Composer running under Cursor's loop rather than Pi's.

## Tools

- `delegate` — one strict saved subagent plus strict profile.
- `delegate_parallel` — two to four independent strict lanes; builder lanes declare disjoint shared-workspace `write_paths`.
- `delegate_review` — opt-in frozen-revision review that automatically chooses a dedicated exact review profile from author provenance; the parent owns finding dispositions and fixes.
- `delegate_profiles` — read full task-fit metadata for specific saved profiles when the concise routing catalog is insufficient; it stays outside the default tool set and is loaded through `search_tools` only when needed.
- `delegate_continue` — related follow-up work in a completed direct strict delegate's existing context.
- `delegate_freeform` — one-off explicit harness, model, reasoning, instructions, and task.
- `delegate_chain` — ephemeral sequential strict steps with automatic previous-output passing.
- `delegate_wait`, `delegate_check`, `delegate_cancel`, `delegate_list` — shared lifecycle management for `sa-*` and `chain-*` ids.
- `subagent_config` — conversational list/save/delete operations for subagents and profiles.

`/subagents` opens the detailed headless-session picker and takeover UI.

## Manual review command

`/review [focus]` is the human entry point to the same strict `delegate_review` coordinator. It selects `review-claude`, `review-codex`, or `review-grok` by author-family inversion from explicit provenance or the active parent model: it picks the first absent family in Anthropic, OpenAI, xAI order, and chooses `review-claude` when all are present or none match. The command detects a local `dev`, `main`, or `master` merge base, covers committed and dirty worktree changes, falls back to the current checkout when no base exists, and reviews the latest commit when the selected base has no changes. A bounded, tool-free summary of relevant user/assistant conversation context is included as untrusted context when the active model can produce one; review continues diff-only if summarization fails.

`/review loop [focus]` also places a persistent parent-session marker. A later `/review` compacts the completed review-fix interval before starting another frozen-revision review. The marker affects parent context only; the automatically selected profile remains stored with the loop for resume and status operations.

## Configuration

Global subagents use Pi's native directory:

```text
~/.pi/agent/agents/*.md
```

Project subagents override global definitions by name:

```text
.pi/agents/*.md
```

Example:

```md
---
name: bee
description: Skeptical analyst that tests conclusions
tools: [read, grep, find, bash]
skills: [testing-quality]
---

Find unsupported assumptions, counterexamples, missing evidence, and operational risks.
```

Global and project compute profiles live in:

```text
~/.pi/agent/delegate-profiles/*.yaml
.pi/delegate-profiles/*.yaml
```

Example:

```yaml
name: deep-thinker
description: Careful long-context analysis with an exact Claude target
bestFor:
  - Architecture and high-risk implementation
strengths:
  - Deep code reasoning
  - Long-context synthesis
limitations:
  - Higher latency than fast profiles
  - Requires Anthropic credentials
target:
  harness: claude
  model: claude-opus-5
  reasoning: high
```

Project configuration is ignored unless Pi trusts the project.

## Runtime guarantees

- At most four subagents run concurrently; excess spawn requests wait in FIFO admission order.
- Parallel lanes resolve completely and validate disjoint writer ownership before any lane launches; accepted lanes keep their individual `sa-*` ids if a sibling launch fails.
- The current workspace is shared. Builder ownership is explicit, overlapping writers are rejected, and worktrees are never created automatically.
- Every saved profile resolves to exactly one target. Unavailable targets fail clearly; the parent must inspect the failure and explicitly choose a different profile if appropriate.
- `fresh`, `handoff`, `continue`, and `review` context policies remain independent from saved role and compute profile. Hermes handoffs use bounded read-only retrieval with source ids rather than copying the parent transcript.
- Structured run events are append-only JSONL under `~/.pi/agent/pi-hermes-memory/delegation-runs/`; prompts, transcripts, tool output, and model reasoning are not persisted there.
- Review loops freeze a hash of HEAD, index, staged/unstaged diffs, and untracked contents. Every retry uses a fresh reviewer, and any later edit invalidates a clean result.
- Review start automatically selects one dedicated exact review profile from explicit provenance or the active parent model. Cursor Composer and Moonshot provenance count as neither Anthropic, OpenAI, nor xAI, so they select `review-claude`; resume and status keep using the profile stored when the review began.
- `/review` automatically derives a merge-base-aware Git scope and adds only a bounded low-thinking summary of conversational text; raw tool output, reasoning, images, custom internal entries, and model/tool metadata are excluded.
- Continuations synchronously enter a new run generation, so immediate waits, cancellation, and result delivery target the correct run.
- Freeform candidate arrays may fall back only after an explicit preflight-safe rejection. Strict saved-profile launches and chains always pass one target, so they cannot replay work on another harness.
- A chain advances only after a proven successful terminal result.
- Failed, cancelled, missing, or timed-out steps stop the chain.
- Every chain step has a 30-minute default hard deadline, overridable per step from 10 seconds to 2 hours.
- Chain-owned child results are suppressed; only the final chain result is delivered automatically.
- Pi children cannot recursively call delegation, workflow, or user-question tools.
- In-process Pi children load skills, prompts, and project context but not global extensions; this prevents every child from duplicating MCP servers, terminal listeners, and other process-wide resources.

## UI

While work is running, a width-aware boxed `Subagents — N running` widget appears above Pi's editor. It shows task, subagent/profile identity, current activity, and elapsed time, refreshes once per second, and clears at zero running subagents.

## Development

```bash
npm install
npm run verify
npm run test:live # optional authenticated Claude Code and Codex checks
```

Install the repository root to load this package with the other extensions:

```bash
pi install git:github.com/tridha643/pi-packages
```

To load only delegation, clone the repository and install `packages/pi-agent-delegation` as a local path.

## Upstream

See [UPSTREAM.md](./UPSTREAM.md), [NOTICE.md](./NOTICE.md), and [SECURITY.md](./SECURITY.md). This public Git repository is `UNLICENSED`; no license is granted for this package or its copied and adapted upstream portions.
