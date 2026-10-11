// Post-v0.9 productization contract: `dev-guard setup` is the first-run
// command and shares one preparation engine with `watch`; the core workflow
// is API-keyless (no OpenAI call without an explicit opt-in); generated
// artifacts are singletons or bounded; agent instructions are MCP-first with
// a hybrid (not unconditional) fresh-thread policy.
//
// Generic fixtures only; no network (fetch is stubbed and counted).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile, readdir, stat, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { prepareWatchProject, prepareProject } from "../dist/prepare.js";
import { prepareTaskContext, processDoneEvent, readHistoryRecords } from "../dist/runtime-state.js";
import { ensureAgentInstructions } from "../dist/install-agent-instructions.js";
import { appendBoundedJsonl, rotateJsonlIfNeeded } from "../dist/artifact-retention.js";
import { resolveAIAssistOptIn } from "../dist/config.js";
import { computeRolloverAssessment } from "../dist/rollover.js";
import { validateProjectRoot } from "../dist/setup.js";

process.env.LC_ALL = "en-US";
process.env.LC_MESSAGES = "en-US";
process.env.LANG = "en-US";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const cleanupRoots = [];
after(async () => {
  await Promise.all(cleanupRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

// Every test runs with no OpenAI key in the environment; individual tests
// that need one set it explicitly and restore it.
const savedKeys = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, DEV_GUARD_OPENAI_API_KEY: process.env.DEV_GUARD_OPENAI_API_KEY };
before(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEV_GUARD_OPENAI_API_KEY;
});
after(() => {
  for (const [key, value] of Object.entries(savedKeys)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function cliEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.INIT_CWD;
  if (!("OPENAI_API_KEY" in extra)) delete env.OPENAI_API_KEY;
  if (!("DEV_GUARD_OPENAI_API_KEY" in extra)) delete env.DEV_GUARD_OPENAI_API_KEY;
  return env;
}

async function cli(root, args, extraEnv = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd: root, env: cliEnv(extraEnv) });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

async function makeProject({ withGit = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "devguard-setup-"));
  cleanupRoots.push(root);
  await put(
    root,
    "package.json",
    JSON.stringify({
      name: "fixture-app",
      packageManager: "pnpm@9.0.0",
      scripts: { build: "next build", test: "vitest", typecheck: "tsc --noEmit" },
      dependencies: { next: "14.0.0", react: "18.0.0" },
      devDependencies: { typescript: "5.0.0" }
    })
  );
  await put(root, "tsconfig.json", "{}\n");
  await put(root, "app/page.tsx", "export default function Page() { return null; }\n");
  await put(root, "app/api/items/route.ts", "export async function GET() { return Response.json([]); }\n");
  await put(root, "components/Card.tsx", "export function Card() { return null; }\n");
  await put(root, "lib/billing.ts", "export function computeInvoiceTotal(lines: number[]): number { return lines.reduce((a, b) => a + b, 0); }\n");
  if (withGit) {
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "test@example.com"]);
    await git(root, ["config", "user.name", "DevGuard Test"]);
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-qm", "init"]);
  }
  return root;
}

async function hashFiles(root, paths) {
  const result = {};
  for (const path of paths) {
    const text = await readFile(join(root, path), "utf8").catch(() => undefined);
    result[path] = text === undefined ? undefined : createHash("sha256").update(text).digest("hex");
  }
  return result;
}

async function listFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

/** Counts OpenAI requests; never touches the network. */
function stubFetch(response) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (response) return response();
    throw new Error("network disabled in test");
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const MANAGED = ["AGENTS.md", "CLAUDE.md", ".mcp.json", ".codex/config.toml", ".claude/settings.json", ".devguard/project/project-knowledge.json", ".devguard/memory/code-index.json", ".devguard/config.json"];

// --- A-D, J: fresh project setup ------------------------------------------

test("A-D/J: setup on a fresh project (no API key) prepares workspace, Code Index, Project Knowledge, MCP, instructions", async () => {
  const root = await makeProject();
  const result = await cli(root, ["setup"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /DevGuard setup complete/);
  assert.match(result.stdout, /Framework:\s+Next\.js/);
  assert.match(result.stdout, /Build:\s+pnpm build/);
  assert.match(result.stdout, /Context broker:\s+deterministic/);
  assert.match(result.stdout, /OpenAI API:\s+not configured \(optional\)/);
  assert.match(result.stdout, /Next\n\s+dev-guard watch/);
  assert.doesNotMatch(result.stdout, /unknown/i, "only detected values are printed");

  assert.ok(await exists(join(root, ".devguard/config.json")));
  const index = JSON.parse(await readFile(join(root, ".devguard/memory/code-index.json"), "utf8"));
  assert.ok(Object.keys(index.files).includes("lib/billing.ts"));
  const knowledge = JSON.parse(await readFile(join(root, ".devguard/project/project-knowledge.json"), "utf8"));
  assert.equal(knowledge.summary.framework, "Next.js");
  assert.ok(knowledge.commands.length > 0);

  const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
  assert.ok(mcp.mcpServers["dev-guard"]);
  assert.match(await readFile(join(root, ".codex/config.toml"), "utf8"), /\[mcp_servers\.dev-guard\]/);
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    assert.match(await readFile(join(root, file), "utf8"), /prepare_task_context/);
  }
  // Setup never starts the watcher/dashboard and never creates project-root docs.
  assert.equal(await exists(join(root, "docs")), false, "setup must not create docs/*.md templates");
  const runtime = JSON.parse(await readFile(join(root, ".devguard/runtime.json"), "utf8"));
  assert.equal(runtime.setupStatus.steps.some((step) => step.key === "dashboard"), false);
});

// --- E, P: idempotency ------------------------------------------------------

test("E/P: repeated setup is idempotent — no rewrites, no duplicate sections/config, no new markdown files", async () => {
  const root = await makeProject();
  await cli(root, ["setup"]);
  const before = await hashFiles(root, MANAGED);
  const mdBefore = (await listFiles(join(root, ".devguard"))).filter((f) => f.endsWith(".md"));
  const second = await cli(root, ["setup"]);
  assert.equal(second.code, 0);
  assert.match(second.stdout, /Already up to date/);
  assert.deepEqual(await hashFiles(root, MANAGED), before);
  const mdAfter = (await listFiles(join(root, ".devguard"))).filter((f) => f.endsWith(".md"));
  assert.deepEqual(mdAfter, mdBefore);
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    const text = await readFile(join(root, file), "utf8");
    assert.equal(text.split("<!-- dev-guard-section-start -->").length - 1, 1);
  }
  const toml = await readFile(join(root, ".codex/config.toml"), "utf8");
  assert.equal(toml.split("[mcp_servers.dev-guard]").length - 1, 1);
  const settings = await readFile(join(root, ".claude/settings.json"), "utf8");
  assert.equal(settings.split("claude-stop.sh").length - 1, 1, "hook registered once");
});

// --- F, G, Q: existing project protection -----------------------------------

test("F/G/Q: setup preserves user AGENTS/CLAUDE text, unrelated MCP config, and existing docs", async () => {
  const root = await makeProject();
  await put(root, "AGENTS.md", "# Team rules\n\nAlways run lint.\n");
  await put(root, "CLAUDE.md", "# Claude notes\n\nPrefer small diffs.\n");
  await put(root, ".mcp.json", JSON.stringify({ mcpServers: { other: { command: "other-mcp" } }, extra: true }, null, 2));
  await put(root, ".codex/config.toml", 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n');
  await put(root, "docs/PROJECT_STATE.md", "# Our real project state\n");
  await put(root, "docs/DECISIONS.md", "# Our decisions\n");
  await put(root, ".env", "SECRET=1\n");
  const pkgBefore = await readFile(join(root, "package.json"), "utf8");

  assert.equal((await cli(root, ["setup"])).code, 0);

  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith("# Team rules\n\nAlways run lint.\n"));
  assert.match(agents, /dev-guard-section-start/);
  assert.ok((await readFile(join(root, "CLAUDE.md"), "utf8")).startsWith("# Claude notes\n\nPrefer small diffs.\n"));
  const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.other, { command: "other-mcp" });
  assert.equal(mcp.extra, true);
  assert.ok(mcp.mcpServers["dev-guard"]);
  const toml = await readFile(join(root, ".codex/config.toml"), "utf8");
  assert.match(toml, /model = "gpt-5"/);
  assert.match(toml, /\[mcp_servers\.other\]\ncommand = "other"/);
  assert.equal(await readFile(join(root, "docs/PROJECT_STATE.md"), "utf8"), "# Our real project state\n");
  assert.equal(await readFile(join(root, "docs/DECISIONS.md"), "utf8"), "# Our decisions\n");
  assert.equal(await readFile(join(root, ".env"), "utf8"), "SECRET=1\n");
  assert.equal(await readFile(join(root, "package.json"), "utf8"), pkgBefore);
});

test("G: a malformed user .mcp.json is left untouched (warning), never replaced", async () => {
  const root = await makeProject();
  const malformed = '{ "mcpServers": { "other": { "command": "x" }, }, }\n';
  await put(root, ".mcp.json", malformed);
  const result = await cli(root, ["setup"]);
  assert.equal(result.code, 0);
  assert.equal(await readFile(join(root, ".mcp.json"), "utf8"), malformed);
  assert.match(result.stdout, /Claude MCP:\s+warning/);
  assert.match(result.stdout, /not valid JSON; left unchanged/);
});

// --- dry-run / root validation ----------------------------------------------

test("setup --dry-run reports the plan and writes nothing", async () => {
  const root = await makeProject();
  await put(root, ".mcp.json", JSON.stringify({ mcpServers: { other: { command: "o" } } }));
  const before = await listFiles(root);
  const result = await cli(root, ["setup", "--dry-run"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Would create[\s\S]*Code Index[\s\S]*Project Knowledge/);
  assert.match(result.stdout, /Would update\n\s+Claude MCP \(\.mcp\.json\) — dev-guard entry only; other servers kept/);
  assert.deepEqual(await listFiles(root), before, "dry-run must not create or modify files");

  await cli(root, ["setup"]);
  const after = await cli(root, ["setup", "--dry-run"]);
  assert.doesNotMatch(after.stdout, /Would (create|update)/);
  assert.match(after.stdout, /Already configured/);
});

test("setup refuses the home directory; a non-git project is supported with a stated limit", async () => {
  assert.match(await validateProjectRoot(homedir()), /not a project root/);
  assert.equal(await validateProjectRoot(await makeProject()), undefined);

  const root = await makeProject({ withGit: false });
  const result = await cli(root, ["setup"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Git:\s+not a git repository — MCP context works; done cannot detect changed files without git/);
  const payload = await prepareTaskContext({ root, task: "Fix computeInvoiceTotal in lib/billing.ts" });
  assert.ok(payload.files.some((file) => file.path === "lib/billing.ts"));
});

// --- H, I, L: watch shares the engine ---------------------------------------

test("H: watch preparation after setup does no setup work", async () => {
  const root = await makeProject();
  assert.equal((await cli(root, ["setup"])).code, 0);
  const before = await hashFiles(root, MANAGED);
  const fetchSpy = stubFetch();
  try {
    const result = await prepareWatchProject(root, { dashboardEnabled: false, dashboardReady: false });
    assert.equal(result.didWork, false, JSON.stringify(result.steps));
    assert.equal(result.steps.find((s) => s.key === "code_index").changed, false);
    assert.equal(result.steps.find((s) => s.key === "knowledge").status, "skipped");
  } finally {
    fetchSpy.restore();
  }
  assert.deepEqual(await hashFiles(root, MANAGED), before);
  assert.equal(fetchSpy.calls.length, 0);
});

test("I/L: watch without setup still prepares everything (zero-config) with no API key and no OpenAI call", async () => {
  const root = await makeProject();
  const fetchSpy = stubFetch();
  let result;
  try {
    result = await prepareWatchProject(root, { dashboardEnabled: true, dashboardReady: true });
  } finally {
    fetchSpy.restore();
  }
  assert.equal(result.didWork, true);
  assert.equal(result.warnings.length, 0, result.warnings.join("\n"));
  for (const key of ["config", "code_index", "knowledge", "agent_instructions", "hooks", "mcp", "dashboard"]) {
    assert.ok(result.steps.some((step) => step.key === key), `missing step ${key}`);
  }
  assert.ok(await exists(join(root, ".devguard/memory/code-index.json")));
  assert.ok(await exists(join(root, ".devguard/project/project-knowledge.json")));
  assert.equal(fetchSpy.calls.length, 0);
  // setup and watch are the same engine: a later setup has nothing to do.
  const setup = await cli(root, ["setup"]);
  assert.match(setup.stdout, /Already up to date/);
});

test("stale Project Knowledge is refreshed, fresh is reused", async () => {
  const root = await makeProject();
  await prepareProject(root);
  const first = await prepareProject(root);
  assert.equal(first.steps.find((s) => s.key === "knowledge").status, "skipped");
  // A newer config input makes it stale.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await put(root, "package.json", JSON.stringify({ name: "fixture-app", packageManager: "pnpm@9.0.0", scripts: { build: "next build", lint: "eslint ." }, dependencies: { next: "14.0.0" } }));
  const refreshed = await prepareProject(root);
  assert.equal(refreshed.steps.find((s) => s.key === "knowledge").changed, true);
});

// --- K, J, 14, 17: API-keyless default --------------------------------------

test("K/14/17: no key → prepare_task_context and done succeed with zero OpenAI requests", async () => {
  const root = await makeProject();
  await cli(root, ["setup"]);
  const fetchSpy = stubFetch();
  try {
    const payload = await prepareTaskContext({ root, task: "Fix rounding in computeInvoiceTotal (lib/billing.ts)" });
    assert.ok(payload.files.some((file) => file.path === "lib/billing.ts" && file.role === "TARGET"));
    await put(root, "lib/billing.ts", "export function computeInvoiceTotal(lines: number[]): number { return Math.round(lines.reduce((a, b) => a + b, 0)); }\n");
    const done = await processDoneEvent(root);
    assert.ok(done.qualityVerdict);
  } finally {
    fetchSpy.restore();
  }
  assert.equal(fetchSpy.calls.length, 0);
  const quality = await readFile(join(root, ".devguard/reports/quality-report.md"), "utf8");
  assert.doesNotMatch(quality, /No OpenAI API key is configured/, "the deterministic report is not framed as missing AI");
});

test("15: an ambient OPENAI_API_KEY alone is not an opt-in — done sends nothing to OpenAI", async () => {
  const root = await makeProject();
  await cli(root, ["setup"]);
  process.env.OPENAI_API_KEY = "sk-test-ambient";
  const fetchSpy = stubFetch();
  try {
    assert.equal((await resolveAIAssistOptIn(root)).enabled, false);
    await prepareTaskContext({ root, task: "Fix computeInvoiceTotal in lib/billing.ts" });
    await put(root, "lib/billing.ts", "export function computeInvoiceTotal(lines: number[]): number { return lines.length; }\n");
    await processDoneEvent(root);
  } finally {
    fetchSpy.restore();
    delete process.env.OPENAI_API_KEY;
  }
  assert.equal(fetchSpy.calls.length, 0);
});

test("15: explicit opt-in (config provider openai) enables the optional AI summary", async () => {
  const root = await makeProject();
  await cli(root, ["setup"]);
  await cli(root, ["config", "set", "openaiApiKey", "sk-test-config"]);
  const optIn = await resolveAIAssistOptIn(root);
  assert.equal(optIn.enabled, true);
  assert.equal(optIn.via, "config-provider");
  process.env.DEV_GUARD_OPENAI_API_KEY = "sk-test-devguard";
  assert.equal((await resolveAIAssistOptIn(await makeProject())).via, "DEV_GUARD_OPENAI_API_KEY");
  delete process.env.DEV_GUARD_OPENAI_API_KEY;

  const fetchSpy = stubFetch(() => ({ ok: false, status: 401, json: async () => ({ error: { message: "stubbed" } }) }));
  try {
    await prepareTaskContext({ root, task: "Fix computeInvoiceTotal in lib/billing.ts" });
    await put(root, "lib/billing.ts", "export function computeInvoiceTotal(lines: number[]): number { return lines.length * 2; }\n");
    await processDoneEvent(root);
  } finally {
    fetchSpy.restore();
  }
  assert.equal(fetchSpy.calls.filter((url) => url.includes("/responses")).length, 1);
});

test("M/N: doctor treats a missing key as optional; AI-only commands explain the opt-in", async () => {
  const root = await makeProject();
  await cli(root, ["setup"]);
  const doctor = await cli(root, ["doctor"]);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.match(doctor.stdout, /Context broker: deterministic \(no API key needed\)/);
  assert.match(doctor.stdout, /OpenAI API: not configured \(optional\)/);
  assert.doesNotMatch(doctor.stdout, /API Key: missing|WARNING missing/);
  assert.doesNotMatch(doctor.stdout, /not set up in this project yet/);
  assert.match(doctor.stdout, /DevGuard storage:[\s\S]*retention: healthy/);

  const taskAi = await cli(root, ["task-ai", "add a billing export"]);
  assert.notEqual(taskAi.code, 0);
  assert.match(taskAi.stderr, /OpenAI API is optional — DevGuard's core workflow does not need it\. This command requires AI assistance\./);
});

// --- O, R: artifact lifecycle -----------------------------------------------

test("O: repeated done overwrites singleton reports — markdown file set does not grow", async () => {
  const root = await makeProject();
  await cli(root, ["setup"]);
  const mdSets = [];
  for (let round = 0; round < 3; round += 1) {
    await prepareTaskContext({ root, task: `Round ${round}: adjust computeInvoiceTotal in lib/billing.ts` });
    await put(root, "lib/billing.ts", `export function computeInvoiceTotal(lines: number[]): number { return lines.length + ${round}; }\n`);
    await processDoneEvent(root);
    mdSets.push((await listFiles(join(root, ".devguard"))).filter((file) => file.endsWith(".md")));
  }
  assert.deepEqual(mdSets[1], mdSets[0]);
  assert.deepEqual(mdSets[2], mdSets[0]);
  assert.equal((await readHistoryRecords(root, 20)).length, 3, "history keeps one record per done");
});

test("R: append-only logs rotate past their threshold and keep the recent tail readable", async () => {
  const root = await makeProject();
  const path = join(root, ".devguard/history.jsonl");
  await mkdir(dirname(path), { recursive: true });
  const policy = { rotateBytes: 4096, keepRecords: 5, keepBytes: 2048 };
  for (let i = 0; i < 60; i += 1) {
    await appendBoundedJsonl(path, `${JSON.stringify({ id: `r${i}`, timestamp: new Date().toISOString(), changedFiles: ["x".repeat(80)] })}\n`, policy);
  }
  const live = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok((await stat(path)).size <= policy.rotateBytes, "live file stays under the threshold");
  assert.equal(live.at(-1).id, "r59", "the newest record is always kept");
  assert.ok(live.length >= 1 && live.length <= 60);
  assert.ok(await exists(`${path}.1`), "one rotated generation is kept");
  const records = await readHistoryRecords(root, 1);
  assert.equal(records.at(-1).id, "r59", "done's carried-over detection still sees the last record");

  // A single oversized last record is still carried over whole.
  const big = join(root, ".devguard/telemetry.jsonl");
  await appendFile(big, `${JSON.stringify({ a: "y".repeat(5000) })}\n`);
  await appendFile(big, `${JSON.stringify({ last: "z".repeat(3000) })}\n`);
  assert.equal(await rotateJsonlIfNeeded(big, policy), true);
  assert.equal(JSON.parse((await readFile(big, "utf8")).trim()).last.length, 3000);
});

// --- T-W: instruction contract ----------------------------------------------

test("T-W: managed instructions are MCP-first, no mandatory markdown, hybrid thread policy, SOON/NEW_THREAD kept", async () => {
  const root = await mkdtemp(join(tmpdir(), "devguard-instr-"));
  cleanupRoots.push(root);
  await ensureAgentInstructions(root);
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    const text = await readFile(join(root, file), "utf8");
    assert.ok(text.indexOf("prepare_task_context") < text.indexOf("project-handoff.md"), "MCP comes before any markdown");
    assert.match(text, /When `prepare_task_context` succeeds, do not also read DevGuard's markdown/);
    assert.match(text, /Only when MCP is unavailable or its result is insufficient/);
    assert.doesNotMatch(text, /Fresh thread per task|Start each distinct task in a fresh agent thread|always start a new (session|thread)/i);
    assert.match(text, /small, closely related follow-up[\s\S]*may continue in this thread/);
    assert.match(text, /separate or large task[\s\S]*fresh agent thread/);
    assert.match(text, /`SOON`: start the next large task or separate step in a fresh thread; `NEW_THREAD`: switch to a fresh thread/);
    assert.doesNotMatch(text, /AI_CONTEXT\.md/);
  }
  const unknown = computeRolloverAssessment({ changedFileCount: 1, qaResultCount: 0 });
  assert.match(unknown.advice, /small follow-up of the same work can continue here/);
  assert.doesNotMatch(unknown.advice, /Start each distinct task/);

  const sources = ["mcp.js", "rollover.js", "runtime-state.js", "install-agent-instructions.js", "index.js"];
  for (const source of sources) {
    const text = await readFile(fileURLToPath(new URL(`../dist/${source}`, import.meta.url)), "utf8");
    assert.doesNotMatch(text, /Start each distinct task in a fresh agent thread/, `${source} still has the unconditional fresh-thread rule`);
  }
});
