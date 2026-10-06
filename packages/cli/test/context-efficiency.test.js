// Context Efficiency: measurement correctness, problem-first view,
// workstream-aware rollover. Synthetic fixtures only (no real ~/.codex reads).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { classifyCommand, codexItemToEvent, codexContextUsage, CodexLocalActivitySource, hashThreadId } from "../dist/agent-activity.js";
import { buildContextEfficiencyReport, rolloverStateFor, workstreamRelation } from "../dist/context-efficiency.js";
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

async function put(root, path, content = "x\n") {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

// A real directory so read paths can be verified on disk.
async function repoRoot() {
  const root = await tempDir("devguard-eff-repo-");
  for (const path of ["src/a.ts", "src/b.ts", "lib/x.ts", "lib/y.ts", "lib/z.ts", "packages/db/src/client.ts", "packages/config/src/env.ts", "packages/config/src/index.ts", "infra/plan.json"]) await put(root, path);
  return root;
}

test("measurement fixtures: targeted vs broad vs external search, multi-file reads, scripts, git status", async () => {
  const root = await repoRoot();
  const c = (cmd, parsed = [], cwd = root) => classifyCommand(cmd, parsed, cwd, root);
  // A. targeted
  assert.deepEqual(c("rg -n 'pool' packages/db").searchScopes, ["targeted"]);
  assert.equal(c("rg -n 'pool' packages/db").broadSearch, false);
  // B. broad (no path from the repository root, or the root itself)
  assert.equal(c("rg -n 'pool'").broadSearch, true);
  assert.equal(c(`rg -n 'pool' ${root}`).broadSearch, true);
  assert.equal(c("find . -name '*.ts'").broadSearch, true);
  assert.equal(c("rg -n 'pool'", [], join(root, "packages")).broadSearch, false, "search from a subdirectory is targeted");
  // The truncated display string must not decide scope (it lost the paths).
  const truncated = c("rg -n 'max:|DB_POOL|pool|standby' packages/db/src/client.ts packages/config/src/index.ts", [{ type: "search", cmd: "rg -n 'max:|DB_POOL|pool|standby' packages/db/src/cli", path: "client.ts" }]);
  assert.deepEqual([truncated.category, truncated.broadSearch], ["SEARCH", false]);
  // Unknown scope is never promoted to broad.
  assert.deepEqual(c('rg -n "$PATTERN" "$DIR"').searchScopes, ["unknown"]);
  assert.equal(c('rg -n "$PATTERN" "$DIR"').broadSearch, false);
  // C. multi-file cat
  assert.deepEqual(c("cat src/a.ts src/b.ts lib/x.ts").paths.sort(), ["lib/x.ts", "src/a.ts", "src/b.ts"]);
  assert.deepEqual(c("sed -n '1,40p' src/a.ts; sed -n '1,20p' lib/y.ts").paths.sort(), ["lib/y.ts", "src/a.ts"]);
  assert.deepEqual(c("for f in src/a.ts lib/z.ts; do sed -n '1,20p' \"$f\"; done").paths.sort(), ["lib/z.ts", "src/a.ts"]);
  // D. inline python reading repository files (only paths that exist count)
  const script = c("python3 - <<'PY'\nfrom pathlib import Path\nfor p in ['packages/db/src/client.ts', 'infra/plan.json', 'missing/file.ts']:\n    print(Path(p).read_text()[:200])\nPY");
  assert.deepEqual([script.category, script.paths.sort()], ["CODE_READS", ["infra/plan.json", "packages/db/src/client.ts"]]);
  assert.equal(c("python3 - <<'PY'\nprint(1+1)\nPY").category, "OTHER", "an unprovable script stays OTHER");
  // E. git status is not a read of a file named "status"
  const status = c("git status --short");
  assert.deepEqual([status.category, status.paths], ["CODE_READS", []]);
  // F. agent memory outside the repository is not a repository search
  const memory = c(`rg -n 'Hot Standby' ${join(root, "..", ".codex", "memories")}`);
  assert.deepEqual([memory.category, memory.searchScopes], ["OTHER", ["external"]]);
  // G. DevGuard markdown and pipeline filters
  assert.equal(c("cat .devguard/reports/project-handoff.md").category, "FALLBACK_DOCS");
  const piped = c("cat src/a.ts | grep -n pool | head -5");
  assert.deepEqual([piped.category, piped.paths, piped.searchScopes], ["CODE_READS", ["src/a.ts"], []]);
  assert.equal(c("pnpm --filter api test").category, "VALIDATION");
  assert.equal(c("dev-guard status").category, "ADMIN");
});

test("Codex items are metadata-only; observed context usage is kept as reported", async () => {
  const root = await repoRoot();
  const secret = "SECRET_OUTPUT_LINE ".repeat(40);
  const event = codexItemToEvent({ type: "CommandExecution", command: ["/bin/zsh", "-lc", "cat src/a.ts src/b.ts"], cwd: `file://${root}`, parsed_cmd: [], aggregated_output: secret }, "2026-01-01T00:00:01Z", "t1", root);
  assert.deepEqual([event.category, event.paths.sort()], ["CODE_READS", ["src/a.ts", "src/b.ts"]]);
  assert.ok(!JSON.stringify(event).includes("SECRET_OUTPUT_LINE") && !JSON.stringify(event).includes("cat src"));
  const usage = codexContextUsage({ type: "token_count", info: { last_token_usage: { input_tokens: 120000 }, model_context_window: 240000 } }, "2026-01-01T00:00:02Z", "t1");
  assert.deepEqual([usage.kind, usage.inputTokens, usage.contextWindow, usage.estTokens], ["context_usage", 120000, 240000, 0]);
  assert.equal(codexContextUsage({ type: "token_count", info: null }, "x", "t1"), undefined);
  assert.equal(codexItemToEvent({ type: "Reasoning", summary_text: ["hidden"] }, "x", "t1", root), undefined);
});

// --- synthetic Codex sessions ------------------------------------------------

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload }) + "\n";
}
function meta(id, cwd, ts, source = "user") {
  return line(ts, "session_meta", { id, session_id: id, cwd, timestamp: ts, thread_source: source, ...(source === "user" ? {} : { parent_thread_id: "p" }) });
}
const item = (ts, payload) => line(ts, "event_msg", { type: "item_completed", item: payload });
const usageLine = (ts, input, window = 200000) => line(ts, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: input }, model_context_window: window } });
const exec = (root, cmd, out = "x".repeat(400)) => ({ type: "CommandExecution", command: ["/bin/zsh", "-lc", cmd], cwd: `file://${root}`, parsed_cmd: [], aggregated_output: out });
const prepare = (paths) => ({ type: "McpToolCall", server: "dev-guard", tool: "prepare_task_context", arguments: {}, result: { content: [{ type: "text", text: JSON.stringify({ files: paths.map((path) => ({ path })) }) }] } });
const edit = (root, path) => ({ type: "FileChange", changes: { [`${root}/${path}`]: { type: "update", unified_diff: "+line\n".repeat(20) } } });

async function snapshotFrom(root, files) {
  const dir = await tempDir("devguard-codex-sessions-");
  await mkdir(join(dir, "2026", "01", "01"), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, "2026", "01", "01", `rollout-${name}`), content);
  return new CodexLocalActivitySource(dir).collect(root, Date.parse("2026-01-01T00:00:00Z"));
}
const staticSource = (snapshot) => ({ provider: "codex", collect: async () => snapshot });
const telemetry = (...entries) => entries.map(([timestamp, event, extra = {}]) => ({ timestamp, event, ...extra }));
async function report(root, snapshot, events) {
  return buildContextEfficiencyReport(root, { now: Date.parse("2026-01-01T06:00:00Z"), telemetry: events, sources: [staticSource(snapshot)] });
}

test("Codex source: project filter, user vs subagent, incremental parsing, context usage", async () => {
  const root = await repoRoot();
  const dir = await tempDir("devguard-codex-sessions-");
  const day = join(dir, "2026", "01", "01");
  await mkdir(day, { recursive: true });
  const mine = join(day, "rollout-a.jsonl");
  await writeFile(mine, meta("thread-a", root, "2026-01-01T00:00:00Z") + item("2026-01-01T00:00:01Z", exec(root, "cat src/a.ts")) + usageLine("2026-01-01T00:00:02Z", 50000));
  await writeFile(join(day, "rollout-b.jsonl"), meta("thread-b", "/other/project", "2026-01-01T00:00:00Z") + item("2026-01-01T00:00:01Z", exec(root, "cat src/a.ts")));
  await writeFile(join(day, "rollout-c.jsonl"), meta("thread-c", root, "2026-01-01T00:00:00Z", "guardian_review"));
  const source = new CodexLocalActivitySource(dir);
  const first = await source.collect(root, Date.parse("2026-01-01T00:00:00Z"));
  assert.deepEqual(first.threads.map((t) => t.source).sort(), ["subagent", "user"]);
  const mineHash = hashThreadId("thread-a");
  assert.deepEqual(first.events.filter((e) => e.thread === mineHash).map((e) => e.kind), ["command", "context_usage"]);
  await appendFile(mine, usageLine("2026-01-01T00:00:03Z", 50200) + usageLine("2026-01-01T00:00:04Z", 90000) + item("2026-01-01T00:00:05Z", { type: "ContextCompaction", id: "c" }));
  const second = await source.collect(root, Date.parse("2026-01-01T00:00:00Z"));
  assert.deepEqual(second.events.filter((e) => e.thread === mineHash).map((e) => e.kind), ["command", "context_usage", "context_usage", "compaction"], "a <2% usage change is not stored again");
});

test("problem-first view: healthy, search-heavy and doc-rereading tasks each get one issue and one action", async () => {
  const root = await repoRoot();
  const prep = ["2026-01-01T01:00:00Z", "TASK_PREPARED", { sessionId: "s1", providedFiles: ["src/a.ts", "src/b.ts"], rolloverStatus: "SAFE" }];
  // Healthy
  let r = await report(root, await snapshotFrom(root, {
    "h.jsonl": meta("t", root, "2026-01-01T00:59:00Z") + item("2026-01-01T01:00:01Z", prepare(["src/a.ts", "src/b.ts"])) + item("2026-01-01T01:00:02Z", exec(root, "sed -n '1,80p' src/a.ts", "y".repeat(800))) + item("2026-01-01T01:00:03Z", exec(root, "rg -n fn lib")) + item("2026-01-01T01:00:04Z", edit(root, "src/a.ts")) + item("2026-01-01T01:00:05Z", exec(root, "pnpm test", "ok\n".repeat(40))) + usageLine("2026-01-01T01:00:06Z", 40000)
  }), telemetry(prep, ["2026-01-01T01:00:07Z", "TASK_DONE", { sessionId: "s1" }]));
  assert.equal(r.now.health, "GOOD");
  assert.equal(r.now.message, "No significant context inefficiency detected.");
  assert.equal(r.currentTask.repositorySearches.broad, 0);
  assert.deepEqual(r.currentTask.suggestionsUsed, { used: 1, of: 1 });
  assert.equal(r.now.thread.state, "CONTINUE", "a finished light task alone does not demand a new thread");
  // Search-heavy
  let rows = meta("t", root, "2026-01-01T00:59:00Z") + item("2026-01-01T01:00:01Z", prepare(["src/a.ts"]));
  for (let i = 0; i < 5; i += 1) rows += item(`2026-01-01T01:00:1${i}Z`, exec(root, `rg -n 'term${i}'`, "z".repeat(4000)));
  rows += item("2026-01-01T01:00:20Z", exec(root, "cat lib/x.ts lib/y.ts lib/z.ts", "q".repeat(3000)));
  r = await report(root, await snapshotFrom(root, { "s.jsonl": rows }), telemetry(prep));
  assert.equal(r.now.primaryIssue.id, "BROAD_SEARCH");
  assert.equal(r.now.action, "Open DevGuard target ranges before searching the repository.");
  assert.notEqual(r.now.health, "GOOD");
  assert.ok(r.now.otherIssues.length <= 2);
  // Doc re-reads
  rows = meta("t", root, "2026-01-01T00:59:00Z") + item("2026-01-01T01:00:01Z", prepare(["src/a.ts"]));
  for (let i = 0; i < 3; i += 1) rows += item(`2026-01-01T01:00:2${i}Z`, exec(root, "cat .devguard/reports/project-handoff.md .devguard/reports/quality-report.md", "h".repeat(6000)));
  r = await report(root, await snapshotFrom(root, { "c.jsonl": rows }), telemetry(prep));
  assert.equal(r.now.primaryIssue.id, "DOC_REREADS");
  assert.ok(r.currentTask.contextOverheadPct >= 50);
});

test("rollover: CONTINUE / SOON / NEW THREAD from pressure, thread reuse and workstream relation", () => {
  const task = (over = {}) => ({ threads: ["t1"], compactions: 0, sameThreadAsPrevious: false, rolloverStatusAtPrepare: "SAFE", ...over });
  const counts = new Map([["t1", 1]]);
  // Case A: same workstream, light, same thread -> CONTINUE
  const same = workstreamRelation({ goal: "Hot standby DB connection budget audit for runtime admission", files: ["a", "b"] }, { goal: "Hot standby DB connection budget remediation for runtime admission capacity", files: ["a", "c"] });
  assert.equal(same.relation, "SAME");
  assert.equal(rolloverStateFor(task({ sameThreadAsPrevious: true, peakContextUse: 0.3 }), new Map([["t1", 2]]), true, same).state, "CONTINUE");
  // Case B: same workstream but heavy -> SOON while active, NEW THREAD after done
  assert.equal(rolloverStateFor(task({ peakContextUse: 0.81 }), counts, true, same).state, "NEW_THREAD_SOON");
  assert.equal(rolloverStateFor(task({ peakContextUse: 0.81, doneAt: "x" }), counts, false, same).state, "NEW_THREAD_RECOMMENDED");
  assert.equal(rolloverStateFor(task({ compactions: 1 }), counts, true, same).state, "NEW_THREAD_RECOMMENDED");
  // Case C: different workstream in the same thread -> NEW THREAD
  const different = workstreamRelation({ goal: "Hot standby DB connection budget audit", files: ["infra/a"] }, { goal: "Admin template editor toolbar button styling polish", files: ["apps/admin/x.tsx"] });
  assert.equal(different.relation, "DIFFERENT");
  assert.equal(rolloverStateFor(task({ sameThreadAsPrevious: true }), new Map([["t1", 2]]), true, different).state, "NEW_THREAD_RECOMMENDED");
  // Case D: unknown relation -> SOON (never assumed different)
  const unknown = workstreamRelation({ goal: "", files: [] }, { goal: "Fix it", files: [] });
  assert.equal(unknown.relation, "UNKNOWN");
  assert.equal(rolloverStateFor(task({ sameThreadAsPrevious: true }), new Map([["t1", 2]]), true, unknown).state, "NEW_THREAD_SOON");
  // A finished light task is CONTINUE (conditional on the next task's workstream), never NEW THREAD by itself.
  const done = rolloverStateFor(task({ doneAt: "x", peakContextUse: 0.2 }), counts, false);
  assert.equal(done.state, "CONTINUE");
  assert.match(done.reason, /same workstream/);
  // Moderate pressure after done -> SOON
  assert.equal(rolloverStateFor(task({ doneAt: "x", peakContextUse: 0.5 }), counts, false).state, "NEW_THREAD_SOON");
});

test("5-second contract: health, task, issue, action and thread render first; everything else is collapsed", async () => {
  const root = await repoRoot();
  const r = await report(root, await snapshotFrom(root, {
    "x.jsonl": meta("t", root, "2026-01-01T00:59:00Z") + item("2026-01-01T01:00:01Z", prepare(["src/a.ts"])) + item("2026-01-01T01:00:02Z", exec(root, "rg -n x")) + item("2026-01-01T01:00:03Z", exec(root, "rg -n y")) + item("2026-01-01T01:00:04Z", exec(root, "rg -n z")) + usageLine("2026-01-01T01:00:05Z", 150000)
  }), telemetry(["2026-01-01T01:00:00Z", "TASK_PREPARED", { sessionId: "s1", providedFiles: ["src/a.ts"] }]));
  const html = await renderPanel(r);
  const order = ["eff-health", "eff-task", "eff-issue", "eff-action", "eff-thread", "eff-metrics", "eff-where", "eff-details"].map((id) => html.indexOf(`data-testid="${id}"`));
  assert.ok(order.every((index) => index >= 0), `all contract elements present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "problem-first order");
  const defaultView = html.slice(0, html.indexOf('data-testid="eff-details"'));
  assert.equal((defaultView.match(/class="eff-tile"/g) || []).length, 4, "at most four numbers by default");
  assert.equal((defaultView.match(/<svg/g) || []).length, 0, "no timeline in the default view");
  assert.match(html, /<details class="eff-details"/);
  assert.ok(!/<details class="eff-details"[^>]* open/.test(html), "details are collapsed by default");
  assert.match(defaultView, /repository-wide/);
});

async function renderPanel(reportData) {
  const D = new URL("../dist/", import.meta.url).pathname;
  const src = await readFile(`${D}dashboard.js`, "utf8");
  const probe = `${D}__panel_probe_${process.pid}.js`;
  await writeFile(probe, src + "\nexport { renderPage as __renderPage };\n");
  try {
    const { __renderPage } = await import(probe);
    const html = __renderPage();
    const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
    const elements = {};
    const doc = { getElementById: (id) => (elements[id] ??= { innerHTML: "", textContent: "", classList: { toggle() {} } }), querySelectorAll: () => [], documentElement: {} };
    const fakeFetch = async (url) => ({ ok: true, json: async () => (String(url).startsWith("/api/efficiency") ? reportData : { error: "stub" }) });
    new Function("document", "localStorage", "navigator", "fetch", "setInterval", script)(doc, { getItem: () => "en", setItem() {} }, { languages: ["en"] }, fakeFetch, () => 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return elements.efficiency.innerHTML;
  } finally {
    await rm(probe, { force: true });
  }
}

test("prepare records targets and the canonical task card; /api/efficiency serves the problem-first report", async () => {
  const root = await tempDir("devguard-eff-prepare-");
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: root });
  await put(root, "src/billing.ts", "export function computeInvoiceTotal(items: number[]) { return items.reduce((a, b) => a + b, 0); }\n");
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Fix computeInvoiceTotal rounding in src/billing.ts" });
  const prepared = (await readTaskTelemetry(root)).find((event) => event.event === "TASK_PREPARED");
  assert.ok(prepared.providedTargets.includes("src/billing.ts"));
  assert.ok(!JSON.stringify(prepared).includes("rounding"), "telemetry never stores task text");
  const card = JSON.parse(await readFile(join(root, ".devguard", "context", "task-context.json"), "utf8"));
  process.env.CODEX_HOME = await tempDir("devguard-eff-codexhome-");
  const server = await startDashboardServer(root, { port: 48000 + Math.floor(Math.random() * 1500) });
  try {
    const body = await (await fetch(`${server.url}/api/efficiency`)).json();
    assert.equal(body.taskCard.goal, card.task);
    assert.deepEqual(body.taskCard.edit, ["src/billing.ts"]);
    assert.ok(body.now && ["GOOD", "NEEDS_ATTENTION", "POOR"].includes(body.now.health));
    assert.equal(body.threadIdentity, "unavailable");
    assert.equal((await fetch(`${server.url}/api/state`)).status, 200);
  } finally {
    await server.close();
  }
});
