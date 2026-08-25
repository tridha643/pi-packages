import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDelegateWriterOwnership,
  parseDelegateWritePaths,
  validateParallelDelegateOwnership,
} from "../src/delegate-writer-ownership.ts";

test("write ownership rejects escapes, globs, and redundant roots", () => {
  assert.equal(parseDelegateWritePaths({ cwd: "/repo", paths: ["../outside"] }).ok, false);
  assert.equal(parseDelegateWritePaths({ cwd: "/repo", paths: ["src/**/*.ts"] }).ok, false);
  const redundant = parseDelegateWritePaths({
    cwd: "/repo",
    paths: ["src", "src/feature.ts"],
  });
  assert.equal(redundant.ok, false);
});

test("parallel ownership rejects overlapping writers before launch", () => {
  const left = parseDelegateWritePaths({ cwd: "/repo", paths: ["src/auth"] });
  const right = parseDelegateWritePaths({ cwd: "/repo", paths: ["src/auth/token.ts"] });
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  if (!left.ok || !right.ok) return;

  const conflict = validateParallelDelegateOwnership([
    { name: "auth", paths: left.paths },
    { name: "token", paths: right.paths },
  ]);
  assert.match(conflict?.message ?? "", /overlaps/);
});

test("parallel ownership rejects case and unicode variants conservatively", () => {
  const upper = parseDelegateWritePaths({ cwd: "/repo", paths: ["Docs/api.md"] });
  const lower = parseDelegateWritePaths({ cwd: "/repo", paths: ["docs/api.md"] });
  const composed = parseDelegateWritePaths({ cwd: "/repo", paths: ["docs/café.md"] });
  const decomposed = parseDelegateWritePaths({ cwd: "/repo", paths: ["docs/café.md"] });
  assert.equal(upper.ok, true);
  assert.equal(lower.ok, true);
  assert.equal(composed.ok, true);
  assert.equal(decomposed.ok, true);
  if (!upper.ok || !lower.ok || !composed.ok || !decomposed.ok) return;

  assert.match(
    validateParallelDelegateOwnership([
      { name: "upper", paths: upper.paths },
      { name: "lower", paths: lower.paths },
    ])?.message ?? "",
    /overlaps/,
  );
  assert.match(
    validateParallelDelegateOwnership([
      { name: "composed", paths: composed.paths },
      { name: "decomposed", paths: decomposed.paths },
    ])?.message ?? "",
    /overlaps/,
  );
});

test("disjoint ownership formats a no-worktree child contract", () => {
  const first = parseDelegateWritePaths({ cwd: "/repo", paths: ["src/auth"] });
  const second = parseDelegateWritePaths({ cwd: "/repo", paths: ["test/billing"] });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  assert.equal(
    validateParallelDelegateOwnership([
      { name: "auth", paths: first.paths },
      { name: "billing", paths: second.paths },
    ]),
    undefined,
  );
  assert.match(formatDelegateWriterOwnership(first.paths) ?? "", /Do not create a worktree/);
});
