// Cold-Start Consumer Behavior Benchmark (generic fixture, approximate).
//
// The earlier artifact-size benchmark only measured how big DevGuard's
// generated files are. This measures what it actually costs an AGENT to
// reach an actionable state, along two paths, on the SAME generic fixture
// and the SAME task:
//
//   "legacy-style" cold start — follow the pre-progressive-loading pattern
//   of reading DevGuard's markdown artifacts up front and opening whole
//   candidate files (no structured line ranges to target).
//
//   "new" cold start — call prepare_task_context once and use its
//   structured files/ranges directly.
//
// All *EstimatedTokens figures are the same char-based approximation used
// throughout DevGuard (see context-cost.ts) — never a provider-billed count.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ensureDevguardWorkspace, ensureCodeIndex, prepareTaskContext, generateProjectHandoff } from "../dist/runtime-state.js";
import { estimateTokens } from "@dev-guard/core";

process.env.LC_ALL = "en-US";
process.env.LC_MESSAGES = "en-US";
process.env.LANG = "en-US";

const execFileAsync = promisify(execFile);
const cleanupRoots = [];

after(async () => {
  await Promise.all(cleanupRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A generic fixture with no project-specific naming — one source file large
 * enough (~70 lines) that "read the whole file" vs "read the targeted
 * range" produce meaningfully different byte counts.
 */
async function makeGenericFixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), "devguard-coldstart-"));
  cleanupRoots.push(root);
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "DevGuard Bench"], { cwd: root });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "generic-fixture", scripts: { build: "true", test: "true" } }, null, 2));
  await writeFile(join(root, "README.md"), "# generic fixture\n\nA small generic project used only to benchmark DevGuard cold-start cost.\n");
  await mkdir(join(root, "src"), { recursive: true });
  const lines = [];
  lines.push("export function add(a, b) {");
  lines.push("  return a + b;");
  lines.push("}");
  lines.push("");
  for (let i = 0; i < 15; i++) {
    lines.push(`function unrelatedHelper${i}(x) {`);
    lines.push(`  // filler logic unrelated to the task, line ${i}`);
    lines.push(`  return x * ${i + 1};`);
    lines.push("}");
    lines.push("");
  }
  lines.push("export function multiply(a, b) {");
  lines.push("  return a * b;");
  lines.push("}");
  await writeFile(join(root, "src", "index.js"), lines.join("\n") + "\n");
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
  return root;
}

/** Generic, content-agnostic duplicate-payload heuristic: sum of the extra
 * bytes contributed by any non-trivial line (>20 chars) that repeats inside
 * the combined text. Works on any fixture; not tuned to specific wording. */
function duplicatePayloadBytes(text) {
  const counts = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length <= 20) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  let total = 0;
  for (const [line, count] of counts) {
    if (count > 1) total += (count - 1) * Buffer.byteLength(line, "utf8");
  }
  return total;
}

test("Cold-Start Benchmark: new (prepare_task_context) path reaches actionable state with far less estimated context than the legacy markdown-bundle + full-file-read path", async () => {
  const root = await makeGenericFixtureRepo();
  await ensureDevguardWorkspace(root);
  await ensureCodeIndex(root);
  const task = "Add a subtract(a, b) function next to add() and multiply() in src/index.js.";
  const result = await prepareTaskContext({ root, task });
  await generateProjectHandoff(root);

  const candidateFiles = result.files.map((file) => file.path);
  assert.ok(candidateFiles.includes("src/index.js"), "the fixture's only real source file must be a candidate");

  // --- Legacy-style cold start: read the markdown bundle, then open every
  // candidate file in full (no structured ranges to target). ---
  const legacyArtifactPaths = [
    ".devguard/context/agent-brief.md",
    ".devguard/reports/read-map.md",
    ".devguard/reports/code-map.md",
    ".devguard/reports/working-context.md",
    ".devguard/reports/project-handoff.md"
  ];
  const legacyArtifactTexts = await Promise.all(legacyArtifactPaths.map((p) => readFile(join(root, p), "utf8")));
  const legacyFullFileTexts = await Promise.all(candidateFiles.map((f) => readFile(join(root, f), "utf8")));
  const legacyCombinedText = [...legacyArtifactTexts, ...legacyFullFileTexts].join("\n");
  const legacy = {
    devGuardArtifactsRead: legacyArtifactPaths.length,
    repoFilesReadBeforeAction: candidateFiles.length,
    repoRangesReadBeforeAction: 0,
    coldStartEstimatedTokens: estimateTokens(legacyCombinedText),
    duplicatePayloadBytes: duplicatePayloadBytes(legacyCombinedText)
  };

  // --- New cold start: one prepare_task_context JSON result, then only the
  // specific ranges it points at (not whole files). ---
  const rangeSlices = [];
  for (const file of result.files) {
    const content = await readFile(join(root, file.path), "utf8");
    const fileLines = content.split("\n");
    for (const range of file.ranges) {
      rangeSlices.push(fileLines.slice(Math.max(0, range.startLine - 1), range.endLine).join("\n"));
    }
  }
  const newCombinedText = [JSON.stringify(result), ...rangeSlices].join("\n");
  const totalRanges = result.files.reduce((sum, file) => sum + file.ranges.length, 0);
  const neu = {
    devGuardArtifactsRead: 1, // one prepare_task_context call
    repoFilesReadBeforeAction: candidateFiles.length,
    repoRangesReadBeforeAction: totalRanges,
    coldStartEstimatedTokens: estimateTokens(newCombinedText),
    duplicatePayloadBytes: duplicatePayloadBytes(newCombinedText)
  };

  console.log("Cold-Start Benchmark (approximate, char-based estimate):");
  console.log(JSON.stringify({ legacy, new: neu }, null, 2));

  assert.ok(
    neu.coldStartEstimatedTokens < legacy.coldStartEstimatedTokens,
    `expected the new path (${neu.coldStartEstimatedTokens} tokens) to cost less than the legacy path (${legacy.coldStartEstimatedTokens} tokens)`
  );
  assert.equal(legacy.repoRangesReadBeforeAction, 0, "legacy path has no structured ranges, only whole-file reads");
  assert.ok(neu.repoRangesReadBeforeAction > 0, "the new path must target specific ranges");
  assert.ok(
    neu.duplicatePayloadBytes <= legacy.duplicatePayloadBytes,
    `expected the new path's single structured payload (${neu.duplicatePayloadBytes}B duplicate) to repeat less than the legacy multi-document bundle (${legacy.duplicatePayloadBytes}B duplicate)`
  );
});
