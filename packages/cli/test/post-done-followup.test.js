// Post-done follow-up correctness, from the PartnerFlow Run1E / Preflight
// Rerun audit: after TASK_DONE, a second `dev-guard done` (edits made after
// the first) had no task baseline and reported the whole 745-file dirty
// tree as its change set ("drift high"); a validation recorded after `done`
// came back UNBOUND, so agents re-opened the closed task with
// prepare_task_context(continueCurrentTask) just to attach it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ensureDevguardWorkspace,
  prepareTaskContext,
  processDoneEvent,
  readProjectState,
  recordValidationEvidence
} from "../dist/runtime-state.js";
import { readTaskTelemetry } from "../dist/task-telemetry.js";

process.env.LC_ALL = "en-US";
process.env.LC_MESSAGES = "en-US";
process.env.LANG = "en-US";

const execFileAsync = promisify(execFile);
const cleanupRoots = [];
const DIRTY_FILES = 700;
const THREAD = { provider: "codex", threadId: "thread-owner-0001", source: "mcp-meta" };
const OTHER_THREAD = { provider: "codex", threadId: "thread-other-0002", source: "mcp-meta" };

after(async () => {
  await Promise.all(cleanupRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

// A repo whose working tree already holds DIRTY_FILES finalized-but-
// uncommitted files from earlier work, like PartnerFlow's 700+.
async function makeDirtyRepo() {
  const root = await mkdtemp(join(tmpdir(), "devguard-post-done-"));
  cleanupRoots.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "DevGuard Test"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "sample", scripts: { test: "true" } }, null, 2));
  await writeFile(join(root, ".gitignore"), ".devguard/\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "init"]);
  await mkdir(join(root, "earlier"), { recursive: true });
  for (let index = 0; index < DIRTY_FILES; index += 1) {
    await writeFile(join(root, "earlier", `note-${index}.md`), `# earlier ${index}\n`);
  }
  await ensureDevguardWorkspace(root);
  await processDoneEvent(root, { completionSource: "cli-done" });
  return root;
}

async function eventsOf(root, name) {
  return (await readTaskTelemetry(root, 5000)).filter((event) => event.event === name);
}

test("A: a follow-up `done` after TASK_DONE reports only the files changed since that done — never the pre-existing dirty tree", async () => {
  const root = await makeDirtyRepo();
  await prepareTaskContext({ root, task: "Task A: add the x module.", caller: THREAD });
  await writeFile(join(root, "x.js"), "export const x = 1;\n");
  const first = await processDoneEvent(root, { completionSource: "cli-done" });
  assert.equal(first.alreadyProcessed, false);
  assert.deepEqual(first.taskScopedChangedFiles, ["x.js"], "TASK_DONE scope: X only");

  await writeFile(join(root, "y.js"), "export const y = 2;\n");
  const followUp = await processDoneEvent(root, { completionSource: "cli-done" });
  assert.equal(followUp.alreadyProcessed, false);
  assert.deepEqual(followUp.taskScopedChangedFiles, ["y.js"], "follow-up scope: Y only, not X and not the 700 earlier files");
  assert.equal(followUp.carriedOverChangedFiles.length, DIRTY_FILES + 1, "earlier dirt and the already-finalized X are carried over");
  assert.ok(followUp.judgments.some((line) => /Follow-up of the task closed just before: only the 1 file/.test(line)), followUp.judgments.join("\n"));

  assert.equal((await eventsOf(root, "TASK_DONE")).filter((event) => event.taskPreparedAt).length, 1);
  const followUps = await eventsOf(root, "TASK_FOLLOWUP_FINALIZED");
  assert.equal(followUps.length, 1, "exactly one follow-up finalization");
  assert.equal(followUps[0].changedFileDeltaCount, 1);

  // An edit to a file the task already finalized is a follow-up change too.
  await writeFile(join(root, "x.js"), "export const x = 3;\n");
  const second = await processDoneEvent(root, { completionSource: "cli-done" });
  assert.deepEqual(second.taskScopedChangedFiles, ["x.js"]);
});

test("B: repeated `done` with no change after TASK_DONE (or after a follow-up) is a NO-OP — no follow-up finalization", async () => {
  const root = await makeDirtyRepo();
  await prepareTaskContext({ root, task: "Task B: add the b module.", caller: THREAD });
  await writeFile(join(root, "b.js"), "export const b = 1;\n");
  await processDoneEvent(root, { completionSource: "cli-done" });
  const repeat = await processDoneEvent(root, { completionSource: "cli-done" });
  assert.equal(repeat.alreadyProcessed, true);
  assert.equal((await eventsOf(root, "TASK_FOLLOWUP_FINALIZED")).length, 0);

  // Same, when the code state hash moves but no dirty file did: still a no-op.
  const state = await readProjectState(root);
  const { writeProjectState } = await import("../dist/runtime-state.js");
  await writeProjectState(root, { ...state, lastFinalizedCodeStateHash: "forced-different-hash" });
  const sameFiles = await processDoneEvent(root, { completionSource: "hook-codex-stop" });
  assert.equal(sameFiles.alreadyProcessed, true, "no file moved since the task's done");
  assert.equal((await eventsOf(root, "TASK_FOLLOWUP_FINALIZED")).length, 0);
});

test("C: a validation recorded after `done` binds to the completed task without re-prepare; a different thread's stays UNBOUND", async () => {
  const root = await makeDirtyRepo();
  await prepareTaskContext({ root, task: "Task C: add the c module.", caller: THREAD });
  await writeFile(join(root, "c.js"), "export const c = 1;\n");
  await processDoneEvent(root, { completionSource: "cli-done" });

  const late = await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "late-check", source: "mcp-agent", caller: THREAD });
  assert.equal(late.taskBinding, "BOUND");
  assert.equal(late.bindingScope, "completed-task");
  const unobservable = await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "late-check-no-identity", source: "mcp-agent" });
  assert.equal(unobservable.taskBinding, "BOUND", "caller not observable: the lineage + time window decide");

  const foreign = await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "other-thread", source: "mcp-agent", caller: OTHER_THREAD });
  assert.equal(foreign.taskBinding, "UNBOUND", "another thread is not the closed task's follow-up");

  // A late fix to the task's own file is still its follow-up...
  await writeFile(join(root, "c.js"), "export const c = 2;\n");
  const ownFix = await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "own-fix", source: "mcp-agent", caller: THREAD });
  assert.equal(ownFix.taskBinding, "BOUND");
  // ...but different work started without prepare_task_context is not.
  await writeFile(join(root, "unrelated.js"), "export const u = 1;\n");
  const unrelated = await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "unrelated", source: "mcp-agent", caller: THREAD });
  assert.equal(unrelated.taskBinding, "UNBOUND", "work outside the closed task's files is not its follow-up");

  // A new task starts a new lineage: the completed task's window no longer applies.
  await prepareTaskContext({ root, task: "Task D: something else.", caller: THREAD });
  await processDoneEvent(root, { completionSource: "cli-done" });
  const { resetRuntimeState } = await import("../dist/runtime-state.js");
  await resetRuntimeState(root);
  const afterReset = await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "after-reset", source: "mcp-agent", caller: THREAD });
  assert.equal(afterReset.taskBinding, "UNBOUND", "a full reset drops the lineage; nothing to follow up");
  assert.equal((await eventsOf(root, "TASK_CONTINUED")).length, 0, "no re-prepare was needed");
});
