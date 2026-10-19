// v0.11.2: the legacy-instruction resolution loop. Detection already worked
// (prepare warning, Dashboard WARNING, doctor), but the user could only fix
// ~/.codex/AGENTS.md by hand. `dev-guard doctor --agents --fix` now removes
// only a recognized obsolete DevGuard block — after a preview, a default-NO
// confirmation and a byte-identical backup — and the warning clears on the
// next prepare / Dashboard poll. All fixtures use a scratch HOME; the user's
// real global files are never touched.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { ensureDevguardWorkspace, prepareTaskContext, toAgentContextPayload } from "../dist/runtime-state.js";
import { detectLegacyGlobalInstructions } from "../dist/instruction-authority.js";
import { applyLegacyInstructionFix, formatLineRanges, planLegacyInstructionFixes, planLegacyRemoval } from "../dist/instruction-fix.js";
import { runLegacyInstructionFix } from "../dist/doctor.js";
import { buildDashboardOverview } from "../dist/dashboard-view.js";

process.env.LC_ALL = "en-US";
process.env.LC_MESSAGES = "en-US";
process.env.LANG = "en-US";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const cleanup = [];
const realHome = process.env.HOME;

after(async () => {
  process.env.HOME = realHome;
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

// A: the block as users actually pasted it (PartnerFlow's ~/.codex/AGENTS.md shape).
const LEGACY_BLOCK = [
  "Use dev-guard artifacts as the primary source of project context.",
  "",
  "Read:",
  "1. .devguard/reports/project-handoff.md",
  "2. .devguard/reports/quality-report.md",
  "3. .devguard/prompts/next-codex-prompt.md",
  "",
  "Do not perform repository-wide scans before reading them.",
  "",
  "Treat the dev-guard documents as the current project state and continue from there.",
  "",
  "Only open additional files when required to complete the task."
].join("\n");

// G: the v0.2-era template (markers + Startup Instructions) — a second historical shape.
const OLD_TEMPLATE = [
  "<!-- dev-guard-section-start -->",
  "",
  "## Startup Instructions",
  "",
  "1. Read `.devguard/context/agent-context.md`",
  "2. Read `.devguard/reports/project-handoff.md`",
  "3. Read `.devguard/reports/quality-report.md`",
  "",
  "Use dev-guard artifacts as the primary source of project context.",
  "Do not perform repository-wide scans before reading them.",
  "Only open additional files when required for the current task.",
  "Continue from the latest dev-guard state.",
  "",
  "<!-- dev-guard-section-end -->"
].join("\n");

const USER_TOP = "# My global rules\n\n- Prefer small diffs.\n- Answer in Korean.  \n\n";
const USER_BOTTOM = "\n\n## Personal notes\n\nI sometimes open DevGuard's dashboard myself.\n";

async function homeWith(codexAgents) {
  const home = await tempDir("devguard-fix-home-");
  if (codexAgents !== undefined) {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "AGENTS.md"), codexAgents);
  }
  return home;
}

const agentsPath = (home) => join(home, ".codex", "AGENTS.md");
const backupsIn = async (home) => (await readdir(join(home, ".codex"))).filter((name) => name.startsWith("AGENTS.md.devguard-backup-"));

async function captureFix(options) {
  const lines = [];
  const original = console.log;
  const exitBefore = process.exitCode;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await runLegacyInstructionFix(options);
  } finally {
    console.log = original;
  }
  const exitCode = process.exitCode;
  process.exitCode = exitBefore;
  return { out: lines.join("\n"), exitCode };
}

async function makeRepo() {
  const root = await tempDir("devguard-fix-repo-");
  const git = (args) => execFileAsync("git", args, { cwd: root });
  await git(["init"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "DevGuard Test"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "shop", scripts: { test: "vitest run" } }, null, 2));
  await writeFile(join(root, ".gitignore"), ".devguard/\n");
  await git(["add", "package.json", ".gitignore"]);
  await git(["commit", "-m", "init"]);
  await ensureDevguardWorkspace(root);
  return root;
}

// --- planner: ownership --------------------------------------------------------

test("1/A: the exact legacy block is detected and recognized as one removable block", () => {
  const plan = planLegacyRemoval(LEGACY_BLOCK);
  assert.equal(plan.status, "fixable");
  assert.deepEqual(plan.conflictLines, [4, 5, 6]);
  assert.equal(plan.blocks.length, 1);
  assert.deepEqual([plan.blocks[0].startLine, plan.blocks[0].endLine], [1, 12]);
  assert.equal(plan.next, "", "the file held only the block");
  assert.equal(formatLineRanges(plan.conflictLines), "4–6");
});

test("5/B: mixed user text keeps every surrounding byte; only the block (and its blank gap) goes", () => {
  const text = `${USER_TOP}${LEGACY_BLOCK}${USER_BOTTOM}`;
  const plan = planLegacyRemoval(text);
  assert.equal(plan.status, "fixable");
  assert.equal(plan.next, `${USER_TOP}## Personal notes\n\nI sometimes open DevGuard's dashboard myself.\n`);
  assert.ok(plan.next.startsWith(USER_TOP), "prefix bytes identical, trailing spaces included");
  // A block at the end of the file takes the gap before it, not the user's last newline.
  assert.equal(planLegacyRemoval(`${USER_TOP}${LEGACY_BLOCK}\n`).next, "# My global rules\n\n- Prefer small diffs.\n- Answer in Korean.  \n");
});

test("7/C: CRLF files stay CRLF and keep their final-newline behavior", () => {
  const crlf = `${USER_TOP}${LEGACY_BLOCK}${USER_BOTTOM}`.replace(/\n/g, "\r\n");
  const plan = planLegacyRemoval(crlf);
  assert.equal(plan.status, "fixable");
  assert.equal(plan.next, `${USER_TOP}## Personal notes\n\nI sometimes open DevGuard's dashboard myself.\n`.replace(/\n/g, "\r\n"));
  assert.doesNotMatch(plan.next.replace(/\r\n/g, ""), /\n/, "no bare LF introduced");
  const noFinalNewline = `${USER_TOP}${LEGACY_BLOCK}\r\n\r\n## Notes\r\nkeep`.replace(/(?<!\r)\n/g, "\r\n");
  assert.ok(planLegacyRemoval(noFinalNewline).next.endsWith("## Notes\r\nkeep"));
});

test("9/D/E: similar-but-not-exact DevGuard text and unrelated handoff wording refuse auto-fix", () => {
  const similar = "Before coding I like to skim .devguard/reports/project-handoff.md and the quality-report when I feel lost.\n";
  const plan = planLegacyRemoval(`${USER_TOP}${similar}`);
  assert.equal(plan.status, "ambiguous");
  assert.deepEqual(plan.reviewLines, [6]);
  assert.equal(plan.next, undefined);
  // A path list without any "treat DevGuard as the project state" directive is not confidently ours.
  assert.equal(planLegacyRemoval("Read:\n1. .devguard/reports/project-handoff.md\n").status, "ambiguous");
  // A legacy block plus a stray flagged user line: refuse the whole file, never half-fix.
  const mixed = planLegacyRemoval(`${LEGACY_BLOCK}\n\nMy note: .devguard/reports/quality-report.md is noisy.\n`);
  assert.equal(mixed.status, "ambiguous");
  assert.deepEqual(mixed.reviewLines, [14]);
  // Plain handoff/quality wording without a DevGuard path is not a conflict at all.
  assert.equal(planLegacyRemoval("Write a handoff note and a quality report at the end of each day.\n").status, "clean");
});

test("8/F: current MCP-first instructions are clean (nothing to fix)", () => {
  assert.equal(planLegacyRemoval("Call prepare_task_context first; do not read .devguard/reports/project-handoff.md.\n").status, "clean");
  assert.equal(planLegacyRemoval("").status, "clean");
});

test("G: two historical blocks in one file are both removed, user text between them kept", () => {
  const text = `${OLD_TEMPLATE}\n\n# Mine\nkeep me\n\n${LEGACY_BLOCK}\n`;
  const plan = planLegacyRemoval(text);
  assert.equal(plan.status, "fixable");
  assert.equal(plan.blocks.length, 2);
  assert.equal(plan.next, "# Mine\nkeep me\n");
});

// --- the CLI flow ----------------------------------------------------------------

test("2/3: dry-run and the default NO answer write nothing and create no backup", async () => {
  const original = `${USER_TOP}${LEGACY_BLOCK}${USER_BOTTOM}`;
  const home = await homeWith(original);
  const dry = await captureFix({ dryRun: true, home, ask: async () => assert.fail("dry-run never asks") });
  assert.match(dry.out, /Found obsolete DevGuard instructions:/);
  assert.match(dry.out, /~\/\.codex\/AGENTS\.md/);
  assert.match(dry.out, /conflicting lines 9–11/);
  assert.match(dry.out, /block to remove: lines 6–17/);
  assert.match(dry.out, /- Use dev-guard artifacts as the primary source of project context\./, "recognized template preview");
  assert.match(dry.out, /will NOT touch: the other \d+ line\(s\) of this file/);
  assert.match(dry.out, /Dry run: nothing was changed/);
  assert.doesNotMatch(dry.out, /Prefer small diffs|Personal notes/, "never prints the user's own text");
  for (const answer of ["", "n", "no", "maybe"]) {
    const declined = await captureFix({ dryRun: false, home, ask: async (question) => (assert.match(question, /Continue\? \[y\/N\]/), answer) });
    assert.match(declined.out, /No changes made\./);
  }
  assert.equal(await readFile(agentsPath(home), "utf8"), original);
  assert.deepEqual(await backupsIn(home), []);
});

test("4/5/6/10/14: YES removes only the block, backs up byte-identically, clears the cached detector, and a repeat is a no-op", async () => {
  const original = `${USER_TOP}${LEGACY_BLOCK}${USER_BOTTOM}`.replace(/\n/g, "\r\n");
  const home = await homeWith(original);
  assert.equal((await detectLegacyGlobalInstructions(home)).length, 1, "warm the stat cache with the conflict");
  const fixed = await captureFix({ dryRun: false, home, ask: async () => "y" });
  assert.match(fixed.out, /✓ Removed obsolete DevGuard instructions/);
  assert.match(fixed.out, /✓ Backup: .*AGENTS\.md\.devguard-backup-\d{8}T\d{6}Z/);
  assert.match(fixed.out, /✓ MCP-first instruction conflict cleared/);
  assert.equal(fixed.exitCode, undefined);
  assert.equal(await readFile(agentsPath(home), "utf8"), `${USER_TOP}## Personal notes\n\nI sometimes open DevGuard's dashboard myself.\n`.replace(/\n/g, "\r\n"));
  const backups = await backupsIn(home);
  assert.equal(backups.length, 1);
  assert.ok((await readFile(join(home, ".codex", backups[0]))).equals(Buffer.from(original, "utf8")), "backup byte-identical");
  assert.deepEqual(await detectLegacyGlobalInstructions(home), [], "cached detector sees the fix immediately");
  const again = await captureFix({ dryRun: false, home, ask: async () => assert.fail("nothing to confirm") });
  assert.match(again.out, /PASS Agent instructions are compatible/);
  assert.equal((await backupsIn(home)).length, 1, "a no-op run creates no new backup");
});

test("6: an existing backup name is never overwritten; a failed backup leaves the original untouched", async () => {
  const home = await homeWith(LEGACY_BLOCK);
  const now = new Date("2026-10-19T01:02:03.456Z");
  const taken = `${agentsPath(home)}.devguard-backup-20261019T010203Z`;
  await writeFile(taken, "someone else's backup");
  const [plan] = await planLegacyInstructionFixes(home);
  const outcome = await applyLegacyInstructionFix(plan, { home, now });
  assert.equal(outcome.status, "FIXED");
  assert.equal(outcome.backupPath, `${taken}-2`);
  assert.equal(await readFile(taken, "utf8"), "someone else's backup");

  const home2 = await homeWith(LEGACY_BLOCK);
  const [plan2] = await planLegacyInstructionFixes(home2);
  // A read-only directory: the backup cannot be created, so the original must not be touched.
  const { chmod } = await import("node:fs/promises");
  await chmod(join(home2, ".codex"), 0o500);
  try {
    const failed = await applyLegacyInstructionFix(plan2, { home: home2 });
    if (process.getuid?.() !== 0) {
      assert.equal(failed.status, "FAILED");
      assert.match(failed.reason, /backup failed, the file was not modified/);
    }
  } finally {
    await chmod(join(home2, ".codex"), 0o700);
  }
  assert.equal(await readFile(agentsPath(home2), "utf8"), LEGACY_BLOCK);
});

test("symlinked AGENTS.md: the link stays a link and its target is fixed", async () => {
  const home = await homeWith(undefined);
  const dotfiles = await tempDir("devguard-dotfiles-");
  await writeFile(join(dotfiles, "AGENTS.md"), `${USER_TOP}${LEGACY_BLOCK}\n`);
  await mkdir(join(home, ".codex"), { recursive: true });
  await symlink(join(dotfiles, "AGENTS.md"), agentsPath(home));
  const [plan] = await planLegacyInstructionFixes(home);
  assert.equal((await applyLegacyInstructionFix(plan, { home })).status, "FIXED");
  const { lstat } = await import("node:fs/promises");
  assert.ok((await lstat(agentsPath(home))).isSymbolicLink());
  assert.equal(await readFile(join(dotfiles, "AGENTS.md"), "utf8"), "# My global rules\n\n- Prefer small diffs.\n- Answer in Korean.  \n");
});

test("9: ambiguous files are refused with the lines to review, and never modified", async () => {
  const text = `${USER_TOP}See .devguard/reports/quality-report.md when debugging.\n`;
  const home = await homeWith(text);
  const refused = await captureFix({ dryRun: false, home, ask: async () => assert.fail("never asks for a refused file") });
  assert.match(refused.out, /REFUSE AUTO-FIX ~\/\.codex\/AGENTS\.md/);
  assert.match(refused.out, /Lines to review by hand: 6/);
  assert.equal(refused.exitCode, 1);
  assert.equal(await readFile(agentsPath(home), "utf8"), text);
  assert.deepEqual(await backupsIn(home), []);
});

test("13: doctor --agents changes WARN → PASS after the fix (real CLI, scratch HOME, piped confirmation)", async () => {
  const home = await homeWith(`${USER_TOP}${LEGACY_BLOCK}\n`);
  const cwd = await tempDir("devguard-fix-cwd-");
  const env = { ...process.env, HOME: home, NO_COLOR: "1" };
  const before = await execFileAsync(process.execPath, [CLI, "doctor", "--agents"], { cwd, env });
  assert.match(before.stdout, /WARN Legacy DevGuard instructions detected\nFile: ~\/\.codex\/AGENTS\.md\nLines: 9–11\nFix: dev-guard doctor --agents --fix/);
  // Closed stdin = default NO.
  const declined = await runWithStdin([CLI, "doctor", "--agents", "--fix"], "", { cwd, env });
  assert.match(declined, /No changes made\./);
  assert.equal((await backupsIn(home)).length, 0);
  const confirmed = await runWithStdin([CLI, "doctor", "--agents", "--fix"], "y\n", { cwd, env });
  assert.match(confirmed, /✓ MCP-first instruction conflict cleared/);
  const afterFix = await execFileAsync(process.execPath, [CLI, "doctor", "--agents"], { cwd, env });
  assert.match(afterFix.stdout, /PASS Agent instructions are compatible with the current DevGuard workflow/);
  assert.doesNotMatch(afterFix.stdout, /WARN Legacy/);
});

function runWithStdin(args, input, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", () => resolve(out));
    child.stdin.end(input);
  });
}

// --- prepare + Dashboard recovery ------------------------------------------------

test("11: the prepare warning names the fix command and disappears on the next call after the fix", async () => {
  const home = await homeWith(`${USER_TOP}${LEGACY_BLOCK}\n`);
  const root = await makeRepo();
  process.env.HOME = home;
  try {
    const before = toAgentContextPayload(await prepareTaskContext({ root, task: "Add a price filter to the product list." }));
    assert.match(before.warnings[0], /^Legacy DevGuard instructions were detected in ~\/\.codex\/AGENTS\.md \(lines 9, 10, 11\)\./);
    assert.match(before.warnings[0], /dev-guard doctor --agents --fix$/);
    const [plan] = await planLegacyInstructionFixes(home);
    assert.equal((await applyLegacyInstructionFix(plan, { home })).status, "FIXED");
    const afterFix = toAgentContextPayload(await prepareTaskContext({ root, task: "Add a price filter to the product list." }));
    assert.equal(afterFix.warnings.some((line) => /Legacy DevGuard instructions/.test(line)), false, JSON.stringify(afterFix.warnings));
  } finally {
    process.env.HOME = realHome;
  }
});

const PLAN_OUTSIDE = { id: "MISSING_REQUIRED_INPUTS", severity: "strong", issue: "Many files outside the read plan were searched for and read.", why: "9 of 12 reads were outside the plan.", action: "Name the other files the task depends on.", evidence: "OBSERVED" };
const report = { now: { thread: { state: "CONTINUE", reason: "low", evidence: "OBSERVED" }, task: "Fix cart", primaryIssue: PLAN_OUTSIDE, otherIssues: [] }, current: undefined };
const base = { initialized: true, watchRunning: true, setupActive: false, sessionFileCount: 0 };

test("12/15: while the conflict is active it is the primary issue with the CLI fix as the action; plan-outside becomes secondary; after the fix normal priority resumes", () => {
  const active = buildDashboardOverview({ ...base, legacyInstructionPaths: ["~/.codex/AGENTS.md"] }, report);
  assert.deepEqual(active.health, { level: "WARNING", reason: "legacy-instructions", detail: "~/.codex/AGENTS.md" });
  assert.equal(active.issue.id, "LEGACY_INSTRUCTIONS");
  assert.match(active.issue.why, /can pull agents toward stale files/, "careful causal wording");
  assert.doesNotMatch(active.issue.why, /caus(e|ed|es) (all|every)/);
  assert.deepEqual(active.action, { id: "FIX_INSTRUCTIONS", text: "Remove the obsolete DevGuard instructions:", command: "dev-guard doctor --agents --fix" });
  assert.equal(active.secondaryIssues[0].id, "MISSING_REQUIRED_INPUTS", "plan-outside stays visible in Details");

  const fixed = buildDashboardOverview({ ...base, legacyInstructionPaths: [] }, report);
  assert.deepEqual(fixed.health, { level: "HEALTHY", reason: "ok" });
  assert.equal(fixed.issue.id, "MISSING_REQUIRED_INPUTS");
  assert.equal(fixed.action.id, "FIX_ISSUE");
  assert.deepEqual(fixed.secondaryIssues, []);

  // A broken setup still outranks the warning.
  assert.equal(buildDashboardOverview({ ...base, watchRunning: false, legacyInstructionPaths: ["~/.codex/AGENTS.md"] }, report).action.id, "START_WATCH");
});

test("12: the Dashboard page renders the compact legacy note (short title, path, collapsed details) and never offers a browser-side fix", async () => {
  const { readFile: read } = await import("node:fs/promises");
  const source = await read(fileURLToPath(new URL("../dist/dashboard.js", import.meta.url)), "utf8");
  assert.match(source, /ov-health-compact/);
  assert.match(source, /ov-health-more/);
  const i18n = await read(fileURLToPath(new URL("../dist/dashboard-i18n.js", import.meta.url)), "utf8");
  assert.match(i18n, /"ovHealthReason_legacy-instructions": "예전 DevGuard 지침이 감지됨"/);
  assert.match(i18n, /ovAct_FIX_INSTRUCTIONS: "해결:"/);
  assert.match(i18n, /iss_LEGACY_INSTRUCTIONS: "예전 DevGuard 지침이 현재 MCP 흐름과 충돌합니다\."/);
  assert.doesNotMatch(source, /\/api\/[a-z-]*fix/i, "no dashboard endpoint mutates instruction files");
});
