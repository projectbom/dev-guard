// Verified Project State (v0.12): event ledger → deterministic projection,
// provenance (OBSERVED vs AGENT_REPORTED), STOPPED/BLOCKED outcomes,
// supersession, task/evidence-scoped validation freshness, user decisions,
// rebuildability, rotation, and the history diet. Every surface (prepare
// payload, Quality Report, Handoff, dashboard cache) must read one projection.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  prepareTaskContext,
  processDoneEvent,
  recordTaskOutcome,
  recordUserDecision,
  recordValidationEvidence,
  toAgentContextPayload
} from "../dist/runtime-state.js";
import {
  appendProjectEvents,
  computeProjectState,
  foldEvents,
  isContinueRequest,
  projectFoldedState,
  readProjectEvents,
  readProjectStateCache,
  rebuildProjectState
} from "../dist/project-state.js";
import { claudeCommandFromResult, codexCommandFromItem, matchReportedValidation, normalizeCommand, resetObservedCommandCache } from "../dist/observed-commands.js";
import { dashboardVerifiedState } from "../dist/verified-state-view.js";

process.env.LC_ALL = "en-US";
process.env.LC_MESSAGES = "en-US";
process.env.LANG = "en-US";

const execFileAsync = promisify(execFile);
const cleanup = [];
after(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRepo({ carried = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "devguard-vps-"));
  cleanup.push(root);
  const git = (...args) => execFileAsync("git", args, { cwd: root });
  await git("init", "-q");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "sample", scripts: { build: "true", test: "node --test" } }, null, 2));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "legacy"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(join(root, "src/own.ts"), "export const own = 1;\n");
  await writeFile(join(root, "test/own.test.js"), "import test from 'node:test';\ntest('own', () => {});\n");
  for (let i = 0; i < carried; i += 1) await writeFile(join(root, `legacy/file${i}.ts`), `export const v${i} = ${i};\n`);
  await git("add", "-A");
  await git("commit", "-qm", "init");
  // Carried-over dirty work from earlier tasks.
  for (let i = 0; i < carried; i += 1) await appendFile(join(root, `legacy/file${i}.ts`), "// dirty\n");
  return root;
}

/** A Claude Code transcript under CLAUDE_CONFIG_DIR, holding the given Bash runs. */
async function claudeTranscript(sessionId, runs) {
  const dir = await mkdtemp(join(tmpdir(), "devguard-claude-"));
  cleanup.push(dir);
  process.env.CLAUDE_CONFIG_DIR = dir;
  await mkdir(join(dir, "projects", "fixture"), { recursive: true });
  const file = join(dir, "projects", "fixture", `${sessionId}.jsonl`);
  await writeFile(file, "");
  const add = async (command, exitCode) => {
    const id = `tu_${Math.random().toString(36).slice(2)}`;
    const ts = new Date().toISOString();
    await appendFile(file, `${JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } })}\n`);
    const result = exitCode === 0 ? { type: "tool_result", tool_use_id: id, content: "ok" } : { type: "tool_result", tool_use_id: id, is_error: true, content: `Exit code ${exitCode}\nfailed` };
    await appendFile(file, `${JSON.stringify({ type: "user", timestamp: ts, message: { content: [result] } })}\n`);
  };
  for (const [command, exitCode] of runs) await add(command, exitCode);
  return { add };
}

const caller = (threadId) => ({ provider: "claude", threadId, source: "mcp-env" });

// --- observed command matching (cases A–D) ------------------------------------

test("matcher: reported PASS/FAIL vs observed exit codes (A/B/C/D) and inconclusive pipelines", () => {
  const at = new Date().toISOString();
  const observed = (command, exitCode) => [{ command: normalizeCommand(command), key: "k", exitCode, at, provider: "codex", thread: "t" }];
  // A
  assert.deepEqual(
    pick(matchReportedValidation({ command: "pnpm -r build", status: "PASS" }, observed("cd /x && pnpm -r build", 0))),
    { provenance: "OBSERVED", verification: "MATCHED" }
  );
  // B
  assert.deepEqual(pick(matchReportedValidation({ command: "node --test a.test.js", status: "FAIL" }, observed("node --test a.test.js", 1))), { provenance: "OBSERVED", verification: "MATCHED" });
  // C — the release's provenance mismatch contract
  assert.deepEqual(pick(matchReportedValidation({ command: "node --test a.test.js", status: "PASS", exitCode: 0 }, observed("node --test a.test.js", 1))), { provenance: "AGENT_REPORTED", verification: "MISMATCH" });
  // D
  assert.deepEqual(pick(matchReportedValidation({ command: "pytest -q", status: "PASS" }, observed("pnpm build", 0))), { provenance: "AGENT_REPORTED", verification: "UNVERIFIED" });
  assert.equal(matchReportedValidation({ command: "pytest -q", status: "PASS" }, undefined).note, "transcript-unavailable");
  // `| tail` reports the filter's exit code: never confirms on its own.
  const piped = [codexCommandFromItem({ type: "CommandExecution", command: ["/bin/zsh", "-lc", "pnpm test 2>&1 | tail -n 40"], exit_code: 0 }, at, "t")];
  assert.equal(piped[0].filtered, true);
  assert.equal(matchReportedValidation({ command: "pnpm test", status: "PASS" }, piped).note, "exit-inconclusive");
  // One `&&` step: exit 0 proves it passed.
  assert.equal(matchReportedValidation({ command: "pnpm lint", status: "PASS" }, observed("pnpm build && pnpm lint", 0)).provenance, "OBSERVED");
  // A FAIL judged from output while the script exited 0 is plausible, not a mismatch.
  assert.equal(matchReportedValidation({ command: "python3 gate.py", status: "FAIL" }, observed("python3 gate.py", 0)).note, "fail-judged-from-output");
  // Claude tool results carry "Exit code N" on error.
  assert.equal(claudeCommandFromResult("npm test", { is_error: true, content: "Exit code 2\nboom" }, at, "t").exitCode, 2);
  assert.equal(claudeCommandFromResult("npm test", { content: "ok" }, at, "t").exitCode, 0);
});

function pick(match) {
  return { provenance: match.provenance, verification: match.verification };
}

test("continue requests are recognized only when they carry nothing else", () => {
  assert.equal(isContinueRequest("Continue the current work."), true);
  assert.equal(isContinueRequest("continue"), true);
  assert.equal(isContinueRequest("계속 진행해줘"), true);
  assert.equal(isContinueRequest("Continue the refactor of the billing module and add tests"), false);
});

// --- stale-state challenge (pure projection) ------------------------------------

test("stale-state challenge: A FAIL → SUPERSEDED, B PASS → STALE after a relevant edit, no CURRENT PASS", () => {
  const t = (n) => new Date(Date.UTC(2026, 9, 21, 0, n)).toISOString();
  const event = (type, taskId, timestamp, payload, extra = {}) => ({ schemaVersion: 1, eventId: `${type}-${timestamp}`, timestamp, taskId, lineageId: "A", type, provenance: "OBSERVED", payload, ...extra });
  const validation = (status, fingerprint, at) => ({ identity: "TEST::unit", kind: "TEST", name: "unit", status, verification: "MATCHED", scope: { mode: "SCOPED", files: { "src/a.ts": fingerprint } }, binding: "BOUND", completedAt: at });
  const events = [
    event("TASK_STARTED", "A", t(1), { task: "fix a" }),
    event("VALIDATION_RECORDED", "A", t(2), validation("FAIL", "h1", t(2))),
    event("TASK_OUTCOME_RECORDED", "A", t(3), { status: "FAIL", reason: "unit test fails" }, { provenance: "AGENT_REPORTED" }),
    event("TASK_STARTED", "B", t(4), { task: "fix a again", continues: "A" }),
    event("VALIDATION_RECORDED", "B", t(5), validation("PASS", "h2", t(5))),
    event("TASK_OUTCOME_RECORDED", "B", t(6), { status: "PASS" }, { provenance: "AGENT_REPORTED" })
  ];
  const folded = foldEvents(events);
  const fresh = projectFoldedState(folded, { fingerprints: { "src/a.ts": "h2" } });
  assert.equal(fresh.validations.counts.current, 1);
  assert.equal(fresh.validations.superseded[0].status, "FAIL");
  assert.equal(fresh.outcome.status, "PASS", "B's PASS supersedes A's FAIL through the continuation chain");
  const after = projectFoldedState(folded, { fingerprints: { "src/a.ts": "h3" } });
  assert.equal(after.validations.counts.current, 0, "no CURRENT PASS once a supporting file changed");
  assert.equal(after.validations.stale[0].status, "PASS");
  assert.equal(after.validations.superseded[0].status, "FAIL");
  assert.match(after.validations.stale[0].because, /src\/a\.ts/);
});

test("supersession is conservative: an unrelated later task never supersedes a FAIL or a STOP", () => {
  const t = (n) => new Date(Date.UTC(2026, 9, 21, 1, n)).toISOString();
  const event = (type, taskId, timestamp, payload) => ({ schemaVersion: 1, eventId: `${type}-${taskId}-${timestamp}`, timestamp, taskId, lineageId: taskId, type, provenance: "AGENT_REPORTED", payload });
  const folded = foldEvents([
    event("TASK_STARTED", "A", t(1), { task: "run gated rollout" }),
    event("TASK_OUTCOME_RECORDED", "A", t(2), { status: "STOPPED", reason: "baseline drift gate", blockedOn: "fresh baseline" }),
    event("TASK_STARTED", "C", t(3), { task: "unrelated docs fix" }),
    event("TASK_OUTCOME_RECORDED", "C", t(4), { status: "PASS" })
  ]);
  const view = projectFoldedState(folded, { fingerprints: {} });
  assert.equal(view.activeBlockers.length, 1);
  assert.equal(view.activeBlockers[0].status, "STOPPED");
  // Explicit supersession settles it.
  const explicit = foldEvents([event("TASK_OUTCOME_RECORDED", "C", t(5), { status: "PASS", supersedes: ["A"] })], folded);
  assert.equal(projectFoldedState(explicit, { fingerprints: {} }).activeBlockers.length, 0);
});

// --- integration: provenance, scoped freshness, decisions, outcomes ------------

test("record_validation_result: OBSERVED when the transcript shows the command and exit code; MISMATCH when it contradicts", async () => {
  resetObservedCommandCache();
  const root = await makeRepo({ carried: 300 });
  const sid = `sess-${Date.now()}-a`;
  const transcript = await claudeTranscript(sid, []);
  await prepareTaskContext({ root, task: "Fix src/own.ts and its test", caller: caller(sid) });
  await appendFile(join(root, "src/own.ts"), "export const more = 2;\n");
  await transcript.add("node --test test/own.test.js", 0);
  const passed = await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "own", command: "node --test test/own.test.js", exitCode: 0, source: "mcp-agent", caller: caller(sid) });
  assert.equal(passed.provenance, "OBSERVED");
  assert.equal(passed.verification, "MATCHED");

  await transcript.add("node --test test/other.test.js", 1);
  const lied = await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "other", command: "node --test test/other.test.js", exitCode: 0, source: "mcp-agent", caller: caller(sid) });
  assert.equal(lied.provenance, "AGENT_REPORTED");
  assert.equal(lied.verification, "MISMATCH");

  const unseen = await recordValidationEvidence({ root, kind: "MANUAL_QA", status: "PASS", name: "browser", command: "opened the page", source: "mcp-agent", caller: caller(sid) });
  assert.equal(unseen.provenance, "AGENT_REPORTED");
  assert.equal(unseen.verification, "UNVERIFIED");

  const events = await readProjectEvents(root);
  const own = events.find((event) => event.type === "VALIDATION_RECORDED" && event.payload.name === "own");
  assert.equal(own.payload.scope.mode, "SCOPED", "scoped to task-owned + command files, not the 300-file dirty tree");
  assert.ok("src/own.ts" in own.payload.scope.files);
  assert.ok("test/own.test.js" in own.payload.scope.files);
  assert.ok(!Object.keys(own.payload.scope.files).some((file) => file.startsWith("legacy/")));

  const view = await computeProjectState(root);
  assert.equal(view.validations.counts.verified, 1);
  assert.equal(view.validations.mismatched[0].identity, "TEST::other");
  assert.ok(!view.validations.current.some((entry) => entry.identity === "TEST::other"), "a mismatch is never current verification");

  // The agent payload never calls the mismatch verified.
  const next = await prepareTaskContext({ root, task: "Fix src/own.ts and its test", continueCurrentTask: true, caller: caller(sid) });
  const state = toAgentContextPayload(next).state;
  assert.ok(state.validations.mismatched.some((line) => /TEST other: PASS \(MISMATCH/.test(line)));
  assert.ok(!state.validations.verified.some((line) => /other/.test(line)));
  assert.ok(state.validations.verified.some((line) => /TEST own: PASS \(observed\)/.test(line)));

  await processDoneEvent(root, { completionSource: "cli-done" });
  // F: an unrelated change elsewhere in the 300-file dirty tree → the scoped check stays CURRENT.
  await appendFile(join(root, "legacy/file7.ts"), "// unrelated\n");
  assert.ok((await computeProjectState(root)).validations.current.some((entry) => entry.identity === "TEST::own"));
  // E: a supporting file changes → STALE.
  await appendFile(join(root, "src/own.ts"), "export const changed = 3;\n");
  const stale = await computeProjectState(root);
  assert.ok(!stale.validations.current.some((entry) => entry.identity === "TEST::own"));
  assert.ok(stale.validations.stale.some((entry) => entry.identity === "TEST::own"));
});

test("a check goes STALE when its own open task edits another file after it", async () => {
  const root = await makeRepo({ carried: 20 });
  await prepareTaskContext({ root, task: "Fix src/own.ts" });
  await appendFile(join(root, "src/own.ts"), "export const a = 1;\n");
  await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "suite", command: "pnpm test", source: "cli" });
  let view = (await prepareTaskContext({ root, task: "Fix src/own.ts", continueCurrentTask: true })).verifiedState;
  assert.equal(view.validations.counts.current, 1);
  await writeFile(join(root, "src/extra.ts"), "export const extra = 1;\n");
  view = (await prepareTaskContext({ root, task: "Fix src/own.ts", continueCurrentTask: true })).verifiedState;
  assert.equal(view.validations.counts.current, 0);
  assert.match(view.validations.stale[0].because, /changed 1 more file\(s\) after this check: src\/extra\.ts/);
});

test("STOPPED/BLOCKED outcomes, user decisions and supersession flow through every surface identically", async () => {
  resetObservedCommandCache();
  const root = await makeRepo({ carried: 50 });
  const sid = `sess-${Date.now()}-b`;
  const transcript = await claudeTranscript(sid, []);
  await prepareTaskContext({ root, task: "Run the gated rollout executor in src/own.ts", caller: caller(sid) });
  const first = await recordUserDecision({ root, decision: "Do not deploy to production." });
  await appendFile(join(root, "src/own.ts"), "export const gate = true;\n");
  await transcript.add("node --test test/own.test.js", 0);
  await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "gate-unit", command: "node --test test/own.test.js", source: "mcp-agent", caller: caller(sid) });
  await transcript.add("node src/own.ts", 3);
  await recordValidationEvidence({ root, kind: "RUNTIME_SMOKE", status: "FAIL", name: "rollout", command: "node src/own.ts", exitCode: 3, source: "mcp-agent", caller: caller(sid) });
  const stopped = await recordTaskOutcome({ root, status: "STOPPED", reason: "Safety gate detected baseline drift and stopped before mutation.", blockedOn: "a fresh baseline snapshot", nextIntent: "Capture a fresh baseline, then re-run the gated rollout." });
  assert.equal(stopped.state.outcome.startsWith("STOPPED"), true);
  await processDoneEvent(root, { completionSource: "cli-done" });

  const quality = await readFile(join(root, ".devguard/reports/quality-report.md"), "utf8");
  const handoff = await readFile(join(root, ".devguard/reports/project-handoff.md"), "utf8");
  const cache = await readProjectStateCache(root);
  for (const doc of [quality, handoff]) {
    assert.match(doc, /## Verified Project State/);
    assert.match(doc, /Outcome: \*\*STOPPED\*\*/);
    assert.match(doc, /not a defect/);
    assert.match(doc, /Do not deploy to production\./);
    assert.match(doc, /Verified \(observed\):.*TEST gate-unit: PASS \(observed\)/);
  }
  assert.equal(cache.outcome.status, "STOPPED");
  assert.equal(dashboardVerifiedState(cache).state, "STOPPED");
  assert.equal(dashboardVerifiedState(cache).blockedOn, "a fresh baseline snapshot");

  // Fresh agent, no conversation history: only "Continue the current work."
  const sid2 = `sess-${Date.now()}-c`;
  const transcript2 = await claudeTranscript(sid2, []);
  const resumed = await prepareTaskContext({ root, task: "Continue the current work.", caller: caller(sid2) });
  const payload = toAgentContextPayload(resumed);
  assert.match(payload.task, /continuing: Run the gated rollout executor/);
  assert.match(payload.nextAction, /Previous task STOPPED on a fresh baseline snapshot.*not a defect/);
  assert.match(payload.state.outcome, /^STOPPED — Safety gate/);
  assert.deepEqual(payload.state.decisions, ["Do not deploy to production. [user, lineage]"]);
  assert.match(payload.state.nextIntent, /Capture a fresh baseline/);
  assert.ok(payload.state.validations.verified.some((line) => /gate-unit: PASS/.test(line)));
  assert.ok(payload.files.some((file) => file.path === "src/own.ts"), "the continued task's file is routed");
  assert.ok(!JSON.stringify(payload).includes("FAIL — Safety gate"), "a deliberate STOP is never presented as FAIL");

  // The user approves deployment: B supersedes A; no policy is enforced.
  const second = await recordUserDecision({ root, decision: "Deployment is now approved for this task.", supersedes: [first.decisionId] });
  assert.deepEqual(second.state.decisions, ["Deployment is now approved for this task. [user, lineage]"]);
  // Continuation succeeds → the old STOP is superseded and no longer the next action.
  await transcript2.add("node src/own.ts", 0);
  const rerun = await recordValidationEvidence({ root, kind: "RUNTIME_SMOKE", status: "PASS", name: "rollout", command: "node src/own.ts", source: "mcp-agent", caller: caller(sid2) });
  assert.equal(rerun.provenance, "OBSERVED");
  const passed = await recordTaskOutcome({ root, status: "PASS", reason: "Rollout completed after a fresh baseline." });
  assert.equal(passed.state.outcome, "PASS — Rollout completed after a fresh baseline.");
  assert.equal(passed.state.blockers, undefined);
  assert.equal(passed.state.nextIntent, null);
  const view = await computeProjectState(root);
  assert.ok(view.validations.superseded.some((entry) => entry.identity === "RUNTIME_SMOKE::rollout" && entry.status === "FAIL"));
  assert.equal(view.decisions.superseded, 1);
  assert.equal(view.activeDecisions.length, 1);
});

test("projection is rebuildable: a lost current.json is recovered from the ledger", async () => {
  const root = await makeRepo();
  await prepareTaskContext({ root, task: "Fix src/own.ts" });
  await recordTaskOutcome({ root, status: "BLOCKED", reason: "Needs approval", blockedOn: "user approval for the production mutation" });
  const before = await readProjectStateCache(root);
  await unlink(join(root, ".devguard/state/current.json"));
  const rebuilt = await rebuildProjectState(root);
  assert.deepEqual({ ...rebuilt, generatedAt: "" }, { ...before, generatedAt: "" });
  assert.equal(rebuilt.nextIntent.provenance, "DERIVED");
  assert.match(rebuilt.nextIntent.text, /user approval/);
});

test("ledger rotation carries live state forward in a checkpoint", async () => {
  const root = await makeRepo();
  await prepareTaskContext({ root, task: "Fix src/own.ts" });
  await recordUserDecision({ root, decision: "Maximum correction budget is 3.", scope: "PROJECT" });
  const padding = "x".repeat(1500);
  const batch = [];
  for (let i = 0; i < 1600; i += 1) {
    batch.push({ type: "COMMAND_OBSERVED", taskId: "noise", provenance: "OBSERVED", payload: { command: `echo ${i} ${padding}`, commandKey: `k${i}`, observedAt: new Date().toISOString() } });
  }
  for (let i = 0; i < batch.length; i += 200) await appendProjectEvents(root, batch.slice(i, i + 200));
  await appendProjectEvents(root, batch.slice(0, 400));
  const rotated = await stat(join(root, ".devguard/events/task-events.jsonl.1")).catch(() => undefined);
  assert.ok(rotated, "the ledger rotated");
  const view = await computeProjectState(root);
  assert.equal(view.activeDecisions[0]?.decision, "Maximum correction budget is 3.");
});

test("history diet: a task in a large carried-over dirty tree stores counts and a hash, not thousands of paths", async () => {
  const root = await makeRepo({ carried: 600 });
  await processDoneEvent(root, { completionSource: "cli-done" }); // finalize the earlier work once
  await prepareTaskContext({ root, task: "Fix src/own.ts" });
  await appendFile(join(root, "src/own.ts"), "export const x = 1;\n");
  await processDoneEvent(root, { completionSource: "cli-done" });
  const lines = (await readFile(join(root, ".devguard/history.jsonl"), "utf8")).trim().split("\n");
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.carriedOverChangedFiles, undefined);
  assert.equal(last.carriedDirtyCount, 600);
  assert.ok(last.carriedDirtyHash);
  assert.deepEqual(last.taskScopedChangedFiles, ["src/own.ts"]);
  assert.ok(last.changedFiles.length <= 200);
  assert.equal(last.changedFileCount, 601);
  assert.ok(lines.at(-1).length < 40_000, `history row is ${lines.at(-1).length} bytes`);
  const finalized = JSON.parse(await readFile(join(root, ".devguard/state/finalized-files.json"), "utf8"));
  assert.equal(finalized.files.length, 601);
});
