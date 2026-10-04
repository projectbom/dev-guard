// Regression tests for the Idempotent Finalization Boundary: the real
// PartnerFlow symptom was `dev-guard watch` repeating "Completion
// processed. Quality: BLOCKED" forever at idle. Root cause: a completion
// actor (most commonly a Claude/Codex Stop hook firing on every agent
// turn, not just when files change) can call processDoneEvent many times
// for the exact same underlying code state. processDoneEvent used to redo
// the full pipeline (history append, quality/handoff regeneration,
// TASK_DONE telemetry, lastProcessedAt mutation) every single time,
// producing a genuinely NEW lastProcessedAt each call — which is exactly
// what `dev-guard watch`'s external-completion detector is designed to
// report. Watch's own dedupe logic was correct all along; the bug was that
// there was nothing upstream making repeat requests actual no-ops.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ensureDevguardWorkspace,
  prepareTaskContext,
  processDoneEvent,
  readProjectState,
  readRuntimeState,
  isIgnoredWatchPath
} from "../dist/runtime-state.js";
import { readTaskTelemetry } from "../dist/task-telemetry.js";
import { devguardPaths } from "../dist/paths.js";

process.env.LC_ALL = "en-US";
process.env.LC_MESSAGES = "en-US";
process.env.LANG = "en-US";

const execFileAsync = promisify(execFile);
const cleanupRoots = [];

after(async () => {
  await Promise.all(cleanupRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

async function makeRepo(prefix = "devguard-completion-idempotency-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanupRoots.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "DevGuard Test"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "sample", scripts: { build: "true", test: "true" } }, null, 2));
  await writeFile(join(root, ".gitignore"), ".devguard/\n");
  await writeFile(join(root, "README.md"), "# sample\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "init"]);
  return root;
}

async function historyCount(root) {
  const text = await readFile(join(root, devguardPaths.history), "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim()).length;
}

async function telemetryCountOf(root, eventType) {
  const events = await readTaskTelemetry(root, 1000);
  return events.filter((event) => event.event === eventType).length;
}

// --- A/C/D/J: repeated completion signal for UNCHANGED code = exactly one effective finalization ---

test("A/C/J: N completion signals (hook-equivalent) for the same unchanged code state produce exactly one effective finalization", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Small real fix." });
  await writeFile(join(root, "a.js"), "export const a = 1;\n");

  const first = await processDoneEvent(root, { completionSource: "hook-claude-stop" });
  assert.equal(first.alreadyProcessed, false, "the first real completion must not be reported as a duplicate");
  assert.equal(await historyCount(root), 1);
  assert.equal(await telemetryCountOf(root, "TASK_DONE"), 1);
  assert.equal(await telemetryCountOf(root, "COMPLETION_SIGNAL_RECEIVED"), 1);
  const firstProjectState = await readProjectState(root);

  // Simulate the real-world repro: a Stop hook firing repeatedly even
  // though nothing changed since (e.g. the agent is just chatting, not
  // editing files) — this is "J" too: each call reads fresh from disk,
  // the same as a process restart would, since processDoneEvent keeps no
  // in-memory-only state.
  for (let i = 0; i < 9; i += 1) {
    const repeat = await processDoneEvent(root, { completionSource: "hook-claude-stop" });
    assert.equal(repeat.alreadyProcessed, true, `repeat #${i} must be reported as already processed`);
    assert.equal(repeat.changedFiles.length, first.changedFiles.length, "a no-op result still echoes the last real completion's facts");
  }

  assert.equal(await historyCount(root), 1, "history must not grow from duplicate completion requests");
  assert.equal(await telemetryCountOf(root, "TASK_DONE"), 1, "exactly one effective finalization despite 10 total signals");
  assert.equal(await telemetryCountOf(root, "COMPLETION_SIGNAL_RECEIVED"), 10, "every raw signal is still recorded, even the no-op ones");

  const projectStateAfter = await readProjectState(root);
  assert.equal(projectStateAfter.lastProcessedAt, firstProjectState.lastProcessedAt, "lastProcessedAt must not advance on duplicate requests");
});

// --- B: BLOCKED quality does not change exactly-once behavior ------------

test("B: a BLOCKED-quality completion is still exactly-once, and BLOCKED itself is untouched", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Risky change with no QA evidence." });
  await mkdir(join(root, "packages/db/migrations"), { recursive: true });
  await writeFile(join(root, "packages/db/migrations/0001_init.sql"), "create table x (id int);\n");

  const first = await processDoneEvent(root, { completionSource: "hook-claude-stop" });
  // Not asserting a specific verdict string here — only that whatever
  // fail-closed verdict the existing QA policy produces (BLOCKED or
  // NEEDS_REVIEW, since no build/test evidence was recorded) survives
  // unchanged, and that it is not silently relaxed to PASS by this change.
  assert.notEqual(first.qualityVerdict, "PASS", "no QA evidence was recorded; quality policy itself must not be weakened");

  for (let i = 0; i < 4; i += 1) {
    const repeat = await processDoneEvent(root, { completionSource: "hook-claude-stop" });
    assert.equal(repeat.alreadyProcessed, true);
    assert.equal(repeat.qualityVerdict, first.qualityVerdict, "a no-op must echo the same (still fail-closed) verdict, never PASS");
  }
  assert.equal(await historyCount(root), 1);
  assert.equal(await telemetryCountOf(root, "TASK_DONE"), 1);
});

// --- D/E: concurrent racing completion actors -----------------------------

test("D/E: concurrent hook + manual + legacy-watch-style calls for the same state still finalize exactly once", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Concurrent completion race." });
  await writeFile(join(root, "a.js"), "export const a = 1;\n");

  const [r1, r2, r3] = await Promise.all([
    processDoneEvent(root, { completionSource: "hook-claude-stop" }),
    processDoneEvent(root, { completionSource: "cli-done" }),
    processDoneEvent(root, { completionSource: "watch-auto-finalize" })
  ]);

  const alreadyProcessedCount = [r1, r2, r3].filter((r) => r.alreadyProcessed).length;
  const freshCount = [r1, r2, r3].filter((r) => !r.alreadyProcessed).length;
  assert.equal(freshCount, 1, "exactly one of the three concurrent racers must win and do the real work");
  assert.equal(alreadyProcessedCount, 2, "the other two must observe it as already processed, not redo it");
  assert.equal(await historyCount(root), 1, "no duplicate history entries from the race");
  assert.equal(await telemetryCountOf(root, "TASK_DONE"), 1, "no duplicate TASK_DONE from the race");
  assert.equal(await telemetryCountOf(root, "COMPLETION_SIGNAL_RECEIVED"), 3, "all three raw signals are still recorded");
});

// --- H: two distinct real tasks are never merged into one ----------------

test("H: two distinct real tasks each finalize once and are never dedupe-merged into one", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);

  await prepareTaskContext({ root, task: "Task A" });
  await writeFile(join(root, "a.js"), "export const a = 1;\n");
  const doneA = await processDoneEvent(root, { completionSource: "hook-claude-stop" });
  assert.equal(doneA.alreadyProcessed, false);

  await prepareTaskContext({ root, task: "Task B" });
  await writeFile(join(root, "b.js"), "export const b = 1;\n");
  const doneB = await processDoneEvent(root, { completionSource: "hook-claude-stop" });
  assert.equal(doneB.alreadyProcessed, false, "Task B is real, different work and must not be treated as a duplicate of Task A");

  assert.equal(await historyCount(root), 2);
  assert.equal(await telemetryCountOf(root, "TASK_DONE"), 2);
});

test("H (edge case): a brand new task/session that happens to reach the SAME code state as before still finalizes (favors one extra finalization over a missed one)", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Task A" });
  await writeFile(join(root, "a.js"), "export const a = 1;\n");
  await processDoneEvent(root, { completionSource: "hook-claude-stop" });

  // New task/session declared, but reverts the file back to a state whose
  // content hash already matches a prior finalization. Different session
  // id, same code state — must still finalize (see isDuplicateFinalization
  // doc comment: both identities must match to count as a duplicate).
  await prepareTaskContext({ root, task: "Task B — coincidentally reverts to the same content" });
  await writeFile(join(root, "a.js"), "export const a = 1;\n");
  const doneB = await processDoneEvent(root, { completionSource: "hook-claude-stop" });
  assert.equal(doneB.alreadyProcessed, false, "a new session is a real, separate completion even if the code content happens to match");
});

// --- G: DevGuard's own generated artifacts are fully covered by the ignore list ---

test("G: every DevGuard-generated artifact path is classified as ignored for watch purposes (telemetry/reports/history never look like application changes)", () => {
  const generatedPaths = [
    devguardPaths.taskTelemetry,
    devguardPaths.history,
    devguardPaths.qualityReport,
    devguardPaths.qualityReportState,
    devguardPaths.projectHandoff,
    devguardPaths.readMap,
    devguardPaths.codeMap,
    devguardPaths.workingContext,
    devguardPaths.agentBrief,
    devguardPaths.agentContext,
    devguardPaths.nextClaudePrompt,
    devguardPaths.nextCodexPrompt,
    devguardPaths.projectKnowledge,
    devguardPaths.codeIndex,
    devguardPaths.changeLog,
    devguardPaths.hookStatus,
    devguardPaths.lastRunReport,
    devguardPaths.historySummary,
    devguardPaths.decisionCandidates,
    devguardPaths.finalizeLock,
    devguardPaths.config
  ];
  for (const path of generatedPaths) {
    assert.ok(isIgnoredWatchPath(path), `${path} must be ignored — it is a DevGuard-generated artifact, not an application change`);
  }
});

// --- Real consumer path: readRuntimeState sanity after a duplicate round ---

test("Real consumer path: runtime.currentTask/sessionId are untouched by a duplicate completion request", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Still working on this.", continueCurrentTask: false });
  await writeFile(join(root, "a.js"), "export const a = 1;\n");
  await processDoneEvent(root, { completionSource: "hook-claude-stop" });
  const afterFirstDone = await readRuntimeState(root);

  await processDoneEvent(root, { completionSource: "hook-claude-stop" });
  const afterDuplicate = await readRuntimeState(root);
  assert.deepEqual(afterDuplicate, afterFirstDone, "a duplicate completion request must not touch runtime state at all");
});
