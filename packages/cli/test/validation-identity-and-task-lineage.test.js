// Regression tests for this round's stabilization pass:
//   - QA storage identity is actually kind+name (not name alone)
//   - legacy qaResults migration (bare-name keys) loads without crashing
//   - code-state identity is content-based, not commit-based (Case A vs Case B)
//   - task identity no longer depends on task-text equality
//   - stale vs never-recorded evidence are distinguishable internally
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ensureDevguardWorkspace,
  prepareTaskContext,
  processDoneEvent,
  recordValidationEvidence,
  recordQAExecutionResult,
  readRuntimeState
} from "../dist/runtime-state.js";
import { computeWorkingTreeContentHash } from "../dist/git.js";

// These assertions check rendered prose against DevGuard's documented
// default locale (en-US). DevGuard's locale resolution intentionally reads
// LC_ALL/LC_MESSAGES/LANG when a project has no explicit `.devguard/config.json`
// locale (see src/locale.ts) — correct, deliberate behavior for a real ko-KR
// host, but it left these assertions accidentally dependent on whatever OS
// locale happens to run the test. Pin it so the suite is deterministic
// regardless of the host machine's locale.
process.env.LC_ALL = "en-US";
process.env.LC_MESSAGES = "en-US";
process.env.LANG = "en-US";

const execFileAsync = promisify(execFile);
const cleanupRoots = [];

after(async () => {
  await Promise.all(cleanupRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), "devguard-identity-"));
  cleanupRoots.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "DevGuard Test"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "sample", scripts: { build: "true" } }, null, 2));
  await writeFile(join(root, ".gitignore"), ".devguard/\n");
  await writeFile(join(root, "README.md"), "# sample\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "init"]);
  return root;
}

async function readQuality(root) {
  return readFile(join(root, ".devguard/reports/quality-report.md"), "utf8");
}

async function readHandoff(root) {
  return readFile(join(root, ".devguard/reports/project-handoff.md"), "utf8");
}

// --- Storage identity: kind + name, not name alone -------------------------

test("Test A: BUILD/ci and TEST/ci do not collide — both are stored and reported", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await recordValidationEvidence({ root, kind: "BUILD", name: "ci", status: "PASS", command: "pnpm build" });
  await recordValidationEvidence({ root, kind: "TEST", name: "ci", status: "FAIL", reason: "3 tests failed" });

  const runtime = await readRuntimeState(root);
  assert.equal(Object.keys(runtime.qaResults).length, 2, "both entries must be stored under distinct keys");

  await processDoneEvent(root);
  const quality = await readQuality(root);
  // Each kind has only one distinct identity ("ci"), so it renders
  // unqualified (see formatKindRows) — the important assertion is that
  // BUILD's PASS and TEST's FAIL are both present and independent.
  assert.match(quality, /Build\s*\|\s*✅ PASS/);
  assert.match(quality, /Targeted Tests\s*\|\s*❌ FAIL/);
});

test("Test B: BUILD/frontend and BUILD/backend are independent (same kind, different name)", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await recordValidationEvidence({ root, kind: "BUILD", name: "frontend", status: "FAIL", reason: "type error" });
  await recordValidationEvidence({ root, kind: "BUILD", name: "backend", status: "PASS" });

  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.match(quality, /Build: frontend\s*\|\s*❌ FAIL/);
  assert.match(quality, /Build: backend\s*\|\s*✅ PASS/);
});

test("Test C: within the same identity, the latest-by-timestamp result wins", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await recordQAExecutionResult(root, {
    name: "frontend",
    kind: "BUILD",
    status: "FAIL",
    command: "pnpm build",
    startedAt: "2026-01-01T10:00:00.000Z",
    completedAt: "2026-01-01T10:00:00.000Z",
    durationMs: 1000
  });
  await recordQAExecutionResult(root, {
    name: "frontend",
    kind: "BUILD",
    status: "PASS",
    command: "pnpm build",
    startedAt: "2026-01-01T10:05:00.000Z",
    completedAt: "2026-01-01T10:05:00.000Z",
    durationMs: 1000
  });
  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.match(quality, /Build\s*\|\s*✅ PASS/);
});

test("Test D: out-of-order arrival — an older write cannot clobber a newer result", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  // Written first, with the LATER timestamp.
  await recordQAExecutionResult(root, {
    name: "build",
    kind: "BUILD",
    status: "PASS",
    command: "pnpm build",
    startedAt: "2026-01-01T10:05:00.000Z",
    completedAt: "2026-01-01T10:05:00.000Z",
    durationMs: 1000
  });
  // Written second, with the EARLIER timestamp — must not overwrite the PASS above.
  await recordQAExecutionResult(root, {
    name: "build",
    kind: "BUILD",
    status: "FAIL",
    command: "pnpm build",
    startedAt: "2026-01-01T10:00:00.000Z",
    completedAt: "2026-01-01T10:00:00.000Z",
    durationMs: 1000
  });
  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.match(quality, /Build\s*\|\s*✅ PASS/);
  assert.doesNotMatch(quality, /Build\s*\|\s*❌ FAIL/);
});

// --- Legacy storage migration ------------------------------------------------

test("Test J: legacy qaResults keyed by bare name loads without crashing and normalizes", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  const runtimePath = join(root, ".devguard", "runtime.json");
  await writeFile(
    runtimePath,
    JSON.stringify(
      {
        pendingChangedFiles: [],
        lastStatus: "idle",
        changeCountSinceIdle: 0,
        qaResults: {
          // Old shape: keyed by bare name, no kind field at all on one entry.
          build: {
            name: "build",
            status: "PASS",
            command: "pnpm build",
            startedAt: "2020-01-01T00:00:00.000Z",
            completedAt: "2020-01-01T00:00:00.000Z",
            durationMs: 1000
          },
          "self-check": {
            name: "self-check",
            kind: "CUSTOM",
            status: "PASS",
            command: "dev-guard self-check",
            startedAt: "2020-01-01T00:00:00.000Z",
            completedAt: "2020-01-01T00:00:00.000Z",
            durationMs: 1000
          }
        }
      },
      null,
      2
    )
  );
  // Must not throw.
  const runtime = await readRuntimeState(root);
  assert.ok(runtime.qaResults["BUILD::build"], "legacy bare-name entry must normalize to the kind+name key");
  assert.ok(runtime.qaResults["CUSTOM::self-check"]);

  await processDoneEvent(root);
  const quality = await readQuality(root);
  // No provenance on the legacy entries -> not auto-trusted as current PASS.
  assert.doesNotMatch(quality, /Build\s*\|\s*✅ PASS/);
});

// --- Code-state content identity: Case A vs Case B --------------------------

test("Test E: same HEAD, source content changed -> stale (Case A)", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", command: "pnpm build" });
  await writeFile(join(root, "README.md"), "# sample\nEdited without committing.\n");
  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.doesNotMatch(quality, /Build\s*\|\s*✅ PASS/);
  assert.match(quality, /Build\s*\|\s*⚪ Not recorded by DevGuard/);
});

test("Test F: validated dirty content, then committed UNCHANGED -> remains current (Case B)", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await writeFile(join(root, "app.js"), "console.log('validated content X');\n");
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", command: "pnpm build" });

  // Commit EXACTLY what was validated — no further edits.
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "commit exactly what was validated"]);

  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.match(quality, /Build\s*\|\s*✅ PASS/, "commit of unchanged validated content must not invalidate evidence");
});

test("Test G: change after commit still invalidates evidence", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await writeFile(join(root, "app.js"), "console.log('X');\n");
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", command: "pnpm build" });
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "commit X"]);

  // Now actually change the content further.
  await writeFile(join(root, "app.js"), "console.log('Y');\n");
  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.doesNotMatch(quality, /Build\s*\|\s*✅ PASS/);
});

test("Test H: relevant untracked file content mutation changes the fingerprint", async () => {
  const root = await makeRepo();
  const h1 = await computeWorkingTreeContentHash(root);
  await writeFile(join(root, "scratch.js"), "export const a = 1;\n");
  const h2 = await computeWorkingTreeContentHash(root);
  await writeFile(join(root, "scratch.js"), "export const a = 2;\n");
  const h3 = await computeWorkingTreeContentHash(root);
  assert.notEqual(h1, h2, "adding an untracked file must change the fingerprint");
  assert.notEqual(h2, h3, "editing that untracked file's content must change the fingerprint again");
});

test("Test I: ignored generated noise does not move the fingerprint", async () => {
  const root = await makeRepo();
  const h1 = await computeWorkingTreeContentHash(root);
  await mkdir(join(root, ".turbo"), { recursive: true });
  await writeFile(join(root, ".turbo", "cache-entry"), "noise\n");
  await writeFile(join(root, "tsconfig.tsbuildinfo"), "{}\n");
  const h2 = await computeWorkingTreeContentHash(root);
  assert.equal(h1, h2, "ignored generated noise must not change the content fingerprint");
});

test("Test I (control): recording evidence itself (which writes .devguard/runtime.json) does not invalidate itself", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  const result = await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", command: "pnpm build" });
  assert.ok(result.codeStateHash, "the stored evidence must carry a codeStateHash in a git repo");
  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.match(quality, /Build\s*\|\s*✅ PASS/, "recording evidence must not stale itself via its own runtime.json write");
});

// --- Task identity: no longer dependent on text equality --------------------

test("Test K: explicit Task A -> Task B (different text) — B has a clean lineage", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Implement ad report pipeline" });
  await processDoneEvent(root);
  await writeFile(join(root, "b.js"), "export const b = 1;\n");
  await prepareTaskContext({ root, task: "Fix unrelated login bug" });
  await processDoneEvent(root);
  const handoff = await readHandoff(root);
  assert.match(handoff, /Fix unrelated login bug/);
  assert.doesNotMatch(handoff, /Implement ad report pipeline/);
});

test("Test L: identical task text across two explicit (non-continuation) calls are distinct tasks", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", command: "pnpm build" });
  await prepareTaskContext({ root, task: "Verify milestone" });
  await processDoneEvent(root);
  const quality1 = await readQuality(root);
  assert.match(quality1, /Build\s*\|\s*✅ PASS/);

  // A second, explicit (non-continuation) invocation with the SAME text must
  // still start a brand-new lineage — text equality is not the identity.
  await writeFile(join(root, "unrelated2.js"), "export const c = 1;\n");
  await prepareTaskContext({ root, task: "Verify milestone" });
  await processDoneEvent(root);
  const quality2 = await readQuality(root);
  // The BUILD evidence recorded for the first "Verify milestone" task must
  // not be treated as belonging to the second one just because the text repeats.
  assert.doesNotMatch(quality2, /Build\s*\|\s*✅ PASS/);
});

test("Test M: explicit continuation (continueCurrentTask) keeps the same task's goal and evidence lineage", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Implement ad report pipeline" });
  await processDoneEvent(root);

  await writeFile(join(root, "more.js"), "export const more = 1;\n");
  await prepareTaskContext({ root, task: "Implement ad report pipeline", continueCurrentTask: true });
  await processDoneEvent(root);

  const handoff = await readHandoff(root);
  assert.match(handoff, /Implement ad report pipeline/);
});

test("Test N: no-boundary limitation — without prepare_task_context or reset, DevGuard keeps the old goal (documented contract)", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Implement ad report pipeline" });
  await processDoneEvent(root);

  // No prepare_task_context, no reset — DevGuard has no boundary signal.
  await writeFile(join(root, "unrelated3.js"), "export const d = 1;\n");
  await processDoneEvent(root);

  const handoff = await readHandoff(root);
  assert.match(handoff, /Implement ad report pipeline/, "documented limitation: DevGuard cannot infer a new task without an explicit signal");
});

// --- Stale vs never-recorded: internally distinguishable --------------------

test("Test O: stale evidence and never-recorded evidence are both NOT_RECORDED visibly, but distinguishable via diagnostic text", async () => {
  const neverRecordedRoot = await makeRepo();
  await ensureDevguardWorkspace(neverRecordedRoot);
  await processDoneEvent(neverRecordedRoot);
  const neverRecordedHandoff = await readHandoff(neverRecordedRoot);
  assert.match(neverRecordedHandoff, /Build result is not recorded in DevGuard/);
  assert.doesNotMatch(neverRecordedHandoff, /became stale/);

  const staleRoot = await makeRepo();
  await ensureDevguardWorkspace(staleRoot);
  await recordValidationEvidence({ root: staleRoot, kind: "BUILD", status: "PASS", command: "pnpm build" });
  await writeFile(join(staleRoot, "README.md"), "# sample\nEdited after the build was verified.\n");
  await processDoneEvent(staleRoot);
  const staleHandoff = await readHandoff(staleRoot);
  assert.match(staleHandoff, /Previous Build PASS became stale after the code state changed/);

  // Both show the same visible NOT_RECORDED state in the Quality Report table...
  const neverRecordedQuality = await readQuality(neverRecordedRoot);
  const staleQuality = await readQuality(staleRoot);
  assert.match(neverRecordedQuality, /Build\s*\|\s*⚪ Not recorded by DevGuard/);
  assert.match(staleQuality, /Build\s*\|\s*⚪ Not recorded by DevGuard/);
});

// --- AI historical context isolation (deterministic, no network) -----------

test("Test P: a synthetic AI-merged review item's historical file never appears in What Changed for a zero-diff round", async () => {
  const { formatQualityChangedFiles } = await import("../dist/runtime-state.js");
  const report = {
    verdict: "PASS",
    summary: [],
    why: [],
    relatedFiles: [],
    requiredVerification: [],
    checklist: [],
    reviewItems: [
      { title: "Historical UI note", body: ["Carried over from a previous round."], files: ["components/AdSlot.jsx"], checks: [] }
    ],
    beforeCommit: [],
    nextRecommendedAction: "",
    documentationSummary: {
      goal: "No source changes were detected in the current diff.",
      overview: [],
      changeTypes: [],
      impact: { affected: [], unaffected: [], risk: "None", riskReason: "No changed files were detected." },
      fileChanges: [],
      qaChecks: [],
      remainingWork: [],
      structure: [],
      excludedAreas: []
    }
  };
  const lines = formatQualityChangedFiles(report, "en-US").join("\n");
  assert.doesNotMatch(lines, /AdSlot\.jsx/);
});

test("Test Q: real live pipeline — an unrelated round after a real AI-reviewed change does not resurface the old file", async () => {
  const root = await mkdtemp(join(tmpdir(), "devguard-ai-live-"));
  cleanupRoots.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "DevGuard Test"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "f3", private: true, scripts: { build: "true" } }, null, 2));
  await writeFile(join(root, ".gitignore"), ".devguard/\n");
  await mkdir(join(root, "components"), { recursive: true });
  await writeFile(join(root, "components", "AdSlot.jsx"), "export function AdSlot() { return null; }\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "init with AdSlot"]);

  await writeFile(join(root, "components", "AdSlot.jsx"), "export function AdSlot() { return <div className='ad-slot-issue-marker'/>; }\n");
  await ensureDevguardWorkspace(root);
  await processDoneEvent(root);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "commit adslot change"]);

  await mkdir(join(root, "billing"), { recursive: true });
  await writeFile(join(root, "billing", "Invoice.ts"), "export function invoice() { return 1; }\n");
  await processDoneEvent(root);

  const quality = await readQuality(root);
  assert.doesNotMatch(quality, /AdSlot/);
  assert.doesNotMatch(quality, /ad-slot-issue-marker/);
});

// --- Compatibility -----------------------------------------------------------

test("Compatibility: a non-git project does not crash and falls back to session-based freshness", async () => {
  const root = await mkdtemp(join(tmpdir(), "devguard-nogit-identity-"));
  cleanupRoots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "nogit", scripts: { build: "true" } }, null, 2));
  await ensureDevguardWorkspace(root);
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", command: "pnpm build" });
  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.match(quality, /Build\s*\|\s*✅ PASS/);
});
