// User-facing rollover + structured document ranges + workstream continuity,
// from a real phase-by-phase audit (five Codex threads):
// - DevGuard reported SOON (61%) to the agent at the end of a task, but the
//   agent never told the user; the user continued in the same thread to 92%
//   and a compaction;
// - every recommended Markdown/JSON file came back with zero ranges, so
//   agents read whole documents (14% -> 60% of the window in ~5 minutes);
// - "Phase 5H" (previous task) vs "Phase5H" (next task) broke continuity.
// Fixtures are generic; provider records are synthetic files in the shapes
// Codex writes.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { ensureCodeIndex, ensureDevguardWorkspace, prepareTaskContext, processDoneEvent, structuredIdentifierTokens, toAgentContextPayload } from "../dist/runtime-state.js";
import { jsonSections, markdownSections } from "../dist/document-ranges.js";

process.env.LC_ALL = "en-US";
process.env.LANG = "en-US";
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CODEX_THREAD_ID;

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, "../dist/index.js");
const cleanup = [];
let codexHome;
before(async () => {
  codexHome = await mkdtemp(join(tmpdir(), "devguard-notice-codex-"));
  cleanup.push(codexHome);
  process.env.CODEX_HOME = codexHome;
});
after(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}
async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
async function makeRepo(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "t@example.com"]);
  await git(root, ["config", "user.name", "t"]);
  await put(root, "package.json", JSON.stringify({ name: "fixture" }));
  await put(root, ".gitignore", ".devguard/\n");
  await put(root, "src/app.ts", "export function startApp(): string {\n  return 'ok';\n}\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "init"]);
  await ensureDevguardWorkspace(root);
  return root;
}

// --- P0: user-facing rollover --------------------------------------------------

const THREAD = "01a11350-bfee-7f72-b25d-8949f18b87b8";
const OTHER_THREAD = "01a113cc-b3cb-7d91-9abe-61e29d611f35";

async function writeRollout(threadId, cwd, inputTokens) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const dir = join(codexHome, "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  await mkdir(dir, { recursive: true });
  const line = (type, payload) => `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`;
  await writeFile(
    join(dir, `rollout-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T00-00-00-${threadId}.jsonl`),
    line("session_meta", { id: threadId, cwd }) + line("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: inputTokens }, model_context_window: 258400 } })
  );
}

async function withMcp(root, run, extraEnv = {}) {
  const env = { ...process.env, CODEX_HOME: codexHome, HOME: root, ...extraEnv };
  delete env.CLAUDE_CODE_SESSION_ID;
  const transport = new StdioClientTransport({ command: process.execPath, args: [cliEntry, "mcp"], cwd: root, env, stderr: "ignore" });
  const client = new Client({ name: "devguard-notice-test", version: "0" });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

// Codex sends the calling thread's id in the request _meta.
const call = async (client, name, args, threadId = THREAD) =>
  JSON.parse((await client.callTool({ name, arguments: args, _meta: threadId ? { threadId } : undefined })).content[0].text);

async function agentDone(root, threadId = THREAD, extraEnv = {}) {
  const env = { ...process.env, CODEX_HOME: codexHome, CODEX_THREAD_ID: threadId, ...extraEnv };
  delete env.DEV_GUARD_COMPLETION_SOURCE;
  const { stdout } = await execFileAsync(process.execPath, [cliEntry, "done"], { cwd: root, env });
  return stdout;
}

test("5G regression (A/B): SOON at Task A's boundary and NEW_THREAD at Task B's boundary both reach the user as a final-reply notice", async () => {
  const root = await makeRepo("devguard-notice-5g-");
  await writeRollout(THREAD, root, 36000); // fresh thread, 14%
  await withMcp(root, async (client) => {
    const prepared = await call(client, "prepare_task_context", { task: "Task A: change startApp to return ready." });
    assert.equal(prepared.rollover.thread.status, "LOW");

    await put(root, "src/app.ts", "export function startApp(): string {\n  return 'ready';\n}\n");
    await writeRollout(THREAD, root, 158000); // 61%
    const recordedA = await call(client, "record_validation_result", { kind: "TEST", status: "PASS", name: "app" });
    assert.equal(recordedA.thread.status, "SOON");
    assert.match(recordedA.thread.reason, /61%/);
    assert.match(recordedA.thread.userNotice, /Start the next large task or separate step in a fresh thread/);
  });
  // The agent-run `dev-guard done` is the task boundary: fresh state, last lines.
  const doneA = await agentDone(root);
  const tailA = doneA.trim().split("\n").slice(-2).join("\n");
  assert.match(tailA, /Thread: SOON/);
  assert.match(tailA, /User notice \(end your final reply with this\): This thread's context usage is rising/);

  // The user keeps going in the same thread anyway: Task B.
  await withMcp(root, async (client) => {
    await call(client, "prepare_task_context", { task: "Task B: add a stopApp function next to startApp." });
    await put(root, "src/app.ts", "export function startApp(): string {\n  return 'ready';\n}\nexport function stopApp(): void {}\n");
    await writeRollout(THREAD, root, 201500); // 78%
    const recordedB = await call(client, "record_validation_result", { kind: "TEST", status: "PASS", name: "app-b" });
    assert.equal(recordedB.thread.status, "NEW_THREAD");
    assert.match(recordedB.thread.userNotice, /Switch to a fresh thread before continuing/);
  });
  assert.match(await agentDone(root), /User notice \(end your final reply with this\): This thread's context usage is high\. Switch to a fresh thread/);
});

test("C. LOW: no thread notice anywhere (no noise)", async () => {
  const root = await makeRepo("devguard-notice-low-");
  await writeRollout(THREAD, root, 36000);
  await withMcp(root, async (client) => {
    await call(client, "prepare_task_context", { task: "Small change to startApp." });
    await put(root, "src/app.ts", "export function startApp(): string {\n  return 'small';\n}\n");
    const recorded = await call(client, "record_validation_result", { kind: "TEST", status: "PASS" });
    assert.equal(recorded.thread.status, "LOW");
    assert.equal(recorded.thread.userNotice, undefined);
  });
  const done = await agentDone(root);
  assert.doesNotMatch(done, /User notice|Thread: /);
});

test("D. stale / foreign signals are never surfaced as a user notice", async () => {
  const root = await makeRepo("devguard-notice-foreign-");
  await writeRollout(THREAD, root, 236000); // the task owner's thread is heavy (91%)
  await writeRollout(OTHER_THREAD, root, 30000); // the caller's own thread is light
  await withMcp(root, async (client) => {
    await call(client, "prepare_task_context", { task: "Owner thread task on startApp." });
    // Another thread records evidence: its OWN fresh state applies, not the owner's.
    const fromOther = await call(client, "record_validation_result", { kind: "TEST", status: "PASS" }, OTHER_THREAD);
    assert.equal(fromOther.thread.status, "LOW");
    assert.equal(fromOther.thread.userNotice, undefined);
    // Caller identity unknown: the owner's state may be reported, but never as a user notice.
    const anonymous = await call(client, "record_validation_result", { kind: "TEST", status: "PASS", name: "anon" }, null);
    assert.equal(anonymous.thread.status, "NEW_THREAD");
    assert.equal(anonymous.thread.userNotice, undefined);
    // Freshness: the thread recovers (new observation) -> the next response reflects it.
    await writeRollout(OTHER_THREAD, root, 30000);
  });
});

test("P0 notice follows the project locale", async () => {
  const root = await makeRepo("devguard-notice-ko-");
  await put(root, ".devguard/config.json", JSON.stringify({ locale: "ko-KR" }));
  await writeRollout(THREAD, root, 160000);
  await withMcp(root, async (client) => {
    await call(client, "prepare_task_context", { task: "startApp 반환값 변경" });
    const recorded = await call(client, "record_validation_result", { kind: "TEST", status: "PASS" });
    assert.equal(recorded.thread.userNotice, "현재 스레드의 컨텍스트 사용량이 높아지고 있습니다. 다음 큰 작업이나 별도 단계는 새 스레드에서 시작하는 것을 권장합니다.");
  });
});

test("P0 instruction contract: the managed AGENTS.md/CLAUDE.md section tells agents when (and when not) to relay the notice", async () => {
  const root = await makeRepo("devguard-notice-instructions-");
  await execFileAsync(process.execPath, [cliEntry, "install-agent-instructions", "--force"], { cwd: root });
  const { readFile } = await import("node:fs/promises");
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    const text = await readFile(join(root, file), "utf8");
    assert.match(text, /`SOON` or `NEW_THREAD`, end your FINAL reply for the task with the provided `userNotice`/, file);
    assert.match(text, /Say nothing about threads when the state is `LOW` or `UNKNOWN`/, file);
    assert.match(text, /never first/, file);
  }
});

// --- P1: structured document ranges ------------------------------------------

const longMarkdown = [
  "# Phase 5I Group B Blocker Closure",
  "",
  "Summary of the closure.",
  "",
  "## Background",
  ...Array.from({ length: 14 }, (_, i) => `Background line ${i} about the release history.`),
  "",
  "## DB Role Cap Feasibility",
  "The dedicated LOGIN role cap is feasible with connection budget headroom.",
  "Role cap per primary: 15, legacy reserve 5.",
  ...Array.from({ length: 8 }, (_, i) => `Role cap evidence ${i}.`),
  "",
  "## Hard Budget",
  "Aggregate connection budget hard bound is 57; the blocker is the provider pool.",
  ...Array.from({ length: 6 }, (_, i) => `Budget evidence ${i}.`),
  "",
  "## Appendix",
  "```",
  "# not a heading inside a fence",
  "```",
  ...Array.from({ length: 10 }, (_, i) => `Appendix line ${i}.`)
].join("\n");

const prettyJson = JSON.stringify({
  phase: "5I",
  note: "values with { braces } and [ brackets ] and \"quotes\" must not break the scanner",
  budget: { aggregate: 57, primaryCap: 15 },
  gates: ["G1 readiness", "G2 parity"],
  blockers: [{ id: "B1", detail: "provider pool hard bound" }],
  changes: [
    { id: "C1", role: "reader" },
    { id: "C3", role: "dedicated LOGIN role cap 15" },
    { id: "C4", role: "legacy reserve" }
  ],
  history: Array.from({ length: 12 }, (_, i) => ({ step: i }))
}, null, 2);

let docsRoot;
async function docsFixture() {
  if (docsRoot) return docsRoot;
  const root = await makeRepo("devguard-docranges-");
  await put(root, "docs/phase5i-group-b-blocker-closure.md", longMarkdown);
  await put(root, "infra/phase5i/group-b-execution-package.json", prettyJson);
  await put(root, "infra/phase5i/minified-evidence.json", JSON.stringify({ budget: { aggregate: 57 }, blockers: ["pool"], changes: [{ id: "C3" }] }));
  for (let i = 0; i < 55; i += 1) await put(root, `packages/feature-${i}/src/module-${i}.ts`, `export function computeValue${i}(input: number): number {\n  return input * ${i + 1};\n}\n`);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "docs"]);
  await ensureCodeIndex(root);
  docsRoot = root;
  return root;
}

test("E. Markdown: recommended docs come with heading sections, not zero ranges", async () => {
  const root = await docsFixture();
  const result = await prepareTaskContext({ root, task: "Close the Group B blockers: check the DB role cap feasibility and the hard connection budget in the phase5i closure doc.", persistTask: false });
  const doc = result.files.find((file) => file.path === "docs/phase5i-group-b-blocker-closure.md");
  assert.ok(doc, result.files.map((file) => file.path).join(", "));
  // Rehydration policy: a small TARGET document is one WHOLE_FILE read —
  // 3–10 line heading ranges were re-read whole in every real session.
  // Section ranges for large documents: see rehydration-plan.test.js.
  assert.equal(doc.role, "TARGET");
  assert.equal(doc.ranges.length, 1, doc.ranges.map((range) => range.label).join(" | "));
  assert.equal(doc.ranges[0].kind, "WHOLE_FILE");
  assert.equal(doc.ranges[0].startLine, 1);
  assert.match(doc.ranges[0].label, /^WHOLE_FILE \(\d+ lines, ~\d+ est\. tokens\)$/);
});

test("F. a CANDIDATE document carries exactly one section in the agent payload; a TARGET at most three", async () => {
  const root = await docsFixture();
  const result = await prepareTaskContext({ root, task: "Close the Group B blockers: check the DB role cap feasibility and the hard connection budget in the phase5i closure doc.", persistTask: false });
  const payload = toAgentContextPayload(result);
  for (const file of payload.files) {
    if (file.role === "CANDIDATE") assert.ok(file.ranges.length <= 1, `${file.path}: ${file.ranges.length}`);
    if (file.role === "TARGET") assert.ok(file.ranges.length <= 3, `${file.path}: ${file.ranges.length}`);
  }
});

test("G/H. JSON: top-level key and array-item ranges with real line numbers; braces inside strings do not break the scan", async () => {
  const sections = jsonSections(prettyJson);
  const byName = Object.fromEntries(sections.map((section) => [section.name, section]));
  const lines = prettyJson.split("\n");
  const lineOf = (needle) => lines.findIndex((line) => line.includes(needle)) + 1;
  assert.equal(byName.note.startLine, lineOf('"note"'));
  assert.equal(byName.budget.startLine, lineOf('"budget"'));
  assert.equal(byName.budget.endLine, lineOf('"primaryCap"') + 1);
  assert.ok(byName["changes[1] C3"], Object.keys(byName).join(", "));
  assert.equal(byName["changes[1] C3"].startLine, lineOf('"id": "C3"') - 1);

  const root = await docsFixture();
  const result = await prepareTaskContext({ root, task: "Group B blockers: review the aggregate budget and blockers, and the C3 role cap change in group-b-execution-package.json.", persistTask: false });
  const pkg = result.files.find((file) => file.path === "infra/phase5i/group-b-execution-package.json");
  assert.ok(pkg, result.files.map((file) => file.path).join(", "));
  // A small JSON TARGET is one WHOLE_FILE read; key/item ranges apply to large JSON (rehydration-plan.test.js).
  assert.equal(pkg.role, "TARGET");
  assert.deepEqual(pkg.ranges.map((range) => range.kind), ["WHOLE_FILE"]);
});

test("I. minified JSON gets no invented line ranges", async () => {
  assert.deepEqual(jsonSections(JSON.stringify({ budget: { aggregate: 57 }, blockers: ["pool"] })), []);
  const root = await docsFixture();
  const result = await prepareTaskContext({ root, task: "Review the minified-evidence.json budget and blockers.", persistTask: false });
  const minified = result.files.find((file) => file.path === "infra/phase5i/minified-evidence.json");
  if (minified) assert.ok(minified.ranges.every((range) => !/^json (?:key|item)/.test(range.label)), minified.ranges.map((range) => range.label).join(" | "));
});

test("markdown scanner: fenced pseudo-headings are ignored and sections nest by level", () => {
  const sections = markdownSections("# T\n\n## A\na\n### A.1\nb\n```\n# fake\n```\n## B\nc\n");
  assert.deepEqual(sections.map((section) => [section.level, section.name, section.startLine, section.endLine]), [[1, "T", 1, 11], [2, "A", 3, 9], [3, "A.1", 5, 9], [2, "B", 10, 11]]);
});

// --- P2: structured identifiers + continuity ---------------------------------

test("J. Phase 5H == Phase5H == Phase-5H == phase_5h; shorthand siblings expand; prose is not glued", () => {
  for (const text of ["Phase 5H", "Phase5H", "Phase-5H", "phase_5h"]) assert.deepEqual(structuredIdentifierTokens(text), ["phase5h"], text);
  assert.deepEqual(structuredIdentifierTokens("Read required Phase5H/5D artifacts"), ["phase5h", "phase5d"]);
  assert.deepEqual(structuredIdentifierTokens("Step 12B and Step-12B and RFC 123 and RFC-123").sort(), ["rfc123", "step12b"]);
  assert.deepEqual(structuredIdentifierTokens("top 10 files, E1 resize, commit 5b5e61abe8"), []);
});

async function continuityFixture() {
  const root = await makeRepo("devguard-phase-continuity-");
  await put(root, "infra/phase5b/production-change-proposal.json", JSON.stringify({ phase: "5B", purpose: "group b connection budget proposal", decision: "INSUFFICIENT_EVIDENCE" }, null, 2));
  await put(root, "packages/gate/src/group-b-gate.ts", "export function evaluateGroupBGate(blockers: number): boolean {\n  return blockers === 0;\n}\n");
  for (let i = 0; i < 55; i += 1) await put(root, `packages/feature-${i}/src/module-${i}.ts`, `export function computeValue${i}(input: number): number {\n  return input * ${i + 1};\n}\n`);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "fixture"]);
  await ensureCodeIndex(root);
  // Previous task names itself "Phase 5H" (with a space).
  await prepareTaskContext({ root, task: "Phase 5H: Group B primary release preflight and exact execution package; no production mutation." });
  await put(root, "docs/phase5h-group-b-preflight.md", "# Phase 5H — Group B Preflight\n\nExecution package prepared; blockers listed.\n");
  await put(root, "infra/phase5h/group-b-execution-package.json", JSON.stringify({ phase: "5H", status: "REVIEWABLE_PACKAGE_BLOCKED" }, null, 2));
  await processDoneEvent(root, { completionSource: "cli-done" });
  return root;
}

test("K. 5H → 5I: a direct 'Phase5H' reference recovers the previous task's artifacts above an unrelated phase proposal", async () => {
  const root = await continuityFixture();
  const result = await prepareTaskContext({ root, task: "Read required Phase5H/5D artifacts and close Group B blockers.", persistTask: false });
  const paths = result.files.map((file) => file.path);
  const doc = result.files.find((file) => file.path === "docs/phase5h-group-b-preflight.md");
  assert.ok(doc, paths.join(", "));
  assert.ok(["TARGET", "CANDIDATE"].includes(doc.role));
  assert.match(doc.reason, /same workstream/);
  const unrelated = paths.indexOf("infra/phase5b/production-change-proposal.json");
  assert.ok(unrelated === -1 || unrelated > paths.indexOf("docs/phase5h-group-b-preflight.md"), paths.join(", "));
  const unrelatedFile = result.files.find((file) => file.path === "infra/phase5b/production-change-proposal.json");
  assert.notEqual(unrelatedFile?.role, "TARGET");
});

test("L. an unrelated next phase does not get false continuity", async () => {
  const root = await continuityFixture();
  const result = await prepareTaskContext({ root, task: "Phase 6A: adjust computeValue3 rounding in module-3.", persistTask: false });
  assert.ok(!result.files.some((file) => /same workstream/.test(file.reason)), result.files.map((file) => `${file.path}: ${file.reason}`).join("\n"));
});
