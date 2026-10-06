// Context Workflow / Rollover-First contract. Found by a real downstream
// usage audit: one agent thread ran for 23h with 8 provider compactions,
// agents re-read handoff/quality/next-prompt markdown after every
// prepare_task_context (~108K tokens), DevGuard's OWN default constraints
// ("Watch / Hooks / Auth / Database / ...") were rendered as "do not modify"
// on Auth/DB tasks, "without importing Shadow changes" ranked only shadow-*
// files, the whole carried-over dirty tree was presented as the task's
// change set, and every history entry was classified token_optimization.
//
// Generic fixtures only; no provider calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  currentSessionQaCount,
  ensureCodeIndex,
  ensureDevguardWorkspace,
  prepareTaskContext,
  processDoneEvent,
  readProjectState,
  recordValidationEvidence,
  taskScopeConstraints,
  toAgentContextPayload
} from "../dist/runtime-state.js";
import { ensureAgentInstructions } from "../dist/install-agent-instructions.js";
import { estimateTokens, extractNegatedTerms } from "@dev-guard/core";

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

async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

// A small monorepo: real fence targets, shadow-* modules that share most of
// the task's vocabulary, auth/db modules, and enough filler for the Code
// Index to behave like a real repository (token rarity weighting needs 50+).
async function makeMonorepo() {
  const root = await mkdtemp(join(tmpdir(), "devguard-context-contract-"));
  cleanupRoots.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "DevGuard Test"]);
  await put(root, "package.json", JSON.stringify({ name: "fixture", scripts: { build: "true", test: "true" } }));
  await put(root, "packages/config/src/env.ts", [
    "export const STANDBY_MODE = process.env.STANDBY_MODE === 'true';",
    "export function isStandbyMode(): boolean {",
    "  return STANDBY_MODE;",
    "}",
    "export function requireProductionSafety(region: string): void {",
    "  if (!region) throw new Error('region required');",
    "}"
  ].join("\n") + "\n");
  await put(root, "apps/api/src/retention/interaction-retention.ts", [
    "import { isStandbyMode } from '@fixture/config';",
    "export class InteractionRetention {",
    "  startRetentionSweep(): void {",
    "    if (isStandbyMode()) return;",
    "    this.deleteExpired();",
    "  }",
    "  deleteExpired(): void {}",
    "}"
  ].join("\n") + "\n");
  await put(root, "apps/worker/src/main.ts", [
    "export async function bootstrapWorker(): Promise<void> {",
    "  startBackgroundJobs();",
    "}",
    "function startBackgroundJobs(): void {}"
  ].join("\n") + "\n");
  // Shadow modules deliberately reuse the task's vocabulary heavily.
  for (const name of ["shadow-provider", "shadow-readiness", "shadow-release"]) {
    await put(root, `apps/server/src/shadow/${name}.ts`, [
      `export function ${name.replace(/-(\w)/g, (_, c) => c.toUpperCase())}StandbyRelease(): string {`,
      "  // standby release baseline startup background retention fences readiness templates",
      "  return 'shadow standby release baseline startup background retention';",
      "}"
    ].join("\n") + "\n");
  }
  await put(root, "infra/shadow/readiness-template.json", JSON.stringify({ standby: true, release: "baseline", startup: "fenced", background: "fenced", retention: "fenced" }) + "\n");
  await put(root, "apps/api/src/auth/session-guard.ts", [
    "export function resolveSessionCustomer(sub: string, authProvider: string): string {",
    "  return `${authProvider}:${sub}`;",
    "}"
  ].join("\n") + "\n");
  await put(root, "packages/db/src/membership-repository.ts", [
    "export function findMembershipByAuthSubject(authSubject: string): string | undefined {",
    "  return authSubject ? 'membership' : undefined;",
    "}"
  ].join("\n") + "\n");
  for (let index = 0; index < 55; index += 1) {
    await put(root, `packages/feature-${index}/src/module-${index}.ts`, [
      `export function computeValue${index}(input: number): number {`,
      `  // unrelated feature ${index} logic`,
      `  return input * ${index + 1};`,
      "}"
    ].join("\n") + "\n");
  }
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "init"]);
  await ensureDevguardWorkspace(root);
  await ensureCodeIndex(root);
  return root;
}

const STANDBY_TASK =
  "Implement backward-compatible STANDBY_MODE fences for retention, startup and background paths in a baseline release without importing Shadow changes; targeted tests and readiness templates. Preserve dirty work; no commit/push.";

test("negative intent: 'without importing Shadow changes' never ranks shadow files as edit candidates", async () => {
  assert.deepEqual(extractNegatedTerms("compare contracts without importing Shadow changes"), ["shadow"]);
  assert.deepEqual(extractNegatedTerms("Shadow 변경을 가져오지 말 것"), ["shadow"]);
  assert.deepEqual(extractNegatedTerms("legacy 수정하지 마세요"), ["legacy"]);
  assert.deepEqual(extractNegatedTerms("Fix the login session mapping"), []);

  const root = await makeMonorepo();
  const result = await prepareTaskContext({ root, task: STANDBY_TASK, persistTask: false });
  const paths = result.files.map((file) => file.path);
  assert.ok(paths.includes("packages/config/src/env.ts"), `env.ts must be a candidate: ${paths.join(", ")}`);
  assert.ok(paths.includes("apps/api/src/retention/interaction-retention.ts"), `retention must be a candidate: ${paths.join(", ")}`);
  const firstReference = result.files.findIndex((file) => file.relevance === "Reference");
  for (const [index, file] of result.files.entries()) {
    if (/shadow/i.test(file.path)) {
      assert.equal(file.relevance, "Reference", `${file.path} must be reference-only`);
      assert.ok(index >= firstReference, "reference-only files come after every edit candidate");
    }
  }
  assert.ok(result.files.filter((file) => file.relevance === "Reference").length <= 2, "at most 2 reference-only slots");
  assert.ok(result.constraints.some((line) => /"shadow" out of scope.*\[task\]/.test(line)));
});

test("constraints are sourced from the task/project, never DevGuard's own default list (Auth/DB task)", async () => {
  const root = await makeMonorepo();
  const result = await prepareTaskContext({
    root,
    task: "Fix Auth session customer resolution: map JWT sub to auth_subject in the Database membership repository.",
    persistTask: false
  });
  const generic = ["Watch", "Hooks", "Auth", "Database", "Routing", "Core engine", "Project Knowledge extraction"];
  for (const item of generic) assert.ok(!result.constraints.includes(item), `generic "${item}" must not be a constraint`);
  for (const line of result.constraints) {
    assert.match(line, /\[task\]$|\[project config\]$|^No task-specific exclusions were stated\.$/, `constraint without a source: ${line}`);
  }
  const brief = await readFile(join(root, ".devguard/context/agent-brief.md"), "utf8");
  const readMap = await readFile(join(root, ".devguard/reports/read-map.md"), "utf8");
  for (const text of [brief, readMap]) assert.doesNotMatch(text, /Core engine|Project Knowledge extraction/);

  assert.deepEqual(taskScopeConstraints("Fix the login flow"), []);
  assert.ok(taskScopeConstraints("Fix login. Do not modify billing; no commit").some((line) => /billing/.test(line)));
});

test("task scope: earlier finalized dirty work is carried over (count only), but a carried file this task edits is in scope", async () => {
  const root = await makeMonorepo();
  // Task A leaves two files dirty and finalizes.
  await prepareTaskContext({ root, task: "Task A: update the feature 1 module." });
  await put(root, ".claude/settings.json", "{\"hooks\":{}}\n");
  await put(root, "packages/feature-1/src/module-1.ts", "export const changedByA = 1;\n");
  await processDoneEvent(root);

  // Task B (infra) edits one of A's files again and adds its own file.
  await prepareTaskContext({ root, task: "Task B: GCP Cloud Run and Vercel infra readiness for the worker startup." });
  await put(root, "packages/feature-1/src/module-1.ts", "export const changedByB = 2;\n");
  await put(root, "infra/cloud-run/worker.yaml", "service: worker\n");
  const result = await processDoneEvent(root);
  assert.deepEqual(result.carriedOverChangedFiles, [".claude/settings.json"]);
  assert.deepEqual([...result.taskScopedChangedFiles].sort(), ["infra/cloud-run/worker.yaml", "packages/feature-1/src/module-1.ts"]);

  const handoff = await readFile(join(root, ".devguard/reports/project-handoff.md"), "utf8");
  const quality = await readFile(join(root, ".devguard/reports/quality-report.md"), "utf8");
  const nextCodex = await readFile(join(root, ".devguard/prompts/next-codex-prompt.md"), "utf8");
  for (const text of [handoff, quality, nextCodex]) {
    assert.doesNotMatch(text, /\.claude\/settings\.json/, "carried-over files must not be presented as this task's changes");
    assert.doesNotMatch(text, /Handoff 생성 문구|adjust only the Handoff copy|Keep watch\/done\/status\/reset UX unchanged/, "no DevGuard-self instructions");
  }
  assert.match(handoff, /1 file\(s\) were already dirty|이번 작업이 수정하지 않은 파일 1개/);

  // History intent leads with the explicit task, not a DevGuard work type.
  const state = await readProjectState(root);
  assert.match(state.lastSummary, /^TASK: Task B: GCP Cloud Run and Vercel infra readiness/);
  assert.doesNotMatch(state.lastSummary, /token_optimization|prompt_quality/);
});

test("handoff and quality report share one validation source; next task is never generic filler", async () => {
  const root = await makeMonorepo();
  await prepareTaskContext({ root, task: "Add worker startup readiness check." });
  await put(root, "apps/worker/src/main.ts", "export async function bootstrapWorker(): Promise<void> { await readiness(); }\nasync function readiness() {}\n");
  await recordValidationEvidence({ root, kind: "RUNTIME_SMOKE", name: "worker-readiness", status: "FAIL", reason: "readiness endpoint returned 503" });
  await processDoneEvent(root);
  const handoff = await readFile(join(root, ".devguard/reports/project-handoff.md"), "utf8");
  const quality = await readFile(join(root, ".devguard/reports/quality-report.md"), "utf8");
  const nextCodex = await readFile(join(root, ".devguard/prompts/next-codex-prompt.md"), "utf8");
  assert.match(quality, /worker-readiness/);
  assert.match(handoff, /RUNTIME_SMOKE worker-readiness: FAIL — readiness endpoint returned 503/);
  assert.doesNotMatch(handoff, /외부 검증 명령의 실행 결과가 기록되어 있지 않습니다|no external verification/i, "must not claim nothing was recorded");
  assert.match(nextCodex, /## Next Task\n- Resolve recorded validation RUNTIME_SMOKE worker-readiness: FAIL/);
  assert.match(nextCodex, /fresh agent thread/);

  // A follow-up task that changes nothing still faces the SAME code state, so
  // the unresolved FAIL is still the real next action — not generic filler.
  await prepareTaskContext({ root, task: "Review the worker readiness design." });
  await processDoneEvent(root);
  const followUp = await readFile(join(root, ".devguard/prompts/next-claude-prompt.md"), "utf8");
  assert.match(followUp, /Next Task: Resolve recorded validation RUNTIME_SMOKE worker-readiness: FAIL/);

  // With no task-scoped change and no open evidence, say so explicitly.
  const clean = await makeMonorepo();
  await prepareTaskContext({ root: clean, task: "Review the worker readiness design." });
  await processDoneEvent(clean);
  const nextClaude = await readFile(join(clean, ".devguard/prompts/next-claude-prompt.md"), "utf8");
  assert.match(nextClaude, /No reliable next task inferred/);
  assert.doesNotMatch(nextClaude, /package scripts|dev-guard self-check/);
});

test("MCP payload is the complete small resume core: next action, scope, open validation, rollover advice, no duplicates", async () => {
  const root = await makeMonorepo();
  await prepareTaskContext({ root, task: "Task A: worker readiness." });
  await put(root, "apps/worker/src/main.ts", "export const changed = true;\n");
  await recordValidationEvidence({ root, kind: "RUNTIME_SMOKE", name: "worker-readiness", status: "UNKNOWN", reason: "endpoint not reachable" });
  await processDoneEvent(root);

  const result = await prepareTaskContext({ root, task: STANDBY_TASK, persistTask: false });
  const payload = toAgentContextPayload(result);
  assert.match(payload.nextAction, /^Previous task left unresolved: RUNTIME_SMOKE worker-readiness: UNKNOWN/);
  assert.match(payload.nextAction, /Read the TARGET ranges first \(.*(?:packages\/config\/src\/env\.ts|apps\/api\/src\/retention)/);
  assert.match(payload.nextAction, /open CANDIDATE files only if needed/);
  assert.ok(payload.files.some((file) => file.role === "TARGET"));
  assert.match(payload.workflow, /do not batch-read every file listed/);
  assert.equal(payload.scope.carriedOverDirtyFiles, 1);
  assert.match(payload.scope.warning, /already dirty before this task/);
  assert.deepEqual(payload.openValidation, ["RUNTIME_SMOKE worker-readiness: UNKNOWN — endpoint not reachable"]);
  assert.match(payload.rollover.advice, /fresh agent thread/);
  assert.match(payload.workflow, /Do not read \.devguard markdown/);
  for (const duplicate of ["readMapPath", "codeMapPath", "agentBriefPath", "resumeCost", "contextFiles"]) assert.equal(payload[duplicate], undefined);
  const tokens = estimateTokens(JSON.stringify(payload));
  assert.ok(tokens <= 2500, `MCP payload must stay within ~2.5K estimated tokens, got ${tokens}`);
});

test("rollover counts only the current task's validations", () => {
  const runtime = {
    sessionId: "sess_now",
    qaResults: {
      a: { sessionId: "sess_old", status: "PASS" },
      b: { sessionId: "sess_old", status: "PASS" },
      c: { sessionId: "sess_now", status: "PASS" }
    }
  };
  assert.equal(currentSessionQaCount(runtime), 1);
  assert.equal(currentSessionQaCount({ qaResults: runtime.qaResults }), 0);
});

test("agent instructions: MCP-primary, no markdown after MCP success, ranges before search, fresh thread per task", async () => {
  const root = await mkdtemp(join(tmpdir(), "devguard-instructions-"));
  cleanupRoots.push(root);
  await ensureAgentInstructions(root);
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    const text = await readFile(join(root, file), "utf8");
    assert.match(text, /call `prepare_task_context`/);
    assert.match(text, /do not also read DevGuard's markdown/);
    assert.match(text, /Do not immediately run repository-wide `rg`\/`grep`\/`find`/);
    assert.match(text, /fresh agent thread/);
    assert.match(text, /does not shorten or speed up the AI provider's own context compaction/);
    assert.doesNotMatch(text, /run `dev-guard done` and `dev-guard status` so handoff\/status files are current/);
    assert.doesNotMatch(text, /session: use `\.devguard\/reports\/read-map\.md`/);
    // Handoff/quality are opt-in only.
    assert.match(text, /Only on explicit request:[\s\S]*project-handoff\.md[\s\S]*quality-report\.md/);
  }
});
