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
