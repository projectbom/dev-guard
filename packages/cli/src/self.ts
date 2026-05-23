import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  analyzeFileRelevance,
  buildTaskCompletionCriteria,
  classifyTaskType,
  formatCompletionCriteria,
  generateCodexPrompt
} from "@dev-guard/core";
import { copyTextToClipboard } from "./clipboard.js";
import { fromRoot, writeTextFile } from "./fs.js";
import { getGitChanges, getProjectFiles } from "./git.js";
import { refreshProjectMemory } from "./refresh.js";
import { runCheck } from "./check.js";
import { runDoctor } from "./doctor.js";
import { runReview } from "./review.js";
import { runTaskAI } from "./task-ai.js";

const execFileAsync = promisify(execFile);

interface SelfOptions {
  requirement: string;
  copy: boolean;
  check: boolean;
}

export async function runSelf(root: string, args: string): Promise<void>;
export async function runSelf(root: string, args: string[]): Promise<void>;
export async function runSelf(root: string, args: string | string[]): Promise<void> {
  const options = parseSelfOptions(Array.isArray(args) ? args : [args]);
  console.error("dev-guard self: refreshing project memory");
  await refreshProjectMemory(root, { full: false, ai: false, dryRun: false });

  try {
    await runTaskAI(root, [options.requirement, "--write", "--prompt", "--save-run", ...(options.copy ? ["--copy"] : [])]);
  } catch (error) {
    if (!isProviderUnavailable(error)) {
      throw error;
    }
    console.error("dev-guard self: provider unavailable; using local heuristic task fallback");
    await runLocalSelfTask(root, options);
  }

  if (options.check) {
    await runSelfCheck(root);
  }
}

export async function runSelfCheck(root: string): Promise<void> {
  const results: Array<{ name: string; ok: boolean; reason?: string }> = [];
  for (const step of [
    { name: "pnpm run build", run: () => execFileAsync("pnpm", ["run", "build"], { cwd: root }) },
    { name: "dev-guard check --local", run: () => runCheck(root, { includeContextFiles: false, local: true }) },
    { name: "dev-guard review --heuristic", run: () => runReview(root, ["--heuristic"]) },
    { name: "dev-guard doctor", run: () => runDoctor(root) }
  ]) {
    console.error(`dev-guard self-check: running ${step.name}`);
    try {
      await step.run();
      results.push({ name: step.name, ok: true });
    } catch (error) {
      const reason = errorMessage(error);
      console.error(`dev-guard self-check: ${step.name} failed (${reason})`);
      results.push({ name: step.name, ok: false, reason });
    }
  }

  console.log("dev-guard self-check summary");
  for (const result of results) {
    console.log(`- ${result.ok ? "pass" : "fail"}: ${result.name}${result.reason ? ` (${result.reason})` : ""}`);
  }
  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

async function runLocalSelfTask(root: string, options: SelfOptions): Promise<void> {
  const [projectFiles, gitChanges] = await Promise.all([getProjectFiles(root), getGitChanges(root)]);
  const taskType = classifyTaskType(options.requirement);
  const criteria = buildTaskCompletionCriteria(taskType);
  const candidates = analyzeFileRelevance(options.requirement, projectFiles)
    .filter((candidate) => candidate.role === "edit" || candidate.role === "reference")
    .slice(0, 8);
  const selectedFiles = candidates.map((candidate) => candidate.path);
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
    selectedFiles.length > 0 ? selectedFiles.map((file) => `- ${file} (후보)`).join("\n") : "- 관련 파일 확인 필요",
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
    maxPromptTokens: 2500
  }).promptText;

  if (options.copy) {
    const result = await copyTextToClipboard(prompt);
    console.error(result.ok ? "dev-guard self: copied Codex prompt to clipboard." : `dev-guard self: clipboard copy failed (${result.reason}).`);
  }

  console.error("dev-guard self summary");
  console.error(`- density: ${prompt.match(/density=([^;\n]+)/)?.[1] ?? "ultra"}`);
  console.error(`- estimated_tokens: ${prompt.match(/estimated_tokens=~(\d+)/)?.[1] ?? "unknown"}`);
  console.error(`- selected files: ${selectedFiles.length > 0 ? selectedFiles.join(", ") : "none"}`);
  console.error("- prompt path: stdout");
  console.error("- task path: .devguard/task.md");
  console.error("- next command: pnpm cli self-check");
  console.log(prompt);
}

function parseSelfOptions(args: string[]): SelfOptions {
  const copy = args.includes("--copy");
  const check = args.includes("--check");
  const requirement = args.filter((arg) => !arg.startsWith("--")).join(" ").trim();
  if (!requirement) {
    throw new Error('요구사항을 입력해 주세요. 예: dev-guard self "prompt density 안전성 보강"');
  }
  return { requirement, copy, check };
}

function isProviderUnavailable(error: unknown): boolean {
  const message = errorMessage(error);
  return /AI provider가 none|OPENAI_API_KEY|provider is set to none/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
