// Thread ownership + context integrity regressions, from a real fresh-thread
// audit (three Codex threads):
// - the previous (parent) thread's late Stop hook finalized the task a new
//   thread had just prepared, 31s after prepare_task_context, leaving that
//   thread's validation evidence UNBOUND;
// - every task was followed by a taskless follow-up finalization that was
//   counted as a second TASK_DONE and emptied workstream continuity;
// - the MCP payload was delivered twice (structuredContent + text);
// - a fresh thread got ROLL_OVER_SOON from DevGuard's own resume-bundle size.
// Fixtures are generic; provider records are synthetic files in the shapes
// Codex / Claude Code actually write.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  ensureCodeIndex,
  ensureDevguardWorkspace,
  prepareTaskContext,
  processDoneEvent,
  readRuntimeState,
  recordValidationEvidence,
  contentDerivedSummary
} from "../dist/runtime-state.js";
import { readTaskTelemetry } from "../dist/task-telemetry.js";
import { devguardPaths } from "../dist/paths.js";
import { codexRolloutPressure, hashThreadId, identityFromMcpContext, resolveCodexTaskOwner } from "../dist/thread-ownership.js";
import { findLegacyGlobalInstructions } from "../dist/doctor.js";

process.env.LC_ALL = "en-US";
process.env.LANG = "en-US";
// The test runner itself may run inside an agent session; never let its
// identity leak into fixtures.
delete process.env.CLAUDE_CODE_SESSION_ID;

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, "../dist/index.js");
const cleanup = [];
let codexHome;

before(async () => {
  codexHome = await mkdtemp(join(tmpdir(), "devguard-codex-home-"));
  cleanup.push(codexHome);
  process.env.CODEX_HOME = codexHome;
});
after(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

const THREAD_A = "01a110b0-2cb0-77d2-ad12-106896b21ba5";
const THREAD_B = "01a11120-3b49-7380-b645-d1d725103f2c";

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function makeRepo(prefix = "devguard-ownership-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "t@example.com"]);
  await git(root, ["config", "user.name", "t"]);
  await put(root, "package.json", JSON.stringify({ name: "fixture", scripts: { test: "true" } }));
  await put(root, ".gitignore", ".devguard/\n");
  await put(root, "README.md", "# fixture\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "init"]);
  await ensureDevguardWorkspace(root);
  return root;
}

function rolloutPath(threadId, when = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const dir = join(codexHome, "sessions", String(when.getFullYear()), pad(when.getMonth() + 1), pad(when.getDate()));
  return { dir, path: join(dir, `rollout-${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T00-00-00-${threadId}.jsonl`) };
}

const line = (timestamp, type, payload) => `${JSON.stringify({ timestamp: new Date(timestamp).toISOString(), type, payload })}\n`;

/** Codex rollout for a thread rooted at `cwd`, optionally recording a code-mode prepare_task_context call. */
async function writeRollout(threadId, cwd, { prepareAt, extra = [] } = {}) {
  const { dir, path } = rolloutPath(threadId);
  await mkdir(dir, { recursive: true });
  let text = line(Date.now() - 60_000, "session_meta", { id: threadId, cwd });
  if (prepareAt) {
    text += line(prepareAt, "response_item", {
      type: "custom_tool_call",
      name: "exec",
      input: 'text(await tools.mcp__dev_guard__prepare_task_context({projectRoot:"x",task:"t"}));'
    });
  }
  for (const entry of extra) text += entry;
  await writeFile(path, text);
  return path;
}

async function events(root) {
  return readTaskTelemetry(root, 1000);
}
const count = (list, type) => list.filter((event) => event.event === type).length;
async function historyCount(root) {
  const text = await readFile(join(root, devguardPaths.history), "utf8").catch(() => "");
  return text.split("\n").filter((entry) => entry.trim()).length;
}

// --- P0: parent → child handoff --------------------------------------------

test("P0 parent→child handoff: the previous thread's late Stop cannot finalize the task the new thread prepared; the owner's Stop finalizes it exactly once", async () => {
  const root = await makeRepo();

  // Thread A: Task A, finalized by its own Stop hook.
  await writeRollout(THREAD_A, root, { prepareAt: Date.now() - 1000 });
  await prepareTaskContext({ root, task: "Task A: add the alpha module.", observeCodexOwner: true });
  const runtimeA = await readRuntimeState(root);
  assert.deepEqual(runtimeA.currentTask.owner, { provider: "codex", threadIdHash: hashThreadId("codex", THREAD_A), source: "codex-rollout" });
  await put(root, "alpha.js", "export const alpha = 1;\n");
  const doneA = await processDoneEvent(root, { completionSource: "hook-codex-stop", sourceThreadId: THREAD_A });
  assert.equal(doneA.alreadyProcessed, false);

  // Thread B (fresh thread after rollover) prepares Task B. Thread A's own
  // rollout meanwhile records the delegation, which merely MENTIONS the tool.
  await writeRollout(THREAD_A, root, {
    prepareAt: Date.now() - 600_000,
    extra: [line(Date.now() - 500, "response_item", { type: "function_call", name: "create_thread", arguments: "Continue in a new thread and call prepare_task_context there first." })]
  });
  await writeRollout(THREAD_B, root, { prepareAt: Date.now() - 800 });
  await prepareTaskContext({ root, task: "Task B: add the beta module.", observeCodexOwner: true });
  const before = await readRuntimeState(root);
  assert.equal(before.currentTask.owner.threadIdHash, hashThreadId("codex", THREAD_B), "the delegation text must not make thread A the owner of Task B");
  const telemetryBefore = await events(root);
  const historyBefore = await historyCount(root);

  // Thread A's late Stop (and notify) arrive while Task B is in progress.
  await put(root, "beta.js", "export const beta = 1;\n");
  const lateStop = await processDoneEvent(root, { completionSource: "hook-codex-stop", sourceThreadId: THREAD_A });
  const lateNotify = await processDoneEvent(root, { completionSource: "hook-codex-notify", sourceThreadId: THREAD_A });
  for (const result of [lateStop, lateNotify]) {
    assert.equal(result.ignored?.reason, "foreign_thread");
    assert.equal(result.ignored.ownerThreadHash, hashThreadId("codex", THREAD_B));
    assert.equal(result.ignored.sourceThreadHash, hashThreadId("codex", THREAD_A));
  }
  const after = await readRuntimeState(root);
  assert.equal(after.currentTask?.text, before.currentTask.text, "Task B must still be the current task");
  assert.equal(after.sessionId, before.sessionId, "session lineage untouched");
  assert.deepEqual(after.currentTask.owner, before.currentTask.owner, "taskOwner untouched");
  assert.equal(await historyCount(root), historyBefore, "no history append");
  const telemetryAfter = await events(root);
  assert.equal(count(telemetryAfter, "TASK_DONE"), count(telemetryBefore, "TASK_DONE"), "no TASK_DONE");
  assert.equal(count(telemetryAfter, "COMPLETION_SIGNAL_RECEIVED"), count(telemetryBefore, "COMPLETION_SIGNAL_RECEIVED"), "an ignored request is not a completion signal");
  const ignored = telemetryAfter.filter((event) => event.event === "COMPLETION_IGNORED");
  assert.equal(ignored.length, 2);
  assert.equal(ignored[0].reason, "foreign_thread");
  assert.ok(!JSON.stringify(ignored).includes(THREAD_A), "raw provider thread ids are never stored");

  // Thread B's validation after the foreign Stop is still bound to Task B.
  const evidence = await recordValidationEvidence({ root, kind: "TEST", status: "PASS", name: "beta-test", source: "mcp-agent" });
  assert.equal(evidence.taskBinding, "BOUND");
  assert.equal(evidence.sessionId, before.sessionId);

  // Thread B's own Stop finalizes Task B exactly once.
  const doneB = await processDoneEvent(root, { completionSource: "hook-codex-stop", sourceThreadId: THREAD_B });
  assert.equal(doneB.alreadyProcessed, false);
  assert.equal(doneB.ignored, undefined);
  assert.deepEqual(doneB.taskScopedChangedFiles, ["beta.js"]);
  const repeat = await processDoneEvent(root, { completionSource: "hook-codex-notify", sourceThreadId: THREAD_B });
  assert.equal(repeat.alreadyProcessed, true);
  const final = await events(root);
  assert.equal(count(final, "TASK_DONE"), 2, "Task A once, Task B once");
  assert.equal((await readRuntimeState(root)).currentTask, undefined, "Task B closed by its owner");
  const ownerSignals = final.filter((event) => event.event === "COMPLETION_SIGNAL_RECEIVED" && event.ownership === "owner");
  assert.equal(ownerSignals.length, 2, "owner-verified signals are labelled (Task A and Task B finalizations)");
});

test("P0 lazy ownership: when the owner was not observable at prepare time, the hook resolves it from the rollouts and still ignores the foreign thread", async () => {
  const root = await makeRepo();
  await prepareTaskContext({ root, task: "Task B without eager owner." });
  const createdAt = Date.parse((await readRuntimeState(root)).currentTask.createdAt);
  await writeRollout(THREAD_B, root, { prepareAt: createdAt - 2000 });
  await writeRollout(THREAD_A, root);
  await put(root, "b.js", "export const b = 1;\n");
  const result = await processDoneEvent(root, { completionSource: "hook-codex-stop", sourceThreadId: THREAD_A });
  assert.equal(result.ignored?.reason, "foreign_thread");
  assert.equal((await readRuntimeState(root)).currentTask.owner.source, "codex-rollout", "the resolved owner is persisted for later checks");
  const own = await processDoneEvent(root, { completionSource: "hook-codex-stop", sourceThreadId: THREAD_B });
  assert.equal(own.alreadyProcessed, false);
});

test("P0 identity unavailable: no observable owner → fail-open finalization, labelled unverified (never a fabricated identity)", async () => {
  const root = await makeRepo("devguard-ownership-unverified-");
  await prepareTaskContext({ root, task: "Task with no observable thread." });
  await put(root, "c.js", "export const c = 1;\n");
  const result = await processDoneEvent(root, { completionSource: "hook-codex-stop", sourceThreadId: THREAD_A });
  assert.equal(result.alreadyProcessed, false);
  assert.equal(result.ignored, undefined);
  const signal = (await events(root)).find((event) => event.event === "COMPLETION_SIGNAL_RECEIVED");
  assert.equal(signal.ownership, "unverified");
});

test("P0 Claude Code: the MCP-observed session id owns the task; a Stop from another session is ignored", async () => {
  const root = await makeRepo("devguard-ownership-claude-");
  const caller = identityFromMcpContext({ CLAUDE_CODE_SESSION_ID: "claude-session-owner" }, undefined);
  assert.deepEqual(caller, { provider: "claude", threadId: "claude-session-owner", source: "mcp-env" });
  await prepareTaskContext({ root, task: "Claude task.", caller });
  await put(root, "d.js", "export const d = 1;\n");
  const foreign = await processDoneEvent(root, { completionSource: "hook-claude-stop", sourceThreadId: "claude-session-other" });
  assert.equal(foreign.ignored?.reason, "foreign_thread");
  const own = await processDoneEvent(root, { completionSource: "hook-claude-stop", sourceThreadId: "claude-session-owner" });
  assert.equal(own.alreadyProcessed, false);
});

test("P0 manual `dev-guard done` is an explicit request and is never ownership-filtered", async () => {
  const root = await makeRepo("devguard-ownership-cli-");
  await prepareTaskContext({ root, task: "CLI task.", caller: { provider: "claude", threadId: "s1", source: "mcp-env" } });
  await put(root, "e.js", "export const e = 1;\n");
  const result = await processDoneEvent(root, { completionSource: "cli-done", sourceThreadId: "someone-else" });
  assert.equal(result.alreadyProcessed, false);
});

test("resolveCodexTaskOwner: two threads calling prepare within the ambiguity window are not guessed apart", async () => {
  const root = await makeRepo("devguard-ownership-ambiguous-");
  const createdAt = Date.now();
  await writeRollout(THREAD_A, root, { prepareAt: createdAt - 1500 });
  await writeRollout(THREAD_B, root, { prepareAt: createdAt - 1000 });
  const resolution = await resolveCodexTaskOwner(root, new Date(createdAt).toISOString());
  assert.equal(resolution.status, "ambiguous");
});

// --- Completion telemetry: TASK_DONE exactly once -----------------------------

test("TASK_DONE exactly once: a hook catching edits made after `dev-guard done` is a follow-up finalization, not a second TASK_DONE", async () => {
  const root = await makeRepo("devguard-followup-");
  await prepareTaskContext({ root, task: "Follow-up shape." });
  await put(root, "f.js", "export const f = 1;\n");
  await processDoneEvent(root, { completionSource: "cli-done" });
  // The agent writes a validation artifact AFTER running done; the next Stop catches it.
  await put(root, "f-validation.json", "{\"done\":true}\n");
  const followUp = await processDoneEvent(root, { completionSource: "hook-codex-stop" });
  assert.equal(followUp.alreadyProcessed, false, "the late edit is still recorded");
  const duplicate = await processDoneEvent(root, { completionSource: "hook-codex-notify" });
  assert.equal(duplicate.alreadyProcessed, true);
  const list = await events(root);
  assert.equal(count(list, "TASK_DONE"), 1);
  assert.equal(count(list, "TASK_FOLLOWUP_FINALIZED"), 1);
  assert.equal(count(list, "HOOK_DONE_TRIGGERED"), 0, "a follow-up is not a hook-driven task completion");
  const signals = list.filter((event) => event.event === "COMPLETION_SIGNAL_RECEIVED");
  assert.deepEqual(signals.map((event) => event.alreadyProcessed), [false, false, true]);
  assert.equal(await historyCount(root), 2);
});

// --- Workstream continuity + document summaries -------------------------------

async function continuityFixture() {
  const root = await makeRepo("devguard-continuity-");
  await put(root, "packages/gate/src/admission-gate.ts", "export function evaluateAdmissionGate(capacity: number): boolean {\n  return capacity > 0;\n}\n");
  await put(root, "apps/web/src/profile-card.tsx", "export function ProfileCard() {\n  return <div>profile</div>;\n}\n");
  for (let index = 0; index < 55; index += 1) await put(root, `packages/feature-${index}/src/module-${index}.ts`, `export function computeValue${index}(input: number): number {\n  return input * ${index + 1};\n}\n`);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "fixture"]);
  await ensureCodeIndex(root);
  // Phase N: produces a decision doc and a proposal artifact.
  await prepareTaskContext({ root, task: "Phase 7 standby admission capacity closure: decide the admission gate capacity and record the decision." });
  await put(root, "docs/standby-phase7-capacity-closure.md", "# Standby Phase 7 — Admission Capacity Closure\n\nDecision: SMALL_DIRECT. The admission gate keeps a 14-connection headroom.\n");
  await put(root, "infra/standby/phase7/change-proposal.json", JSON.stringify({ phase: "7", purpose: "standby admission capacity change proposal", decision: "SMALL_DIRECT" }, null, 2));
  await processDoneEvent(root, { completionSource: "cli-done" });
  // Taskless follow-up finalization right after (the real masking shape).
  await put(root, "infra/standby/phase7/local-validation.json", "{\"status\":\"PASS\"}\n");
  await processDoneEvent(root, { completionSource: "hook-codex-stop" });
  return root;
}

test("E. Phase N → N+1: the previous same-workstream task's outputs are continuity candidates even after a taskless follow-up finalization", async () => {
  const root = await continuityFixture();
  const result = await prepareTaskContext({ root, task: "Phase 8 standby admission rollout: implement the admission gate rollout using the phase 7 capacity closure decision.", persistTask: false });
  const paths = result.files.map((file) => file.path);
  assert.ok(paths.includes("docs/standby-phase7-capacity-closure.md"), `previous phase decision doc expected in: ${paths.join(", ")}`);
  const prior = result.files.find((file) => file.path === "docs/standby-phase7-capacity-closure.md");
  assert.match(prior.reason, /previous task in the same workstream/);
});

test("F. unrelated new workstream: previous outputs are not injected", async () => {
  const root = await continuityFixture();
  const result = await prepareTaskContext({ root, task: "Fix the ProfileCard layout spacing on mobile.", persistTask: false });
  const paths = result.files.map((file) => file.path);
  assert.ok(!paths.includes("docs/standby-phase7-capacity-closure.md"), paths.join(", "));
  assert.ok(!paths.includes("infra/standby/phase7/change-proposal.json"), paths.join(", "));
});

test("documentation summary: documents and JSON artifacts are identified by their own content, not diff boilerplate", () => {
  assert.equal(
    contentDerivedSummary("docs/hot-standby-phase5d-release-acceptance.md", "# PartnerFlow Hot Standby Phase5D — Release & Rollout Acceptance\n\n2026-10-06. Production mutation NONE.\n"),
    "PartnerFlow Hot Standby Phase5D — Release & Rollout Acceptance"
  );
  assert.equal(contentDerivedSummary("docs/short.md", "# Phase 5C\n\nCapacity decision closure for the standby DB.\n"), "Phase 5C — Capacity decision closure for the standby DB.");
  assert.equal(
    contentDerivedSummary("infra/x/proposal.json", JSON.stringify({ phase: "5C", decision: "SMALL_DIRECT", rows: [1, 2] })),
    "phase: 5C; decision: SMALL_DIRECT"
  );
  assert.equal(contentDerivedSummary("infra/x/matrix.json", JSON.stringify({ rows: [], cells: [] })), "JSON with rows, cells");
  assert.equal(contentDerivedSummary("package.json", JSON.stringify({ name: "x" })), undefined, "manifests keep their existing summary path");
  assert.equal(contentDerivedSummary("src/a.ts", "export const a = 1;"), undefined);
});

// --- Candidate semantics: no product-specific overfit -------------------------

let semanticsRoot;
async function semanticsFixture() {
  if (semanticsRoot) return semanticsRoot;
  const root = await makeRepo("devguard-semantics-");
  await put(root, "packages/db/src/legacy-owner-closure.ts", "// Legacy connection budget owner: closes the old owner's reserved slots.\nexport function closeLegacyOwnerBudget(reserved: number): number {\n  return Math.max(0, reserved - 3);\n}\n");
  await put(root, "packages/db/src/runtime-admission.ts", "export function checkRuntimeAdmission(active: number, cap: number): boolean {\n  return active < cap;\n}\n");
  await put(root, "apps/web/src/shared-view.tsx", "export function SharedView({ readOnly }: { readOnly: boolean }) {\n  return <form>{readOnly ? null : <button>Save</button>}</form>;\n}\n");
  await put(root, "apps/web/src/theme-toggle.tsx", "export function ThemeToggle() {\n  const saved = localStorage.getItem('theme');\n  const save = (value: string) => localStorage.setItem('theme', value);\n  return <button onClick={() => save(saved === 'dark' ? 'light' : 'dark')}>Theme</button>;\n}\n");
  for (let index = 0; index < 55; index += 1) await put(root, `packages/feature-${index}/src/module-${index}.ts`, `export function computeValue${index}(input: number): number {\n  return input * ${index + 1};\n}\n`);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "fixture"]);
  await ensureCodeIndex(root);
  semanticsRoot = root;
  return root;
}

const allLabels = (result) => result.files.flatMap((file) => file.ranges.map((range) => range.label));
const forbidden = /shared\/readOnly mode guard|owner\/viewer|cardStyle|localStorage hydration|storage\/style signals/i;

test("A. 'legacy owner closure' (a bare word 'owner') is not a sharing/ownership UI task", async () => {
  const root = await semanticsFixture();
  const result = await prepareTaskContext({ root, task: "Read-only production metadata check and legacy owner closure: implement closeLegacyOwnerBudget for the connection budget.", persistTask: false });
  assert.ok(result.files.some((file) => file.path === "packages/db/src/legacy-owner-closure.ts"));
  for (const file of result.files) assert.doesNotMatch(`${file.reason} ${file.ranges.map((range) => range.label).join(" ")}`, forbidden, file.path);
  const labels = allLabels(result);
  assert.ok(new Set(labels).size > 1 || labels.length <= 1, `labels must describe what matched, not one classifier label for every range: ${labels.join(" | ")}`);
});

test("B. a real shared/readOnly UI task is labelled by the identifier that actually matched", async () => {
  const root = await semanticsFixture();
  const result = await prepareTaskContext({ root, task: "Visitors can still edit in SharedView: respect the `readOnly` prop so the Save button is hidden.", persistTask: false });
  const file = result.files.find((entry) => entry.path === "apps/web/src/shared-view.tsx");
  assert.ok(file, result.files.map((entry) => entry.path).join(", "));
  assert.equal(file.role, "TARGET");
  assert.ok(file.ranges.some((range) => /^exact code usage: .*readOnly/.test(range.label)), file.ranges.map((range) => range.label).join(" | "));
  assert.doesNotMatch(file.reason, forbidden);
});

test("C. a backend 'runtime admission' task still reaches backend code (no page-bug gate zeroing it)", async () => {
  const root = await semanticsFixture();
  const result = await prepareTaskContext({ root, task: "Implement the runtime admission cap check in checkRuntimeAdmission for the standby DB.", persistTask: false });
  assert.ok(result.files.some((file) => file.path === "packages/db/src/runtime-admission.ts" && file.role === "TARGET"), result.files.map((file) => `${file.path}:${file.role}`).join(", "));
});

test("D. a persistence UI-state task is labelled from the task's own identifiers, never a fixed cardStyle vocabulary", async () => {
  const root = await semanticsFixture();
  const result = await prepareTaskContext({ root, task: "ThemeToggle: persist the theme with `localStorage.setItem` and restore it with `localStorage.getItem` on load.", persistTask: false });
  const file = result.files.find((entry) => entry.path === "apps/web/src/theme-toggle.tsx");
  assert.ok(file);
  assert.ok(file.ranges.some((range) => /^exact code usage: .*localStorage\.(set|get)Item/.test(range.label)), file.ranges.map((range) => range.label).join(" | "));
  assert.doesNotMatch(allLabels(result).join(" "), /cardStyle/);
});

// --- MCP payload + during-task thread advice ----------------------------------

test("MCP: prepare_task_context delivers ONE payload (no structuredContent duplicate); record_validation_result carries thread advice", async () => {
  const root = await makeRepo("devguard-mcp-");
  await put(root, "src/app.ts", "export function startApp(): string {\n  return 'ok';\n}\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "app"]);
  await ensureCodeIndex(root);
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: "mcp-test-session", HOME: root, CODEX_HOME: codexHome };
  const transport = new StdioClientTransport({ command: process.execPath, args: [cliEntry, "mcp"], cwd: root, env, stderr: "ignore" });
  const client = new Client({ name: "devguard-test", version: "0" });
  await client.connect(transport);
  try {
    const prepared = await client.callTool({ name: "prepare_task_context", arguments: { task: "Change startApp to return 'ready'." } });
    assert.equal(prepared.structuredContent, undefined, "payload must not be duplicated into structuredContent");
    assert.equal(prepared.content.length, 1);
    const payload = JSON.parse(prepared.content[0].text);
    for (const key of ["task", "nextAction", "files", "constraints", "validation", "openValidation", "rollover", "workflow"]) assert.ok(key in payload, key);
    assert.ok(payload.files.some((file) => file.path === "src/app.ts" && file.ranges.length > 0));
    assert.equal(payload.rollover.thread.status, "UNKNOWN", "no transcript → UNKNOWN, never an estimated %");
    assert.equal(typeof payload.resumeCostTokens, "number", "resume cost is reported separately from thread pressure");
    assert.equal((await readRuntimeState(root)).currentTask.owner.provider, "claude");

    const recorded = await client.callTool({ name: "record_validation_result", arguments: { kind: "TEST", status: "PASS", name: "unit" } });
    const body = JSON.parse(recorded.content[0].text);
    assert.equal(body.recorded.taskBinding, "BOUND");
    assert.deepEqual(Object.keys(body.thread).sort(), ["reason", "status"]);
  } finally {
    await client.close();
  }
  const prepared = (await events(root)).find((event) => event.event === "TASK_PREPARED");
  assert.ok(prepared.mcpPayloadTokens > 0);
});

test("thread pressure: Codex rollout token_count / compaction are classified from observed values only", () => {
  const usage = (input) => `${JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input }, model_context_window: 258400 } } })}\n`;
  assert.equal(codexRolloutPressure(usage(31000)).status, "LOW");
  const soon = codexRolloutPressure(usage(31000) + usage(163000));
  assert.equal(soon.status, "SOON");
  assert.match(soon.reason, /63% of the provider window/);
  assert.equal(codexRolloutPressure(usage(244000)).status, "NEW_THREAD");
  assert.equal(codexRolloutPressure(usage(90000) + '{"timestamp":"t","type":"compacted","payload":{}}\n').status, "NEW_THREAD");
  assert.equal(codexRolloutPressure("").status, "UNKNOWN");
});

test("thread pressure end to end: prepare in a fresh Codex thread is SAFE even with a large resume bundle; a heavy owner thread is reported", async () => {
  const root = await makeRepo("devguard-pressure-");
  const tokenLine = (input) => line(Date.now() - 100, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: input }, model_context_window: 258400 } });
  await writeRollout(THREAD_B, root, { prepareAt: Date.now() - 1000, extra: [tokenLine(31000)] });
  const fresh = await prepareTaskContext({ root, task: "Fresh thread task.", observeCodexOwner: true });
  assert.equal(fresh.rollover.thread.status, "LOW");
  assert.equal(fresh.rollover.status, "SAFE");
  await writeRollout(THREAD_B, root, { prepareAt: Date.now() - 600_000, extra: [tokenLine(244000)] });
  const { currentThreadPressure } = await import("../dist/runtime-state.js");
  const heavy = await currentThreadPressure(root);
  assert.equal(heavy.status, "NEW_THREAD");
});

// --- Instruction authority ----------------------------------------------------

test("instruction authority: legacy 'read DevGuard markdown first' global instructions are reported read-only; current MCP-first text is not", async () => {
  const home = await mkdtemp(join(tmpdir(), "devguard-home-"));
  cleanup.push(home);
  await mkdir(join(home, ".codex"), { recursive: true });
  const legacy = "Use dev-guard artifacts as the primary source of project context.\n\nRead:\n1. .devguard/reports/project-handoff.md\n2. .devguard/reports/quality-report.md\n3. .devguard/prompts/next-codex-prompt.md\n";
  await writeFile(join(home, ".codex", "AGENTS.md"), legacy);
  const found = await findLegacyGlobalInstructions(home);
  assert.deepEqual(found, [{ path: join(home, ".codex", "AGENTS.md"), lines: [4, 5, 6] }]);
  assert.equal(await readFile(join(home, ".codex", "AGENTS.md"), "utf8"), legacy, "never edited");
  await appendFile(join(home, ".codex", "AGENTS.md"), "\nCall prepare_task_context first.\n");
  assert.deepEqual(await findLegacyGlobalInstructions(home), [], "a file already describing the MCP-first workflow is not a conflict");
});

test("instruction authority: repository docs describe one workflow (no 'read project-handoff.md first' startup block)", async () => {
  const repoRoot = resolve(here, "../../..");
  for (const doc of ["docs/npm-setup.md", "docs/npm-setup.ko.md"]) {
    const text = await readFile(join(repoRoot, doc), "utf8");
    assert.doesNotMatch(text, /Before doing any work:\s*\n\s*\n?1\. Read `\.devguard\/reports/, doc);
    assert.doesNotMatch(text, /Required reading:/, doc);
    assert.match(text, /prepare_task_context/, doc);
  }
});

test("hook scripts pass the provider thread id to `dev-guard done`", async () => {
  const { refreshGeneratedHookScripts } = await import("../dist/hooks.js");
  void refreshGeneratedHookScripts;
  const root = await makeRepo("devguard-hookscript-");
  await execFileAsync(process.execPath, [cliEntry, "install-hooks", "--agent", "all"], { cwd: root, env: { ...process.env, HOME: root } }).catch(() => undefined);
  const stop = await readFile(join(root, devguardPaths.codexHook), "utf8").catch(() => "");
  const notify = await readFile(join(root, devguardPaths.codexNotifyHook), "utf8").catch(() => "");
  assert.match(stop, /export DEV_GUARD_HOOK_THREAD_ID="\$session_id"/);
  assert.match(notify, /export DEV_GUARD_HOOK_THREAD_ID="\$thread_id"/);
});
