// Regression fixture for the PartnerFlow milestone: Quality Report / Handoff
// accuracy. See CLAUDE.md task history for the real-session bug this guards
// against (Handoff goal collapsed to "Update the user-facing UI behavior...",
// and Quality Report showed "No recent result" despite real build/test/runtime
// evidence).
import { test, before, after } from "node:test";
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
  recordRuntimeChange
} from "../dist/runtime-state.js";

const execFileAsync = promisify(execFile);

let root;
let qualityReport;
let projectHandoff;

async function git(args) {
  await execFileAsync("git", args, { cwd: root });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "devguard-partnerflow-"));
  await git(["init"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "DevGuard Test"]);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "partnerflow", private: true, scripts: { build: "true" } }, null, 2)
  );
  await writeFile(join(root, ".gitignore"), ".next/\n*.tsbuildinfo\nnode_modules/\n.devguard/\n");
  await writeFile(join(root, "README.md"), "# PartnerFlow\n");
  await mkdir(join(root, "migrations"), { recursive: true });
  await writeFile(join(root, "migrations", "0001_init.sql"), "create table clicks (id serial primary key);\n");
  await git(["add", "-A"]);
  await git(["commit", "-m", "init"]);

  // The real session's actual changes: 2 UI files + an API integration file + a test.
  await mkdir(join(root, "components"), { recursive: true });
  await writeFile(
    join(root, "components", "AdSlot.jsx"),
    "export function AdSlot() { return <div className=\"ad-slot\">ad</div>; }\n"
  );
  await writeFile(
    join(root, "components", "AdSlot.module.css"),
    ".ad-slot { display: block; }\n"
  );
  await mkdir(join(root, "app", "api", "coupang"), { recursive: true });
  await writeFile(
    join(root, "app", "api", "coupang", "route.ts"),
    "export async function GET() { return fetch('https://api.coupang.com/products'); }\n"
  );
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "tests", "ad-serving.test.ts"), "test('renders ad', () => {});\n");

  // A tracked, source-controlled migration edit must never be treated as
  // "generated" noise even though it lives in a directory that sounds generated.
  await writeFile(
    join(root, "migrations", "0001_init.sql"),
    "create table clicks (id serial primary key);\n-- added sub_id column\n"
  );

  await ensureDevguardWorkspace(root);

  // Step 1: the agent calls prepare_task_context with the real session goal
  // (this is what runtime.currentTask.text becomes).
  await prepareTaskContext({
    root,
    task: "Ad Serving + Report Pipeline End-to-End Milestone Verification",
    persistTask: true
  });

  // Step 2: the agent reports real validation evidence it actually observed.
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS", command: "pnpm build" });
  await recordValidationEvidence({ root, kind: "TYPECHECK", status: "PASS", summary: "6 packages" });
  await recordValidationEvidence({ root, kind: "TEST", status: "PASS", summary: "23 targeted tests" });
  await recordValidationEvidence({
    root,
    kind: "RUNTIME_SMOKE",
    name: "product-api",
    status: "PASS",
    summary: "actual Coupang Product API call succeeded"
  });
  await recordValidationEvidence({
    root,
    kind: "RUNTIME_SMOKE",
    name: "render",
    status: "PASS",
    summary: "/unit/render 200 with a real product"
  });
  await recordValidationEvidence({
    root,
    kind: "RUNTIME_SMOKE",
    name: "impression",
    status: "PASS",
    summary: "1 real impression row persisted"
  });
  await recordValidationEvidence({
    root,
    kind: "RUNTIME_SMOKE",
    name: "click",
    status: "PASS",
    summary: "1 real click row + 302 redirect to Coupang"
  });
  await recordValidationEvidence({
    root,
    kind: "RUNTIME_SMOKE",
    name: "report-sync",
    status: "PASS",
    summary: "clicks 404 rows, ads/impression-click 145 rows"
  });
  await recordValidationEvidence({
    root,
    kind: "RUNTIME_SMOKE",
    name: "attribution",
    status: "UNKNOWN",
    summary: "549 official rows unresolved",
    reason: "local smoke SUB_ID does not match past official report SUB_ID (NO_BINDING_MATCH)"
  });

  // Step 3: the file watcher also happened to observe generated build noise;
  // it must never leak into the changed-file analysis.
  await recordRuntimeChange(root, ".next/cache/webpack/x.pack");
  await recordRuntimeChange(root, "tsconfig.tsbuildinfo");
  await recordRuntimeChange(root, "components/AdSlot.jsx");

  await processDoneEvent(root);

  qualityReport = await readFile(join(root, ".devguard/reports/quality-report.md"), "utf8");
  projectHandoff = await readFile(join(root, ".devguard/reports/project-handoff.md"), "utf8");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("quality report shows the recorded Build PASS instead of 'no recent result'", () => {
  assert.match(qualityReport, /Build\s*\|\s*✅ PASS/);
  assert.doesNotMatch(qualityReport, /최근 실행 결과 없음/);
  assert.doesNotMatch(qualityReport, /No recent result/);
});

test("quality report shows recorded Typecheck and Targeted Tests as PASS", () => {
  assert.match(qualityReport, /Typecheck\s*\|\s*✅ PASS/);
  assert.match(qualityReport, /Targeted Tests\s*\|\s*✅ PASS/);
});

test("quality report lists runtime smoke evidence by name", () => {
  assert.match(qualityReport, /Runtime Smoke: product-api/);
  assert.match(qualityReport, /Runtime Smoke: attribution/);
});

test("quality report excludes .next and .tsbuildinfo noise from changed files", () => {
  assert.doesNotMatch(qualityReport, /tsconfig\.tsbuildinfo/);
  assert.doesNotMatch(qualityReport, /\.next\/cache/);
});

test("quality report keeps a tracked migration file instead of treating it as generated", () => {
  assert.match(qualityReport, /migrations\/0001_init\.sql/);
});

test("handoff preserves the canonical session goal instead of a generic UI sentence", () => {
  assert.match(projectHandoff, /Ad Serving \+ Report Pipeline End-to-End Milestone Verification/);
  assert.doesNotMatch(projectHandoff, /Update the user-facing UI behavior and verify the changed interaction\./);
});

test("handoff surfaces the unresolved attribution blocker together with its recorded reason", () => {
  assert.match(projectHandoff, /attribution/i);
  assert.match(projectHandoff, /NO_BINDING_MATCH|SUB_ID/);
});

test("handoff excludes generated noise from changed files the same way quality report does", () => {
  assert.doesNotMatch(projectHandoff, /tsconfig\.tsbuildinfo/);
  assert.doesNotMatch(projectHandoff, /\.next\/cache/);
});

test("no hallucinated 'pnpm cli' commands appear in generated reports", () => {
  assert.doesNotMatch(qualityReport, /pnpm cli/);
  assert.doesNotMatch(projectHandoff, /pnpm cli/);
});

test("handoff verification section reads real Next QA content, not the '확인 필요' placeholder", () => {
  assert.doesNotMatch(projectHandoff, /확인 필요/);
  assert.match(projectHandoff, /Verification to run next/);
});

test("quality report and handoff agree on the same NEEDS_REVIEW/BLOCKED verdict", () => {
  const qualityVerdict = qualityReport.match(/\| Overall \| [^\s]+ (PASS|NEEDS_REVIEW|BLOCKED) \|/)?.[1];
  const handoffStatus = projectHandoff.match(/- Status: (PASS|NEEDS_REVIEW|BLOCKED)/)?.[1];
  assert.ok(qualityVerdict, "quality report should contain an Overall verdict");
  assert.equal(handoffStatus, qualityVerdict);
});
