// Execution lineage + task-boundary headroom, from the 2026-10-10 PartnerFlow
// audit: ~70% of a fresh thread's early reads were outside the read plan,
// mostly the previous run's own scripts and older executors it reused, found
// again with `rg --files`; and tasks that ended at 42–49% (LOW) were followed
// in the same thread by tasks that ended at 67–88%.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ensureCodeIndex, ensureDevguardWorkspace, prepareTaskContext, processDoneEvent, threadStateForAgent } from "../dist/runtime-state.js";
import { taskBoundaryHeadroom } from "../dist/thread-ownership.js";
import { contextIssues } from "../dist/context-efficiency.js";
import { recordTaskTelemetry } from "../dist/task-telemetry.js";
import { devguardPaths } from "../dist/paths.js";

process.env.LC_ALL = "en-US";
process.env.LANG = "en-US";

const execFileAsync = promisify(execFile);
const cleanup = [];
let codexHome;
before(async () => {
  codexHome = await mkdtemp(join(tmpdir(), "devguard-lineage-codex-"));
  cleanup.push(codexHome);
  process.env.CODEX_HOME = codexHome;
});
after(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

const THREAD_A = "01a12544-8b0f-7f40-b4b0-ea209104fd45";
const caller = (threadId) => ({ provider: "codex", threadId, source: "mcp-meta" });

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}
async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

const bigScript = [
  "import json, subprocess",
  "PROJECT = 'partnerflow'",
  "",
  ...Array.from({ length: 30 }, (_, index) => [`def helper_${index}(value):`, ...Array.from({ length: 12 }, (__, line) => `    value = value + ${line}  # padding line to make the script large enough to exceed the whole-file threshold`), "    return value", ""]).flat(),
  "def route_qualified(window):",
  "    # decides whether the route latency window qualifies",
  "    return window['p95'] < 2117",
  "",
  "if __name__ == '__main__':",
  "    print(route_qualified({'p95': 100}))",
  ""
].join("\n");

async function lineageRepo() {
  const root = await mkdtemp(join(tmpdir(), "devguard-lineage-"));
  cleanup.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "t@example.com"]);
  await git(root, ["config", "user.name", "t"]);
  await put(root, "package.json", JSON.stringify({ name: "ops" }));
  await put(root, ".gitignore", ".devguard/\n");
  await put(root, "infra/standby/run3/execute.py", "def execute():\n    return 'older executor reused by later runs'\n");
  await put(root, "infra/standby/run6f/collector.py", bigScript);
  await put(root, "docs/billing-invoice-email.md", "# Billing invoice email\n\nTemplate notes.\n");
  await put(root, "src/billing/invoice-email.ts", "export function invoiceEmail(): string {\n  return 'invoice';\n}\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "init"]);
  await ensureDevguardWorkspace(root);
  await ensureCodeIndex(root);
  return root;
}

// The previous task's own Codex log: it ran its executor and read older scripts.
async function writeTaskRollout(root, threadId, commands, inputTokens) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const dir = join(codexHome, "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  await mkdir(dir, { recursive: true });
  const ts = () => new Date().toISOString();
  const line = (type, payload) => `${JSON.stringify({ timestamp: ts(), type, payload })}\n`;
  let text = line("session_meta", { id: threadId, cwd: root, thread_source: "user", timestamp: ts() });
  for (const command of commands) text += line("event_msg", { type: "item_completed", item: { type: "CommandExecution", command: ["/bin/zsh", "-lc", command], cwd: root, aggregated_output: "ok" } });
  text += line("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: inputTokens }, model_context_window: 258400 } });
  await writeFile(join(dir, `rollout-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T00-00-00-${threadId}.jsonl`), text);
}

async function runTaskA(root) {
  await prepareTaskContext({ root, task: "Group B Run6G corrective: prepare and execute the run6g runtime against the route latency gate.", caller: caller(THREAD_A) });
  await put(root, "infra/standby/run6g/prepare.py", "def prepare():\n    return 'run6g prepare'\n");
  await put(root, "infra/standby/run6g/runtime.py", "def runtime():\n    return 'run6g runtime'\n");
  await put(root, "infra/standby/run6g/test_prepare.py", "def test_prepare():\n    assert True\n");
  await put(root, "infra/standby/run6g/execution-result.json", JSON.stringify({ status: "STOP", reason: "route latency gate" }, null, 2));
  await put(root, "docs/hot-standby-group-b-run6g-corrective-20261010.md", "# Group B Run6G corrective\n\n## Result\n\nSTOP at the route latency gate.\n");
  await writeTaskRollout(root, THREAD_A, [
    "cd infra/standby/run6g && python3 prepare.py --dry-run",
    "python3 infra/standby/run6g/runtime.py",
    "sed -n '1,40p' infra/standby/run3/execute.py",
    "cat infra/standby/run6f/collector.py"
  ], 120000);
  return processDoneEvent(root, { completionSource: "cli-done" });
}

async function lastHistoryRecord(root) {
  return JSON.parse((await readFile(join(root, devguardPaths.history), "utf8")).trim().split("\n").at(-1));
}

test("E: done records the task's execution lineage — scripts it executed, scripts it read, files it produced (paths only, bounded)", async () => {
  const root = await lineageRepo();
  await runTaskA(root);
  const lineage = (await lastHistoryRecord(root)).executionLineage;
  assert.ok(lineage, "lineage recorded");
  assert.deepEqual(lineage.executed.sort(), ["infra/standby/run6g/prepare.py", "infra/standby/run6g/runtime.py"]);
  assert.deepEqual(lineage.usedScripts.sort(), ["infra/standby/run3/execute.py", "infra/standby/run6f/collector.py"]);
  assert.ok(lineage.produced.includes("infra/standby/run6g/execution-result.json"));
  assert.ok(lineage.produced.every((file) => !file.endsWith("/")), "files only, no directory entries");
  assert.ok(JSON.stringify(lineage).length < 4000, "bounded");
});

test("F/H: the next same-workstream task plans the previous executor and reused scripts as lineage, with script-sized ranges", async () => {
  const root = await lineageRepo();
  await runTaskA(root);
  const result = await prepareTaskContext({
    root,
    task: "Group B Run6H resume: rerun the run6g corrective with the operator-approved route latency outlier.",
    explicitInputs: ["docs/hot-standby-group-b-run6g-corrective-20261010.md"],
    persistTask: false
  });
  const lineage = result.files.filter((file) => file.source === "execution-lineage");
  const paths = lineage.map((file) => file.path);
  assert.ok(paths.includes("infra/standby/run6g/prepare.py"), paths.join(", "));
  assert.ok(paths.includes("infra/standby/run6g/runtime.py"), paths.join(", "));
  assert.ok(lineage.length <= 4);
  assert.ok(!paths.includes("infra/standby/run6g/test_prepare.py"), "test helpers rank below executors when the task is not about tests");
  // A resume/rerun task: the previous executor is a TARGET, not just a candidate.
  assert.equal(lineage.find((file) => file.path === "infra/standby/run6g/prepare.py").role, "TARGET");
  assert.match(lineage.find((file) => file.path === "infra/standby/run6g/prepare.py").reason, /Executed by the previous task/);
  // Lineage never displaces the user's own inputs.
  assert.equal(result.files.find((file) => file.path === "docs/hot-standby-group-b-run6g-corrective-20261010.md").source, "explicit-user-input");
  // H: a small script is one WHOLE_FILE read.
  assert.equal(lineage.find((file) => file.path === "infra/standby/run6g/prepare.py").ranges[0].kind, "WHOLE_FILE");

  // H: a large reused script is offered by its relevant top-level sections, not whole.
  const big = await prepareTaskContext({
    root,
    task: "Check route_qualified in the run6f collector for the route latency window.",
    explicitInputs: ["infra/standby/run6f/collector.py"],
    persistTask: false
  });
  const collector = big.files.find((file) => file.path === "infra/standby/run6f/collector.py");
  assert.ok(!collector.ranges.some((range) => range.kind === "WHOLE_FILE"), collector.ranges.map((range) => range.label).join(" | "));
  assert.ok(collector.ranges.some((range) => range.label === "script def route_qualified"), collector.ranges.map((range) => range.label).join(" | "));
});

test("G: an unrelated workstream does not inherit the previous task's lineage", async () => {
  const root = await lineageRepo();
  await runTaskA(root);
  const result = await prepareTaskContext({ root, task: "Update the billing invoice email template wording.", persistTask: false });
  assert.deepEqual(result.files.filter((file) => file.source === "execution-lineage").map((file) => file.path), []);
});

test("I/J: task-boundary headroom — 47% + heavy next task warns, 47% + small follow-up continues, no history is conservative", () => {
  const growth = [0.3, 0.35, 0.25];
  const heavy = taskBoundaryHeadroom({ ratio: 0.47, recentGrowth: growth, nextTaskText: "Execute the authorized Production preflight rerun." });
  assert.equal(heavy.status, "SOON", heavy.reason);
  const light = taskBoundaryHeadroom({ ratio: 0.47, recentGrowth: growth, nextTaskText: "Small follow-up: fix a typo in the report wording." });
  assert.equal(light.status, "CONTINUE", light.reason);
  const unknownNext = taskBoundaryHeadroom({ ratio: 0.47, recentGrowth: growth });
  assert.equal(unknownNext.status, "SOON", "a typical next task (30%) from 47% crosses 75%");
  assert.equal(taskBoundaryHeadroom({ ratio: 0.62, recentGrowth: growth, nextTaskText: "Run a full audit." }).status, "NEW_THREAD");
  assert.equal(taskBoundaryHeadroom({ ratio: 0.2, recentGrowth: growth }).status, "CONTINUE");
  assert.equal(taskBoundaryHeadroom({ ratio: 0.47, recentGrowth: [0.3] }).status, "SOON", "too little history: conservative");
  assert.equal(taskBoundaryHeadroom({ ratio: 0.2, recentGrowth: [] }).status, "UNKNOWN");
});

test("I: at the agent's own done, a LOW (47%) thread with typical 30% task growth gets the SOON notice; in-task thresholds are unchanged", async () => {
  const root = await lineageRepo();
  const thread = "01a12581-e924-7dc2-ac0b-46f2945e4460";
  await writeTaskRollout(root, thread, [], Math.round(0.47 * 258400));
  for (const [index, [start, end]] of [[40000, 118000], [36000, 126000], [37000, 101000]].entries()) {
    await recordTaskTelemetry(root, { event: "TASK_PREPARED", sessionId: `sess_${index}`, observedInputTokens: start, contextWindow: 258400 });
    await recordTaskTelemetry(root, { event: "TASK_DONE", sessionId: `sess_${index}`, observedInputTokens: end, contextWindow: 258400 });
  }
  const atBoundary = await threadStateForAgent(root, caller(thread), { taskBoundary: true });
  assert.equal(atBoundary.status, "SOON", atBoundary.reason);
  assert.ok(atBoundary.userNotice);
  assert.match(atBoundary.reason, /Task boundary:/);
  const duringTask = await threadStateForAgent(root, caller(thread));
  assert.equal(duringTask.status, "LOW", "record_validation_result during the task still uses the 50/75 thresholds");
  assert.equal(duringTask.userNotice, undefined);
});

test("K: the dashboard names the real gap — rediscovered execution files vs inputs the user did not name", () => {
  const base = {
    sessionId: "s", label: "t", startedAt: "2026-10-10T00:00:00Z", estTokens: 69000,
    costByCategory: { MCP: 2000, FALLBACK_DOCS: 0, SEARCH: 3000, CODE_READS: 50000, CODE_EDITS: 6000, VALIDATION: 2000, ADMIN: 3000, OTHER: 3000 },
    modeTokens: { IMPLEMENTATION: 6000, EXPLORATION: 53000, VALIDATION: 2000, CONTEXT_ADMIN: 3000, RESUME_RECOVERY: 2000, OTHER: 3000 },
    otherBreakdown: {}, provided: { files: 12 }, usedFiles: 26, providedUsed: 12, nonProvidedUsed: 14,
    searchCalls: 1, broadSearchCalls: 0, searchBeforeProvidedRead: false, fallbackDocReads: 0, repeatedFallbackDocReads: 0,
    validation: { pass: 1, fail: 0, unknown: 0 }, threads: ["a"], compactions: 0, activityEvents: 30, touchedFiles: [],
    unusedSuggestionReads: { files: 3, estTokens: 4900 }, providedDocRereads: { files: 1, estTokens: 2500 }, explicitInputCount: 9
  };
  const execution = contextIssues({ ...base, nonProvidedReads: { files: 14, estTokens: 28100, scriptTokens: 21000 } });
  assert.equal(execution[0].id, "MISSING_EXECUTION_CONTEXT");
  assert.match(execution[0].issue, /Execution files from earlier runs were rediscovered outside the read plan/);
  assert.doesNotMatch(execution[0].action, /explicitInputs/, "explicit inputs already worked; the action must not blame them");
  const inputs = contextIssues({ ...base, nonProvidedReads: { files: 9, estTokens: 20000, scriptTokens: 2000 } });
  assert.equal(inputs[0].id, "MISSING_REQUIRED_INPUTS");
  assert.doesNotMatch(inputs[0].action, /explicitInputs/, "the task already passed explicit inputs");
  const noExplicit = contextIssues({ ...base, explicitInputCount: 0, nonProvidedReads: { files: 9, estTokens: 20000, scriptTokens: 0 } });
  assert.match(noExplicit[0].action, /explicitInputs/);
});

// v0.9.0: Tier C was a fixed 4 files. Live: 11/15 offered lineage files were
// used (73%) but only 11/24 lineage files the agents actually read were
// offered (46%) — heavy tasks re-read 7–8 of the previous run's scripts, and
// a documentation-only step in between dropped the older executor entirely.
import { planExecutionLineage, LINEAGE_PLAN_LIMIT, LINEAGE_PLAN_MAX, LINEAGE_TOKEN_BUDGET } from "../dist/execution-lineage.js";

async function scriptTree(files) {
  const root = await mkdtemp(join(tmpdir(), "devguard-lineage-plan-"));
  cleanup.push(root);
  for (const [path, size] of Object.entries(files)) await put(root, path, "x".repeat(size));
  return root;
}
const planInput = (overrides = {}) => ({ planned: new Set(), anchors: [], taskText: "Run7 rerun of the collector pipeline.", sameWorkstream: true, isExcluded: () => false, ...overrides });

test("C/D: lineage grows past 4 only for strong same-workstream files inside the token budget, never past 8", async () => {
  const small = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`run7/step_${index}.py`, 2000]));
  const root = await scriptTree(small);
  const lineage = { executed: Object.keys(small).slice(0, 4), produced: [], usedScripts: Object.keys(small).slice(4), used: [] };
  const plan = await planExecutionLineage(root, lineage, planInput());
  assert.equal(plan.length, LINEAGE_PLAN_MAX, "twelve small scripts: capped at the hard maximum");
  assert.ok(plan.reduce((sum, file) => sum + file.estimatedTokens, 0) <= LINEAGE_TOKEN_BUDGET);

  // Large scripts: the first 4 are always offered, the budget stops the rest.
  const large = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`run7/big_${index}.py`, 24000]));
  const bigRoot = await scriptTree(large);
  const bigPlan = await planExecutionLineage(bigRoot, { executed: Object.keys(large), produced: [], usedScripts: [], used: [] }, planInput());
  assert.equal(bigPlan.length, LINEAGE_PLAN_LIMIT, "no extra slot when the budget is already spent");

  // Smaller files still fit after a large one was skipped.
  const mixed = { "run7/a.py": 8000, "run7/b.py": 8000, "run7/c.py": 8000, "run7/d.py": 8000, "run7/huge.py": 60000, "run7/tiny.py": 400 };
  const mixedRoot = await scriptTree(mixed);
  const mixedPlan = await planExecutionLineage(mixedRoot, { executed: Object.keys(mixed).slice(0, 4), produced: [], usedScripts: ["run7/huge.py", "run7/tiny.py"], used: [] }, planInput());
  assert.deepEqual(mixedPlan.slice(4).map((file) => file.path), ["run7/tiny.py"]);

  // Anchored only (gate failed): the fixed 4, no adaptive extension.
  const anchored = await planExecutionLineage(root, lineage, planInput({ sameWorkstream: false, anchors: ["run7/notes.md"] }));
  assert.equal(anchored.length, LINEAGE_PLAN_LIMIT);
});

test("E: tests and disposable probes rank below executors and never take an extra slot", async () => {
  const files = {
    "run7/execute.py": 1200, "run7/prepare.py": 1200, "run7/runtime.py": 1200,
    "run7/test_execute.py": 800, "run7/local-route-attempt2/first_read.py": 300, "scratch/probe_latency.py": 300,
    "run7/collect.py": 1200, "run7/summarize.sql": 900
  };
  const root = await scriptTree(files);
  const lineage = { executed: ["run7/execute.py", "run7/test_execute.py", "run7/local-route-attempt2/first_read.py"], produced: ["run7/prepare.py", "run7/runtime.py"], usedScripts: ["scratch/probe_latency.py", "run7/collect.py", "run7/summarize.sql"], used: [] };
  const plan = await planExecutionLineage(root, lineage, planInput({ taskText: "Run7 rerun and 검증 of the collector pipeline." }));
  const paths = plan.map((file) => file.path);
  for (const low of ["run7/test_execute.py", "run7/local-route-attempt2/first_read.py", "scratch/probe_latency.py"]) assert.ok(!paths.includes(low), `${low} demoted: ${paths.join(", ")}`);
  assert.deepEqual(paths.slice(0, 1), ["run7/execute.py"]);
  // A task about tests still gets the test file.
  const testTask = await planExecutionLineage(root, lineage, planInput({ taskText: "Fix the failing pytest for Run7 execute." }));
  assert.ok(testTask.some((file) => file.path === "run7/test_execute.py"));
});

test("F/G: the last execution-bearing task's executor survives one documentation-only task in the same workstream — never across workstreams", async () => {
  const root = await lineageRepo();
  await runTaskA(root);
  // A documentation-only step in the same workstream: no script executed.
  const threadB = "01a12599-0000-7000-8000-00000000000b";
  await prepareTaskContext({ root, task: "Group B Run6G corrective: document the run6g route latency gate result in the corrective report.", caller: caller(threadB) });
  await put(root, "docs/hot-standby-group-b-run6g-corrective-20261010.md", "# Group B Run6G corrective\n\n## Result\n\nSTOP at the route latency gate. Operator review pending.\n");
  await writeTaskRollout(root, threadB, ["cat docs/hot-standby-group-b-run6g-corrective-20261010.md"], 60000);
  await processDoneEvent(root, { completionSource: "cli-done" });
  const docRecord = await lastHistoryRecord(root);
  assert.equal(docRecord.continuesWorkstream, true, "the documentation task recorded its workstream link");
  assert.equal(docRecord.executionLineage?.executed.length ?? 0, 0);

  const next = await prepareTaskContext({ root, task: "Group B Run6G corrective rerun: execute the run6g runtime again against the route latency gate.", persistTask: false });
  const lineage = next.files.filter((file) => file.source === "execution-lineage");
  const runtime = lineage.find((file) => file.path === "infra/standby/run6g/runtime.py");
  assert.ok(runtime, lineage.map((file) => file.path).join(", "));
  assert.match(runtime.reason, /earlier execution step/);

  const unrelated = await prepareTaskContext({ root, task: "Update the billing invoice email template wording.", persistTask: false });
  assert.deepEqual(unrelated.files.filter((file) => file.source === "execution-lineage").map((file) => file.path), []);
});

// v0.9.0: growth samples were "first start of a lineage → its last done", so
// a lineage re-opened with continueCurrentTask (14% → done 58% → continued
// 61% → done 74%) produced a 60% sample instead of 44% and 13%. And `done`
// escalated a 58% thread to NEW_THREAD although the next task (unknown at
// done) was a light one that ended at 74%.
import { recentTaskGrowth } from "../dist/runtime-state.js";

const W = 258400;
async function telemetryRoot(sequence) {
  const root = await mkdtemp(join(tmpdir(), "devguard-growth-"));
  cleanup.push(root);
  await ensureDevguardWorkspace(root);
  for (const [event, sessionId, ratio] of sequence) {
    await recordTaskTelemetry(root, { event, sessionId, ...(ratio === undefined ? {} : { observedInputTokens: Math.round(ratio * W), contextWindow: W }) });
  }
  return root;
}
const rounded = (values) => values.map((value) => Math.round(value * 100));

test("H/I (D): growth is paired per task — a re-opened lineage never measures task B from task A's start", async () => {
  const root = await telemetryRoot([
    ["TASK_PREPARED", "s1", 0.14], ["TASK_DONE", "s1", 0.58],
    ["TASK_CONTINUED", "s1", 0.61], ["TASK_DONE", "s1", 0.74],
    // A resume inside an open task keeps the original start.
    ["TASK_PREPARED", "s2", 0.2], ["TASK_CONTINUED", "s2", 0.3], ["TASK_DONE", "s2", 0.5],
    // A start with no observed reading yields no sample, and is still consumed by its done.
    ["TASK_PREPARED", "s3"], ["TASK_DONE", "s3", 0.4], ["TASK_DONE", "s3", 0.6]
  ]);
  assert.deepEqual(rounded(await recentTaskGrowth(root)), [44, 13, 30]);
});

test("J/K (A–C): boundary — heavy next task warns, light continuation is not over-warned at prepare, 69% + heavy is NEW_THREAD", () => {
  // A: Task A 37% → 47% with heavy history; at done the next task is unknown.
  const heavyHistory = [0.38, 0.44, 0.3];
  const atDone = taskBoundaryHeadroom({ ratio: 0.47, recentGrowth: heavyHistory });
  assert.equal(atDone.status, "SOON");
  assert.match(atDone.reason, /^Headroom risk:/, "done-time verdict is a headroom risk, not a forecast");
  // B: Task A 37% → 41%, light next task: done may show mild risk, prepare continues.
  const lightHistory = [0.04, 0.13, 0.3];
  assert.notEqual(taskBoundaryHeadroom({ ratio: 0.41, recentGrowth: lightHistory, nextTaskText: "Small follow-up: fix the wording in the summary table." }).status, "NEW_THREAD");
  assert.equal(taskBoundaryHeadroom({ ratio: 0.41, recentGrowth: lightHistory, nextTaskText: "Small follow-up: fix the wording in the summary table." }).status, "CONTINUE");
  // C: 69% and a heavy next task.
  assert.equal(taskBoundaryHeadroom({ ratio: 0.69, recentGrowth: heavyHistory, nextTaskText: "Execute the production preflight rerun." }).status, "NEW_THREAD");
});

test("J: at done a 58% thread with large typical growth is SOON (headroom risk), not NEW_THREAD; ≥75% observed is still NEW_THREAD", async () => {
  const root = await lineageRepo();
  for (const [index, [start, end]] of [[0.14, 0.51], [0.14, 0.73], [0.14, 0.71], [0.14, 0.58]].entries()) {
    await recordTaskTelemetry(root, { event: "TASK_PREPARED", sessionId: `g${index}`, observedInputTokens: Math.round(start * W), contextWindow: W });
    await recordTaskTelemetry(root, { event: "TASK_DONE", sessionId: `g${index}`, observedInputTokens: Math.round(end * W), contextWindow: W });
  }
  const mid = "01a12581-e924-7dc2-ac0b-46f2945e4461";
  await writeTaskRollout(root, mid, [], Math.round(0.58 * W));
  const atDone = await threadStateForAgent(root, caller(mid), { taskBoundary: true });
  assert.equal(atDone.status, "SOON", atDone.reason);
  assert.equal(atDone.boundary.status, "NEW_THREAD", "the raw headroom projection is still reported");
  assert.ok(atDone.userNotice);
  const full = "01a12581-e924-7dc2-ac0b-46f2945e4462";
  await writeTaskRollout(root, full, [], Math.round(0.8 * W));
  assert.equal((await threadStateForAgent(root, caller(full), { taskBoundary: true })).status, "NEW_THREAD");
});

import { classifyExecutionGap } from "../dist/context-efficiency.js";

test("L: MISSING_EXECUTION_CONTEXT names the actual lineage gap and never repeats what the user already does", () => {
  const lineage = (executed, usedScripts = []) => ({ executed, produced: [], usedScripts, used: [] });
  const records = [
    { executionLineage: lineage(["run5/execute.py"]) },
    { executionLineage: lineage([], []) , continuesWorkstream: true },
    { followUp: true },
    { executionLineage: lineage(["run6/prepare.py"], ["run6/collect.py", "run6/runtime.py", "run6/report.py", "run6/summary.py", "run6/load.py"]) }
  ];
  assert.equal(classifyExecutionGap(["run6/report.py", "run6/summary.py"], records), "LINEAGE_CAPACITY");
  assert.equal(classifyExecutionGap(["run5/execute.py"], records.slice(0, 2)), "OLDER_EXECUTOR_GAP");
  assert.equal(classifyExecutionGap(["tools/other.py"], records), "UNPLANNED_EXECUTION_CONTEXT");
  assert.equal(classifyExecutionGap([], records), undefined);
  assert.equal(classifyExecutionGap(["run6/report.py"], []), undefined, "no history: no cause claimed");

  const base = {
    sessionId: "s", label: "t", startedAt: "2026-10-10T00:00:00Z", estTokens: 69000,
    costByCategory: { MCP: 2000, FALLBACK_DOCS: 0, SEARCH: 3000, CODE_READS: 50000, CODE_EDITS: 6000, VALIDATION: 2000, ADMIN: 3000, OTHER: 3000 },
    modeTokens: { IMPLEMENTATION: 6000, EXPLORATION: 53000, VALIDATION: 2000, CONTEXT_ADMIN: 3000, RESUME_RECOVERY: 2000, OTHER: 3000 },
    otherBreakdown: {}, provided: { files: 12 }, usedFiles: 26, providedUsed: 12, nonProvidedUsed: 14,
    searchCalls: 1, broadSearchCalls: 0, searchBeforeProvidedRead: false, fallbackDocReads: 0, repeatedFallbackDocReads: 0,
    validation: { pass: 1, fail: 0, unknown: 0 }, threads: ["a"], compactions: 0, activityEvents: 30, touchedFiles: [],
    unusedSuggestionReads: { files: 0, estTokens: 0 }, providedDocRereads: { files: 0, estTokens: 0 }, explicitInputCount: 9,
    nonProvidedReads: { files: 14, estTokens: 28100, scriptTokens: 21000 }
  };
  const capacity = contextIssues({ ...base, executionGapCause: "LINEAGE_CAPACITY" })[0];
  assert.equal(capacity.id, "MISSING_EXECUTION_CONTEXT");
  assert.equal(capacity.cause, "LINEAGE_CAPACITY");
  assert.match(capacity.why, /Previous execution files exceeded the current lineage plan budget/);
  const older = contextIssues({ ...base, executionGapCause: "OLDER_EXECUTOR_GAP" })[0];
  assert.match(older.why, /An older same-workstream executor was rediscovered outside the read plan/);
  for (const issue of [capacity, older, contextIssues(base)[0]]) {
    assert.doesNotMatch(issue.action, /dev-guard done|keep one workstream|consecutive/i, "the user already finishes with done and keeps the workstream together");
  }
});

test("M: history and runtime written before v0.9.0 (no workstream link) still plan — conservatively, with no older executor", async () => {
  const root = await lineageRepo();
  await runTaskA(root);
  const threadB = "01a12599-0000-7000-8000-00000000000c";
  await prepareTaskContext({ root, task: "Group B Run6G corrective: document the run6g route latency gate result in the corrective report.", caller: caller(threadB) });
  await put(root, "docs/hot-standby-group-b-run6g-corrective-20261010.md", "# Group B Run6G corrective\n\nOperator review pending.\n");
  await writeTaskRollout(root, threadB, ["cat docs/hot-standby-group-b-run6g-corrective-20261010.md"], 60000);
  await processDoneEvent(root, { completionSource: "cli-done" });
  const historyFile = join(root, devguardPaths.history);
  const legacy = (await readFile(historyFile, "utf8")).trim().split("\n").map((line) => {
    const record = JSON.parse(line);
    delete record.continuesWorkstream;
    return JSON.stringify(record);
  });
  await writeFile(historyFile, `${legacy.join("\n")}\n`);
  const next = await prepareTaskContext({ root, task: "Group B Run6G corrective rerun: execute the run6g runtime again against the route latency gate.", persistTask: false });
  assert.ok(next.files.length > 0);
  assert.ok(!next.files.some((file) => /earlier execution step/.test(file.reason ?? "")), "no workstream link recorded: no look-back");
});
