// Regression tests for Validation Evidence provenance/freshness (code state
// fingerprint, aggregation identity) and Task Goal session lineage. See the
// task history for the concrete risks these guard against: an uncommitted
// edit after a recorded PASS being shown as current, and a previous task's
// goal leaking into a new task's Handoff.
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
  resetRuntimeState
} from "../dist/runtime-state.js";

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
  const root = await mkdtemp(join(tmpdir(), "devguard-freshness-"));
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

// --- Test A: same HEAD, working tree changed --------------------------------

test("Test A: BUILD PASS recorded at HEAD A becomes stale after an uncommitted edit at the same HEAD", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);

  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", command: "pnpm build" });

  // No commit at all — HEAD stays the same, only the working tree changes.
  await writeFile(join(root, "README.md"), "# sample\nEdited after the build was verified, without committing.\n");

  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.doesNotMatch(quality, /Build\s*\|\s*✅ PASS/);
  assert.match(quality, /Build\s*\|\s*⚪ Not recorded by DevGuard/);
});

// --- Test B: unchanged working tree remains fresh (control) -----------------

test("Test B (control): BUILD PASS remains fresh when the working tree does not change at all", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", command: "pnpm build" });
  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.match(quality, /Build\s*\|\s*✅ PASS/);
});

// --- Test C: staged change invalidates evidence -----------------------------

test("Test C: a staged (but uncommitted) change invalidates previously recorded evidence", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", command: "pnpm build" });

  await writeFile(join(root, "README.md"), "# sample\nStaged edit after the build was verified.\n");
  await git(root, ["add", "README.md"]);

  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.doesNotMatch(quality, /Build\s*\|\s*✅ PASS/);
  assert.match(quality, /Build\s*\|\s*⚪ Not recorded by DevGuard/);
});

// --- Test D: relevant untracked file vs ignored generated noise ------------

test("Test D: a new untracked source file invalidates evidence, but ignored generated noise does not", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", command: "pnpm build" });

  // Generated/ignored noise must not move the fingerprint.
  await mkdir(join(root, ".turbo"), { recursive: true });
  await writeFile(join(root, ".turbo", "cache-entry"), "noise\n");
  await writeFile(join(root, "tsconfig.tsbuildinfo"), "{}\n");
  await processDoneEvent(root);
  let quality = await readQuality(root);
  assert.match(quality, /Build\s*\|\s*✅ PASS/, "ignored generated noise must not invalidate evidence");

  // A real new untracked source file must invalidate it.
  await writeFile(join(root, "new-feature.js"), "export const featureFlag = true;\n");
  await processDoneEvent(root);
  quality = await readQuality(root);
  assert.doesNotMatch(quality, /Build\s*\|\s*✅ PASS/);
  assert.match(quality, /Build\s*\|\s*⚪ Not recorded by DevGuard/);
});

// --- Test E: legacy evidence with no provenance at all ----------------------

test("Test E: legacy evidence with no gitHead/codeStateHash/sessionId is not auto-trusted as current PASS", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  // Simulate evidence recorded by a DevGuard version that predates all
  // provenance fields, by writing runtime.json directly (recordQAExecutionResult
  // would always stamp provenance now, so this bypasses it deliberately).
  const runtimePath = join(root, ".devguard", "runtime.json");
  await writeFile(
    runtimePath,
    JSON.stringify(
      {
        pendingChangedFiles: [],
        lastStatus: "idle",
        changeCountSinceIdle: 0,
        qaResults: {
          build: {
            name: "build",
            kind: "BUILD",
            status: "PASS",
            command: "pnpm build",
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
  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.doesNotMatch(quality, /Build\s*\|\s*✅ PASS/);
  assert.match(quality, /Build\s*\|\s*⚪ Not recorded by DevGuard/);
});

// --- Test F: explicit task transition ---------------------------------------

test("Test F: an explicit new prepare_task_context call starts a clean task lineage", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);

  await prepareTaskContext({ root, task: "Implement ad report pipeline", persistTask: true });
  await processDoneEvent(root);
  let handoff = await readHandoff(root);
  assert.match(handoff, /Implement ad report pipeline/);

  await writeFile(join(root, "unrelated.js"), "export const unrelated = true;\n");
  await prepareTaskContext({ root, task: "Fix unrelated login bug", persistTask: true });
  await processDoneEvent(root);

  handoff = await readHandoff(root);
  assert.match(handoff, /Fix unrelated login bug/);
  assert.doesNotMatch(handoff, /Implement ad report pipeline/);
});

// --- Test G: same-task persistence ------------------------------------------

test("Test G: the same task's goal persists across additional done calls without recalling prepare_task_context", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);

  await prepareTaskContext({ root, task: "Implement ad report pipeline", persistTask: true });
  await processDoneEvent(root);

  await writeFile(join(root, "more.js"), "export const more = 1;\n");
  await processDoneEvent(root);

  const handoff = await readHandoff(root);
  assert.match(handoff, /Implement ad report pipeline/);
});

// --- Test H: no-boundary limitation (documented contract, not inferred) ----

test("Test H: without prepare_task_context or reset, DevGuard cannot tell a new task started and keeps the old goal", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);

  await prepareTaskContext({ root, task: "Implement ad report pipeline", persistTask: true });
  await processDoneEvent(root);

  // The user mentally moves on to a materially different, larger piece of
  // work — but never calls prepare_task_context or dev-guard reset. DevGuard
  // has no contractual signal that a new task began, so per the documented
  // Task Boundary Contract it must keep showing the previous goal rather
  // than guessing from the diff shape. This is a known limitation, not a bug:
  // large/different-area diffs are deliberately NOT used as a "new task"
  // heuristic.
  await mkdir(join(root, "billing"), { recursive: true });
  await writeFile(join(root, "billing", "invoice.js"), "export function generateInvoice() { return {}; }\n");
  await writeFile(join(root, "billing", "invoice.test.js"), "test('invoice', () => {});\n");
  await processDoneEvent(root);

  const handoff = await readHandoff(root);
  assert.match(handoff, /Implement ad report pipeline/);
});

// A real `dev-guard reset` is still the one supported way to explicitly end
// a session/task lineage when there is no next `prepare_task_context` call.
test("dev-guard reset still ends the session lineage (supplementary to Test H)", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Implement ad report pipeline", persistTask: true });
  await processDoneEvent(root);

  await resetRuntimeState(root);

  await writeFile(join(root, "unrelated.js"), "export const unrelated = true;\n");
  await processDoneEvent(root);

  const handoff = await readHandoff(root);
  assert.doesNotMatch(handoff, /Implement ad report pipeline/);
});

// --- Test I: aggregation identity — different names are independent -------

test("Test I: BUILD/frontend-build and BUILD/backend-build are independent validation scopes", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await recordValidationEvidence({ root, kind: "BUILD", name: "frontend-build", status: "FAIL", reason: "type error" });
  await recordValidationEvidence({ root, kind: "BUILD", name: "backend-build", status: "PASS" });

  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.match(quality, /Build: frontend-build\s*\|\s*❌ FAIL/);
  assert.match(quality, /Build: backend-build\s*\|\s*✅ PASS/);
});

// --- Test J: latest result within the same identity wins --------------------

test("Test J: within the same BUILD/frontend-build identity, the latest-by-timestamp result wins regardless of insertion order", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);

  // Inserted first, but chronologically LATER (completedAt).
  await recordQAExecutionResult(root, {
    name: "frontend-build",
    kind: "BUILD",
    status: "PASS",
    command: "pnpm build",
    startedAt: "2026-01-01T10:00:00.000Z",
    completedAt: "2026-01-01T10:00:00.000Z",
    durationMs: 1000
  });
  // Inserted second, but chronologically EARLIER (completedAt) — must not
  // clobber the later result recorded above.
  await recordQAExecutionResult(root, {
    name: "frontend-build",
    kind: "BUILD",
    status: "FAIL",
    command: "pnpm build",
    startedAt: "2026-01-01T09:00:00.000Z",
    completedAt: "2026-01-01T09:00:00.000Z",
    durationMs: 1000,
    reason: "flaky failure from an earlier attempt"
  });

  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.match(quality, /Build\s*\|\s*✅ PASS/);
  assert.doesNotMatch(quality, /Build\s*\|\s*❌ FAIL/);
});

// --- Test K: AI stale "What Changed" (deterministic, no network/API key) ---

test("Test K: a zero-diff round's What Changed never surfaces an AI review item's file from stale historical context", async () => {
  const { formatQualityChangedFiles } = await import("../dist/runtime-state.js");
  // Simulates exactly the confirmed bug: the current round has zero changed
  // files (documentationSummary.fileChanges is empty and authoritative), but
  // an AI-merged review item references a file from a previous round.
  const report = {
    verdict: "PASS",
    summary: [],
    why: [],
    relatedFiles: [],
    requiredVerification: [],
    checklist: [],
    reviewItems: [
      {
        title: "Historical UI note",
        body: ["Carried over from a previous round's AI review."],
        files: ["components/AdSlot.jsx"],
        checks: []
      }
    ],
    beforeCommit: [],
    nextRecommendedAction: "",
    documentationSummary: {
      goal: "No source changes were detected in the current diff.",
      overview: ["No source changes were detected in the current diff."],
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
  assert.match(lines, /No changed files recorded/);
});

// --- Compatibility: non-git projects and legacy state -----------------------

test("Compatibility: a non-git project does not crash and falls back to session-based freshness", async () => {
  const root = await mkdtemp(join(tmpdir(), "devguard-nogit-"));
  cleanupRoots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "nogit", scripts: { build: "true" } }, null, 2));
  await ensureDevguardWorkspace(root);
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", command: "pnpm build" });
  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.match(quality, /Build\s*\|\s*✅ PASS/);
});

test("Compatibility: legacy ProjectState without lastTaskGoalSessionId does not crash and does not leak", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  const statePath = join(root, ".devguard", "state.json");
  await writeFile(
    statePath,
    JSON.stringify({ lastTaskGoal: "Old goal from a previous DevGuard version", lastQualityVerdict: "PASS" }, null, 2)
  );
  await processDoneEvent(root);
  const handoff = await readHandoff(root);
  assert.doesNotMatch(handoff, /Old goal from a previous DevGuard version/);
});
