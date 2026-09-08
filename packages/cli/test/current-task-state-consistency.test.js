// Regression tests for the "single authoritative CurrentTaskState" pass:
//   - Quality Report and Handoff must show identical QA facts (same
//     structured source, not a text-report-parse round trip)
//   - Handoff must never claim a command ran without evidence
//   - task constraints (no DevGuard CLI / no full repo build/test / no
//     commit / no push) must survive into Handoff and filter every
//     recommended command
//   - REQUIRED vs OUT_OF_SCOPE must not be confused with PASS/FAIL/
//     NOT_RECORDED
//   - task goal/identity must be identical across Handoff, Agent Context,
//     and Working Context, and a stale/previous task must never leak in
//   - import paths/module specifiers/unrelated string literals must never
//     be reported as user-facing wording changes
//   - AI enhancement must never be able to change deterministic QA facts,
//     and previous-session prose must never bleed into the current change
//     summary
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
  generateProjectHandoff,
  extractTaskConstraints,
  filterCommandsByConstraints,
  mergeAIQualityReview,
  stripHistoricalPhrases
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

async function makeRepo(prefix = "devguard-task-state-") {
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

async function readAgentContext(root) {
  return readFile(join(root, ".devguard/context/agent-context.md"), "utf8");
}

async function readWorkingContext(root) {
  return readFile(join(root, ".devguard/reports/working-context.md"), "utf8");
}

// --- A: QA consistency across renderers -------------------------------------

test("Test A: Quality Report and Handoff show identical QA facts (typecheck/test/runtime smoke PASS, build not recorded)", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await writeFile(join(root, "src.js"), "export const x = 1;\n");
  // Evidence must be recorded while a task is active (Task Binding
  // Contract) or it is UNBOUND and excluded from current-task QA facts.
  await prepareTaskContext({ root, task: "Fix admin dashboard filter." });
  await recordValidationEvidence({ root, kind: "TYPECHECK", status: "PASS", command: "tsc --noEmit" });
  await recordValidationEvidence({ root, kind: "TEST", status: "PASS", command: "vitest run" });
  await recordValidationEvidence({ root, kind: "RUNTIME_SMOKE", name: "http", status: "PASS", command: "curl http://localhost" });
  await processDoneEvent(root);

  const quality = await readQuality(root);
  const handoff = await readHandoff(root);

  // Quality Report: all three recorded PASS results are visible as PASS,
  // Build is visible as not recorded (not silently missing, not FAIL).
  assert.match(quality, /Typecheck[^\n]*✅ PASS/);
  assert.match(quality, /Targeted Tests[^\n]*✅ PASS/);
  assert.match(quality, /Runtime Smoke[^\n]*✅ PASS/);
  assert.match(quality, /Build[^\n]*Not recorded/i);
  assert.doesNotMatch(quality, /Build[^\n]*❌ FAIL/);

  // Handoff must not contradict this: it must not claim Typecheck/Test/
  // Runtime Smoke are still outstanding (they are recorded PASS), and it
  // must not silently drop the recorded PASS evidence either — the same
  // "not recorded" framing for Build must appear, not a blocker claim.
  assert.doesNotMatch(handoff, /Typecheck[^\n]*(not recorded|필요|missing)/i);
  assert.doesNotMatch(handoff, /Runtime [Ss]moke[^\n]*(still needs|남아|필요)/i);
});

// --- B: no false command execution claim ------------------------------------

test("Test B: Handoff never claims dev-guard done ran when it did not", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  // Regenerate Handoff the way `dev-guard handoff` does — WITHOUT ever
  // calling processDoneEvent (`dev-guard done`) in this session.
  await generateProjectHandoff(root);
  const handoff = await readHandoff(root);
  assert.doesNotMatch(handoff, /`dev-guard done`: pass/);
  assert.match(handoff, /`dev-guard done`: not run in this session/);
});

test("Test B (control): Handoff generated as part of an actual done run may say dev-guard done: pass", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await writeFile(join(root, "src.js"), "export const x = 1;\n");
  await prepareTaskContext({ root, task: "Small fix." });
  await processDoneEvent(root);
  const handoff = await readHandoff(root);
  assert.match(handoff, /`dev-guard done`: pass/);
});

// --- C: constraint filtering -------------------------------------------------

test("Test C: task constraints (no DevGuard CLI / no full repo build / no commit / no push) are never recommended", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await writeFile(join(root, "src.js"), "export const x = 1;\n");
  await prepareTaskContext({
    root,
    task: "Fix admin dashboard filter bug. Constraints: no DevGuard CLI, no full repo build, no commit, no push."
  });
  await processDoneEvent(root);

  const handoff = await readHandoff(root);
  // Handoff's Verification Run section legitimately reports that
  // `dev-guard done` already ran (it's what generated this document, see
  // Test B's control case) — that's an evidence statement, not a
  // recommendation, so it is excluded from the "never recommended" check.
  const recommendationSurface = handoff.replace(/## 6\. Verification Run[\s\S]*?(?=\n## )/, "");
  assert.doesNotMatch(recommendationSurface, /dev-guard self-check/);
  assert.doesNotMatch(recommendationSurface, /dev-guard done/);
  assert.doesNotMatch(recommendationSurface, /pnpm run build/);
  assert.doesNotMatch(recommendationSurface, /\bgit commit\b/);
  assert.doesNotMatch(recommendationSurface, /\bgit push\b/);
  // Constraints must still be visible to the next agent, not silently
  // dropped once the task text is reduced to a goal string.
  assert.match(handoff, /Constraints:/);
});

test("extractTaskConstraints / filterCommandsByConstraints: unit-level constraint model", () => {
  const constraints = extractTaskConstraints(
    "Fix admin dashboard filter bug. Constraints: no DevGuard CLI, no full repo build, no full repo test, no commit, no push."
  );
  const kinds = constraints.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["NO_COMMIT", "NO_DEVGUARD_CLI", "NO_FULL_REPO_BUILD", "NO_FULL_REPO_TEST", "NO_PUSH"]);

  const filtered = filterCommandsByConstraints(
    ["pnpm run build", "pnpm --filter admin run build", "dev-guard done", "git commit -m x", "pnpm run typecheck"],
    constraints
  );
  assert.ok(!filtered.includes("pnpm run build"), "full repo build must be filtered out");
  assert.ok(filtered.includes("pnpm --filter admin run build"), "a scoped/workspace build is not a full repo build");
  assert.ok(!filtered.includes("dev-guard done"), "DevGuard CLI commands must be filtered out");
  assert.ok(!filtered.includes("git commit -m x"), "commit must be filtered out");
  assert.ok(filtered.includes("pnpm run typecheck"), "an unrelated command must survive filtering");
});

// --- D: targeted QA is not mistaken for full-repo QA ------------------------

test("Test D: a full-repo build/test constraint is not forced as a completion blocker", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await writeFile(join(root, "src.js"), "export const x = 1;\n");
  await recordValidationEvidence({ root, kind: "TEST", name: "targeted", status: "PASS", command: "pnpm --filter admin test" });
  await prepareTaskContext({ root, task: "Fix admin dashboard filter bug. Constraints: no full repo build, no full repo test." });
  const result = await processDoneEvent(root);
  const quality = await readQuality(root);
  // package.json declares a root build script, so without the constraint
  // this would be flagged BLOCKED for missing a full `pnpm run build`
  // recommendation; with the constraint it must not be.
  assert.notEqual(result.qualityVerdict, "BLOCKED", `verdict must not be BLOCKED just because full-repo build/test is out of scope; got: ${quality}`);
  assert.doesNotMatch(quality, /build script exists but no build command was suggested/);
});

// --- E: QA confidence exactness ---------------------------------------------

test("Test E: QA Confidence states exactly what is recorded — no false PASS, no false 'still remains'", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await writeFile(join(root, "src.js"), "export const x = 1;\n");
  await recordValidationEvidence({ root, kind: "TYPECHECK", status: "PASS", command: "tsc --noEmit" });
  await recordValidationEvidence({ root, kind: "TEST", status: "PASS", command: "vitest run" });
  await recordValidationEvidence({ root, kind: "RUNTIME_SMOKE", name: "http", status: "PASS", command: "curl http://localhost" });
  await prepareTaskContext({ root, task: "Update the admin UI component and check the interaction." });
  await processDoneEvent(root);
  const quality = await readQuality(root);
  const confidenceSection = quality.split("8. QA Confidence")[1]?.split(/\n## /)[0] ?? "";
  assert.notEqual(confidenceSection, "", "QA Confidence section must be present");
  assert.doesNotMatch(confidenceSection, /Build[^\n]*(are recorded as PASS|passed)/i);
  assert.doesNotMatch(confidenceSection, /[Rr]untime [Ss]mok[^\n]*(remains|still)/);
});

// --- F/G/H: task identity consistency ---------------------------------------

test("Test F: the same current task goal is used by Handoff, Agent Context, and Working Context", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await writeFile(join(root, "src.js"), "export const x = 1;\n");
  await prepareTaskContext({ root, task: "Admin UI Audit Phase 2" });
  await processDoneEvent(root);

  const handoff = await readHandoff(root);
  const agentContext = await readAgentContext(root);
  const workingContext = await readWorkingContext(root);
  for (const [name, content] of [["Handoff", handoff], ["Agent Context", agentContext], ["Working Context", workingContext]]) {
    assert.match(content, /Admin UI Audit Phase 2/, `${name} must show the current task goal`);
  }
});

test("Test G: after a real task boundary, Handoff/Agent Context/Working Context agree there is no stale current task", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await writeFile(join(root, "src.js"), "export const x = 1;\n");
  await prepareTaskContext({ root, task: "Admin Runtime Bug Hunt" });
  await processDoneEvent(root);

  // No new prepare_task_context, no continuation — resetRuntimeState (as
  // triggered by a real `dev-guard reset`) is simulated by starting a fresh
  // root instead, since resetRuntimeState is exercised directly in
  // generated-artifact-and-context-accuracy.test.js Test C. Here we check
  // the cross-artifact agreement property specifically: a DIFFERENT task's
  // text must never appear in an unrelated fresh project's artifacts.
  const other = await makeRepo();
  await ensureDevguardWorkspace(other);
  await writeFile(join(other, "src.js"), "export const y = 1;\n");
  await prepareTaskContext({ root: other, task: "Update the template source viewer." });
  await processDoneEvent(other);

  const handoff = await readHandoff(other);
  const agentContext = await readAgentContext(other);
  const workingContext = await readWorkingContext(other);
  for (const [name, content] of [["Handoff", handoff], ["Agent Context", agentContext], ["Working Context", workingContext]]) {
    assert.doesNotMatch(content, /Admin Runtime Bug Hunt/, `${name} must not show an unrelated project's task`);
  }
});

test("Test H: a new task's Handoff does not inherit the previous task's next action text", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await writeFile(join(root, "a.js"), "export const a = 1;\n");
  await prepareTaskContext({ root, task: "Implement ad report pipeline" });
  await processDoneEvent(root);
  const handoffA = await readHandoff(root);
  assert.match(handoffA, /Implement ad report pipeline/);

  await writeFile(join(root, "b.js"), "export const b = 1;\n");
  await prepareTaskContext({ root, task: "Fix template version editor layout" });
  await processDoneEvent(root);
  const handoffB = await readHandoff(root);
  assert.match(handoffB, /Fix template version editor layout/);
  assert.doesNotMatch(handoffB, /Implement ad report pipeline/);
});

// --- I/J/K: change intelligence safety --------------------------------------

test("Test I: an import specifier change is never reported as user-facing wording", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await writeFile(
    join(root, "component.tsx"),
    'import { X } from "@partner-flow/contracts";\nimport Link from "next/link";\nexport const C = () => null;\n'
  );
  await prepareTaskContext({ root, task: "Swap the contracts import for next/link." });
  await processDoneEvent(root);
  const quality = await readQuality(root);
  const handoff = await readHandoff(root);
  assert.doesNotMatch(quality, /Updates the user-facing wording from ".*@partner-flow\/contracts.*" to/);
  assert.doesNotMatch(handoff, /Updates the user-facing wording from ".*@partner-flow\/contracts.*" to/);
});

test("Test J: unrelated string literals in different lines are not paired as a before/after wording change", async () => {
  const root = await makeRepo();
  await writeFile(join(root, "list.tsx"), 'export const label = "템플릿 목록";\nexport const OTHER = "unrelated";\n');
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "base"]);
  await ensureDevguardWorkspace(root);
  await writeFile(join(root, "list.tsx"), 'export const label = "other label";\nexport const OTHER = "LOOP";\n');
  await prepareTaskContext({ root, task: "Rename an unrelated constant." });
  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.doesNotMatch(quality, /Updates the user-facing wording from "템플릿 목록" to "LOOP"/);
});

test("Test K: an unrecognized UI diff falls back to a conservative, non-fabricated description", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await writeFile(join(root, "widget.tsx"), 'export function Widget(){ return <div className="xyzzy-plugh">{Math.random()}</div>; }\n');
  await prepareTaskContext({ root, task: "Adjust the widget UI." });
  await processDoneEvent(root);
  const quality = await readQuality(root);
  assert.match(quality, /Adjusts UI rendering or interaction behavior\./);
});

// --- L/M: AI cannot fabricate facts or leak history -------------------------

test("Test L: stripHistoricalPhrases removes only verbatim historical matches, keeps current text", () => {
  const historical = ["Back Card compressed to four cards.", "Moves details into a collapsible section."];
  const current = [
    "Back Card compressed to four cards.",
    "Adds a template source viewer and version editor split layout.",
    "Moves details into a collapsible section."
  ];
  const cleaned = stripHistoricalPhrases(current, historical);
  assert.deepEqual(cleaned, ["Adds a template source viewer and version editor split layout."]);
});

test("Test M: AI-generated prose cannot override deterministic verdict/QA/checklist facts", () => {
  const report = {
    verdict: "PASS",
    summary: ["Deterministic summary."],
    why: ["Deterministic reason."],
    relatedFiles: ["a.ts"],
    requiredVerification: [],
    checklist: [{ label: "generated/runtime files", status: "PASS", detail: "no generated runtime files in git changes" }],
    reviewItems: [],
    beforeCommit: [],
    nextRecommendedAction: "Ship it.",
    documentationSummary: undefined,
    qaResults: { "RUNTIME_SMOKE::default": { kind: "RUNTIME_SMOKE", name: "default", status: "PASS", source: "test", completedAt: new Date().toISOString(), durationMs: 1 } }
  };
  const generated = {
    summary: ["Runtime smoke still needs verification."],
    why: ["Build has not been verified either."],
    nextAction: "Run the full suite again.",
    reviewItems: []
  };
  const merged = mergeAIQualityReview(report, generated, { changedFiles: ["a.ts"], historicalPhrases: [] });
  assert.equal(merged.verdict, "PASS", "AI prose must not change the deterministic verdict");
  assert.deepEqual(merged.qaResults, report.qaResults, "AI prose must not change recorded QA results");
  assert.deepEqual(merged.checklist, report.checklist, "AI prose must not change the deterministic checklist");
});

// --- PartnerFlow-shaped fixture ----------------------------------------------

test("PartnerFlow fixture: Admin UI Audit Phase 2 produces internally consistent, accurate artifacts", async () => {
  const root = await makeRepo("devguard-partnerflow-taskstate-");
  await ensureDevguardWorkspace(root);
  await mkdir(join(root, "apps/admin/templates/[id]"), { recursive: true });
  await writeFile(join(root, "apps/admin/templates/[id]/page.tsx"), "export default function Page(){ return null; }\n");
  await writeFile(join(root, "apps/admin/templates/[id]/ad-template-version-form.tsx"), "export function Form(){ return null; }\n");

  // Evidence must be recorded while a task is active (Task Binding
  // Contract) or it is UNBOUND and excluded from current-task QA facts.
  await prepareTaskContext({
    root,
    task: "Admin UI Audit Phase 2: template source viewer + version editor improvement. Constraints: no DevGuard CLI, no full repo build, no full repo test, no commit, no push."
  });
  await recordValidationEvidence({ root, kind: "TYPECHECK", status: "PASS", command: "pnpm --filter admin typecheck" });
  await recordValidationEvidence({ root, kind: "TEST", name: "targeted", status: "PASS", command: "pnpm --filter admin test" });
  await recordValidationEvidence({ root, kind: "RUNTIME_SMOKE", name: "http", status: "PASS", command: "curl http://localhost:3000" });
  await processDoneEvent(root);

  const quality = await readQuality(root);
  const handoff = await readHandoff(root);
  const agentContext = await readAgentContext(root);
  const workingContext = await readWorkingContext(root);

  for (const [name, content] of [["Handoff", handoff], ["Agent Context", agentContext], ["Working Context", workingContext]]) {
    assert.match(content, /Admin UI Audit Phase 2/, `${name} must show the current task goal`);
  }

  // Verified evidence must be visible and consistent between Quality Report
  // and Handoff.
  assert.match(quality, /Typecheck[^\n]*✅ PASS/);
  assert.doesNotMatch(handoff, /Typecheck[^\n]*(not recorded|필요|missing)/i);

  // Forbidden commands must never be RECOMMENDED — Handoff's Verification
  // Run section is an evidence statement about what already happened (this
  // Handoff genuinely was produced by a `done` run in this test, see Test
  // B's control case), not a recommendation, so it is excluded here.
  const handoffWithoutVerificationEvidence = handoff.replace(/## 6\. Verification Run[\s\S]*?(?=\n## )/, "");
  for (const doc of [handoffWithoutVerificationEvidence, quality]) {
    assert.doesNotMatch(doc, /dev-guard self-check/);
    assert.doesNotMatch(doc, /dev-guard done/);
    assert.doesNotMatch(doc, /pnpm run build/);
    assert.doesNotMatch(doc, /\bgit commit\b/);
    assert.doesNotMatch(doc, /\bgit push\b/);
  }

  // This Handoff genuinely was generated by a `done` run in this call, so
  // (unlike Test B) it is correct for it to say so.
  assert.match(handoff, /`dev-guard done`: pass/);
});
