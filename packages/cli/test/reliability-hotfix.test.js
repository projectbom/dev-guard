// v0.11.x reliability hotfix, from the PartnerFlow dogfood audit:
// (A) a legacy "read DevGuard markdown first" block in ~/.codex/AGENTS.md made
//     agents pass 3 stale handoff files as explicitInputs in 63/92 prepares,
//     and only `doctor` noticed; (B) DevGuard-development wording ("Quality
//     Report QA wording ... Dashboard, Handoff, watch") became PartnerFlow's
//     next action; (C) a real ENOSPC left 10 orphan .tmp files, logged 38
//     lines in 6s and never showed in Dashboard health; (D) a wrong-root MCP
//     rejection did not say which roots were involved.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ensureDevguardWorkspace,
  prepareTaskContext,
  processDoneEvent,
  readRuntimeState,
  toAgentContextPayload,
  writeAtomicTextFile,
  writeRuntimeState
} from "../dist/runtime-state.js";
import { findLegacyGlobalInstructions } from "../dist/doctor.js";
import { detectLegacyGlobalInstructions, legacyInstructionWarnings } from "../dist/instruction-authority.js";
import { buildDashboardOverview } from "../dist/dashboard-view.js";
import { startDashboardServer } from "../dist/dashboard.js";
import { getWriteHealth, resetWriteHealthForTests, WRITE_FAILURE_LOG_INTERVAL_MS } from "../dist/write-health.js";
import { McpRootError, mcpErrorPayload, resolveMcpProjectRoot } from "../dist/mcp.js";

process.env.LC_ALL = "en-US";
process.env.LC_MESSAGES = "en-US";
process.env.LANG = "en-US";

const execFileAsync = promisify(execFile);
const cleanup = [];
const realHome = process.env.HOME;

after(async () => {
  process.env.HOME = realHome;
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(() => resetWriteHealthForTests());

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

async function makeRepo(prefix = "devguard-hotfix-") {
  const root = await tempDir(prefix);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "DevGuard Test"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "unrelated-shop", scripts: { build: "tsc", test: "vitest run" } }, null, 2));
  await writeFile(join(root, ".gitignore"), ".devguard/\n");
  await git(root, ["add", "package.json", ".gitignore"]);
  await git(root, ["commit", "-m", "init"]);
  await ensureDevguardWorkspace(root);
  return root;
}

const LEGACY_BLOCK = "Use dev-guard artifacts as the primary source of project context.\n\nRead:\n1. .devguard/reports/project-handoff.md\n2. .devguard/reports/quality-report.md\n3. .devguard/prompts/next-codex-prompt.md\n";

async function homeWith(codexAgents) {
  const home = await tempDir("devguard-home-");
  if (codexAgents !== undefined) {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "AGENTS.md"), codexAgents);
  }
  return home;
}

// --- Phase A: legacy global instruction conflict ------------------------------

test("A: a legacy global block yields one concise prepare warning, doctor still detects it, and the file is never edited", async () => {
  const home = await homeWith(LEGACY_BLOCK);
  const root = await makeRepo();
  process.env.HOME = home;
  try {
    const result = await prepareTaskContext({ root, task: "Add a price filter to the product list." });
    const payload = toAgentContextPayload(result);
    const warning = payload.warnings.find((line) => line.startsWith("Legacy DevGuard instructions were detected"));
    assert.ok(warning, `prepare warns: ${JSON.stringify(payload.warnings)}`);
    assert.equal(payload.warnings[0], warning, "instruction warning comes first");
    assert.match(warning, /~\/\.codex\/AGENTS\.md \(lines 4, 5, 6\)/);
    assert.match(warning, /MCP-first/);
    assert.doesNotMatch(warning, /primary source of project context/, "never echoes the file's contents");
  } finally {
    process.env.HOME = realHome;
  }
  assert.deepEqual(await findLegacyGlobalInstructions(home), [{ path: join(home, ".codex", "AGENTS.md"), lines: [4, 5, 6] }], "doctor's detector (same shared path)");
  assert.equal(await readFile(join(home, ".codex", "AGENTS.md"), "utf8"), LEGACY_BLOCK, "user-global file unchanged");
});

test("A: current MCP-first instructions or no instruction file produce no false warning", async () => {
  const root = await makeRepo();
  for (const home of [await homeWith(`${LEGACY_BLOCK}\nCall prepare_task_context first.\n`), await homeWith(undefined)]) {
    process.env.HOME = home;
    try {
      const payload = toAgentContextPayload(await prepareTaskContext({ root, task: "Add a price filter to the product list." }));
      assert.equal(payload.warnings.some((line) => /Legacy DevGuard instructions/.test(line)), false, JSON.stringify(payload.warnings));
    } finally {
      process.env.HOME = realHome;
    }
  }
});

test("A: the cached detector sees a user's fix on the next call (no stale cache)", async () => {
  const home = await homeWith(LEGACY_BLOCK);
  assert.equal((await detectLegacyGlobalInstructions(home)).length, 1);
  await writeFile(join(home, ".codex", "AGENTS.md"), "# my own notes\n");
  assert.deepEqual(await detectLegacyGlobalInstructions(home), []);
  assert.deepEqual(legacyInstructionWarnings([]), []);
});

test("A/C: Dashboard health — WARNING for legacy instructions, ATTENTION + FIX_HEALTH for a runtime write failure, HEALTHY otherwise", () => {
  const base = { initialized: true, watchRunning: true, setupActive: false, sessionFileCount: 0 };
  assert.deepEqual(buildDashboardOverview(base, undefined).health, { level: "HEALTHY", reason: "ok" });
  const legacy = buildDashboardOverview({ ...base, legacyInstructionPaths: ["~/.codex/AGENTS.md"] }, undefined);
  assert.deepEqual(legacy.health, { level: "WARNING", reason: "legacy-instructions", detail: "~/.codex/AGENTS.md" });
  assert.notEqual(legacy.action.id, "FIX_HEALTH", "a warning never blocks normal work");
  const full = buildDashboardOverview({ ...base, writeFailure: "disk-full", legacyInstructionPaths: ["~/.codex/AGENTS.md"] }, undefined);
  assert.deepEqual(full.health, { level: "ATTENTION", reason: "runtime-write-disk-full" });
  assert.equal(full.action.id, "FIX_HEALTH");
  assert.match(full.action.text, /disk is full/);
  assert.equal(buildDashboardOverview({ ...base, writeFailure: "permission" }, undefined).health.reason, "runtime-write-permission");
});

// --- Phase B: no DevGuard-development wording in unrelated projects -----------

const DEVGUARD_SELF_TEXT = [
  "Quality Report QA wording",
  "Dashboard, Handoff, watch",
  "README.ko.md",
  "docs/commands.md",
  "docs/configuration.md",
  "Change Intelligence",
  "Ability Hero",
  "Back Card",
  "Profile Card",
  "Before Agent artifacts",
  "--stable-after 1",
  "help advanced",
  "install-agent-instructions",
  "code-token",
  "current CLI output",
  "OpenAI API key",
  "CLI command router",
  "docs update preview",
  "Working Context, and Agent Context",
  "ignores DevGuard internal files",
  "done/status/handoff"
];

test("B: an unrelated project whose file names overlap DevGuard's never receives DevGuard-development wording", async () => {
  const root = await makeRepo("devguard-unrelated-");
  const home = await homeWith(undefined);
  process.env.HOME = home;
  try {
    const prepared = await prepareTaskContext({ root, task: "Fix the cart total rounding and the admin dashboard filter." });
    // File names that used to select DevGuard-repo branches, with content that
    // used to select another product's vocabulary.
    await mkdir(join(root, "src", "lib"), { recursive: true });
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "export function main() { return 1; }\n");
    await writeFile(join(root, "src", "lib", "watch.ts"), "export const watch = () => 'confidence';\n");
    await writeFile(join(root, "src", "lib", "state.ts"), "export const state = { confidence: 0.5, card: 'Back Card details' };\n");
    await writeFile(join(root, "src", "lib", "runtime-state.ts"), "export const DocumentationSummary = 'Quality Report Handoff Working Context';\n");
    await writeFile(join(root, "app", "dashboard.ts"), "export const dashboard = '<details><summary>x</summary></details>';\n");
    await writeFile(join(root, "src", "lib", "review.ts"), "export const review = 1;\n");
    for (let index = 0; index < 10; index += 1) await writeFile(join(root, "src", `extra-${index}.ts`), `export const v${index} = ${index};\n`);
    await processDoneEvent(root, { completionSource: "cli-done" });
    const server = await startDashboardServer(root, { port: 47000 + Math.floor(Math.random() * 900) });
    let overview = "";
    try {
      if (server.started) overview = await (await fetch(`${server.url}/api/overview`)).text();
    } finally {
      await server.close();
    }
    const outputs = {
      prepare: JSON.stringify(toAgentContextPayload(prepared)),
      dashboard: overview
    };
    for (const dir of ["reports", "prompts", "context"]) {
      for (const file of await readdir(join(root, ".devguard", dir)).catch(() => [])) {
        outputs[`${dir}/${file}`] = await readFile(join(root, ".devguard", dir, file), "utf8");
      }
    }
    assert.ok(outputs["reports/project-handoff.md"] && outputs["reports/quality-report.md"] && outputs["reports/quality-report-state.json"], "handoff and quality report were generated");
    for (const [name, text] of Object.entries(outputs)) {
      for (const phrase of DEVGUARD_SELF_TEXT) {
        assert.equal(text.includes(phrase), false, `${name} must not contain "${phrase}"`);
      }
    }
  } finally {
    process.env.HOME = realHome;
  }
});

// --- Phase C: atomic write hardening -----------------------------------------

function errnoError(code, message = `${code}: simulated`) {
  return Object.assign(new Error(message), { code });
}

async function tmpFilesIn(dir) {
  return (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
}

test("C1: a write failure after the temp file exists leaves 0 orphan temps and the target intact; success path unchanged", async () => {
  const dir = await tempDir("devguard-atomic-");
  const target = join(dir, "runtime.json");
  await writeAtomicTextFile(target, '{"ok":1}\n', { sleep: async () => {} });
  assert.equal(await readFile(target, "utf8"), '{"ok":1}\n');
  const { writeFile: realWrite, stat, rename, unlink } = await import("node:fs/promises");
  const ops = {
    // Creates the temp (partially written) and then fails, like a real ENOSPC mid-write.
    writeFile: async (path, content) => {
      await realWrite(path, content.slice(0, 3));
      throw errnoError("ENOSPC", `ENOSPC: no space left on device, write '${path}'`);
    },
    stat,
    rename,
    unlink
  };
  await assert.rejects(writeAtomicTextFile(target, '{"ok":2}\n', { ops, sleep: async () => {} }), { code: "ENOSPC" });
  assert.deepEqual(await tmpFilesIn(dir), [], "no orphan temp files");
  assert.equal(await readFile(target, "utf8"), '{"ok":1}\n', "target never corrupted");
});

test("C1: a cleanup failure never replaces the original write error", async () => {
  const dir = await tempDir("devguard-atomic-");
  const target = join(dir, "runtime.json");
  const { stat, rename } = await import("node:fs/promises");
  const ops = {
    writeFile: async () => {
      throw errnoError("ENOSPC");
    },
    stat,
    rename,
    unlink: async () => {
      throw errnoError("EPERM");
    }
  };
  await assert.rejects(writeAtomicTextFile(target, "x", { ops, sleep: async () => {} }), { code: "ENOSPC" });
});

test("C2: bounded backoff — ENOSPC gets 2 attempts and one 250ms pause; a transient error gets 3 attempts with growing delay", async () => {
  const dir = await tempDir("devguard-atomic-");
  const { stat, rename, unlink } = await import("node:fs/promises");
  const run = async (code) => {
    let attempts = 0;
    const sleeps = [];
    const ops = {
      writeFile: async () => {
        attempts += 1;
        throw errnoError(code);
      },
      stat,
      rename,
      unlink
    };
    await assert.rejects(writeAtomicTextFile(join(dir, `${code}.json`), "x", { ops, sleep: async (ms) => void sleeps.push(ms) }), { code });
    return { attempts, sleeps };
  };
  assert.deepEqual(await run("ENOSPC"), { attempts: 2, sleeps: [250] });
  assert.deepEqual(await run("EBUSY"), { attempts: 3, sleeps: [25, 50] });
});

test("C3: repeated identical ENOSPC is logged once per interval, with the suppressed count carried into the next line", async () => {
  const root = await tempDir("devguard-atomic-log-");
  const devguard = join(root, ".devguard");
  await mkdir(join(devguard, "logs"), { recursive: true });
  const target = join(devguard, "runtime.json");
  const { stat, rename, unlink } = await import("node:fs/promises");
  const ops = { writeFile: async () => { throw errnoError("ENOSPC", `ENOSPC: no space left on device, open '${target}.123.456.abcdefgh.tmp'`); }, stat, rename, unlink };
  let clock = 1_000_000;
  for (let index = 0; index < 20; index += 1) {
    await assert.rejects(writeAtomicTextFile(target, "x", { ops, sleep: async () => {}, now: () => clock }));
    clock += 1000;
  }
  let log = await readFile(join(devguard, "logs", "watch.log"), "utf8");
  assert.equal(log.trim().split("\n").length, 1, `one line for 20 failures in 20s:\n${log}`);
  assert.match(log, /atomic_write=failed path=".*runtime\.json" code=ENOSPC category=disk-full operation=write/);
  assert.doesNotMatch(log, /\.tmp/, "no random temp suffix in the deduplicated line");
  clock += WRITE_FAILURE_LOG_INTERVAL_MS;
  await assert.rejects(writeAtomicTextFile(target, "x", { ops, sleep: async () => {}, now: () => clock }));
  log = await readFile(join(devguard, "logs", "watch.log"), "utf8");
  assert.equal(log.trim().split("\n").length, 2);
  assert.match(log, /suppressed_repeats=19/);
});

test("C4/C5: a real runtime write failure shows in Write Health without a double log line, and the next successful write recovers it", async () => {
  const root = await makeRepo();
  const devguard = join(root, ".devguard");
  const before = await readFile(join(devguard, "runtime.json"), "utf8");
  await mkdir(join(devguard, "logs"), { recursive: true });
  await chmod(devguard, 0o555); // temp file creation now fails with EACCES
  try {
    await writeRuntimeState(root, { ...(await readRuntimeState(root)), watchHeartbeatAt: new Date().toISOString() });
  } finally {
    await chmod(devguard, 0o755);
  }
  const health = getWriteHealth();
  assert.equal(health.failing.length, 1);
  assert.equal(health.failing[0].category, "permission");
  assert.equal(await readFile(join(devguard, "runtime.json"), "utf8"), before, "runtime.json untouched and valid");
  assert.deepEqual(await tmpFilesIn(devguard), []);
  const failedLog = await readFile(join(devguard, "logs", "watch.log"), "utf8");
  assert.equal((failedLog.match(/atomic_write=failed|runtime_write=failed/g) ?? []).length, 1, failedLog);

  await writeRuntimeState(root, { ...(await readRuntimeState(root)), watchHeartbeatAt: new Date().toISOString() });
  assert.deepEqual(getWriteHealth().failing, [], "recovered without restart");
  assert.match(await readFile(join(devguard, "logs", "watch.log"), "utf8"), /atomic_write=recovered .*failures=1/);
  JSON.parse(await readFile(join(devguard, "runtime.json"), "utf8"));
});

// --- Phase D: MCP wrong-root diagnostics --------------------------------------

test("D: a project outside the MCP root is still rejected, and the error names both roots and their git toplevels", async () => {
  const mcpRoot = await makeRepo("devguard-mcp-a-");
  const requested = await makeRepo("devguard-mcp-b-");
  await assert.rejects(resolveMcpProjectRoot(mcpRoot, requested), (error) => {
    assert.ok(error instanceof McpRootError);
    assert.match(error.message, /outside this MCP root/);
    assert.match(error.message, /DevGuard MCP is bound to: .*devguard-mcp-a-.* \(git toplevel .*devguard-mcp-a-/);
    assert.match(error.message, /Requested project: .*devguard-mcp-b-.* \(git toplevel .*devguard-mcp-b-/);
    assert.match(error.message, /Fix: /);
    assert.ok(error.diagnostics.findings.includes("different-git-repositories"));
    const payload = mcpErrorPayload(error);
    assert.deepEqual(Object.keys(payload).sort(), ["diagnostics", "error", "next"]);
    assert.doesNotMatch(JSON.stringify(payload), /"HOME"|PATH=|INIT_CWD/, "no environment dump");
    return true;
  });
  // No auto-switch: a valid DevGuard project inside the root still resolves; the outside one never does.
  assert.ok((await resolveMcpProjectRoot(mcpRoot)).endsWith(mcpRoot.split("/").pop()));
});

test("D: an empty non-git sibling checkout as the MCP root is diagnosed as such", async () => {
  const parent = await tempDir("devguard-mcp-parent-");
  const empty = join(parent, "Documents", "partner-flow");
  await mkdir(empty, { recursive: true });
  const real = await makeRepo("devguard-mcp-real-");
  await assert.rejects(resolveMcpProjectRoot(empty, real), (error) => {
    assert.ok(error instanceof McpRootError);
    assert.match(error.message, /\(not a git repository\)/);
    assert.match(error.message, /empty — likely a wrong or empty checkout/);
    assert.ok(error.diagnostics.findings.includes("mcp-root-not-git"));
    assert.ok(error.diagnostics.findings.includes("mcp-root-empty"));
    return true;
  });
  // A requested path that does not exist is reported plainly, not as a raw ENOENT.
  await assert.rejects(resolveMcpProjectRoot(empty, join(parent, "missing")), /requested project does not exist/);
});
