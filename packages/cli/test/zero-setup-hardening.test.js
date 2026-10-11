// 0.10 release-candidate contract: `dev-guard watch` is the zero-setup entry
// point (setup is optional), Project Knowledge freshness follows project
// STRUCTURE (not only manifest mtimes), append-only logs rotate without
// losing lines under concurrent writers or a crash, user config is never
// clobbered, and current-facing docs/instructions describe this flow.
//
// Generic fixtures only; no network (fetch is stubbed and counted).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile, stat, unlink, utimes, rename, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { formatPreparation, prepareProject, prepareWatchProject } from "../dist/prepare.js";
import { getProjectKnowledgeRefreshStatus } from "../dist/knowledge.js";
import { prepareTaskContext, processDoneEvent, readHistoryRecords } from "../dist/runtime-state.js";
import { appendBoundedJsonl, readBoundedJsonlTail, rotateJsonlIfNeeded } from "../dist/artifact-retention.js";
import { readTaskTelemetry } from "../dist/task-telemetry.js";
import { replaceTomlTable } from "../dist/mcp-setup.js";
import { ensureAgentInstructions, replaceManagedSections } from "../dist/install-agent-instructions.js";

process.env.LC_ALL = "en-US";
process.env.LC_MESSAGES = "en-US";
process.env.LANG = "en-US";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const RETENTION_MODULE = fileURLToPath(new URL("../dist/artifact-retention.js", import.meta.url));
const cleanupRoots = [];
after(async () => {
  await Promise.all(cleanupRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

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

async function cli(cwd, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.INIT_CWD;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { cwd, env, timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), "devguard-zero-setup-"));
  cleanupRoots.push(root);
  await put(root, "package.json", JSON.stringify({ name: "fixture", packageManager: "pnpm@9.0.0", scripts: { build: "next build" }, dependencies: { next: "14.0.0" }, devDependencies: { typescript: "5.0.0" } }));
  await put(root, "tsconfig.json", "{}\n");
  await put(root, "README.md", "# Fixture\n");
  await put(root, "app/page.tsx", "export default function Page() { return null; }\n");
  await put(root, "app/api/items/route.ts", "export async function GET() { return Response.json([]); }\n");
  await put(root, "components/Card.tsx", "export function Card() { return null; }\n");
  await put(root, "components/Badge.tsx", "export function Badge() { return null; }\n");
  await put(root, "supabase/migrations/001_init.sql", "create table items (id int);\n");
  await put(root, "lib/billing.ts", "export function computeInvoiceTotal(lines: number[]): number { return lines.reduce((a, b) => a + b, 0); }\n");
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=t@e.st", "-c", "user.name=T", "add", "-A"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=t@e.st", "-c", "user.name=T", "commit", "-qm", "init"], { cwd: root });
  return root;
}

const MANAGED = ["AGENTS.md", "CLAUDE.md", ".mcp.json", ".codex/config.toml", ".claude/settings.json", ".devguard/project/project-knowledge.json", ".devguard/memory/code-index.json", ".devguard/config.json"];
async function hashFiles(root) {
  const result = {};
  for (const path of MANAGED) {
    const text = await readFile(join(root, path), "utf8").catch(() => undefined);
    result[path] = text === undefined ? undefined : createHash("sha256").update(text).digest("hex");
  }
  return result;
}

function stubFetch() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error("network disabled in test");
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

// --- A-E: zero-setup ---------------------------------------------------------

test("A/B/E: watch preparation alone fully prepares a fresh project — setup is never required", async () => {
  const root = await makeProject();
  const result = await prepareWatchProject(root, { dashboardEnabled: true, dashboardReady: true });
  for (const path of MANAGED) assert.ok(await stat(join(root, path)).catch(() => false), `missing ${path}`);
  const { headline, lines } = formatPreparation(result);
  assert.equal(headline, "First-time project preparation");
  assert.ok(lines.some((line) => /^✓ Indexed \d+ project files$/.test(line)));
  assert.ok(lines.includes("✓ Detected pnpm@9.0.0 / TypeScript / Next.js"));
  assert.ok(lines.includes("✓ Project Knowledge ready"));
  assert.ok(lines.includes("✓ Claude MCP configured (.mcp.json)"));
  assert.ok(lines.includes("✓ Codex MCP configured (.codex/config.toml)"));
  assert.ok(lines.some((line) => line.startsWith("✓ Agent instructions ready")));
  assert.ok(lines.includes("✓ Completion hooks ready"));
  assert.equal(result.warnings.length, 0, result.warnings.join("\n"));
});

test("C/D: a second watch (or watch after setup) is a no-op that prints only 'Project ready.'", async () => {
  const root = await makeProject();
  await prepareWatchProject(root, { dashboardEnabled: false, dashboardReady: false });
  const before = await hashFiles(root);
  const second = await prepareWatchProject(root, { dashboardEnabled: false, dashboardReady: false });
  assert.equal(second.didWork, false);
  assert.deepEqual(formatPreparation(second), { headline: "Project ready.", lines: [] });
  assert.deepEqual(await hashFiles(root), before);

  const other = await makeProject();
  assert.equal((await cli(other, ["setup"])).code, 0);
  const afterSetup = await prepareWatchProject(other, { dashboardEnabled: false, dashboardReady: false });
  assert.equal(formatPreparation(afterSetup).headline, "Project ready.");
});

test("watch refuses an invalid project root before touching anything", async () => {
  const result = await cli(homedir(), ["watch", "--no-dashboard"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /is not a project root/);
  await assert.rejects(() => prepareProject(homedir()), /is not a project root/);
});

test("non-critical failures degrade to actionable warnings; the remaining steps still run", async () => {
  const root = await makeProject();
  await mkdir(join(root, "AGENTS.md")); // unwritable as a file
  const result = await prepareProject(root);
  const warning = result.warnings.find((line) => line.startsWith("AGENTS.md / CLAUDE.md not updated"));
  assert.ok(warning, result.warnings.join("\n"));
  assert.match(warning, /Agents will not see the DevGuard workflow until this is fixed/);
  assert.ok(await stat(join(root, ".mcp.json")).catch(() => false), "MCP step still ran");
  assert.ok(await stat(join(root, ".devguard/project/project-knowledge.json")).catch(() => false));
});

// --- F-J: Project Knowledge structural freshness ---------------------------

async function freshKnowledgeProject() {
  const root = await makeProject();
  await prepareProject(root);
  assert.equal((await getProjectKnowledgeRefreshStatus(root)).reason, "fresh", "E: unchanged repository is fresh");
  return root;
}

test("F: a new API route makes Knowledge stale with package.json unchanged", async () => {
  const root = await freshKnowledgeProject();
  await put(root, "app/api/orders/route.ts", "export async function POST() { return Response.json({}); }\n");
  const status = await getProjectKnowledgeRefreshStatus(root);
  assert.equal(status.reason, "stale");
  assert.ok(status.staleFiles.includes("project file set"));
  const refreshed = await prepareProject(root);
  assert.equal(refreshed.steps.find((s) => s.key === "knowledge").changed, true);
  const knowledge = JSON.parse(await readFile(join(root, ".devguard/project/project-knowledge.json"), "utf8"));
  assert.ok(knowledge.apis.some((api) => api.route === "/api/orders"));
  assert.equal((await getProjectKnowledgeRefreshStatus(root)).reason, "fresh");
});

test("G: a new migration makes Knowledge stale", async () => {
  const root = await freshKnowledgeProject();
  await put(root, "supabase/migrations/002_orders.sql", "create table orders (id int);\n");
  assert.equal((await getProjectKnowledgeRefreshStatus(root)).reason, "stale");
});

test("H: removing a component makes Knowledge stale", async () => {
  const root = await freshKnowledgeProject();
  await unlink(join(root, "components/Badge.tsx"));
  assert.equal((await getProjectKnowledgeRefreshStatus(root)).reason, "stale");
});

test("I: README text edits and DevGuard's own setup files do not trigger regeneration", async () => {
  const root = await freshKnowledgeProject();
  await put(root, "README.md", "# Fixture\n\nMuch longer description now.\n");
  await put(root, "docs/notes.md", "# notes\n");
  await put(root, ".mcp.json", JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  await put(root, "lib/billing.ts", "export function computeInvoiceTotal(lines: number[]): number { return 0; }\n");
  assert.equal((await getProjectKnowledgeRefreshStatus(root)).reason, "fresh");
});

test("J: package.json script or tsconfig changes make Knowledge stale; touching without change does not", async () => {
  const root = await freshKnowledgeProject();
  const future = new Date(Date.now() + 60_000);
  await utimes(join(root, "package.json"), future, future);
  assert.equal((await getProjectKnowledgeRefreshStatus(root)).reason, "fresh", "mtime-only touch is not a change");
  await put(root, "package.json", JSON.stringify({ name: "fixture", packageManager: "pnpm@9.0.0", scripts: { build: "next build", test: "vitest" }, dependencies: { next: "14.0.0" } }));
  const status = await getProjectKnowledgeRefreshStatus(root);
  assert.equal(status.reason, "stale");
  assert.deepEqual(status.staleFiles, ["package.json"]);
});

test("pre-0.10 Knowledge without a fingerprint is refreshed exactly once", async () => {
  const root = await freshKnowledgeProject();
  const path = join(root, ".devguard/project/project-knowledge.json");
  const knowledge = JSON.parse(await readFile(path, "utf8"));
  delete knowledge.fingerprint;
  await writeFile(path, JSON.stringify(knowledge));
  assert.equal((await getProjectKnowledgeRefreshStatus(root)).reason, "stale");
  await prepareProject(root);
  assert.equal((await getProjectKnowledgeRefreshStatus(root)).reason, "fresh");
});

// --- K-P: rotation -----------------------------------------------------------

const tiny = { rotateBytes: 2048 };

test("K/O: history rotates, and done's last-record read survives the rotation", async () => {
  const root = await makeProject();
  await prepareProject(root);
  const path = join(root, ".devguard/history.jsonl");
  for (let i = 0; i < 40; i += 1) {
    await appendBoundedJsonl(path, `${JSON.stringify({ id: `h${i}`, timestamp: new Date().toISOString(), changedFiles: ["x".repeat(100)] })}\n`, tiny);
  }
  assert.ok(await stat(`${path}.1`).catch(() => false));
  assert.ok((await stat(path).catch(() => ({ size: 0 }))).size <= tiny.rotateBytes);
  assert.equal((await readHistoryRecords(root, 1)).at(-1).id, "h39");
  // Several rotations happened at this tiny threshold, so only the newest
  // generations remain — the merged read must still be a contiguous,
  // ordered tail ending at the newest record.
  const ids = (await readHistoryRecords(root, 20)).map((r) => Number(r.id.slice(1)));
  assert.ok(ids.length >= 2);
  assert.deepEqual(ids, Array.from({ length: ids.length }, (_, i) => 40 - ids.length + i));
});

test("L/M: change-log and telemetry rotate under the same policy; telemetry reads stay contiguous", async () => {
  const root = await makeProject();
  await prepareProject(root);
  const changeLog = join(root, ".devguard/memory/change-log.jsonl");
  const telemetry = join(root, ".devguard/telemetry.jsonl");
  for (let i = 0; i < 40; i += 1) {
    await appendBoundedJsonl(changeLog, `${JSON.stringify({ timestamp: String(i), changedFiles: ["y".repeat(100)] })}\n`, tiny);
    await appendBoundedJsonl(telemetry, `${JSON.stringify({ timestamp: String(i), event: "TASK_PREPARED", pad: "z".repeat(100) })}\n`, tiny);
  }
  for (const path of [changeLog, telemetry]) assert.ok(await stat(`${path}.1`).catch(() => false), `${path} rotated`);
  const last = await readBoundedJsonlTail(changeLog, 1 << 20, 1);
  assert.equal(last[0].timestamp, "39");
  const events = await readTaskTelemetry(root, 10);
  assert.deepEqual(events.map((event) => event.timestamp), Array.from({ length: 10 }, (_, i) => String(30 + i)));
});

test("N: concurrent appends from 8 processes across a rotation lose and duplicate nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "devguard-rotate-race-"));
  cleanupRoots.push(root);
  const path = join(root, "log.jsonl");
  const writers = 8;
  const perWriter = 60;
  const lineBytes = 200;
  // Sized so exactly one rotation must happen (total between 1x and 2x the
  // threshold): a second, racing rotation would rename the small new live
  // file over the full `.1` and the lost lines would show up below.
  const rotateBytes = Math.floor((writers * perWriter * lineBytes) / 1.5);
  const script = `
    import { appendBoundedJsonl } from ${JSON.stringify(RETENTION_MODULE)};
    // Under \`node -e\`, user arguments start at argv[1].
    const [path, writer, count, rotateBytes] = process.argv.slice(1);
    for (let i = 0; i < Number(count); i += 1) {
      const line = JSON.stringify({ w: writer, i, pad: "p".repeat(${lineBytes - 40}) });
      await appendBoundedJsonl(path, line + "\\n", { rotateBytes: Number(rotateBytes) });
    }`;
  await Promise.all(
    Array.from({ length: writers }, (_, writer) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, path, String(writer), String(perWriter), String(rotateBytes)], { stdio: "inherit" });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
      })
    )
  );
  const read = async (file) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const all = [...(await read(`${path}.1`)), ...(await read(path))];
  const keys = all.map((record) => `${record.w}:${record.i}`);
  assert.equal(new Set(keys).size, keys.length, "no duplicated line");
  assert.equal(keys.length, writers * perWriter, "no lost line");
  assert.ok(await stat(`${path}.1`).catch(() => false), "a rotation happened");
  assert.equal(await stat(`${path}.rotate.lock`).catch(() => undefined), undefined, "lock released");
});

test("P: crash safety — a crash right after the rename, or a stale rotate lock, never hides the latest record", async () => {
  const root = await makeProject();
  await prepareProject(root);
  const path = join(root, ".devguard/history.jsonl");
  await appendFile(path, `${JSON.stringify({ id: "older" })}\n${JSON.stringify({ id: "latest" })}\n`);
  // Crash after rename: the live file is gone, only `.1` holds the data.
  await rename(path, `${path}.1`);
  assert.equal((await readHistoryRecords(root, 1)).at(-1).id, "latest");
  // A lock left behind by a crashed rotator is reclaimed once stale.
  await appendFile(path, `${JSON.stringify({ id: "big", pad: "q".repeat(4096) })}\n`);
  const lock = `${path}.rotate.lock`;
  await writeFile(lock, "0");
  const old = new Date(Date.now() - 5 * 60_000);
  await utimes(lock, old, old);
  assert.equal(await rotateJsonlIfNeeded(path, tiny), true);
  assert.equal((await readHistoryRecords(root, 1)).at(-1).id, "big");
  // A fresh lock held by another rotator makes this call skip, not block.
  await appendFile(path, `${JSON.stringify({ id: "next", pad: "q".repeat(4096) })}\n`);
  await writeFile(lock, String(Date.now()));
  assert.equal(await rotateJsonlIfNeeded(path, tiny), false);
  await unlink(lock);
});

// --- W-AA: config safety -------------------------------------------------------

test("Z: updating the dev-guard Codex table keeps every other table, comment and nested table", () => {
  const before = 'model = "gpt-5"\n\n[mcp_servers.dev-guard]\ncommand = "dev-guard"\nargs = ["mcp"]\n\n# fast profile\n[profiles.fast]\nmodel = "gpt-5-mini"\n\n[mcp_servers.dev-guard.env]\nX = "1"\n';
  const block = ["[mcp_servers.dev-guard]", 'command = "npx"', 'args = ["--no-install","dev-guard","mcp"]'];
  const after = replaceTomlTable(before, "[mcp_servers.dev-guard]", block);
  assert.equal(after, 'model = "gpt-5"\n\n[mcp_servers.dev-guard]\ncommand = "npx"\nargs = ["--no-install","dev-guard","mcp"]\n\n# fast profile\n[profiles.fast]\nmodel = "gpt-5-mini"\n\n[mcp_servers.dev-guard.env]\nX = "1"\n');
  assert.equal(replaceTomlTable(after, "[mcp_servers.dev-guard]", block), after, "idempotent");
  assert.equal(replaceTomlTable("[other]\nx = 1\n", "[mcp_servers.dev-guard]", block), undefined);
});

test("Z: old-format dev-guard Codex entry is upgraded in place through the real setup path", async () => {
  const root = await makeProject();
  await put(root, ".codex/config.toml", '[mcp_servers.dev-guard]\ncommand = "dev-guard"\nargs = ["mcp"]\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n');
  await put(root, ".mcp.json", JSON.stringify({ mcpServers: { "dev-guard": { command: "dev-guard", args: ["mcp"] }, other: { command: "o" } } }));
  await prepareProject(root);
  const toml = await readFile(join(root, ".codex/config.toml"), "utf8");
  assert.match(toml, /args = \["--no-install","dev-guard","mcp"\]/);
  assert.match(toml, /\[profiles\.fast\]\nmodel = "gpt-5-mini"/);
  const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.other, { command: "o" });
  assert.deepEqual(mcp.mcpServers["dev-guard"].args, ["--no-install", "dev-guard", "mcp"]);
});

test("X/Y: duplicate DevGuard sections collapse to one; user text and unpaired markers are kept", async () => {
  const S = "<!-- dev-guard-section-start -->";
  const E = "<!-- dev-guard-section-end -->";
  const text = `# Mine\n\n${S}\nold A\n${E}\n\nmiddle user text\n\n${S}\nold B\n${E}\n\ntail\n`;
  assert.equal(replaceManagedSections(text, `${S}\nNEW\n${E}`), `# Mine\n\n${S}\nNEW\n${E}\n\nmiddle user text\n\ntail\n`);
  const root = await mkdtemp(join(tmpdir(), "devguard-dup-"));
  cleanupRoots.push(root);
  await writeFile(join(root, "AGENTS.md"), text);
  await ensureAgentInstructions(root);
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  assert.equal(agents.split(S).length - 1, 1);
  assert.ok(agents.startsWith("# Mine\n\n"));
  assert.match(agents, /middle user text/);
  assert.match(agents, /tail\n$/);
});

// --- AB-AE: OpenAI isolation ---------------------------------------------------

test("AC: a shell-wide OPENAI_API_KEY with provider none → setup, watch prep, prepare_task_context and done make zero requests", async () => {
  const root = await makeProject();
  process.env.OPENAI_API_KEY = "sk-dummy-global";
  const fetchSpy = stubFetch();
  try {
    await prepareProject(root);
    await prepareWatchProject(root, { dashboardEnabled: false, dashboardReady: false });
    await prepareTaskContext({ root, task: "Fix computeInvoiceTotal in lib/billing.ts" });
    await put(root, "lib/billing.ts", "export function computeInvoiceTotal(lines: number[]): number { return 1; }\n");
    await processDoneEvent(root);
  } finally {
    fetchSpy.restore();
    delete process.env.OPENAI_API_KEY;
  }
  assert.deepEqual(fetchSpy.calls, []);
  const setup = await cli(root, ["setup"], { OPENAI_API_KEY: "sk-dummy-global" });
  assert.match(setup.stdout, /OpenAI API:\s+not configured \(optional\)/);
  const watchOut = await cli(root, ["doctor"], { OPENAI_API_KEY: "sk-dummy-global" });
  assert.doesNotMatch(watchOut.stdout, /WARNING/);
});

// --- Q-V: documentation and instruction contract --------------------------------

const CURRENT_DOCS = ["README.md", "README.ko.md", "packages/cli/README.md", "docs/npm-setup.md", "docs/npm-setup.ko.md", "docs/commands.md", "docs/watch.md", "docs/configuration.md", "docs/handoff.md", "docs/context-rollover.md", "docs/local-development.md"];

test("Q/V: CLI help and every current-facing doc lead with `dev-guard watch`; setup is optional", async () => {
  const help = await cli(REPO, ["--help"]);
  const gettingStarted = help.stdout.slice(help.stdout.indexOf("Getting Started"));
  assert.ok(gettingStarted.indexOf("dev-guard watch") >= 0);
  assert.ok(gettingStarted.indexOf("dev-guard watch") < gettingStarted.indexOf("setup"), "watch comes before setup");
  assert.match(help.stdout, /Optional\n\n\s+setup\s+Prepare and inspect the project without starting watch/);
  for (const doc of ["README.md", "README.ko.md", "packages/cli/README.md"]) {
    const text = await readFile(join(REPO, doc), "utf8");
    const quick = text.slice(text.search(/## (Quick Start|빠른 시작)/));
    const firstRunBlock = quick.slice(quick.indexOf("```bash", quick.indexOf("```bash") + 1));
    assert.match(firstRunBlock.slice(0, 80), /cd my-project\ndev-guard watch\n```/, `${doc}: first run is watch`);
  }
  for (const doc of CURRENT_DOCS) {
    const text = await readFile(join(REPO, doc), "utf8");
    assert.doesNotMatch(text, /\n(cd [\w-]+\n)?dev-guard setup\ndev-guard watch\n/, `${doc}: setup is not presented as a required step before watch`);
    assert.doesNotMatch(text, /one-time `dev-guard setup`|Recommended — (run once|prepare once)/, doc);
  }
});

test("R/S/T/U: current docs and generated instructions — hybrid threads, MCP first, no key, fallback only as fallback", async () => {
  for (const doc of CURRENT_DOCS) {
    const text = await readFile(join(REPO, doc), "utf8");
    assert.doesNotMatch(text, /Start each distinct task in a fresh|always (use|start) a new (thread|session)/i, doc);
    assert.doesNotMatch(text, /OpenAI (API )?key (is )?required|configure OpenAI before/i, doc);
  }
  const root = await mkdtemp(join(tmpdir(), "devguard-instr-"));
  cleanupRoots.push(root);
  await ensureAgentInstructions(root);
  const text = await readFile(join(root, "CLAUDE.md"), "utf8");
  assert.doesNotMatch(text, /dev-guard setup|dev-guard init|install-hooks first/);
  assert.ok(text.indexOf("prepare_task_context") < text.indexOf("agent-brief.md"));
  assert.match(text, /Only when MCP is unavailable or its result is insufficient/);
  assert.match(text, /small, closely related follow-up/);
  assert.doesNotMatch(text, /OpenAI/);
});
