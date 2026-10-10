// Post-done finalization lineage, from the 2026-10-10 PartnerFlow audit:
// (1) every task ended with a TASK_FOLLOWUP_FINALIZED of 0 files because the
// watcher-reported untracked DIRECTORY sat in the completion baseline and
// then "vanished"; (2) once, the runtime lost its session (and every recorded
// validation) right after `done`, and the late Stop hook finalized the whole
// 1,022-file dirty tree under a brand-new session.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile, chmod } from "node:fs/promises";
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
  recordRuntimeChange,
  recordValidationEvidence,
  resetRuntimeState
} from "../dist/runtime-state.js";
import { readTaskTelemetry } from "../dist/task-telemetry.js";
import { devguardPaths } from "../dist/paths.js";

process.env.LC_ALL = "en-US";
process.env.LANG = "en-US";

const execFileAsync = promisify(execFile);
const cleanupRoots = [];
const DIRTY_FILES = 1000;
const THREAD_A = { provider: "codex", threadId: "01a1231f-2c8a-7521-9652-e7ed112d9071", source: "mcp-meta" };
const THREAD_B = { provider: "codex", threadId: "01a12544-8b0f-7f40-b4b0-ea209104fd45", source: "mcp-meta" };

after(async () => {
  await Promise.all(cleanupRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

async function makeDirtyRepo() {
  const root = await mkdtemp(join(tmpdir(), "devguard-post-done-lineage-"));
  cleanupRoots.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "DevGuard Test"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "sample" }, null, 2));
  await writeFile(join(root, ".gitignore"), ".devguard/\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "init"]);
  await mkdir(join(root, "earlier"), { recursive: true });
  for (let index = 0; index < DIRTY_FILES; index += 1) await writeFile(join(root, "earlier", `note-${index}.md`), `# earlier ${index}\n`);
  await ensureDevguardWorkspace(root);
  await processDoneEvent(root, { completionSource: "cli-done" });
  return root;
}

const events = async (root, name) => (await readTaskTelemetry(root, 5000)).filter((event) => event.event === name);
const historyCount = async (root) => (await readFile(join(root, devguardPaths.history), "utf8")).split("\n").filter((line) => line.trim()).length;

// Task A creates a new untracked directory; the watcher reports the directory itself.
async function taskA(root) {
  await prepareTaskContext({ root, task: "Task A: add the run7 executor.", caller: THREAD_A });
  await mkdir(join(root, "infra/run7"), { recursive: true });
  await writeFile(join(root, "infra/run7/execute.py"), "print('run7')\n");
  await writeFile(join(root, "x.js"), "export const x = 1;\n");
  await recordRuntimeChange(root, "infra/run7");
  await recordRuntimeChange(root, "infra/run7/execute.py");
  return processDoneEvent(root, { completionSource: "cli-done" });
}

test("A: a late Stop with no change after done is a NO-OP — directory pseudo-entries never read as 'returned to committed state'", async () => {
  const root = await makeDirtyRepo();
  const done = await taskA(root);
  assert.ok(!done.taskScopedChangedFiles.includes("infra/run7"), "the directory itself is not a changed file");
  assert.deepEqual([...done.taskScopedChangedFiles].sort(), ["infra/run7/execute.py", "x.js"]);
  const baseline = (await readProjectState(root)).postCompletionBaseline;
  assert.equal(baseline.fileHashes["infra/run7"], undefined, "no directory in the completion baseline");
  const history = await historyCount(root);

  const stop = await processDoneEvent(root, { completionSource: "hook-codex-stop", sourceThreadId: THREAD_A.threadId });
  assert.equal(stop.alreadyProcessed, true);
  assert.equal((await events(root, "TASK_FOLLOWUP_FINALIZED")).length, 0);
  assert.equal(await historyCount(root), history, "no history mutation");
  const signal = (await events(root, "COMPLETION_SIGNAL_RECEIVED")).at(-1);
  assert.equal(signal.alreadyProcessed, true);
});

test("B/C: a post-done edit of the task's file is its follow-up; unrelated work is finalized as untasked (delta only), never as the task's", async () => {
  const root = await makeDirtyRepo();
  await taskA(root);
  await writeFile(join(root, "x.js"), "export const x = 2;\n");
  const followUp = await processDoneEvent(root, { completionSource: "hook-codex-stop", sourceThreadId: THREAD_A.threadId });
  assert.deepEqual(followUp.taskScopedChangedFiles, ["x.js"]);
  assert.equal((await events(root, "TASK_FOLLOWUP_FINALIZED")).length, 1);

  await mkdir(join(root, "src/billing"), { recursive: true });
  await writeFile(join(root, "src/billing/z.js"), "export const z = 1;\n");
  const late = await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "z-check", source: "mcp-agent", caller: THREAD_A });
  assert.equal(late.taskBinding, "UNBOUND", "evidence for unrelated work is not Task A's");
  const untasked = await processDoneEvent(root, { completionSource: "hook-codex-stop", sourceThreadId: THREAD_A.threadId });
  assert.deepEqual(untasked.taskScopedChangedFiles, ["src/billing/z.js"], "only the delta — never the 1,000-file tree");
  assert.ok(untasked.judgments.some((line) => /finalized as untasked work, not as that task's follow-up/.test(line)), untasked.judgments.join("\n"));
  assert.equal((await events(root, "TASK_FOLLOWUP_FINALIZED")).length, 1, "not counted as a Task A follow-up");
  assert.equal((await events(root, "UNTASKED_FINALIZED")).length, 1);
  const lastRecord = JSON.parse((await readFile(join(root, devguardPaths.history), "utf8")).trim().split("\n").at(-1));
  assert.equal(lastRecord.untasked, true);
  const baseline = (await readProjectState(root)).postCompletionBaseline;
  assert.ok(!baseline.taskFiles.includes("src/billing/z.js"), "untasked work never joins the task's own files");
  assert.equal(baseline.followUpOpen, false);
  const after = await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "after-untasked", source: "mcp-agent", caller: THREAD_A });
  assert.equal(after.taskBinding, "UNBOUND", "the follow-up window closes once untasked work was finalized");
});

test("C': lost lineage — an unreadable runtime is never replaced by defaults, and a late Stop with no session reuses the completed lineage", async () => {
  const root = await makeDirtyRepo();
  await taskA(root);
  await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "a-check", source: "mcp-agent", caller: THREAD_A });
  const before = await readRuntimeState(root);
  assert.ok(before.sessionId && before.qaResults["TEST::a-check"]);

  // A read failure during the done-time reset must not wipe session/evidence.
  const runtimePath = join(root, devguardPaths.runtime);
  await chmod(runtimePath, 0o000);
  try {
    await resetRuntimeState(root, { preserveQaResults: true });
  } finally {
    await chmod(runtimePath, 0o644);
  }
  const kept = await readRuntimeState(root);
  assert.equal(kept.sessionId, before.sessionId);
  assert.ok(kept.qaResults["TEST::a-check"], "recorded validations survive");

  // Even if the session is lost by any route, the late Stop stays in Task A's lineage.
  const raw = JSON.parse(await readFile(runtimePath, "utf8"));
  delete raw.sessionId;
  await writeFile(runtimePath, JSON.stringify(raw));
  await writeFile(join(root, "x.js"), "export const x = 9;\n");
  const stop = await processDoneEvent(root, { completionSource: "hook-codex-stop", sourceThreadId: THREAD_A.threadId });
  assert.deepEqual(stop.taskScopedChangedFiles, ["x.js"], "not the whole dirty tree under a new session");
  assert.equal((await readRuntimeState(root)).sessionId, before.sessionId);
  assert.equal((await events(root, "TASK_DONE")).filter((event) => !event.taskPreparedAt).length, 1, "only the initial setup finalization is a taskless TASK_DONE");
});

test("D: after Task B is prepared, Task A's late Stop from its own thread leaves Task B untouched", async () => {
  const root = await makeDirtyRepo();
  await taskA(root);
  await prepareTaskContext({ root, task: "Task B: something else.", caller: THREAD_B });
  const before = await readRuntimeState(root);
  const late = await processDoneEvent(root, { completionSource: "hook-codex-stop", sourceThreadId: THREAD_A.threadId });
  assert.equal(late.ignored?.reason, "foreign_thread");
  const afterState = await readRuntimeState(root);
  assert.equal(afterState.sessionId, before.sessionId);
  assert.equal(afterState.currentTask.text, "Task B: something else.");
});
