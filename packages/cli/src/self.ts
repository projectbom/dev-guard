import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  analyzeFileRelevance,
  buildImpactHints,
  buildTaskCompletionCriteria,
  classifyTaskType,
  formatCompletionCriteria,
  generateCodexPrompt,
  type CodeGraphEntry,
  type FileSummary,
  type ProjectIndexEntry
} from "@dev-guard/core";
import { copyTextToClipboard } from "./clipboard.js";
import { filterCommandTargetCandidates, inferCommandTargetFiles, mergeCommandTargetCandidates } from "./command-targets.js";
import { fromRoot, readJsonFile, writeTextFile } from "./fs.js";
import { getGitChanges, getProjectFiles } from "./git.js";
import { refreshProjectMemory } from "./refresh.js";
import { runCheck } from "./check.js";
import { runDoctor } from "./doctor.js";
import { runReview } from "./review.js";
import { runTaskAI } from "./task-ai.js";
import { recordQAExecutionResult, recordValidationEvidence, type ValidationEvidenceKind } from "./runtime-state.js";

const execFileAsync = promisify(execFile);

interface SelfOptions {
  requirement: string;
  copy: boolean;
  check: boolean;
  debugContext: boolean;
}

export async function runSelf(root: string, args: string): Promise<void>;
export async function runSelf(root: string, args: string[]): Promise<void>;
export async function runSelf(root: string, args: string | string[]): Promise<void> {
  const options = parseSelfOptions(Array.isArray(args) ? args : [args]);
  console.error(options.debugContext ? "dev-guard self: refreshing project memory" : "dev-guard: refreshing project memory");
  await refreshProjectMemory(root, { full: false, ai: false, dryRun: false });

  try {
    await runTaskAI(root, [
      options.requirement,
      "--write",
      "--prompt",
      "--save-run",
      ...(options.copy ? ["--copy"] : []),
      ...(options.debugContext ? ["--debug-context"] : [])
    ]);
  } catch (error) {
    if (!isProviderUnavailable(error)) {
      throw error;
    }
    console.error(options.debugContext ? "dev-guard self: provider unavailable; using local heuristic task fallback" : "dev-guard: provider unavailable; using local heuristic fallback");
    await runLocalSelfTask(root, options);
  }

  if (options.check) {
    await runSelfCheck(root);
  }
}

export async function runSelfCheck(root: string): Promise<void> {
  const results: Array<{ name: string; ok: boolean; reason?: string; output: string[] }> = [];
  const selfStartedAt = new Date();
  for (const step of [
    { name: "pnpm run build", run: () => execFileAsync("pnpm", ["run", "build"], { cwd: root }) },
    { name: "dev-guard check --local", run: () => runCheck(root, { includeContextFiles: false, local: true }) },
    { name: "dev-guard review --heuristic", run: () => runReview(root, ["--heuristic"]) },
    { name: "dev-guard doctor", run: () => runDoctor(root) }
  ]) {
    console.log(`dev-guard self-check: running ${step.name}`);
    const startedAt = new Date();
    try {
      const output = await captureConsole(step.run);
      const completedAt = new Date();
      results.push({ name: step.name, ok: true, output });
      await recordQAExecutionResult(root, {
        name: qaResultName(step.name),
        command: step.name,
        status: "PASS",
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        summary: summarizeSelfCheckStep(step.name, output).join("; "),
        kind: qaResultKind(step.name),
        source: "self-check"
      });
      for (const line of summarizeSelfCheckStep(step.name, output)) {
        console.log(`  ${line}`);
      }
    } catch (error) {
      const completedAt = new Date();
      const reason = errorMessage(error);
      console.log(`dev-guard self-check: ${step.name} failed (${reason})`);
      results.push({ name: step.name, ok: false, reason, output: [] });
      await recordQAExecutionResult(root, {
        name: qaResultName(step.name),
        command: step.name,
        status: "FAIL",
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        reason,
        kind: qaResultKind(step.name),
        source: "self-check"
      });
    }
  }

  console.log("dev-guard self-check summary");
  for (const result of results) {
    console.log(`- ${result.ok ? "pass" : "fail"}: ${result.name}${result.reason ? ` (${result.reason})` : ""}`);
  }
  const selfCompletedAt = new Date();
  const failed = results.find((result) => !result.ok);
  await recordQAExecutionResult(root, {
    name: "self-check",
    command: "dev-guard self-check",
    status: failed ? "FAIL" : "PASS",
    startedAt: selfStartedAt.toISOString(),
    completedAt: selfCompletedAt.toISOString(),
    durationMs: selfCompletedAt.getTime() - selfStartedAt.getTime(),
    summary: results.map((result) => `${result.ok ? "pass" : "fail"}: ${result.name}`).join("; "),
    reason: failed?.reason,
    kind: "CUSTOM",
    source: "self-check"
  });
  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

function qaResultName(command: string): string {
  if (command === "pnpm run build") return "build";
  if (command === "dev-guard check --local") return "check-local";
  if (command === "dev-guard review --heuristic") return "review-heuristic";
  if (command === "dev-guard doctor") return "doctor";
  return command;
}

function qaResultKind(command: string): "BUILD" | "CUSTOM" {
  return command === "pnpm run build" ? "BUILD" : "CUSTOM";
}

const VALIDATION_KINDS: ValidationEvidenceKind[] = ["BUILD", "TYPECHECK", "TEST", "LINT", "MANUAL_QA", "RUNTIME_SMOKE", "CUSTOM"];
const VALIDATION_STATUSES = ["PASS", "FAIL", "UNKNOWN"] as const;

export async function runRecordValidation(root: string, args: string[]): Promise<void> {
  const options = parseFlags(args);
  const rawKind = options.get("kind")?.toUpperCase();
  const rawStatus = options.get("status")?.toUpperCase();
  const kind = VALIDATION_KINDS.find((candidate) => candidate === rawKind);
  const status = VALIDATION_STATUSES.find((candidate) => candidate === rawStatus);
  if (!kind) {
    throw new Error(`--kind is required and must be one of: ${VALIDATION_KINDS.join(", ")}`);
  }
  if (!status) {
    throw new Error(`--status is required and must be one of: ${VALIDATION_STATUSES.join(", ")}`);
  }
  const result = await recordValidationEvidence({
    root,
    kind,
    status,
    name: options.get("name"),
    command: options.get("command"),
    summary: options.get("summary"),
    reason: options.get("reason")
  });
  console.log(`dev-guard record-validation: recorded ${result.kind} "${result.name}" as ${result.status}`);
  console.log("- next: run dev-guard done to regenerate Quality Report / Handoff with this evidence");
}

function parseFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, "true");
      continue;
    }
    flags.set(key, next);
    index += 1;
  }
  return flags;
}

async function runLocalSelfTask(root: string, options: SelfOptions): Promise<void> {
  const [projectFiles, gitChanges, index, summaries, codeGraph] = await Promise.all([
    getProjectFiles(root),
    getGitChanges(root),
    readJsonFile<ProjectIndexEntry[]>(fromRoot(root, ".devguard/project-index.json"), []),
    readJsonFile<FileSummary[]>(fromRoot(root, ".devguard/file-summaries.json"), []),
    readJsonFile<CodeGraphEntry[]>(fromRoot(root, ".devguard/code-graph.json"), [])
  ]);
  const taskType = classifyTaskType(options.requirement);
  const criteria = buildTaskCompletionCriteria(taskType);
  const commandTarget = inferCommandTargetFiles(options.requirement, projectFiles);
  const relevanceCandidates = filterCommandTargetCandidates(analyzeFileRelevance(options.requirement, projectFiles, { index, summaries, codeGraph }), commandTarget);
  const candidates = mergeCommandTargetCandidates(relevanceCandidates, commandTarget)
    .filter((candidate) => candidate.role === "edit" || candidate.role === "reference")
    .slice(0, 8);
  const editFiles = candidates.filter((candidate) => candidate.role === "edit").map((candidate) => candidate.path);
  const referenceFiles = candidates.filter((candidate) => candidate.role === "reference").map((candidate) => candidate.path);
  const selectedFiles = [...editFiles, ...referenceFiles];
  const impactHints = buildImpactHints([...gitChanges.changedFiles, ...selectedFiles], codeGraph);
  if (options.debugContext) {
    console.error("dev-guard self debug context");
    console.error(`- requirement anchor: ${options.requirement}`);
    console.error(`- task type: ${taskType.type}${taskType.subtype ? ` / ${taskType.subtype}` : ""}`);
    console.error(`- scored candidates (${candidates.length}):`);
    for (const candidate of candidates) {
      console.error(`  - ${candidate.path}`);
      console.error(`    score: ${candidate.score}`);
      console.error(`    role: ${candidate.role}`);
      console.error(`    reasons: ${candidate.reasons.join("; ") || "none"}`);
    }
    console.error(`- impact hints (${impactHints.length}):`);
    for (const hint of impactHints.slice(0, 5)) {
      console.error(`  - ${hint.file}: imported by ${hint.importedByCount}; affected ${hint.affectedAreas.join(", ") || "unknown"}`);
    }
  }
  const taskMarkdown = [
    "## 목표",
    options.requirement,
    "",
    "## 사용자 요구사항 해석",
    `- 원문: ${options.requirement}`,
    `- 작업 유형: ${taskType.type}${taskType.subtype ? ` / ${taskType.subtype}` : ""}`,
    "",
    "## 작업 유형",
    `- type: ${taskType.type}`,
    `- confidence: ${taskType.confidence}`,
    `- strategy: ${taskType.strategy}`,
    `- risk: ${taskType.riskLevel}`,
    `- requires phasing: ${taskType.requiresPhasing}`,
    taskType.subtype ? `- subtype: ${taskType.subtype}` : "",
    "",
    "## 수정 대상",
    editFiles.length > 0 ? editFiles.map((file) => `- ${file} (후보)`).join("\n") : "- 관련 파일 확인 필요",
    "",
    "## 참고 대상",
    referenceFiles.length > 0 ? referenceFiles.map((file) => `- ${file} (참고)`).join("\n") : "- 없음",
    "",
    "## 보호 대상",
    "- scope_lock=true",
    "- preserve_behavior=true",
    "- unrelated_changes_forbidden=true",
    "",
    "## 완료 기준",
    formatCompletionCriteria(criteria),
    "",
    "## 검증 명령어",
    "- `pnpm run build`",
    "- `pnpm cli check --local`",
    "- `pnpm cli review --heuristic`",
    ""
  ]
    .filter((line) => line !== "")
    .join("\n");

  await writeTextFile(fromRoot(root, ".devguard/task.md"), `${taskMarkdown}\n`);
  const prompt = generateCodexPrompt({
    taskMarkdown,
    rulesMarkdown: "",
    mistakesMarkdown: "",
    projectStateMarkdown: "",
    decisionsMarkdown: "",
    changedFiles: gitChanges.changedFiles,
    changeFiles: gitChanges.changeFiles,
    diffText: gitChanges.diffText,
    compact: true,
    density: "ultra",
    maxPromptTokens: 2500,
    impactHints
  }).promptText;

  if (options.copy) {
    const result = await copyTextToClipboard(prompt);
    console.error(result.ok ? "dev-guard: copied Codex prompt to clipboard." : `dev-guard: clipboard copy failed (${result.reason}).`);
  }

  console.error(options.debugContext ? "dev-guard self summary" : "dev-guard prompt summary");
  console.error(`- density: ${prompt.match(/density=([^;\n]+)/)?.[1] ?? "ultra"}`);
  console.error(`- estimated_tokens: ${prompt.match(/estimated_tokens=~(\d+)/)?.[1] ?? "unknown"}`);
  console.error(`- selected files: ${selectedFiles.length > 0 ? selectedFiles.join(", ") : "none"}`);
  console.error("- prompt path: stdout");
  console.error("- task path: .devguard/task.md");
  console.error("- next command: dev-guard done");
  console.log(prompt);
}

function parseSelfOptions(args: string[]): SelfOptions {
  const copy = args.includes("--copy");
  const check = args.includes("--check");
  const debugContext = args.includes("--debug-context");
  const requirement = args.filter((arg) => !arg.startsWith("--")).join(" ").trim();
  if (!requirement) {
    throw new Error('요구사항을 입력해 주세요. 예: dev-guard self "prompt density 안전성 보강"');
  }
  return { requirement, copy, check, debugContext };
}

function isProviderUnavailable(error: unknown): boolean {
  const message = errorMessage(error);
  return /AI provider가 none|OPENAI_API_KEY|provider is set to none/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function captureConsole(run: () => Promise<unknown>): Promise<string[]> {
  const originalLog = console.log;
  const originalError = console.error;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(...args.map(String).join(" ").split(/\r?\n/));
  };
  console.error = (...args: unknown[]) => {
    lines.push(...args.map(String).join(" ").split(/\r?\n/));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines;
}

function summarizeSelfCheckStep(name: string, lines: string[]): string[] {
  if (name === "pnpm run build") {
    return ["build completed"];
  }
  if (name === "dev-guard check --local") {
    return [`findings: ${countMatching(lines, "[warning]")} warning(s), ${countMatching(lines, "[info]")} info`];
  }
  if (name === "dev-guard review --heuristic") {
    const status = valueAfter(lines, "status:") ?? "unknown";
    const alignment = valueAfter(lines, "- Requirement Alignment Score:") ?? valueAfter(lines, "Requirement Alignment Score:");
    const drift = valueAfter(lines, "- Drift Risk:") ?? valueAfter(lines, "Drift Risk:");
    return [`status: ${status}`, alignment ? `requirement alignment: ${alignment}` : undefined, drift ? `drift risk: ${drift}` : undefined].filter(
      (line): line is string => Boolean(line)
    );
  }
  if (name === "dev-guard doctor") {
    return [
      `provider: ${valueAfter(lines, "Provider:") ?? "unknown"}`,
      `git baseline: ${valueAfter(lines, "Git Baseline:") ?? "unknown"}`,
      `project memory: ${valueAfter(lines, "Project Memory:") ?? "unknown"}`
    ];
  }
  return lines.slice(0, 3);
}

function valueAfter(lines: string[], prefix: string): string | undefined {
  const line = lines.find((candidate) => candidate.trim().startsWith(prefix));
  return line ? line.trim().slice(prefix.length).trim() : undefined;
}

function countMatching(lines: string[], pattern: string): number {
  return lines.filter((line) => line.includes(pattern)).length;
}
