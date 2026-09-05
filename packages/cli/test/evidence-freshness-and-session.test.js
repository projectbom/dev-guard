// Regression tests for Validation Evidence provenance/freshness and Task Goal
// session lineage. See the task history for the concrete risk these guard
// against: stale evidence from an old commit being shown as current, and a
// previous task's goal leaking into a new task's Handoff.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ensureDevguardWorkspace,
  prepareTaskContext,
  processDoneEvent,
  recordValidationEvidence,
  recordQAExecutionResult,
  resetRuntimeState
} from "../dist/runtime-state.js";

const execFileAsync = promisify(execFile);
const cleanupRoots = [];

after(async () => {
  await Promise.all(cleanupRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), "devguard-freshness-"));
  cleanupRoots.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "DevGuard Test"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "sample", scripts: { build: "true" } }, null, 2));
  await writeFile(join(root, ".gitignore"), ".devguard/\n");
  await writeFile(join(root, "README.md"), "# sample\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "init"]);
  return root;
}

async function readQuality(root) {
  return readFile(join(root, ".devguard/reports/quality-report.md"), "utf8");
}

async function readHandoff(root) {
  return readFile(join(root, ".devguard/reports/project-handoff.md"), "utf8");
}

// --- Test A: stale evidence (git-HEAD-based freshness) ---------------------

test("Test A: BUILD PASS recorded at an older commit is not shown as current after a new commit", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);

  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", command: "pnpm build" });

  // Advance the code state to a new commit (a different git HEAD SHA).
  await writeFile(join(root, "app.js"), "console.log('v2');\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "advance"]);

  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.doesNotMatch(quality, /Build\s*\|\s*✅ PASS/);
  assert.match(quality, /Build\s*\|\s*⚪ Not recorded by DevGuard/);
});

test("Test A (control): BUILD PASS recorded at the current commit is still shown as current", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", command: "pnpm build" });
  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.match(quality, /Build\s*\|\s*✅ PASS/);
});

// --- Test B / C: task goal session lineage ---------------------------------

test("Test B: a previous task's goal does not leak into a new session that never called prepare_task_context", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);

  await prepareTaskContext({ root, task: "Implement ad report pipeline", persistTask: true });
  await processDoneEvent(root);
  let handoff = await readHandoff(root);
  assert.match(handoff, /Implement ad report pipeline/);

  // Explicit session boundary: a real `dev-guard reset` starts a new session/task lineage.
  await resetRuntimeState(root);

  // A new, unrelated task begins without ever calling prepare_task_context again.
  await writeFile(join(root, "unrelated.js"), "export const unrelated = true;\n");
  await processDoneEvent(root);

  handoff = await readHandoff(root);
  assert.doesNotMatch(handoff, /Implement ad report pipeline/);
});

test("Test C: the same task's goal persists across multiple done calls without recalling prepare_task_context", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);

  await prepareTaskContext({ root, task: "Implement ad report pipeline", persistTask: true });
  await processDoneEvent(root);

  // Second done in the same session, no new prepare_task_context call.
  await writeFile(join(root, "more.js"), "export const more = 1;\n");
  await processDoneEvent(root);

  const handoff = await readHandoff(root);
  assert.match(handoff, /Implement ad report pipeline/);
});

// --- Test D: UNKNOWN vs NOT_RECORDED ----------------------------------------

test("Test D: recorded UNKNOWN evidence and truly-absent evidence render as distinct states", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await recordValidationEvidence({
    root,
    kind: "RUNTIME_SMOKE",
    name: "attribution",
    status: "UNKNOWN",
    reason: "NO_BINDING_MATCH"
  });
  // BUILD kind: nothing recorded at all for it.
  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.match(quality, /Runtime Smoke: attribution\s*\|\s*🟡 UNKNOWN/);
  assert.match(quality, /Build\s*\|\s*⚪ Not recorded by DevGuard/);
  // Confidence must not conflate "no evidence" with "recorded failure".
  assert.match(quality, /##[^\n]*QA Confidence\s*\n\s*\nUnknown/);
});

// --- Test E: contradictory evidence aggregation -----------------------------

test("Test E: the most recently recorded evidence wins, independent of insertion order", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);

  // Inserted first, but its completedAt is LATER than the second insertion.
  await recordQAExecutionResult(root, {
    name: "build-later",
    kind: "BUILD",
    status: "PASS",
    command: "pnpm build",
    startedAt: "2026-01-01T10:00:00.000Z",
    completedAt: "2026-01-01T10:00:00.000Z",
    durationMs: 1000
  });
  // Inserted second, but its completedAt is EARLIER than the first insertion.
  await recordQAExecutionResult(root, {
    name: "build-earlier",
    kind: "BUILD",
    status: "FAIL",
    command: "pnpm build",
    startedAt: "2026-01-01T09:00:00.000Z",
    completedAt: "2026-01-01T09:00:00.000Z",
    durationMs: 1000,
    reason: "flaky failure from an earlier attempt"
  });

  await processDoneEvent(root);
  const quality = await readQuality(root);
  // The chronologically later PASS must win over the earlier FAIL, even
  // though the FAIL entry was recorded (inserted) second.
  assert.match(quality, /Build\s*\|\s*✅ PASS/);
  assert.doesNotMatch(quality, /Build\s*\|\s*❌ FAIL/);
});

// --- Test F: independent kinds ----------------------------------------------

test("Test F: independent kinds (and named runtime-smoke sub-checks) are reported without overwriting each other", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", command: "pnpm build" });
  await recordValidationEvidence({ root, kind: "TYPECHECK", status: "PASS", summary: "6 packages" });
  await recordValidationEvidence({ root, kind: "RUNTIME_SMOKE", name: "smoke-a", status: "FAIL", reason: "timeout" });
  await recordValidationEvidence({ root, kind: "RUNTIME_SMOKE", name: "smoke-b", status: "PASS" });

  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.match(quality, /Build\s*\|\s*✅ PASS/);
  assert.match(quality, /Typecheck\s*\|\s*✅ PASS/);
  assert.match(quality, /Runtime Smoke: smoke-a\s*\|\s*❌ FAIL/);
  assert.match(quality, /Runtime Smoke: smoke-b\s*\|\s*✅ PASS/);
});

// --- Compatibility: non-git projects and legacy state -----------------------

test("Compatibility: a non-git project does not crash and falls back to session-based freshness", async () => {
  const root = await mkdtemp(join(tmpdir(), "devguard-nogit-"));
  cleanupRoots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "nogit", scripts: { build: "true" } }, null, 2));
  await ensureDevguardWorkspace(root);
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", command: "pnpm build" });
  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.match(quality, /Build\s*\|\s*✅ PASS/);
});

test("Compatibility: legacy ProjectState without lastTaskGoalSessionId does not crash and does not leak", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  const statePath = join(root, ".devguard", "state.json");
  await writeFile(
    statePath,
    JSON.stringify({ lastTaskGoal: "Old goal from a previous DevGuard version", lastQualityVerdict: "PASS" }, null, 2)
  );
  await processDoneEvent(root);
  const handoff = await readHandoff(root);
  assert.doesNotMatch(handoff, /Old goal from a previous DevGuard version/);
});
