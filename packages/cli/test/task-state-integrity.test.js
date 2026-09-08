// Regression tests for the Task/Change/Validation/Artifact state-integrity
// pass: the real PartnerFlow+Codex failure was DevGuard merging Task state
// from one piece of work with Validation evidence from a completely
// different, undeclared piece of work into one normal-looking Quality
// Report/Handoff. These tests prove that specific failure mode is now
// structurally impossible — evidence recorded with no active task can never
// become current-task PASS, and a stale carried-over goal next to real
// unbound evidence fails closed instead of rendering a plausible blend.
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
  readRuntimeState,
  generateProjectHandoff
} from "../dist/runtime-state.js";

// See validation-identity-and-task-lineage.test.js for why this is pinned:
// these assertions check rendered prose against DevGuard's documented
// default locale, which must not depend on the host machine's OS locale.
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

async function makeRepo(prefix = "devguard-task-integrity-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanupRoots.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "DevGuard Test"]);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "partner-flow", packageManager: "pnpm@9.0.0", scripts: { build: "true", test: "true" } }, null, 2)
  );
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

// --- Task Binding -------------------------------------------------------

test("Test A: validation recorded with no active task is stored as UNBOUND, never bound to a previous task", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  const result = await recordValidationEvidence({ root, kind: "TYPECHECK", status: "PASS", command: "tsc --noEmit" });
  assert.equal(result.taskBinding, "UNBOUND");

  const runtime = await readRuntimeState(root);
  const stored = Object.values(runtime.qaResults)[0];
  assert.equal(stored.taskBinding, "UNBOUND");
});

test("Test B: evidence recorded after a task's done cycle (no re-declaration) is UNBOUND and excluded from PASS facts", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Migrate the settlement import schema." });
  await writeFile(join(root, "migration.sql"), "CREATE TABLE settlement_import (id int);\n");
  await processDoneEvent(root);

  // Task A is now closed (processDoneEvent clears runtime.currentTask).
  // New evidence recorded here, with no re-declared task, is real work but
  // must never be attributed to Task A (or any task) as PASS.
  await writeFile(join(root, "unrelated.js"), "export const x = 1;\n");
  const evidence = await recordValidationEvidence({ root, kind: "TYPECHECK", status: "PASS", command: "tsc --noEmit" });
  assert.equal(evidence.taskBinding, "UNBOUND");

  const quality = await readQuality(root);
  assert.doesNotMatch(quality, /Typecheck\s*\|\s*✅ PASS/, "unbound evidence must not appear as current-task PASS");
});

// --- State Mismatch (Fail-Closed) ---------------------------------------

test("Test E: a stale carried-over task next to real unbound evidence fails closed instead of blending", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);

  // Historical/old task: DB migration. Fully completed via prepare_task_context
  // + done (so its goal AND code-state fingerprint are both recorded).
  await prepareTaskContext({ root, task: "Update packages/db/migrations/0016_settlement_import_foundation.sql" });
  await mkdir(join(root, "packages/db/migrations"), { recursive: true });
  await writeFile(join(root, "packages/db/migrations/0016_settlement_import_foundation.sql"), "CREATE TABLE settlement_import (id int);\n");
  await processDoneEvent(root);
  let handoff = await readHandoff(root);
  assert.match(handoff, /Update packages\/db\/migrations/, "sanity check: the DB migration task was recorded");

  // New, real work happens with NO prepare_task_context call (exactly the
  // reported failure): different files change, and validation evidence for
  // that different work is recorded — unbound, since there is no active
  // task. The code state has therefore moved on from what the DB migration
  // goal was recorded against.
  await mkdir(join(root, "apps/admin/app"), { recursive: true });
  await writeFile(join(root, "apps/admin/app/layout.tsx"), "export default function Layout(){ return null; }\n");
  await recordValidationEvidence({ root, kind: "TYPECHECK", status: "PASS", command: "pnpm --filter admin typecheck" });
  await recordValidationEvidence({ root, kind: "RUNTIME_SMOKE", name: "admin-layout-browser-qa", status: "PASS", command: "curl http://localhost:3000/admin" });

  await processDoneEvent(root);
  const quality = await readQuality(root);
  handoff = await readHandoff(root);

  // Must NEVER render a normal report blending the stale DB migration task
  // with the unrelated Admin evidence as if it verified that task.
  assert.match(quality, /STATE_MISMATCH/, "Quality Report must fail closed on task/change-state mismatch");
  assert.match(handoff, /Handoff unavailable for current state/, "Handoff must fail closed, not render a blended resume document");
  assert.doesNotMatch(quality, /Typecheck\s*\|\s*✅ PASS/, "the unrelated Admin evidence must not appear as if it verified the stale task");
});

test("Test E (control): the same scenario without any new evidence does NOT fail closed (harmless repeated done)", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Update packages/db/migrations/0016_settlement_import_foundation.sql" });
  await mkdir(join(root, "packages/db/migrations"), { recursive: true });
  await writeFile(join(root, "packages/db/migrations/0016_settlement_import_foundation.sql"), "CREATE TABLE settlement_import (id int);\n");
  await processDoneEvent(root);

  // Code state moves on, but NO evidence is recorded in the gap — nothing
  // is at risk of misattribution, so this must not escalate to a full
  // integrity failure; it should just stop showing the stale goal.
  await mkdir(join(root, "apps/admin/app"), { recursive: true });
  await writeFile(join(root, "apps/admin/app/layout.tsx"), "export default function Layout(){ return null; }\n");
  await processDoneEvent(root);

  const quality = await readQuality(root);
  const handoff = await readHandoff(root);
  assert.doesNotMatch(quality, /STATE_MISMATCH/);
  assert.doesNotMatch(handoff, /Handoff unavailable for current state/);
});

// --- Real consumer-path QA confidence (not just unit tests) -------------

test("Test H: real record_validation_result -> processDoneEvent -> generated quality-report.md is exact", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Admin App Shell / Layout improvement." });
  await mkdir(join(root, "apps/admin/app"), { recursive: true });
  await writeFile(join(root, "apps/admin/app/layout.tsx"), "export default function Layout(){ return null; }\n");
  await recordValidationEvidence({ root, kind: "TYPECHECK", status: "PASS", command: "pnpm --filter admin typecheck" });
  await recordValidationEvidence({ root, kind: "TEST", name: "targeted", status: "PASS", command: "pnpm --filter admin test" });
  await recordValidationEvidence({ root, kind: "RUNTIME_SMOKE", name: "admin-layout-browser-qa", status: "PASS", command: "curl http://localhost:3000/admin" });
  // BUILD and MANUAL_QA are intentionally never recorded.
  await processDoneEvent(root);

  const quality = await readQuality(root);
  assert.match(quality, /Typecheck\s*\|\s*✅ PASS/);
  assert.match(quality, /Targeted Tests\s*\|\s*✅ PASS/);
  assert.match(quality, /Runtime Smoke[^\n]*✅ PASS/);
  assert.match(quality, /Build\s*\|\s*⚪ Not recorded by DevGuard/);
  assert.doesNotMatch(quality, /Build\s*\|\s*✅ PASS/);

  const confidenceSection = quality.split("8. QA Confidence")[1]?.split(/\n## /)[0] ?? "";
  assert.notEqual(confidenceSection, "");
  assert.doesNotMatch(confidenceSection, /Build[^\n]*(are recorded as PASS|passed)/i, "Build must never be described as passed in QA Confidence");
  assert.doesNotMatch(confidenceSection, /[Rr]untime [Ss]mok[^\n]*(remains|still)/, "a recorded PASS Runtime Smoke must never be described as outstanding");
});

// --- Completion Provenance ------------------------------------------------

test("Test J: a Handoff generated as part of processDoneEvent with completionSource 'cli-done' says the CLI command ran", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Small fix." });
  await writeFile(join(root, "a.js"), "export const a = 1;\n");
  await processDoneEvent(root, { completionSource: "cli-done" });
  const handoff = await readHandoff(root);
  assert.match(handoff, /`dev-guard done`: pass/);
});

test("Test K: watch's auto-finalize completion does not claim the dev-guard done CLI command ran", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Small fix." });
  await writeFile(join(root, "a.js"), "export const a = 1;\n");
  await processDoneEvent(root, { completionSource: "watch-auto-finalize" });
  const handoff = await readHandoff(root);
  assert.doesNotMatch(handoff, /`dev-guard done`: pass/);
  assert.match(handoff, /processed automatically by `dev-guard watch`/);
});

test("Test L: dev-guard handoff regeneration (no completion event) says nothing executed", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await generateProjectHandoff(root);
  const handoff = await readHandoff(root);
  assert.doesNotMatch(handoff, /`dev-guard done`: pass/);
  assert.match(handoff, /not run in this session/);
});

// --- Domain Consistency ----------------------------------------------------

test("Test M: a SQL migration file is consistently classified as Database affected, never unaffected", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await mkdir(join(root, "packages/db/migrations"), { recursive: true });
  await writeFile(join(root, "packages/db/migrations/0016_settlement_import.sql"), "CREATE TABLE settlement_import (id int primary key);\n");
  await prepareTaskContext({ root, task: "Add the settlement import migration." });
  await processDoneEvent(root);
  const quality = await readQuality(root);
  const impactSection = quality.split(/## 4\. Impact/)[1]?.split(/\n## /)[0] ?? "";
  assert.match(impactSection, /Database/, "Database must appear as affected");
  const noImpactBlock = impactSection.split(/No direct change detected/)[1] ?? "";
  assert.doesNotMatch(noImpactBlock, /Database/, "Database must not also appear in the unaffected list");
  // The concrete SQL content should be recognized deterministically, not
  // reported as "no diff detail available".
  assert.match(quality, /settlement_import/);
});

test("Test N: an Admin layout change is Dashboard/UI affected and Database unaffected", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await mkdir(join(root, "apps/admin/app"), { recursive: true });
  await mkdir(join(root, "apps/admin/components/layout"), { recursive: true });
  await writeFile(join(root, "apps/admin/app/layout.tsx"), "export default function Layout(){ return <div className='shell'/>; }\n");
  await writeFile(join(root, "apps/admin/components/layout/page-container.tsx"), "export function PageContainer(){ return <div className='container'/>; }\n");
  await prepareTaskContext({ root, task: "Improve the admin app shell and layout." });
  await processDoneEvent(root);
  const quality = await readQuality(root);
  const impactSection = quality.split(/## 4\. Impact/)[1]?.split(/\n## /)[0] ?? "";
  assert.match(impactSection, /Database/, "Database must be listed (as unaffected) for a non-DB change");
  const affectedBlock = impactSection.split(/No direct change detected/)[0] ?? "";
  assert.doesNotMatch(affectedBlock, /Database/, "Database must not appear in the affected list for an Admin layout change");
});

// --- PartnerFlow broken-lifecycle fixture (section 29) ---------------------

test("PartnerFlow broken lifecycle: DB task/history + unbound Admin evidence never becomes a normal Handoff", async () => {
  const root = await makeRepo("devguard-partnerflow-broken-");
  await ensureDevguardWorkspace(root);

  // Historical/old task.
  await prepareTaskContext({ root, task: "Update packages/db/migrations/0016_settlement_import_foundation.sql" });
  await mkdir(join(root, "packages/db/migrations"), { recursive: true });
  await writeFile(join(root, "packages/db/migrations/0016_settlement_import_foundation.sql"), "CREATE TABLE settlement_import (id int);\n");
  await processDoneEvent(root);

  // New actual work: no active task, Admin App Shell / Layout changes,
  // validation evidence recorded for that work.
  await mkdir(join(root, "apps/admin/app"), { recursive: true });
  await writeFile(join(root, "apps/admin/app/layout.tsx"), "export default function Layout(){ return null; }\n");
  await recordValidationEvidence({ root, kind: "TYPECHECK", status: "PASS", command: "pnpm --filter admin typecheck" });
  await recordValidationEvidence({ root, kind: "TEST", name: "4-layout-variants", status: "PASS", summary: "4 layout variant tests passed" });
  await recordValidationEvidence({ root, kind: "RUNTIME_SMOKE", name: "admin-layout-browser-qa", status: "PASS" });
  await processDoneEvent(root);

  const quality = await readQuality(root);
  const handoff = await readHandoff(root);
  assert.doesNotMatch(quality + handoff, /Typecheck\s*\|\s*✅ PASS/, "unbound Admin typecheck evidence must never be shown as passing verification");
  assert.match(quality, /STATE_MISMATCH/);
  assert.match(handoff, /Handoff unavailable for current state/);
});

// --- PartnerFlow correct-lifecycle fixture (section 30) ---------------------

test("PartnerFlow correct lifecycle: prepare_task_context + Admin changes + Admin validation produces an accurate Handoff", async () => {
  const root = await makeRepo("devguard-partnerflow-correct-");
  await ensureDevguardWorkspace(root);
  await mkdir(join(root, "apps/admin/app"), { recursive: true });
  await writeFile(join(root, "apps/admin/app/layout.tsx"), "export default function Layout(){ return null; }\n");
  await writeFile(join(root, "apps/admin/components-page-container.tsx"), "export function PageContainer(){ return null; }\n");

  await prepareTaskContext({
    root,
    task: "Admin App Shell / Layout improvement. Constraints: no DevGuard CLI, no commit, no push."
  });
  await recordValidationEvidence({ root, kind: "TYPECHECK", status: "PASS", command: "pnpm --filter admin typecheck" });
  await recordValidationEvidence({ root, kind: "TEST", name: "4-layout-variants", status: "PASS", summary: "4 layout variant tests passed" });
  await recordValidationEvidence({ root, kind: "RUNTIME_SMOKE", name: "admin-layout-browser-qa", status: "PASS" });
  await processDoneEvent(root);

  const quality = await readQuality(root);
  const handoff = await readHandoff(root);
  assert.doesNotMatch(quality, /STATE_MISMATCH/);
  assert.doesNotMatch(handoff, /Handoff unavailable for current state/);
  assert.match(handoff, /Admin App Shell \/ Layout improvement/);
  assert.match(quality, /Typecheck\s*\|\s*✅ PASS/);
  assert.match(quality, /Targeted Tests\s*\|\s*✅ PASS/);
  assert.match(quality, /Runtime Smoke[^\n]*✅ PASS/);
  // Constraints must be respected: no DevGuard CLI recommendation anywhere.
  assert.doesNotMatch(handoff.replace(/## 6\. Verification Run[\s\S]*?(?=\n## )/, ""), /dev-guard (self-check|done)/);
});
