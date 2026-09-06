// Regression tests for 0.8.3: generated-artifact leakage into changed-files/
// Quality Report/Handoff/Working Context/Project Knowledge, stale-task
// promotion in Working/Agent Context, monorepo sourceRoots detection,
// package.json/lockfile over-blocking, and Regression Risk duplication.
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
  recordRuntimeChange,
  resetRuntimeState,
  generateAgentContext,
  generateWorkingContext
} from "../dist/runtime-state.js";
import { generateProjectKnowledge } from "../dist/knowledge.js";

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

async function makeRepo(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
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

// --- Test A: .next excluded from changed-files, even nested in a monorepo app

test("Test A: nested .next generated output is excluded from changed files, real source is kept", async () => {
  const root = await makeRepo("devguard-artifact-a-");
  await mkdir(join(root, "apps/admin/app/(dashboard)/ad-management/templates"), { recursive: true });
  await writeFile(
    join(root, "apps/admin/app/(dashboard)/ad-management/templates/page.tsx"),
    "export default function Page() { return <div className='page'>ok</div>; }\n"
  );
  await mkdir(join(root, "apps/admin/.next/server/app/(dashboard)/ad-management/templates"), { recursive: true });
  await writeFile(
    join(root, "apps/admin/.next/server/app/(dashboard)/ad-management/templates/page.js"),
    "module.exports = function(){return React.createElement('div',{className:'page'});};\n"
  );
  await writeFile(join(root, "apps/admin/.next/server/app-paths-manifest.json"), "{}\n");

  await ensureDevguardWorkspace(root);
  // Simulate the file watcher (chokidar) having observed the compiled output
  // directly, independent of git status — this is the actual mechanism by
  // which nested .next output reached changed-files before the fix.
  await recordRuntimeChange(root, "apps/admin/.next/server/app/(dashboard)/ad-management/templates/page.js");
  await recordRuntimeChange(root, "apps/admin/.next/server/app-paths-manifest.json");

  await processDoneEvent(root);
  const quality = await readQuality(root);
  const handoff = await readHandoff(root);
  assert.match(quality, /apps\/admin\/app\/\(dashboard\)\/ad-management\/templates\/page\.tsx/, "real source file must be listed");
  assert.doesNotMatch(quality, /\.next\//, "Quality Report must never mention a .next path");
  assert.doesNotMatch(handoff, /\.next\//, "Handoff must never mention a .next path");
});

// --- Test B: .devguard.backup excluded from Project Knowledge -------------

test("Test B: .devguard.backup and .devguard-old are excluded from Project Knowledge", async () => {
  const root = await makeRepo("devguard-artifact-b-");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const ok = 1;\n");
  await mkdir(join(root, ".devguard.backup", "reports"), { recursive: true });
  await writeFile(join(root, ".devguard.backup", "config.json"), "{}\n");
  await writeFile(join(root, ".devguard.backup", "reports", "quality-report.md"), "# old\n");
  await mkdir(join(root, ".devguard-old", "prompts"), { recursive: true });
  await writeFile(join(root, ".devguard-old", "prompts", "next-codex-prompt.md"), "old\n");

  const knowledge = await generateProjectKnowledge(root);
  const allPaths = [
    ...knowledge.summary.entryPoints,
    ...knowledge.importantFiles.map((f) => f.path),
    ...knowledge.architecture.modules.flatMap((m) => m.files)
  ];
  assert.ok(!allPaths.some((p) => p.includes(".devguard.backup")), "no .devguard.backup path should be indexed");
  assert.ok(!allPaths.some((p) => p.includes(".devguard-old")), "no .devguard-old path should be indexed");
});

// --- Test C: stale task fallback forbidden ---------------------------------

test("Test C: a past session's documentation summary is not promoted as the current task after a real reset", async () => {
  const root = await makeRepo("devguard-artifact-c-");
  await ensureDevguardWorkspace(root);
  await mkdir(join(root, "components"), { recursive: true });
  await writeFile(join(root, "components", "AdSlot.jsx"), "export function AdSlot(){return <div className='ad'/>;}\n");
  await prepareTaskContext({ root, task: "Update the user-facing UI behavior and verify the changed interaction." });
  await processDoneEvent(root);
  let working = await readFile(join(root, ".devguard/reports/working-context.md"), "utf8");
  assert.match(working, /Update the user-facing UI behavior/, "sanity check: the explicit task was recorded as the goal");

  // Explicit session boundary: a real dev-guard reset, no new prepare_task_context.
  await resetRuntimeState(root);

  const context = await generateAgentContext(root).then(() => readFile(join(root, ".devguard/context/agent-context.md"), "utf8"));
  assert.doesNotMatch(context, /Update the user-facing UI behavior/, "a stale summary from a different session must not become the active goal");
  assert.match(context, /확인 필요|None/, "with no active task, the goal/task source must read as unresolved, not a stale claim");

  working = await generateWorkingContext(root).then(() => readFile(join(root, ".devguard/reports/working-context.md"), "utf8"));
  assert.doesNotMatch(working, /Update the user-facing UI behavior/, "Working Context must not keep showing the previous session's goal either");
});

// --- Test D: explicit resume still works -----------------------------------

test("Test D: within the same session, a recorded summary is still usable (resume is not broken)", async () => {
  const root = await makeRepo("devguard-artifact-d-");
  await ensureDevguardWorkspace(root);
  await mkdir(join(root, "components"), { recursive: true });
  await writeFile(join(root, "components", "AdSlot.jsx"), "export function AdSlot(){return <div className='ad'/>;}\n");
  await prepareTaskContext({ root, task: "Fix the ad slot rendering bug" });
  await processDoneEvent(root);

  // Regenerate Working Context again in the SAME session (no reset, no new
  // prepare_task_context call) — this must still reflect the real goal.
  await generateWorkingContext(root);
  const working = await readFile(join(root, ".devguard/reports/working-context.md"), "utf8");
  assert.match(working, /Fix the ad slot rendering bug/, "same-session resume must still surface the recorded goal");
});

// --- Test E: Working Context never recommends a generated artifact --------

test("Test E: Working Context entry files never include .next/dist/build output", async () => {
  const root = await makeRepo("devguard-artifact-e-");
  await mkdir(join(root, "apps/admin/app"), { recursive: true });
  await writeFile(join(root, "apps/admin/app/page.tsx"), "export default function Page(){return null;}\n");
  await mkdir(join(root, "apps/admin/.next/server/app"), { recursive: true });
  await writeFile(join(root, "apps/admin/.next/server/app/page.js"), "module.exports = {};\n");
  await mkdir(join(root, "apps/admin/dist"), { recursive: true });
  await writeFile(join(root, "apps/admin/dist/bundle.js"), "console.log(1);\n");

  await ensureDevguardWorkspace(root);
  await prepareTaskContext({ root, task: "Update the admin page" });
  const working = await readFile(join(root, ".devguard/reports/working-context.md"), "utf8");
  assert.doesNotMatch(working, /\.next\//);
  assert.doesNotMatch(working, /\/dist\//);
});

// --- Test F: monorepo sourceRoots reflect real workspace structure --------

test("Test F: sourceRoots reflect actual monorepo app/package/infra structure", async () => {
  const root = await makeRepo("devguard-artifact-f-");
  await mkdir(join(root, "apps/admin"), { recursive: true });
  await writeFile(join(root, "apps/admin/package.json"), JSON.stringify({ name: "admin" }));
  await mkdir(join(root, "apps/api"), { recursive: true });
  await writeFile(join(root, "apps/api/package.json"), JSON.stringify({ name: "api" }));
  await mkdir(join(root, "packages/db"), { recursive: true });
  await writeFile(join(root, "packages/db/package.json"), JSON.stringify({ name: "db" }));
  await mkdir(join(root, "infra/aws-cdk"), { recursive: true });
  await writeFile(join(root, "infra/aws-cdk/package.json"), JSON.stringify({ name: "aws-cdk" }));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "guide.md"), "# guide\n");

  const knowledge = await generateProjectKnowledge(root);
  const roots = knowledge.summary.sourceRoots;
  assert.ok(roots.includes("apps/admin"), `expected apps/admin in ${JSON.stringify(roots)}`);
  assert.ok(roots.includes("apps/api"), `expected apps/api in ${JSON.stringify(roots)}`);
  assert.ok(roots.includes("packages/db"), `expected packages/db in ${JSON.stringify(roots)}`);
  assert.ok(roots.includes("infra/aws-cdk"), `expected infra/aws-cdk in ${JSON.stringify(roots)}`);
  assert.ok(roots.includes("docs"), `expected docs in ${JSON.stringify(roots)}`);
});

// --- Test G/H: package.json semantic diff vs lockfile ----------------------

test("Test G: a non-dependency package.json change (scripts only) is not a lockfile blocker", async () => {
  const root = await makeRepo("devguard-artifact-g-");
  await ensureDevguardWorkspace(root);
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  pkg.scripts.lint = "eslint .";
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.doesNotMatch(quality, /package.json changed but no lockfile/i);
  assert.match(quality, /Package lock consistency:.*not required|does not look inconsistent|only non-dependency fields/i);
});

test("Test H: a dependency change without a lockfile update is flagged as a blocker", async () => {
  const root = await makeRepo("devguard-artifact-h-");
  await ensureDevguardWorkspace(root);
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  pkg.dependencies = { "left-pad": "^1.0.0" };
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.match(quality, /Generated files|Package lock consistency/i);
  assert.match(quality, /🔴 BLOCKED|BLOCKED/);
  assert.match(quality, /dependency-impacting fields.*no lockfile change/i);
});

// --- Test I: Regression Risk is consistent across the whole report --------

test("Test I: Regression Risk is the same value in the QA Summary table and the detailed section", async () => {
  const root = await makeRepo("devguard-artifact-i-");
  await mkdir(join(root, "app/api/orders"), { recursive: true });
  await writeFile(join(root, "app/api/orders/route.ts"), "export async function GET() { return new Response('ok'); }\n");
  await ensureDevguardWorkspace(root);
  await processDoneEvent(root);
  const quality = await readQuality(root);
  const tableValue = quality.match(/\|\s*Regression Risk\s*\|\s*([A-Za-z]+)\s*\|/)?.[1];
  const detailValue = quality.match(/## 7\. Regression Risk\s*\n\s*\nRegression Risk:\s*([A-Za-z]+)/)?.[1];
  assert.ok(tableValue, `table regression risk value not found in:\n${quality}`);
  assert.ok(detailValue, `detail regression risk value not found in:\n${quality}`);
  assert.equal(tableValue, detailValue, "the QA Summary table and the detailed section must report the identical Regression Risk value");
});

// --- Test J: low-confidence diff does not produce speculative UI claims ---

test("Test J: a .next-only change (excluded) produces no changed-file entries and no speculative UI/manual-QA claims", async () => {
  const root = await makeRepo("devguard-artifact-j-");
  await mkdir(join(root, "apps/admin/.next/server/app"), { recursive: true });
  await writeFile(join(root, "apps/admin/.next/server/app/page.js"), "module.exports = React.createElement('div',{className:'x'});\n");
  await ensureDevguardWorkspace(root);
  await recordRuntimeChange(root, "apps/admin/.next/server/app/page.js");
  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.doesNotMatch(quality, /Dashboard\/UI/i);
  assert.doesNotMatch(quality, /Manual browser\/mobile QA is still needed/i);
  assert.doesNotMatch(quality, /Verify the changed UI in desktop and mobile width/i);
});
