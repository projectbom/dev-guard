// DG-02 regression tests: validation evidence freshness must require BOTH
// code-state freshness AND current-task identity match. Before this fix,
// `isEvidenceFresh`'s codeStateHash/gitHead precedence let two unrelated
// tasks started back-to-back (no code change in between) share "fresh"
// evidence — Task A's recorded PASS leaked into Task B's
// `prepare_task_context` validation summary. Reuses the existing
// `runtime.sessionId` task-lineage identity (already stamped on every
// QAExecutionResult) rather than inventing a new identity field.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ensureDevguardWorkspace, prepareTaskContext, recordValidationEvidence } from "../dist/runtime-state.js";

process.env.LC_ALL = "en-US";
process.env.LC_MESSAGES = "en-US";
process.env.LANG = "en-US";

const execFileAsync = promisify(execFile);
const cleanupRoots = [];

after(async () => {
  await Promise.all(cleanupRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), "devguard-taskid-"));
  cleanupRoots.push(root);
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "DevGuard Test"], { cwd: root });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "generic-fixture" }, null, 2));
  await writeFile(join(root, "src.js"), "export function add(a, b) { return a + b; }\n");
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
  return root;
}

async function readRuntimeJson(root) {
  return JSON.parse(await readFile(join(root, ".devguard", "runtime.json"), "utf8"));
}

async function writeRuntimeJson(root, value) {
  await writeFile(join(root, ".devguard", "runtime.json"), JSON.stringify(value, null, 2));
}

test("DG-02 Scenario A: evidence recorded for Task A appears in Task A's own fresh list on continuation", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Task A: generic task." });
  await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "unit", source: "cli" });

  const result = await prepareTaskContext({ root, task: "Task A: generic task.", continueCurrentTask: true });
  assert.equal(result.validation.freshCount, 1);
  assert.equal(result.validation.fresh[0].name, "unit");
  assert.equal(result.validation.otherTaskCount, 0);
});

test("DG-02 Scenario B: evidence recorded for Task A does NOT appear in Task B's fresh list", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Task A: generic task." });
  await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "unit", source: "cli" });

  const resultB = await prepareTaskContext({ root, task: "Task B: a different, unrelated task." });
  assert.equal(resultB.validation.freshCount, 0, "Task A's evidence must not read as fresh for Task B");
  assert.ok(!resultB.validation.fresh.some((entry) => entry.name === "unit"), "Task A's entry must not appear in Task B's fresh list");
  assert.equal(resultB.validation.otherTaskCount, 1, "it should instead be visible as belonging to a different task");
});

test("DG-02 Scenario C (core regression): Task A -> Task B with IDENTICAL code/git state still excludes Task A's evidence", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Task A: generic task." });
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", name: "build", source: "cli" });

  // No file changes, no commits — git HEAD and working-tree content are
  // byte-identical to when the evidence above was recorded. This is
  // exactly the scenario that exposed DG-02: codeStateHash/gitHead alone
  // would say "fresh" for any task, which is the bug.
  const resultB = await prepareTaskContext({ root, task: "Task B: unrelated, same code state." });
  assert.equal(resultB.validation.freshCount, 0, "identical code state must not be enough to count as current-task-fresh across a task boundary");
  assert.equal(resultB.validation.otherTaskCount, 1);
});

test("DG-02 Scenario D: a real code change still makes evidence stale within the SAME task (existing code-freshness behavior preserved)", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Task A: generic task." });
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", name: "build", source: "cli" });

  await writeFile(join(root, "src.js"), "export function add(a, b) { return a + b; } // changed\n");

  const result = await prepareTaskContext({ root, task: "Task A: generic task.", continueCurrentTask: true });
  assert.equal(result.validation.freshCount, 0, "a real code change must invalidate the evidence even for the same task");
  assert.equal(result.validation.staleCount, 1);
  assert.equal(result.validation.otherTaskCount, 0);
});

test("DG-02 Scenario E: evidence recorded with no active task is unbound and never promoted to current-task fresh", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  // No prepare_task_context call first — no active task.
  await recordValidationEvidence({ root, kind: "LINT", status: "PASS", name: "lint", source: "cli" });

  const result = await prepareTaskContext({ root, task: "Task A: started after the unbound evidence." });
  assert.equal(result.validation.freshCount, 0);
  assert.equal(result.validation.unboundCount, 1);
  assert.ok(!result.validation.fresh.some((entry) => entry.name === "lint"));
});

test("DG-02 Scenario F: legacy evidence with no sessionId field at all does not crash and is never treated as current-task fresh", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Task A: generic task." });

  // Simulate evidence written by a DevGuard version that predates the
  // sessionId-based task-identity fix entirely (bypasses
  // recordValidationEvidence, which would always stamp one now).
  const runtime = await readRuntimeJson(root);
  const [gitHeadOut] = [await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).then((r) => r.stdout.trim())];
  await writeRuntimeJson(root, {
    ...runtime,
    qaResults: {
      "BUILD::build": {
        name: "build",
        kind: "BUILD",
        status: "PASS",
        command: "pnpm build",
        startedAt: "2020-01-01T00:00:00.000Z",
        completedAt: "2020-01-01T00:00:00.000Z",
        durationMs: 0,
        taskBinding: "BOUND",
        gitHead: gitHeadOut
        // no sessionId, no codeStateHash — legacy shape
      }
    }
  });

  const result = await prepareTaskContext({ root, task: "Task A: generic task.", continueCurrentTask: true });
  assert.equal(result.validation.freshCount, 0, "legacy evidence with no task-identity field must never be treated as current-task fresh");
  assert.ok(!result.validation.fresh.some((entry) => entry.name === "build"));
});

test("DG-02 Scenario G: task/session identity persists correctly across separate prepare_task_context calls (restart-safe, file-persisted)", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Task A: generic task." });
  const runtimeAfterA = await readRuntimeJson(root);
  assert.ok(runtimeAfterA.sessionId, "sessionId must be persisted to disk, not just held in memory");

  await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "unit", source: "cli" });

  // A fresh call (new process would read the exact same file) continuing
  // the same task must still see the evidence as fresh.
  const resumed = await prepareTaskContext({ root, task: "Task A: generic task.", continueCurrentTask: true });
  assert.equal(resumed.validation.freshCount, 1);
});
