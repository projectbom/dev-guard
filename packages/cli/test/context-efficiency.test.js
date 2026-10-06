// Context Efficiency Dashboard: agent activity observability.
// Synthetic fixtures only (no provider calls, no real ~/.codex reads).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { classifyCommand, codexItemToEvent, CodexLocalActivitySource, hashThreadId } from "../dist/agent-activity.js";
import { buildContextEfficiencyReport } from "../dist/context-efficiency.js";
import { startDashboardServer } from "../dist/dashboard.js";
import { ensureDevguardWorkspace, prepareTaskContext } from "../dist/runtime-state.js";
import { readTaskTelemetry } from "../dist/task-telemetry.js";

const execFileAsync = promisify(execFile);
const cleanup = [];
after(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

const ROOT = "/work/app";

test("command classification is deterministic and category-only", () => {
  const c = (cmd, parsed = [], cwd = ROOT) => classifyCommand(cmd, parsed, cwd, ROOT);
  assert.equal(c("sed -n '1,80p' .devguard/reports/project-handoff.md").category, "FALLBACK_DOCS");
  assert.equal(c("cat .devguard/reports/quality-report.md .devguard/prompts/next-codex-prompt.md").paths.length, 2);
  const broad = c("rg -n 'STANDBY' .");
  assert.deepEqual([broad.category, broad.broadSearch], ["SEARCH", true]);
  assert.equal(c("rg -n 'STANDBY'").broadSearch, true, "no path from the repo root is repository-wide");
  assert.equal(c("rg -n 'STANDBY' packages/config/src").broadSearch, false);
  assert.equal(c("pwd && rg --files").broadSearch, true, "a leading no-op does not hide the search");
  const read = c("sed -n '10,40p' src/env.ts", [{ type: "read", cmd: "sed -n '10,40p' src/env.ts", path: "src/env.ts" }]);
  assert.deepEqual([read.category, read.paths], ["CODE_READS", ["src/env.ts"]]);
  assert.equal(c("cat /etc/hosts").paths.length, 0, "paths outside the repository are dropped");
  assert.equal(c("pnpm --filter api test").category, "VALIDATION");
  assert.equal(c("node --test packages/cli/test/x.test.js").category, "VALIDATION");
  assert.equal(c("dev-guard status").category, "ADMIN");
  assert.equal(c("dev-guard self-check").category, "VALIDATION");
  const other = c("python3 - <<'PY'\nimport json\nprint(1)\nPY");
  assert.deepEqual([other.category, other.otherLabel], ["OTHER", "inline script"]);
});

test("Codex items become metadata-only events (no command text, output or arguments retained)", () => {
  const secretOutput = "SECRET_OUTPUT_LINE ".repeat(40);
  const command = codexItemToEvent(
    { type: "CommandExecution", command: ["/bin/zsh", "-lc", "sed -n '1,40p' src/a.ts"], cwd: `file://${ROOT}`, parsed_cmd: [{ type: "read", cmd: "sed -n '1,40p' src/a.ts", path: "src/a.ts" }], aggregated_output: secretOutput, duration: { secs: 0, nanos: 5_000_000 } },
    "2026-01-01T00:00:01Z",
    "t1",
    ROOT
  );
  assert.equal(command.category, "CODE_READS");
  assert.deepEqual(command.paths, ["src/a.ts"]);
  assert.ok(command.estTokens > 100);
  assert.equal(command.durationMs, 5);
  const serialized = JSON.stringify(command);
  assert.ok(!serialized.includes("SECRET_OUTPUT_LINE") && !serialized.includes("sed -n"), "no raw command/output stored");

  const mcp = codexItemToEvent(
    { type: "McpToolCall", server: "dev-guard", tool: "prepare_task_context", arguments: { task: "SECRET TASK TEXT" }, result: { content: [{ type: "text", text: JSON.stringify({ files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] }) }] } },
    "2026-01-01T00:00:00Z",
    "t1",
    ROOT
  );
  assert.deepEqual([mcp.category, mcp.mode, mcp.providedPaths], ["MCP", "RESUME_RECOVERY", ["src/a.ts", "src/b.ts"]]);
  assert.ok(!JSON.stringify(mcp).includes("SECRET TASK TEXT"));
  const edit = codexItemToEvent({ type: "FileChange", changes: { [`${ROOT}/src/a.ts`]: { type: "update", unified_diff: "+x" } } }, "2026-01-01T00:00:02Z", "t1", ROOT);
  assert.deepEqual([edit.category, edit.mode, edit.paths], ["CODE_EDITS", "IMPLEMENTATION", ["src/a.ts"]]);
  assert.equal(codexItemToEvent({ type: "ContextCompaction", id: "x" }, "2026-01-01T00:00:03Z", "t1", ROOT).kind, "compaction");
  assert.equal(codexItemToEvent({ type: "Reasoning", summary_text: ["hidden"] }, "2026-01-01T00:00:03Z", "t1", ROOT), undefined, "reasoning is never recorded");
});

// --- synthetic Codex sessions directory ---------------------------------

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload }) + "\n";
}
function meta(id, cwd, ts, source = "user") {
  return line(ts, "session_meta", { id, session_id: id, cwd, timestamp: ts, thread_source: source, ...(source === "user" ? {} : { parent_thread_id: "p" }) });
}
function item(ts, payload) {
  return line(ts, "event_msg", { type: "item_completed", item: payload });
}
const exec = (cmd, out = "x".repeat(400), parsed = []) => ({ type: "CommandExecution", command: ["/bin/zsh", "-lc", cmd], cwd: `file://${ROOT}`, parsed_cmd: parsed, aggregated_output: out });
const prepare = (paths) => ({ type: "McpToolCall", server: "dev-guard", tool: "prepare_task_context", arguments: {}, result: { content: [{ type: "text", text: JSON.stringify({ files: paths.map((path) => ({ path })) }) }] } });
const read = (path) => exec(`sed -n '1,80p' ${path}`, "y".repeat(800), [{ type: "read", cmd: `sed -n '1,80p' ${path}`, path }]);
const edit = (path) => ({ type: "FileChange", changes: { [`${ROOT}/${path}`]: { type: "update", unified_diff: "+line\n".repeat(20) } } });

async function sessionsDir() {
  const dir = await tempDir("devguard-codex-sessions-");
  await mkdir(join(dir, "2026", "01", "01"), { recursive: true });
  return dir;
}

test("Codex source: project filter, user vs subagent threads, incremental parsing", async () => {
  const dir = await sessionsDir();
  const day = join(dir, "2026", "01", "01");
  const mine = join(day, "rollout-2026-01-01T00-00-00-aaa.jsonl");
  await writeFile(mine, meta("thread-a", ROOT, "2026-01-01T00:00:00Z") + item("2026-01-01T00:00:01Z", read("src/a.ts")));
  await writeFile(join(day, "rollout-2026-01-01T00-00-00-bbb.jsonl"), meta("thread-b", "/other/project", "2026-01-01T00:00:00Z") + item("2026-01-01T00:00:01Z", read("src/z.ts")));
  await writeFile(join(day, "rollout-2026-01-01T00-00-00-ccc.jsonl"), meta("thread-c", ROOT, "2026-01-01T00:00:00Z", "guardian_review") + item("2026-01-01T00:00:02Z", exec("ls")));
  const source = new CodexLocalActivitySource(dir);
  const since = Date.parse("2026-01-01T00:00:00Z");
  const first = await source.collect(ROOT, since);
  assert.equal(first.available, true);
  assert.deepEqual(first.threads.map((t) => t.source).sort(), ["subagent", "user"]);
  assert.equal(first.threads.find((t) => t.source === "user").thread, hashThreadId("thread-a"), "thread ids are hashed");
  assert.equal(first.events.filter((e) => e.thread === hashThreadId("thread-a")).length, 1);
  await appendFile(mine, item("2026-01-01T00:00:05Z", exec("pnpm test")) + item("2026-01-01T00:00:06Z", { type: "ContextCompaction", id: "c1" }));
  const second = await source.collect(ROOT, since);
  assert.deepEqual(second.events.filter((e) => e.thread === hashThreadId("thread-a")).map((e) => e.kind), ["command", "command", "compaction"]);
  const missing = await new CodexLocalActivitySource(join(dir, "nope")).collect(ROOT, since);
  assert.equal(missing.available, false);
});

// --- scenarios ------------------------------------------------------------

function staticSource(threads, events) {
  return { provider: "codex", collect: async () => ({ provider: "codex", available: true, threads, events }) };
}
async function eventsFrom(rows) {
  const dir = await sessionsDir();
  for (const [file, content] of Object.entries(rows)) await writeFile(join(dir, "2026", "01", "01", file), content);
  return new CodexLocalActivitySource(dir).collect(ROOT, Date.parse("2026-01-01T00:00:00Z"));
}
function telemetry(...entries) {
  return entries.map(([timestamp, event, extra = {}]) => ({ timestamp, event, ...extra }));
}
async function report(snapshot, events, root) {
  return buildContextEfficiencyReport(root ?? (await tempDir("devguard-eff-root-")), {
    now: Date.parse("2026-01-01T06:00:00Z"),
    telemetry: events,
    sources: [staticSource(snapshot.threads, snapshot.events)]
  });
}

test("Scenario A (healthy): provided ranges used, targeted work, done, then a fresh thread", async () => {
  const snapshot = await eventsFrom({
    "rollout-a.jsonl":
      meta("thread-1", ROOT, "2026-01-01T00:59:00Z") +
      item("2026-01-01T01:00:01Z", prepare(["src/a.ts", "src/b.ts"])) +
      item("2026-01-01T01:00:02Z", read("src/a.ts")) +
      item("2026-01-01T01:00:03Z", exec("rg -n 'fn' src/b.ts")) +
      item("2026-01-01T01:00:04Z", edit("src/a.ts")) +
      item("2026-01-01T01:00:05Z", exec("pnpm test", "ok\n".repeat(50)))
  });
  const r = await report(snapshot, telemetry(
    ["2026-01-01T01:00:00Z", "TASK_PREPARED", { sessionId: "s1", providedFiles: ["src/a.ts", "src/b.ts"], providedRangeCount: 3, mcpPayloadTokens: 900, rolloverStatus: "SAFE" }],
    ["2026-01-01T01:00:06Z", "VALIDATION_RECORDED", { sessionId: "s1", validationKind: "TEST", validationStatus: "PASS" }],
    ["2026-01-01T01:00:07Z", "TASK_DONE", { sessionId: "s1", completionSource: "hook-codex-stop" }]
  ));
  const task = r.current;
  assert.deepEqual(task.candidateUtilization, { used: 1, of: 1 });
  assert.equal(task.broadSearchCalls, 0);
  assert.equal(task.searchBeforeProvidedRead, false);
  assert.ok(task.modeTokens.IMPLEMENTATION > task.modeTokens.EXPLORATION, "reading the file it edits is implementation");
  assert.deepEqual(r.recommendations.map((rec) => rec.id), ["C"], "only the fresh-thread advice after completion");
  assert.equal(r.summary.rollover.state, "NEW_THREAD_RECOMMENDED");
  assert.equal(r.threadIdentity, "observed");
});

test("Scenario B (search-heavy): broad searches dominate and DevGuard candidates are ignored", async () => {
  let rows = meta("thread-1", ROOT, "2026-01-01T00:59:00Z") + item("2026-01-01T01:00:01Z", prepare(["src/a.ts"]));
  for (let i = 0; i < 6; i += 1) rows += item(`2026-01-01T01:00:1${i}Z`, exec(`rg -n 'term${i}' .`, "z".repeat(4000)));
  for (const path of ["lib/x.ts", "lib/y.ts", "lib/z.ts"]) rows += item("2026-01-01T01:00:20Z", read(path));
  const r = await report(await eventsFrom({ "rollout-b.jsonl": rows }), telemetry(["2026-01-01T01:00:00Z", "TASK_PREPARED", { sessionId: "s1", providedFiles: ["src/a.ts"], rolloverStatus: "SAFE" }]));
  assert.equal(r.summary.largestCost.category, "SEARCH");
  assert.equal(r.summary.workMode.mode, "EXPLORATION");
  assert.equal(r.current.broadSearchCalls, 6);
  assert.equal(r.current.searchBeforeProvidedRead, true);
  assert.deepEqual(r.current.candidateUtilization, { used: 0, of: 3 });
  const ids = r.recommendations.map((rec) => rec.id);
  assert.ok(ids.includes("B") && ids.includes("D"), `expected B and D, got ${ids}`);
  assert.ok(r.recommendations.length <= 3);
});

test("Scenario C (context-admin-heavy): repeated fallback markdown reads after MCP are caught", async () => {
  let rows = meta("thread-1", ROOT, "2026-01-01T00:59:00Z") + item("2026-01-01T01:00:01Z", prepare(["src/a.ts"]));
  for (let i = 0; i < 3; i += 1) {
    rows += item(`2026-01-01T01:00:2${i}Z`, exec("cat .devguard/reports/project-handoff.md .devguard/reports/quality-report.md", "h".repeat(6000)));
    rows += item(`2026-01-01T01:00:3${i}Z`, exec("sed -n '1,80p' .devguard/prompts/next-codex-prompt.md", "p".repeat(1500)));
  }
  rows += item("2026-01-01T01:00:40Z", read("src/a.ts"));
  const r = await report(await eventsFrom({ "rollout-c.jsonl": rows }), telemetry(["2026-01-01T01:00:00Z", "TASK_PREPARED", { sessionId: "s1", providedFiles: ["src/a.ts"] }]));
  assert.equal(r.summary.largestCost.category, "FALLBACK_DOCS");
  assert.equal(r.current.fallbackDocReads, 9);
  assert.equal(r.current.repeatedFallbackDocReads, 6);
  assert.equal(r.recommendations[0].id, "A");
  assert.match(r.recommendations[0].reason, /Fallback docs used \d+% .*9 reads, 6 repeated/);
});

test("Scenario D (long multi-task thread): a second task in the same thread is flagged from observed thread identity", async () => {
  const rows =
    meta("thread-1", ROOT, "2026-01-01T00:59:00Z") +
    item("2026-01-01T01:00:01Z", prepare(["src/a.ts"])) +
    item("2026-01-01T01:00:02Z", read("src/a.ts")) +
    item("2026-01-01T01:30:00Z", { type: "ContextCompaction", id: "c1" }) +
    item("2026-01-01T02:00:01Z", prepare(["src/b.ts"])) +
    item("2026-01-01T02:00:02Z", read("src/b.ts"));
  const r = await report(await eventsFrom({ "rollout-d.jsonl": rows }), telemetry(
    ["2026-01-01T01:00:00Z", "TASK_PREPARED", { sessionId: "s1", providedFiles: ["src/a.ts"] }],
    ["2026-01-01T01:50:00Z", "TASK_DONE", { sessionId: "s1" }],
    ["2026-01-01T02:00:00Z", "TASK_PREPARED", { sessionId: "s2", providedFiles: ["src/b.ts"] }]
  ), await (async () => {
    const root = await tempDir("devguard-eff-d-");
    await mkdir(join(root, ".devguard"), { recursive: true });
    await writeFile(join(root, ".devguard", "runtime.json"), JSON.stringify({ sessionId: "s2", currentTask: { text: "Second task" } }));
    return root;
  })());
  assert.equal(r.recent.length, 2);
  assert.equal(r.recent[0].compactions, 1);
  assert.equal(r.current.sameThreadAsPrevious, true);
  assert.equal(r.current.label, "Second task");
  assert.equal(r.summary.rollover.state, "NEW_THREAD_RECOMMENDED");
  assert.equal(r.summary.rollover.evidence, "OBSERVED");
  assert.ok(r.timeline.events.some((event) => event.type === "COMPACTION" && event.evidence === "OBSERVED"));
  assert.ok(r.timeline.cumulative.length > 0);
});

test("no activity source: thread identity is reported as unavailable, nothing is invented", async () => {
  const r = await buildContextEfficiencyReport(await tempDir("devguard-eff-empty-"), {
    telemetry: telemetry(["2026-01-01T01:00:00Z", "TASK_PREPARED", { sessionId: "s1", providedFiles: ["src/a.ts"] }]),
    sources: [{ provider: "codex", collect: async () => ({ provider: "codex", available: false, note: "none", threads: [], events: [] }) }]
  });
  assert.equal(r.threadIdentity, "unavailable");
  assert.equal(r.current.estTokens, 0);
  assert.equal(r.current.sameThreadAsPrevious, undefined);
  assert.equal(r.summary.candidateUsage.used, 0);
  assert.notEqual(r.summary.rollover.state, "NEW_THREAD_RECOMMENDED");
});

test("prepare records provided paths and the canonical task card; /api/efficiency serves the report", async () => {
  const root = await tempDir("devguard-eff-prepare-");
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: root });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "billing.ts"), "export function computeInvoiceTotal(items: number[]) { return items.reduce((a, b) => a + b, 0); }\n");
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Fix computeInvoiceTotal rounding in src/billing.ts" });
  const prepared = (await readTaskTelemetry(root)).find((event) => event.event === "TASK_PREPARED");
  assert.ok(prepared.providedFiles.includes("src/billing.ts"));
  assert.ok(prepared.mcpPayloadTokens > 0);
  assert.ok(!JSON.stringify(prepared).includes("rounding"), "telemetry never stores task text");
  const card = JSON.parse(await readFile(join(root, ".devguard", "context", "task-context.json"), "utf8"));
  assert.match(card.task, /computeInvoiceTotal/);

  process.env.CODEX_HOME = await tempDir("devguard-eff-codexhome-");
  const port = 48000 + Math.floor(Math.random() * 1500);
  const server = await startDashboardServer(root, { port });
  try {
    const response = await fetch(`${server.url}/api/efficiency`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.taskCard.goal, card.task);
    assert.ok(body.taskCard.edit.includes("src/billing.ts"));
    assert.equal(body.threadIdentity, "unavailable");
    const page = await (await fetch(server.url)).text();
    assert.match(page, /id="efficiency"/);
    assert.equal((await fetch(`${server.url}/api/state`)).status, 200);
  } finally {
    await server.close();
  }
});
