import {
  filterDevGuardContextFiles,
  filterDiffTextForFiles,
  formatInferredDiffIntentClusters,
  inferDiffIntentClusters,
  inferredIntentToRequirement,
  isAlwaysIgnoredContextPath,
  scoreTaskAnchorFreshness,
  type ChangeFile,
  type CodeGraphEntry,
  type DevGuardRunLog,
  type InferredDiffIntentClusters,
  type ProjectIdentity,
  type TaskAnchorFreshnessResult
} from "@dev-guard/core";
import type { GitChanges } from "./git.js";
import { sameProjectIdentity } from "./project-identity.js";
import { listRunLogs, readLatestRun, readRunById } from "./runs.js";

export type EffectiveTaskMode = "diff-first" | "diff-first_uncertain" | "task-first" | "task-first_caution";
export type EffectiveAnchorStatus = "absent" | "stale" | "uncertain" | "fresh";

export interface EffectiveTaskOptions {
  forceTask?: boolean;
  fromDiff?: boolean;
  noRun?: boolean;
  runId?: string;
}

export interface EffectiveTaskContext {
  anchorStatus: EffectiveAnchorStatus;
  mode: EffectiveTaskMode;
  taskMatchScore: number;
  runMatchScore?: number;
  useTaskMarkdown: boolean;
  useRun: boolean;
  effectiveTaskMarkdown: string;
  effectiveRunLog?: DevGuardRunLog;
  inferredTask: InferredDiffIntentClusters;
  reason: string;
  freshness: TaskAnchorFreshnessResult;
  runSelection: EffectiveRunSelection;
}

export interface EffectiveRunSelection {
  run?: DevGuardRunLog;
  score?: number;
  mode: "none" | "explicit" | "latest" | "matched";
  warning?: string;
}

const runUseThreshold = 30;

export async function resolveEffectiveTaskContext(input: {
  root: string;
  taskMarkdown: string;
  gitChanges: Pick<GitChanges, "diffText" | "changedFiles" | "changeFiles">;
  reviewChangeFiles?: ChangeFile[];
  changedFiles?: string[];
  codeGraph?: CodeGraphEntry[];
  currentIdentity?: ProjectIdentity;
  options?: EffectiveTaskOptions;
}): Promise<EffectiveTaskContext> {
  const options = input.options ?? {};
  const rawChangeFiles = input.reviewChangeFiles ?? input.gitChanges.changeFiles;
  const changeFiles = filterDevGuardContextFiles(rawChangeFiles, false);
  const changedFileSet = new Set(changeFiles.map((file) => file.path));
  const changedFiles = (input.changedFiles ?? [...changedFileSet])
    .filter((file) => changedFileSet.has(file) && !isAlwaysIgnoredContextPath(file))
    .sort();
  const diffText = filterDiffTextForFiles(input.gitChanges.diffText, changedFiles);
  const freshness = scoreTaskAnchorFreshness({
    taskMarkdown: input.taskMarkdown,
    diffText,
    changedFiles,
    changeFiles
  });
  const diffOnlyInferredTask = inferDiffIntentClusters({
    changedFiles,
    changeFiles,
    diffText,
    codeGraph: input.codeGraph ?? []
  });
  const runSelection = await selectEffectiveRun({
    root: input.root,
    options,
    changedFiles,
    taskMarkdown: input.taskMarkdown,
    currentIdentity: input.currentIdentity
  });
  const runMatchScore = runSelection.score ?? 0;
  const anchorStatus = mapAnchorStatus(freshness.mode);
  const forced = Boolean(options.forceTask);
  const fromDiff = Boolean(options.fromDiff);

  let mode: EffectiveTaskMode;
  let useTaskMarkdown: boolean;
  let useRun = false;
  let reason: string;

  if (fromDiff) {
    mode = "diff-first";
    useTaskMarkdown = false;
    reason = "forced from current diff";
  } else if (forced) {
    mode = freshness.mode === "use_task" ? "task-first" : "task-first_caution";
    useTaskMarkdown = true;
    useRun = Boolean(runSelection.run);
    reason = "--task forced";
  } else if (freshness.mode === "anchor_absent") {
    mode = "diff-first";
    useTaskMarkdown = false;
    reason = "task.md absent";
  } else if (freshness.mode === "stale") {
    mode = "diff-first";
    useTaskMarkdown = false;
    reason = `task.md stale (match score ${freshness.matchScore})`;
  } else if (freshness.mode === "uncertain") {
    if (runMatchScore < runUseThreshold) {
      mode = "diff-first_uncertain";
      useTaskMarkdown = false;
      reason = `task.md uncertain and run score ${runMatchScore} < ${runUseThreshold}`;
    } else {
      mode = "task-first_caution";
      useTaskMarkdown = true;
      reason = `task.md uncertain but run score ${runMatchScore} >= ${runUseThreshold}`;
    }
  } else {
    mode = "task-first";
    useTaskMarkdown = true;
    useRun = Boolean(runSelection.run && runMatchScore >= runUseThreshold);
    reason = `task.md fresh (match score ${freshness.matchScore})`;
  }

  if (options.noRun || fromDiff || (!forced && (freshness.mode !== "use_task" || runMatchScore < runUseThreshold))) {
    useRun = false;
  }
  if (!forced && !fromDiff && useTaskMarkdown && shouldPreferDiffIntent(input.taskMarkdown, diffOnlyInferredTask)) {
    mode = freshness.mode === "uncertain" ? "diff-first_uncertain" : "diff-first";
    useTaskMarkdown = false;
    useRun = false;
    reason = "task.md topic conflicts with current diff intent";
  }

  const inferredTask = inferDiffIntentClusters({
    changedFiles,
    changeFiles,
    diffText,
    codeGraph: input.codeGraph ?? [],
    taskText: useTaskMarkdown ? input.taskMarkdown : undefined
  });
  const effectiveTaskMarkdown = useTaskMarkdown
    ? input.taskMarkdown
    : buildInferredTaskMarkdown(inferredTask, mode);

  return {
    anchorStatus,
    mode,
    taskMatchScore: freshness.matchScore,
    runMatchScore,
    useTaskMarkdown,
    useRun,
    effectiveTaskMarkdown,
    effectiveRunLog: useRun ? runSelection.run : undefined,
    inferredTask,
    reason,
    freshness,
    runSelection
  };
}

function shouldPreferDiffIntent(taskMarkdown: string, inferred: InferredDiffIntentClusters): boolean {
  const intent = inferred.primaryIntent;
  const text = taskMarkdown.toLowerCase();
  const subtype = (intent.subtype ?? "").toLowerCase();
  if (intent.type !== "app_feature_refactor") {
    return false;
  }
  const hasArchitectureTaskSignal = /(architecture|refactor|migration|structure|구조|전환|마이그레이션|재구성|리팩터)/i.test(taskMarkdown);
  const hasCopyOnlySignal = /(ui_text_cleanup|copy-only|wording_cleanup|문구|표현|카피|텍스트|wording|copy cleanup)/i.test(taskMarkdown);
  const scopeTokens = [
    subtype,
    ...intent.scope.filter((scope) => !/ui|source|changed|document_ui/.test(scope)).map((scope) => scope.toLowerCase())
  ].filter((token) => token.length >= 4);
  const hasIntentToken = scopeTokens.some((token) => text.includes(token.replace(/_/g, "-")) || text.includes(token.replace(/_/g, " ")));
  if (subtype === "living_document") {
    const hasLivingDocumentSignal = /(living\s*document|living-document|artifact|아티팩트|문서|document)/i.test(taskMarkdown);
    return !hasLivingDocumentSignal && hasCopyOnlySignal;
  }
  return !hasArchitectureTaskSignal && !hasIntentToken && hasCopyOnlySignal;
}

export function formatEffectiveTaskBasis(context: EffectiveTaskContext): string[] {
  return [
    `review basis: ${basisLabel(context)}`,
    `task summary: ${summarizeTask(context)}`,
    `run: ${context.useRun && context.effectiveRunLog ? `used ${context.effectiveRunLog.id}` : "ignored"}`
  ];
}

export function formatEffectiveTaskContext(prefix: string, context: EffectiveTaskContext): string[] {
  const taskLabel =
    context.anchorStatus === "absent"
      ? "task anchor: absent"
      : `task.md ${context.anchorStatus} (match score ${context.taskMatchScore})`;
  const runScore = context.runMatchScore ?? 0;
  const runLabel = context.useRun && context.effectiveRunLog
    ? `using run ${context.effectiveRunLog.id} (match score ${runScore})`
    : `run ignored (match score ${runScore})`;
  const using = context.useTaskMarkdown
    ? context.mode === "task-first_caution"
      ? "using task.md with caution"
      : "using task.md"
    : "using diff-inferred task";
  return [
    `${prefix}: ${taskLabel}`,
    `${prefix}: ${runLabel}`,
    `${prefix}: ${using} (${context.mode})`
  ];
}

export function formatEffectiveTaskBlock(title: string, context: EffectiveTaskContext): string[] {
  return [
    title,
    `  - task.md: ${context.anchorStatus}${context.anchorStatus === "absent" ? "" : ` (match score ${context.taskMatchScore})`}`,
    `  - run: ${context.useRun && context.effectiveRunLog ? `using ${context.effectiveRunLog.id}` : "ignored"} (match score ${context.runMatchScore ?? 0})`,
    `  - using: ${context.useTaskMarkdown ? "task.md" : "inferred task from current diff"} (${context.mode})`
  ];
}

export function formatEffectiveRunSummary(context: EffectiveTaskContext): string {
  return [
    context.useRun && context.effectiveRunLog ? `- using run: ${context.effectiveRunLog.id}` : "- run: ignored",
    `- run match score: ${context.runMatchScore ?? 0}`,
    `- anchor mode: ${context.mode}`,
    `- primary basis: ${basisLabel(context)}`,
    `- task summary: ${summarizeTask(context)}`
  ].join("\n");
}

function basisLabel(context: EffectiveTaskContext): string {
  if (context.reason === "--task forced") {
    return "forced task";
  }
  if (context.reason === "forced from current diff") {
    return "forced diff";
  }
  return context.useTaskMarkdown ? "task.md" : "diff-inferred";
}

function summarizeTask(context: EffectiveTaskContext): string {
  const intent = context.inferredTask.primaryIntent;
  const source = context.effectiveTaskMarkdown;
  const goal = extractSectionFirstLine(source, "목표") ?? extractSectionFirstLine(source, "Goal");
  const type =
    source.match(/type:\s*([a-z_]+)/i)?.[1] ??
    intent.type;
  const subtype =
    source.match(/subtype:\s*([a-z0-9_.+-]+)/i)?.[1] ??
    intent.subtype;
  const summary = goal ?? inferredIntentToRequirement(intent).split(/\r?\n/)[0] ?? "current diff";
  return [summary.replace(/^-\s*/, "").slice(0, 100), type ? `type=${type}` : "", subtype ? `subtype=${subtype}` : ""]
    .filter(Boolean)
    .join(" / ");
}

function extractSectionFirstLine(markdown: string, section: string): string | undefined {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, "i").test(line.trim()));
  if (start < 0) {
    return undefined;
  }
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (/^##\s+/.test(trimmed)) {
      break;
    }
    if (trimmed && !trimmed.startsWith("#")) {
      return trimmed;
    }
  }
  return undefined;
}

async function selectEffectiveRun(input: {
  root: string;
  options: EffectiveTaskOptions;
  changedFiles: string[];
  taskMarkdown: string;
  currentIdentity?: ProjectIdentity;
}): Promise<EffectiveRunSelection> {
  if (input.options.noRun || input.options.fromDiff) {
    return { mode: "none" };
  }

  if (input.options.runId === "latest") {
    const latest = await readLatestRun(input.root);
    if (!latest) {
      return { mode: "latest", warning: "latest run not found" };
    }
    const warning = runIdentityWarning("latest run", latest, input.currentIdentity);
    if (warning) {
      return { mode: "latest", warning };
    }
    return { run: latest, score: scoreRunAgainstDiff(latest, input.changedFiles, input.taskMarkdown), mode: "latest" };
  }

  if (input.options.runId) {
    const run = await readRunById(input.root, input.options.runId);
    if (!run) {
      return { mode: "explicit", warning: `run ${input.options.runId} not found` };
    }
    const warning = runIdentityWarning(`run ${input.options.runId}`, run, input.currentIdentity);
    if (warning) {
      return { mode: "explicit", warning };
    }
    return { run, score: scoreRunAgainstDiff(run, input.changedFiles, input.taskMarkdown), mode: "explicit" };
  }

  const [latest, runs] = await Promise.all([readLatestRun(input.root), listRunLogs(input.root)]);
  const usableRuns = runs.filter((run) => !runIdentityWarning(`run ${run.id}`, run, input.currentIdentity));
  const scoredRuns = usableRuns
    .map((run) => ({ run, score: scoreRunAgainstDiff(run, input.changedFiles, input.taskMarkdown) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.run.createdAt) - Date.parse(a.run.createdAt));
  const selected = scoredRuns[0];
  const latestWarning = latest ? runIdentityWarning("latest run", latest, input.currentIdentity) : undefined;
  const latestScore = latest && !latestWarning ? scoreRunAgainstDiff(latest, input.changedFiles, input.taskMarkdown) : undefined;
  if (selected) {
    return {
      run: selected.run,
      score: selected.score,
      mode: "matched",
      warning: latestWarning ?? (latest && latest.id !== selected.run.id && latestScore === 0 ? "latest run does not match current diff" : undefined)
    };
  }
  return {
    mode: "none",
    score: latestScore,
    warning: latestWarning ?? (latest && latestScore === 0 ? "latest run does not match current diff" : undefined)
  };
}

function scoreRunAgainstDiff(run: DevGuardRunLog, changedFiles: string[], taskMarkdown: string): number {
  const changed = changedFiles.filter((file) => !isAlwaysIgnoredContextPath(file));
  if (changed.length === 0) {
    return 0;
  }
  const runHints = [
    ...(run.relatedFiles ?? []),
    ...(run.changedFilesAtCreation ?? []),
    ...extractPathHints(run.generatedTaskMarkdown ?? ""),
    ...extractPathHints(run.generatedCodexPrompt ?? "")
  ].filter((path) => !isAlwaysIgnoredContextPath(path));
  let score = 0;
  for (const file of changed) {
    if (runHints.some((hint) => pathHintMatches(file, hint))) {
      score += 3;
    }
  }
  if (run.userRequest && taskMarkdown.includes(run.userRequest.slice(0, 30))) {
    score += 1;
  }
  return score;
}

function runIdentityWarning(source: string, run: DevGuardRunLog, currentIdentity?: ProjectIdentity): string | undefined {
  if (!currentIdentity) {
    return undefined;
  }
  if (!run.projectIdentity) {
    return `${source} has no project identity`;
  }
  return sameProjectIdentity(currentIdentity, run.projectIdentity) ? undefined : `${source} project identity mismatch`;
}

function buildInferredTaskMarkdown(clusters: InferredDiffIntentClusters, mode: EffectiveTaskMode): string {
  const intent = clusters.primaryIntent;
  return [
    "# Inferred Current Task",
    "",
    "## 작업 유형",
    `- type: ${intent.type}`,
    intent.subtype ? `- subtype: ${intent.subtype}` : "",
    `- confidence: ${intent.confidence}`,
    `- strategy: diff-inferred`,
    "",
    "## 목표",
    `- ${inferredIntentToRequirement(intent)}`,
    "",
    "## 현재 기준",
    `- source: current git diff`,
    `- mode: ${mode}`,
    `- ${formatInferredDiffIntentClusters(clusters)}`
  ].filter((line) => line !== "").join("\n");
}

function mapAnchorStatus(mode: TaskAnchorFreshnessResult["mode"]): EffectiveAnchorStatus {
  if (mode === "anchor_absent") return "absent";
  if (mode === "use_task") return "fresh";
  return mode;
}

function extractPathHints(markdown: string): string[] {
  const roots = "(?:app|apps|pages|packages|src|lib|components|hooks|utils|supabase|styles|constants|public|docs)";
  const matches = [...markdown.matchAll(new RegExp(`(?:^|[\\s\`])((?:\\./)?${roots}/[^\\s,)\\]\`]+)`, "g"))].map((match) =>
    cleanPathHint(match[1] ?? "")
  );
  return [...new Set(matches.filter(Boolean))];
}

function cleanPathHint(path: string): string {
  return path
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/^\.\//, "")
    .replace(/\s+-\s+.*$/, "")
    .replace(/\s+\([^)]*\)$/, "")
    .replace(/[),.\]]+$/, "");
}

function pathHintMatches(file: string, hint: string): boolean {
  const normalizedHint = cleanPathHint(hint);
  if (!normalizedHint) {
    return false;
  }
  if (normalizedHint.endsWith("/**")) {
    const directory = normalizedHint.slice(0, -3);
    return file === directory || file.startsWith(`${directory}/`);
  }
  if (normalizedHint.endsWith("/*")) {
    const directory = normalizedHint.slice(0, -2);
    return file.startsWith(`${directory}/`) && !file.slice(directory.length + 1).includes("/");
  }
  return file === normalizedHint || file.startsWith(`${normalizedHint}/`) || normalizedHint.startsWith(`${file}/`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
