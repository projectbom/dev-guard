// Regression + benchmark tests for the Context Rollover / resume-cost
// feature (estimateTokens/measureResumeBundleCost/computeRolloverAssessment,
// and their wiring into prepare_task_context).
//
// Scenarios covered (see the task spec this implements):
//   A) small task on a generic fixture does not trigger rollover
//   B) a growing session (more changed files / more validation evidence)
//      pushes the rollover score up, not flat forever
//   C) a task transition does not inherit the previous task's age signal,
//      even when workspace-wide signals (changed files) legitimately persist
//   D) prepare_task_context's own JSON result alone carries everything a
//      fresh agent needs (task, constraints, files+ranges, rollover,
//      resume cost) without reading any of the markdown fallback files
//   E) the rollover assessment never depends on any AI-provider context
//      metric — it is computable from DevGuard-owned signals alone
//   F) all of the above on a generic fixture repo with no project-specific
//      naming (no PartnerFlow/Supabase/Vercel-specific anything)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ensureDevguardWorkspace, prepareTaskContext, generateReadMap, loadResumeRawInputs, recordValidationEvidence } from "../dist/runtime-state.js";
import { computeRolloverAssessment, measureResumeBundleCost } from "../dist/rollover.js";
import { estimateTokens } from "@dev-guard/core";

process.env.LC_ALL = "en-US";
process.env.LC_MESSAGES = "en-US";
process.env.LANG = "en-US";

const execFileAsync = promisify(execFile);
const cleanupRoots = [];

after(async () => {
  await Promise.all(cleanupRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeGenericFixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), "devguard-rollover-"));
  cleanupRoots.push(root);
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "DevGuard Test"], { cwd: root });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "generic-fixture", scripts: { build: "true" } }, null, 2));
  await writeFile(join(root, "README.md"), "# generic fixture\n");
  await writeFile(join(root, "src.js"), "export function add(a, b) { return a + b; }\n");
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
  return root;
}

async function readRuntimeJson(root) {
  const raw = await readFile(join(root, ".devguard", "runtime.json"), "utf8");
  return JSON.parse(raw);
}

async function writeRuntimeJson(root, value) {
  await writeFile(join(root, ".devguard", "runtime.json"), JSON.stringify(value, null, 2));
}

// --- Pure unit tests: computeRolloverAssessment -----------------------------

test("computeRolloverAssessment: low signals are SAFE", () => {
  const result = computeRolloverAssessment({
    changedFileCount: 1,
    qaResultCount: 0,
    contextBundleEstimatedTokens: 200
  });
  assert.equal(result.status, "SAFE");
});

test("computeRolloverAssessment: signals well past budget are ROLL_OVER_RECOMMENDED", () => {
  const result = computeRolloverAssessment({
    changedFileCount: 40,
    qaResultCount: 20,
    taskCreatedAt: new Date(Date.now() - 1000 * 60 * 400).toISOString(),
    contextBundleEstimatedTokens: 12000
  });
  assert.equal(result.status, "ROLL_OVER_RECOMMENDED");
  assert.ok(result.dominantSignal, "a dominant signal should be identified");
});

test("computeRolloverAssessment: moderate signals land on ROLL_OVER_SOON, not SAFE or RECOMMENDED", () => {
  const result = computeRolloverAssessment({
    changedFileCount: 14, // 0.7 of default budget 20
    qaResultCount: 7, // 0.7 of default budget 10
    contextBundleEstimatedTokens: 4200 // 0.7 of default budget 6000
  });
  assert.equal(result.status, "ROLL_OVER_SOON");
});

test("computeRolloverAssessment (Scenario E): never needs any AI-provider context signal — DevGuard-owned inputs only, and works with no active task at all", () => {
  const result = computeRolloverAssessment({
    changedFileCount: 0,
    qaResultCount: 0,
    contextBundleEstimatedTokens: 0
    // no taskCreatedAt: no active task — must not throw or require one
  });
  assert.equal(result.status, "SAFE");
  assert.ok(!result.signals.some((signal) => signal.label === "taskAgeMinutes"), "no task age signal should be produced when there is no active task");
  assert.match(result.note, /not a reading of the AI provider/i);
});

test("computeRolloverAssessment: one signal already past its own budget floors status at ROLL_OVER_SOON even when every other signal is quiet", () => {
  const result = computeRolloverAssessment({
    changedFileCount: 0,
    qaResultCount: 0,
    contextBundleEstimatedTokens: 7923 // > default budget of 6000, alone
  });
  assert.notEqual(result.status, "SAFE", "an already-over-budget resume bundle must not be averaged away into SAFE by quiet unrelated signals");
});

test("estimateTokens is a plain character-based approximation (provider independent)", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("a".repeat(400)), 100);
});

// --- measureResumeBundleCost on an uninitialized generic fixture ------------

test("measureResumeBundleCost (Scenario F, generic fixture): returns zeroed, non-throwing result when no artifacts exist yet", async () => {
  const root = await mkdtemp(join(tmpdir(), "devguard-rollover-empty-"));
  cleanupRoots.push(root);
  const cost = await measureResumeBundleCost(root);
  assert.equal(cost.totalBytes, 0);
  assert.equal(cost.totalEstimatedTokens, 0);
  assert.equal(cost.perArtifact.length, 6);
});

// --- End-to-end wiring through prepare_task_context -------------------------

test("Scenario A: a small task on a generic fixture reports resumeCost/rollover, and rollover is SAFE", async () => {
  const root = await makeGenericFixtureRepo();
  await ensureDevguardWorkspace(root);
  const result = await prepareTaskContext({ root, task: "Add a subtract function next to add()." });

  assert.ok(result.resumeCost, "result must carry an estimated resume cost");
  assert.ok(result.resumeCost.totalEstimatedTokens >= 0);
  assert.ok(result.rollover, "result must carry a rollover assessment");
  assert.equal(result.rollover.status, "SAFE", "a small, fresh task on a tiny fixture should not recommend rollover");
});

test("Scenario D: prepare_task_context's own JSON alone is a sufficient minimal resume package (no markdown read required)", async () => {
  const root = await makeGenericFixtureRepo();
  await ensureDevguardWorkspace(root);
  const result = await prepareTaskContext({ root, task: "Add a subtract function next to add()." });

  // Everything a fresh agent needs to start is already in this one object.
  assert.equal(result.task, "Add a subtract function next to add().");
  assert.ok(Array.isArray(result.files));
  assert.ok(Array.isArray(result.constraints));
  assert.ok(result.rollover);
  assert.ok(result.resumeCost);
  assert.ok(result.contextFiles.agentBrief, "fallback path is still named, for when MCP is unavailable, but is not required to start");

  // The minimal structured subset an agent actually needs is meaningfully
  // smaller than the full 6-file markdown fallback bundle it never had to
  // read — this is the progressive-loading property this feature measures.
  const minimalResumeSubset = JSON.stringify({
    task: result.task,
    constraints: result.constraints,
    files: result.files,
    rollover: result.rollover
  });
  const minimalResumeTokens = estimateTokens(minimalResumeSubset);
  assert.ok(
    minimalResumeTokens <= result.resumeCost.totalEstimatedTokens || result.resumeCost.totalEstimatedTokens === 0,
    `expected the minimal structured subset (${minimalResumeTokens} tokens) to not exceed the full markdown bundle (${result.resumeCost.totalEstimatedTokens} tokens)`
  );
});

test("Scenario B: a growing session (more changed files, more validation evidence) raises the rollover score instead of staying flat", async () => {
  const root = await makeGenericFixtureRepo();
  await ensureDevguardWorkspace(root);
  const small = await prepareTaskContext({ root, task: "Small task on a quiet session." });

  // Simulate a long-running, heavily-exercised session: many pending changed
  // files and many recorded validations accumulated in the workspace.
  const runtime = await readRuntimeJson(root);
  const manyFiles = Array.from({ length: 30 }, (_, i) => `src/file-${i}.js`);
  const manyQaResults = Object.fromEntries(
    Array.from({ length: 15 }, (_, i) => [
      `check-${i}`,
      {
        name: `check-${i}`,
        kind: "TEST",
        status: "PASS",
        command: "true",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1
      }
    ])
  );
  await writeRuntimeJson(root, { ...runtime, pendingChangedFiles: manyFiles, qaResults: manyQaResults });

  const grown = await prepareTaskContext({ root, task: "Same work, much later in a long session." });

  assert.ok(
    grown.rollover.score > small.rollover.score,
    `expected rollover score to grow with session size (small=${small.rollover.score}, grown=${grown.rollover.score})`
  );
  assert.notEqual(grown.rollover.status, "SAFE", "a session with 30 pending files and 15 validations should no longer read as SAFE");
});

// --- Single Resolution Path: renderers must consume a shared snapshot, not re-read disk --

test("No Independent Re-Inference: a renderer given a preloaded snapshot uses it instead of re-reading the (since-mutated) disk state", async () => {
  const root = await makeGenericFixtureRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Task A: the snapshot this render must use." });
  const raw = await loadResumeRawInputs(root);
  assert.equal(raw.runtime.currentTask?.text, "Task A: the snapshot this render must use.");

  // Mutate the ON-DISK runtime state to a different task AFTER the snapshot
  // was taken. A renderer that independently re-reads state instead of
  // using the snapshot it was handed would pick this up; one that does not
  // re-infer context on its own will not.
  const runtime = await readRuntimeJson(root);
  await writeRuntimeJson(root, { ...runtime, currentTask: { ...runtime.currentTask, text: "Task Z: written to disk after the snapshot was taken." } });

  await generateReadMap(root, raw);
  const readMap = await readFile(join(root, ".devguard", "reports", "read-map.md"), "utf8");
  assert.match(readMap, /Task A: the snapshot this render must use\./, "the renderer must use the preloaded snapshot");
  assert.doesNotMatch(readMap, /Task Z/, "the renderer must not have re-read the mutated on-disk state");
});

test("Renderer Consistency: the same prepare_task_context call produces the same task goal in read-map, agent-brief, and working-context", async () => {
  const root = await makeGenericFixtureRepo();
  await ensureDevguardWorkspace(root);
  const task = "Add a divide(a, b) helper alongside add()/multiply().";
  await prepareTaskContext({ root, task });

  const [readMap, agentBrief, workingContext] = await Promise.all([
    readFile(join(root, ".devguard", "reports", "read-map.md"), "utf8"),
    readFile(join(root, ".devguard", "context", "agent-brief.md"), "utf8"),
    readFile(join(root, ".devguard", "reports", "working-context.md"), "utf8")
  ]);
  for (const [label, content] of [["read-map", readMap], ["agent-brief", agentBrief], ["working-context", workingContext]]) {
    assert.ok(content.includes(task), `${label} should state the exact same task goal`);
  }
});

test("Scenario D (validation): prepare_task_context's validation summary reflects recorded evidence without needing Quality Report", async () => {
  const root = await makeGenericFixtureRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "A task with a passing build already recorded." });
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", name: "build", command: "true", source: "cli" });

  const result = await prepareTaskContext({ root, task: "A task with a passing build already recorded.", continueCurrentTask: true });
  assert.ok(result.validation, "result must carry a validation summary");
  assert.equal(result.validation.freshCount, 1);
  assert.equal(result.validation.fresh[0].status, "PASS");
  assert.equal(result.validation.fresh[0].name, "build");
});

test("Scenario C: a new task does not inherit the previous task's age signal, even though workspace-wide signals persist", async () => {
  const root = await makeGenericFixtureRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Task A: the old, long-running task." });

  // Back-date Task A so it looks like it has been open for hours, and give
  // the workspace a pile of pending changed files (a legitimate
  // workspace-wide signal that should persist across a task boundary).
  const runtime = await readRuntimeJson(root);
  const oldCreatedAt = new Date(Date.now() - 1000 * 60 * 300).toISOString();
  await writeRuntimeJson(root, {
    ...runtime,
    currentTask: { ...runtime.currentTask, createdAt: oldCreatedAt },
    pendingChangedFiles: ["a.js", "b.js", "c.js"]
  });

  // Task B starts (a bare call is always a new task/session lineage).
  const taskB = await prepareTaskContext({ root, task: "Task B: a brand new, unrelated task." });

  const taskAgeSignal = taskB.rollover.signals.find((signal) => signal.label === "taskAgeMinutes");
  assert.ok(taskAgeSignal, "Task B should still report a task age signal (it has its own active task)");
  assert.ok(taskAgeSignal.value < 5, `Task B's age should be ~0 minutes, not inherited from Task A (got ${taskAgeSignal.value})`);

  const changedFilesSignal = taskB.rollover.signals.find((signal) => signal.label === "changedFiles");
  assert.equal(changedFilesSignal.value, 3, "workspace-wide pending changed files legitimately persist across a task boundary");
});
