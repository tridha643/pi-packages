import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DELEGATE_PROFILE_METADATA_LIMITS,
  buildStrictDelegateCandidateList,
  discoverDelegateProfiles,
  parseDelegateProfile,
} from "../src/delegate-profiles.ts";

async function withTempDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "delegate-profiles-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function profileYaml(options: {
  name?: string;
  description?: string;
  harness?: string;
  model?: string;
  reasoning?: string;
} = {}): string {
  return [
    `name: ${options.name ?? "quality"}`,
    `description: ${options.description ?? "Careful implementation target"}`,
    "bestFor:",
    "  - Complex implementation",
    "strengths:",
    "  - Strong code reasoning",
    "limitations:",
    "  - Higher latency",
    "target:",
    `  harness: ${options.harness ?? "pi"}`,
    `  model: ${options.model ?? "provider/model"}`,
    `  reasoning: ${options.reasoning ?? "high"}`,
  ].join("\n");
}

test("project profiles override globals and retain one exact target", async () => {
  await withTempDirectory(async (directory) => {
    const globalProfileDir = join(directory, "global-profiles");
    const projectProfileDir = join(directory, "project", ".pi", "delegate-profiles");
    await mkdir(globalProfileDir, { recursive: true });
    await mkdir(projectProfileDir, { recursive: true });
    await writeFile(join(globalProfileDir, "quality.yaml"), profileYaml());
    await writeFile(
      join(globalProfileDir, "fast.yml"),
      profileYaml({ name: "fast", model: "fast-model", reasoning: "minimal" }),
    );
    await writeFile(
      join(projectProfileDir, "quality.yml"),
      profileYaml({
        description: "Project quality target",
        harness: "claude",
        model: "claude-project",
        reasoning: "xhigh",
      }),
    );

    const result = await discoverDelegateProfiles({
      cwd: join(directory, "project"),
      globalProfileDir,
    });

    assert.deepEqual(result.errors, []);
    assert.equal(result.profiles.length, 2);
    const quality = result.profiles.find((profile) => profile.name === "quality");
    assert.ok(quality);
    assert.equal(quality.source, "project");
    assert.equal(quality.description, "Project quality target");
    assert.deepEqual(quality.target, {
      harness: "claude",
      model: "claude-project",
      reasoning: "xhigh",
    });
    assert.deepEqual(quality.bestFor, ["Complex implementation"]);
  });
});

test("untrusted discovery excludes project profiles before precedence", async () => {
  await withTempDirectory(async (directory) => {
    const globalProfileDir = join(directory, "global-profiles");
    const projectProfileDir = join(directory, "project", ".pi", "delegate-profiles");
    await mkdir(globalProfileDir, { recursive: true });
    await mkdir(projectProfileDir, { recursive: true });
    await writeFile(join(globalProfileDir, "quality.yaml"), profileYaml());
    await writeFile(
      join(projectProfileDir, "quality.yaml"),
      profileYaml({ description: "Project override" }),
    );

    const result = await discoverDelegateProfiles({
      cwd: join(directory, "project"),
      globalProfileDir,
      includeProject: false,
    });

    assert.equal(result.profiles.length, 1);
    assert.equal(result.profiles[0]?.source, "global");
  });
});

test("ordered candidates and unknown target fields are rejected", () => {
  const legacy = parseDelegateProfile(
    `${profileYaml()}\ncandidates: []\n`,
    { filePath: "/tmp/legacy.yaml", source: "global" },
  );
  assert.equal(legacy.ok, false);
  if (!legacy.ok) {
    assert.equal(legacy.error.code, "unknown-field");
    assert.equal(legacy.error.field, "candidates");
  }

  const unknownTarget = parseDelegateProfile(
    `${profileYaml()}\n  temperature: 1\n`,
    { filePath: "/tmp/unknown-target.yaml", source: "global" },
  );
  assert.equal(unknownTarget.ok, false);
  if (!unknownTarget.ok) {
    assert.equal(unknownTarget.error.code, "unknown-field");
    assert.equal(unknownTarget.error.field, "target.temperature");
  }
});

test("all routing metadata is required and bounded", () => {
  for (const field of ["bestFor", "strengths", "limitations"] as const) {
    const content = profileYaml().replace(`${field}:\n  - `, `${field}: []\n# `);
    const parsed = parseDelegateProfile(content, {
      filePath: `/tmp/${field}.yaml`,
      source: "project",
    });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.error.field, field);
  }

  const longDescription = parseDelegateProfile(
    profileYaml({
      description: "x".repeat(
        DELEGATE_PROFILE_METADATA_LIMITS.descriptionCharacters + 1,
      ),
    }),
    { filePath: "/tmp/long.yaml", source: "project" },
  );
  assert.equal(longDescription.ok, false);
  if (!longDescription.ok) assert.equal(longDescription.error.field, "description");

  const tooManyStrengths = profileYaml().replace(
    "strengths:\n  - Strong code reasoning",
    `strengths:\n${Array.from(
      { length: DELEGATE_PROFILE_METADATA_LIMITS.listItems + 1 },
      (_, index) => `  - Strength ${index}`,
    ).join("\n")}`,
  );
  const parsedTooMany = parseDelegateProfile(tooManyStrengths, {
    filePath: "/tmp/too-many.yaml",
    source: "project",
  });
  assert.equal(parsedTooMany.ok, false);
  if (!parsedTooMany.ok) assert.equal(parsedTooMany.error.field, "strengths");
});

test("target values are strict and metadata items cannot be blank", () => {
  const invalidReasoning = parseDelegateProfile(
    profileYaml({ reasoning: "extreme" }),
    { filePath: "/tmp/reasoning.yaml", source: "global" },
  );
  assert.equal(invalidReasoning.ok, false);
  if (!invalidReasoning.ok) {
    assert.equal(invalidReasoning.error.field, "target.reasoning");
  }

  const blankLimitation = parseDelegateProfile(
    profileYaml().replace("  - Higher latency", '  - "   "'),
    { filePath: "/tmp/blank.yaml", source: "global" },
  );
  assert.equal(blankLimitation.ok, false);
  if (!blankLimitation.ok) {
    assert.equal(blankLimitation.error.field, "limitations[0]");
  }
});

test("strict saved profiles construct exactly one launch candidate", () => {
  const parsed = parseDelegateProfile(profileYaml(), {
    filePath: "/tmp/quality.yaml",
    source: "global",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.deepEqual(buildStrictDelegateCandidateList(parsed.value), [
    { harness: "pi", model: "provider/model", reasoning: "high" },
  ]);
});
