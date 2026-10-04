// Regression tests for the PartnerFlow task-boundary/handoff-goal/telemetry
// audit: three confirmed gaps, fixed together because they share one root
// cause — DevGuard had no notion of "what was already here before this
// task started," so (1) a later task silently inherited an earlier task's
// leftover dirty files, (2) a diff-type heuristic fallback goal (hardcoded
// to describe DevGuard's OWN doc-generation feature) was shown with the
// same unqualified confidence as a real declared task, and (3) nothing
// recorded whether `dev-guard done` ran by hand or via a Stop hook. See
// CLAUDE.md task history for the real PartnerFlow Handoff this reproduces:
// "Improve generated DevGuard documentation so it explains feature-level
// changes from the current session." shown as Current Work Goal next to
// 100+ files of unrelated ad-serving work.
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
  recordValidationEvidence,
  generateProjectHandoff
} from "../dist/runtime-state.js";
import { readTaskTelemetry } from "../dist/task-telemetry.js";

// See validation-identity-and-task-lineage.test.js for why this is pinned:
// these assertions check rendered prose against DevGuard's documented
// default locale, which must not depend on the host machine's OS locale.
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

async function makeRepo(prefix = "devguard-task-boundary-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanupRoots.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "DevGuard Test"]);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "partner-flow", packageManager: "pnpm@9.0.0", scripts: { build: "true", test: "true" } }, null, 2)
  );
  await writeFile(join(root, ".gitignore"), ".devguard/\n");
  await writeFile(join(root, "README.md"), "# sample\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "init"]);
  return root;
}

async function readHandoff(root) {
  return readFile(join(root, ".devguard/reports/project-handoff.md"), "utf8");
}

// --- Scenario A: two sequential tasks in the same dirty tree -------------

test("Scenario A: Task B's scope does not silently inherit Task A's leftover dirty file", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);

  await prepareTaskContext({ root, task: "Task A: fix the settlement importer." });
  await writeFile(join(root, "a.js"), "export const a = 1;\n");
  const resultA = await processDoneEvent(root);
  assert.ok(resultA.changedFiles.includes("a.js"));
  // Task A itself has no baseline to carry over from (nothing was dirty
  // before it started), so everything it touched is its own scope.
  assert.deepEqual(resultA.taskScopedChangedFiles, ["a.js"]);
  assert.deepEqual(resultA.carriedOverChangedFiles, []);

  // a.js is intentionally left uncommitted (never committed, never
  // reverted) — exactly the real-world shape: `done`'s partial reset
  // clears the TASK, not the working tree.
  await prepareTaskContext({ root, task: "Task B: add the admin layout." });
  await writeFile(join(root, "b.js"), "export const b = 1;\n");
  const resultB = await processDoneEvent(root);

  // The full changedFiles view must still show both — nothing is hidden —
  // but the task-scoped split must attribute only b.js to Task B and call
  // out a.js as carried over from before Task B started.
  assert.ok(resultB.changedFiles.includes("a.js"));
  assert.ok(resultB.changedFiles.includes("b.js"));
  assert.deepEqual(resultB.taskScopedChangedFiles, ["b.js"]);
  assert.deepEqual(resultB.carriedOverChangedFiles, ["a.js"]);
  assert.ok(
    resultB.judgments.some((j) => j.includes("already dirty before this task") && j.includes("a.js")),
    "Task B's judgments must flag the carried-over file"
  );
});

// --- Scenario B: continuing the same task keeps extending one scope ------

test("Scenario B: continueCurrentTask keeps the lineage's original baseline, so later files in the same task are not misread as carried over", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);

  await prepareTaskContext({ root, task: "Implement ad report pipeline." });
  await writeFile(join(root, "a.js"), "export const a = 1;\n");
  await prepareTaskContext({ root, task: "Implement ad report pipeline.", continueCurrentTask: true });
  await writeFile(join(root, "b.js"), "export const b = 1;\n");
  const result = await processDoneEvent(root);

  assert.deepEqual(result.taskScopedChangedFiles, ["a.js", "b.js"]);
  assert.deepEqual(result.carriedOverChangedFiles, []);
});

// --- Goal confidence: the exact PartnerFlow regression --------------------

test("Goal confidence: a QA-type diff-inferred goal is never the DevGuard-self sentence, and is marked as an unconfirmed guess", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  // No prepare_task_context call at all — exactly the reported PartnerFlow
  // shape: real, large, undeclared work with no explicit task.
  await mkdir(join(root, "packages/logger/tests"), { recursive: true });
  await writeFile(join(root, "packages/logger/tests/error-reporting.test.ts"), "test('x', () => {});\n");
  await processDoneEvent(root);
  const handoff = await readHandoff(root);

  assert.doesNotMatch(
    handoff,
    /Improve generated DevGuard documentation/,
    "a downstream project's Handoff must never show DevGuard's own self-referential fallback sentence"
  );
  assert.match(
    handoff,
    /Basis: inferred, not an explicitly declared task/,
    "a non-canonical (diff-inferred) goal must be visibly marked as an unconfirmed guess"
  );
});

test("Goal confidence: a project's own '(dashboard)' route files do not trigger DevGuard's own Dashboard-UI-QA guess text", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await mkdir(join(root, "apps/admin/app/(dashboard)/settings"), { recursive: true });
  await writeFile(join(root, "apps/admin/app/(dashboard)/settings/page.tsx"), "export default function Page(){ return null; }\n");
  // No task declared, and no QA/UI-typed file either — forces the final
  // bare file-list fallback (inferGoalFromFiles) rather than the
  // documentationGoal heuristic, which is the function this test targets.
  await processDoneEvent(root);
  const handoff = await readHandoff(root);
  assert.doesNotMatch(
    handoff,
    /Fix Dashboard UI QA issues around spacing/,
    "a project's own (dashboard) route segment must never be misread as DevGuard's own Dashboard source file"
  );
});

test("Goal confidence (control): an explicit canonical task is shown with no 'Basis: inferred' qualifier", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await writeFile(join(root, "a.js"), "export const a = 1;\n");
  await prepareTaskContext({ root, task: "Admin UI Audit Phase 2" });
  await processDoneEvent(root);
  const handoff = await readHandoff(root);
  assert.match(handoff, /Admin UI Audit Phase 2/);
  assert.doesNotMatch(handoff, /Basis: inferred, not an explicitly declared task/);
});

// --- Hook-vs-manual completion provenance ---------------------------------

test("Completion provenance: a Claude Stop hook-triggered done is distinguishable from a manual one, but still reports the CLI command ran", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Small fix." });
  await writeFile(join(root, "a.js"), "export const a = 1;\n");
  await processDoneEvent(root, { completionSource: "hook-claude-stop" });
  const handoff = await readHandoff(root);
  assert.match(handoff, /`dev-guard done`: pass/, "hook-triggered completion is still a real `dev-guard done` run");
  assert.match(handoff, /triggered automatically by the Claude Code Stop hook/);
});

test("Completion provenance (control): a manual cli-done run does not claim a hook triggered it", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Small fix." });
  await writeFile(join(root, "a.js"), "export const a = 1;\n");
  await processDoneEvent(root, { completionSource: "cli-done" });
  const handoff = await readHandoff(root);
  assert.match(handoff, /`dev-guard done`: pass/);
  assert.doesNotMatch(handoff, /triggered automatically by/);
});

// --- persistTask:false must actually revert (found via real smoke check) -

test("persistTask:false reverts currentTask/sessionId even when the pre-call runtime had no currentTask/sessionId at all", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  const { readRuntimeState } = await import("../dist/runtime-state.js");

  const before = await readRuntimeState(root);
  assert.equal(before.currentTask, undefined, "sanity check: no task active yet");

  await prepareTaskContext({ root, task: "One-off read-only check.", persistTask: false });

  const after = await readRuntimeState(root);
  assert.equal(after.currentTask, undefined, "persistTask:false must not leave a currentTask behind");
  assert.equal(after.sessionId, before.sessionId, "persistTask:false must not leave a new sessionId behind");
});

// --- Effectiveness telemetry ------------------------------------------------

test("Telemetry: prepare/continue/replace/validate/done emit a typed, ordered event stream with no prompt/content leakage", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);

  await prepareTaskContext({ root, task: "Task A: secret-looking prompt text ABC123." });
  await prepareTaskContext({ root, task: "Task A: secret-looking prompt text ABC123.", continueCurrentTask: true });
  await prepareTaskContext({ root, task: "Task B: a completely different task." });
  await recordValidationEvidence({ root, kind: "TYPECHECK", status: "PASS", command: "tsc --noEmit" });
  await writeFile(join(root, "a.js"), "export const a = 1;\n");
  await processDoneEvent(root);

  const events = await readTaskTelemetry(root);
  const types = events.map((event) => event.event);
  assert.deepEqual(types, ["TASK_PREPARED", "TASK_CONTINUED", "TASK_REPLACED", "VALIDATION_RECORDED", "COMPLETION_SIGNAL_RECEIVED", "TASK_DONE"]);

  const [prepared, continued, replaced, validated, done] = events;
  assert.ok(prepared.sessionId);
  assert.equal(continued.sessionId, prepared.sessionId, "continuing keeps the same session lineage");
  assert.notEqual(replaced.sessionId, prepared.sessionId, "a new (non-continuing) prepare call starts a new lineage");
  assert.equal(validated.validationKind, "TYPECHECK");
  assert.equal(validated.validationStatus, "PASS");
  assert.equal(done.completionSource, "cli-done");
  assert.equal(typeof prepared.candidateFileCount, "number");
  assert.equal(typeof prepared.estimatedResumeTokens, "number");
  assert.ok(["SAFE", "ROLL_OVER_SOON", "ROLL_OVER_RECOMMENDED"].includes(prepared.rolloverStatus));

  // Never leak the raw task text (which could carry prompt content) into
  // the telemetry stream — only typed counters/ids/statuses.
  const raw = JSON.stringify(events);
  assert.doesNotMatch(raw, /secret-looking prompt text ABC123/);
});

test("Telemetry: HOOK_DONE_TRIGGERED is recorded alongside TASK_DONE only for hook-sourced completion", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Small fix." });
  await writeFile(join(root, "a.js"), "export const a = 1;\n");
  await processDoneEvent(root, { completionSource: "hook-codex-stop" });
  const events = await readTaskTelemetry(root);
  const hookEvent = events.find((event) => event.event === "HOOK_DONE_TRIGGERED");
  assert.ok(hookEvent, "a hook-sourced done must record HOOK_DONE_TRIGGERED");
  assert.equal(hookEvent.completionSource, "hook-codex-stop");
});

test("Telemetry (control): a manual cli-done run never records HOOK_DONE_TRIGGERED", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Small fix." });
  await writeFile(join(root, "a.js"), "export const a = 1;\n");
  await processDoneEvent(root, { completionSource: "cli-done" });
  const events = await readTaskTelemetry(root);
  assert.ok(!events.some((event) => event.event === "HOOK_DONE_TRIGGERED"));
});
