import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  analyzeDiff,
  defaultConfig,
  filterDevGuardContextFiles,
  formatInferredDiffIntentClusters,
  generateUpdateSuggestions,
  inferDiffIntentClusters,
  type ChangeFile,
  type CodeGraphEntry,
  type DevGuardConfig
} from "@dev-guard/core";
import { appendTextFile, fromRoot, readJsonFile, readTextFile, writeFileIfMissing, writeTextFile } from "./fs.js";
import { getDiffForChangeFiles, getGitChanges, type GitChanges } from "./git.js";
import { migrateLegacyDevguardDir } from "./migration.js";
import { devguardPaths } from "./paths.js";
import { generateProjectKnowledge } from "./knowledge.js";

const execFileAsync = promisify(execFile);

export interface RuntimeState {
  pendingChangedFiles: string[];
  firstChangedAt?: string;
  lastChangedAt?: string;
  lastChangedFile?: string;
  lastActivityAt?: string;
  lastStableAt?: string;
  watchStartedAt?: string;
  watchHeartbeatAt?: string;
  lastDiffHash?: string;
  lastStatus?: "idle" | "active" | "ready_for_done" | "finalizing" | "processed";
  changeCountSinceIdle?: number;
  idleDeadlineAt?: string;
  idleSinceAt?: string;
  buildActive?: boolean;
  hookActive?: boolean;
  revision?: number;
  updatedAt?: string;
}

export interface ProjectState {
  lastProcessedAt?: string;
  lastSummary?: string;
  lastDrift?: "low" | "medium" | "high";
  lastQualityVerdict?: QualityVerdict;
  lastQualityNextAction?: string;
  lastChangedFiles?: string[];
  lastReportPath?: string;
  lastPromptPath?: string;
  lastHandoffPath?: string;
}

export interface DoneProcessingResult {
  changedFiles: string[];
  areas: string[];
  judgments: string[];
  reportPath: string;
  promptPath: string;
  historySummaryPath: string;
  decisionCandidatesPath: string;
  qualityReportPath: string;
  projectHandoffPath: string;
  agentContextPath: string;
  nextClaudePromptPath: string;
  projectKnowledgePath: string;
  qualityVerdict: QualityVerdict;
  summary: string;
  drift: "low" | "medium" | "high";
}

type QualityVerdict = "PASS" | "NEEDS_REVIEW" | "BLOCKED";

interface QualityCheckItem {
  label: string;
  status: "PASS" | "WARN" | "BLOCKED";
  detail: string;
  affectsVerdict?: boolean;
}

interface QualityReport {
  verdict: QualityVerdict;
  why: string[];
  requiredVerification: string[];
  checklist: QualityCheckItem[];
  beforeCommit: string[];
  nextRecommendedAction: string;
}

export interface HistoryRecord {
  id: string;
  timestamp: string;
  changedFiles: string[];
  areas: string[];
  diffStat: string;
  inferredSummary: string;
  driftCandidates: string[];
  docUpdateCandidates: string[];
  testCandidates: string[];
  generatedPromptPath: string;
  reportPath: string;
  qualityVerdict?: string;
}

interface PackageJson {
  packageManager?: string;
  scripts?: Record<string, string>;
}

interface ProjectContextSummary {
  projectPurpose: string;
  currentGoal: string;
  notDoing: string;
  techStack: string;
  structure: string;
  decisions: string[];
}

interface RiskDetail {
  content: string;
  relatedFiles: string[];
  reason: string;
  checkMethod: string;
  decisionRule: string;
}

interface NextTaskPlan {
  title: string;
  goal: string;
  scope: string[];
  likelyFiles: string[];
  doNotEdit: string[];
  success: string[];
}

const runtimePath = devguardPaths.runtime;
const statePath = devguardPaths.state;
const historyPath = devguardPaths.history;
const reportPath = devguardPaths.lastRunReport;
const promptPath = devguardPaths.nextCodexPrompt;
const historySummaryPath = devguardPaths.historySummary;
const decisionCandidatesPath = devguardPaths.decisionCandidates;
const qualityReportPath = devguardPaths.qualityReport;
const projectHandoffPath = devguardPaths.projectHandoff;
const hookStatusPath = devguardPaths.hookStatus;

const defaultRuntime: RuntimeState = {
  pendingChangedFiles: [],
  lastStatus: "idle",
  changeCountSinceIdle: 0
};

export async function readRuntimeState(root: string): Promise<RuntimeState> {
  await ensureDevguardWorkspace(root);
  try {
    return readJsonFile<RuntimeState>(fromRoot(root, runtimePath), defaultRuntime);
  } catch {
    return defaultRuntime;
  }
}

export async function writeRuntimeState(root: string, state: RuntimeState): Promise<void> {
  await ensureDevguardWorkspace(root);
  try {
    await writeAtomicTextFile(fromRoot(root, runtimePath), `${JSON.stringify(normalizeRuntimeState(state), null, 2)}\n`);
  } catch (error) {
    await logRuntimeWriteWarning(root, `runtime_write=failed path=${runtimePath} error=${quoteLogValue(errorMessage(error))}`);
  }
}

export async function resetRuntimeState(root: string): Promise<void> {
  await writeRuntimeState(root, { ...defaultRuntime, idleSinceAt: new Date().toISOString() });
}

export async function readProjectState(root: string): Promise<ProjectState> {
  await ensureDevguardWorkspace(root);
  return readJsonFile<ProjectState>(fromRoot(root, statePath), {});
}

export async function writeProjectState(root: string, state: ProjectState): Promise<void> {
  await ensureDevguardWorkspace(root);
  await writeAtomicTextFile(fromRoot(root, statePath), `${JSON.stringify(state, null, 2)}\n`);
}

export async function readHistoryRecords(root: string, limit = 20): Promise<HistoryRecord[]> {
  await ensureDevguardWorkspace(root);
  const text = await readTextFile(fromRoot(root, historyPath));
  const records = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as HistoryRecord;
      } catch {
        return undefined;
      }
    })
    .filter((record): record is HistoryRecord => Boolean(record));
  return records.slice(-limit);
}

export async function recordRuntimeChange(root: string, path: string, options: { idleAfterMs?: number } = {}): Promise<RuntimeState> {
  const normalized = normalizeEventPath(root, path);
  if (!normalized || isIgnoredWatchPath(normalized)) {
    return readRuntimeState(root);
  }
  const now = new Date().toISOString();
  const current = await readRuntimeState(root);
  const pendingChangedFiles = [...new Set([...current.pendingChangedFiles, normalized])].sort();
  const wasIdle = !current.lastStatus || current.lastStatus === "idle" || current.lastStatus === "processed";
  const next: RuntimeState = {
    ...current,
    pendingChangedFiles,
    firstChangedAt: current.firstChangedAt ?? now,
    lastChangedAt: now,
    lastChangedFile: normalized,
    lastActivityAt: now,
    changeCountSinceIdle: wasIdle ? 1 : (current.changeCountSinceIdle ?? 0) + 1,
    idleDeadlineAt: options.idleAfterMs ? new Date(Date.now() + options.idleAfterMs).toISOString() : current.idleDeadlineAt,
    idleSinceAt: undefined,
    lastStatus: "active"
  };
  await writeRuntimeState(root, next);
  return next;
}

export async function markRuntimeStable(root: string, diffHash: string): Promise<RuntimeState> {
  const current = await readRuntimeState(root);
  const project = await readProjectState(root);
  if (isRuntimeOlderThanProcessed(current, project.lastProcessedAt)) {
    await logRuntimeWriteWarning(root, "runtime_write=skipped reason=stale_stable_after_done");
    await writeRuntimeState(root, defaultRuntime);
    return defaultRuntime;
  }
  const next: RuntimeState = {
    ...current,
    lastStableAt: new Date().toISOString(),
    lastDiffHash: diffHash,
    idleDeadlineAt: undefined,
    idleSinceAt: current.pendingChangedFiles.length > 0 ? current.idleSinceAt : new Date().toISOString(),
    changeCountSinceIdle: current.pendingChangedFiles.length > 0 ? current.changeCountSinceIdle : 0,
    lastStatus: current.pendingChangedFiles.length > 0 ? "ready_for_done" : "idle"
  };
  await writeRuntimeState(root, next);
  return next;
}

export function isIgnoredWatchPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    normalized.startsWith("node_modules/") ||
    normalized.startsWith(".next/") ||
    normalized.startsWith("dist/") ||
    normalized.startsWith("build/") ||
    normalized.startsWith(".git/") ||
    normalized.startsWith("coverage/") ||
    normalized === runtimePath ||
    normalized === devguardPaths.state ||
    normalized === devguardPaths.history ||
    isPathOrChild(normalized, devguardPaths.reportsDir) ||
    isPathOrChild(normalized, devguardPaths.promptsDir) ||
    isPathOrChild(normalized, devguardPaths.contextDir) ||
    isPathOrChild(normalized, devguardPaths.logsDir) ||
    isPathOrChild(normalized, devguardPaths.hooksDir) ||
    /\.(png|jpe?g|gif|webp|avif|ico|svg|ttf|otf|woff2?|mp4|mov|mp3|wav|pdf|zip|gz)$/i.test(normalized)
  );
}

function isPathOrChild(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

async function writeAtomicTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const tempPath = `${path}.${process.pid}.${Date.now()}.${randomSuffix()}.tmp`;
    try {
      await writeFile(tempPath, content, "utf8");
      await stat(tempPath);
      await rename(tempPath, path);
      return;
    } catch (error) {
      lastError = error;
      await logAtomicWriteWarning(path, `atomic_write=retry attempt=${attempt} path=${quoteLogValue(path)} error=${quoteLogValue(errorMessage(error))}`);
      await sleep(25 * attempt);
    }
  }
  await logAtomicWriteWarning(path, `atomic_write=failed path=${quoteLogValue(path)} error=${quoteLogValue(errorMessage(lastError))}`);
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function processDoneEvent(root: string): Promise<DoneProcessingResult> {
  await ensureDevguardWorkspace(root);
  const runtime = await readRuntimeState(root);
  const gitChanges = await loadChangesWithFallback(root, runtime);
  const changeFiles = filterDevGuardContextFiles(gitChanges.changeFiles, false);
  const rawChangedFiles = [...new Set(gitChanges.changeFiles.map((file) => file.path))].sort();
  const changedFiles = [
    ...new Set(
      (changeFiles.length > 0 ? changeFiles.map((file) => file.path) : runtime.pendingChangedFiles).filter(
        (file) => !isIgnoredWatchPath(file) && !isDevguardManagedDocPath(file)
      )
    )
  ].sort();
  const diffText = changeFiles.length > 0 ? await getDiffForChangeFiles(root, changeFiles).catch(() => gitChanges.diffText) : gitChanges.diffText;
  const diffStat = await getGitDiffStat(root).catch(() => "git diff stat unavailable");
  const [projectMarkdown, architectureMarkdown, decisionsMarkdown, tasksMarkdown, config, codeGraph] = await Promise.all([
    readTextFile(fromRoot(root, devguardPaths.project)),
    readTextFile(fromRoot(root, devguardPaths.architecture)),
    readTextFile(fromRoot(root, devguardPaths.decisions)),
    readTextFile(fromRoot(root, devguardPaths.tasks)),
    readJsonFile<DevGuardConfig>(fromRoot(root, ".devguard/config.json"), defaultConfig),
    readJsonFile<CodeGraphEntry[]>(fromRoot(root, ".devguard/code-graph.json"), [])
  ]);
  const clusters = inferDiffIntentClusters({ changedFiles, changeFiles, diffText, codeGraph });
  const checkReport = analyzeDiff({
    changedFiles,
    changeFiles,
    diffText,
    taskText: [tasksMarkdown, projectMarkdown, architectureMarkdown].join("\n\n"),
    rulesText: decisionsMarkdown,
    config,
    includeContextFiles: false
  });
  const updateSuggestions = generateUpdateSuggestions({
    changedFiles,
    changeFiles,
    diffText,
    taskMarkdown: tasksMarkdown || projectMarkdown || "No active task document.",
    rulesMarkdown: decisionsMarkdown,
    mistakesMarkdown: architectureMarkdown,
    includeContextFiles: false
  });
  const areas = classifyAreas(changedFiles);
  const judgments = buildJudgments({ areas, clusters, checkFindings: checkReport.findings.map((finding) => finding.message), architectureMarkdown, decisionsMarkdown });
  const drift = clusters.mixedRisk;
  const summary = formatInferredDiffIntentClusters(clusters);
  const timestamp = new Date().toISOString();
  const majorChanges = inferMajorChanges({ summary, changedFiles, areas, diffText });
  const testCandidates = await inferTestCandidates(root, { areas, changedFiles });
  const projectContext = summarizeProjectContext({ projectMarkdown, architectureMarkdown, decisionsMarkdown });
  const docUpdateCandidates = [updateSuggestions.summary];
  const historyRecord: HistoryRecord = {
    id: `run_${timestamp.replace(/[-:.]/g, "").slice(0, 15)}_${hashRuntimeFiles(changedFiles).slice(0, 6)}`,
    timestamp,
    changedFiles,
    areas,
    diffStat,
    inferredSummary: summary,
    driftCandidates: judgments,
    docUpdateCandidates,
    testCandidates,
    generatedPromptPath: promptPath,
    reportPath
  };
  const previousHistory = await readHistoryRecords(root, 20);
  const nextHistory = [...previousHistory, historyRecord];
  const decisionCandidates = inferDecisionCandidates({ areas, changedFiles, judgments, summary });
  const riskDetails = buildRiskDetails({ judgments, changedFiles, areas });
  const nextTask = chooseNextTask({ drift, judgments, areas, changedFiles, testCandidates });
  const qualityReport = await assessCompletionQuality(root, {
    changedFiles,
    rawChangedFiles,
    areas,
    judgments,
    testCandidates,
    nextTaskTitle: nextTask.title
  });
  historyRecord.qualityVerdict = qualityReport.verdict;
  const reportMarkdown = renderLastRunReport({
    timestamp,
    changedFiles,
    areas,
    judgments,
    summary,
    drift,
    updateSummary: updateSuggestions.summary,
    diffStat,
    majorChanges,
    testCandidates
  });
  const historySummaryMarkdown = renderHistorySummary(nextHistory);
  const decisionCandidatesMarkdown = renderDecisionCandidates({
    timestamp,
    summary,
    candidates: decisionCandidates,
    changedFiles
  });
  const qualityReportMarkdown = renderQualityReport(qualityReport);
  const promptMarkdown = renderNextPrompt({
    projectContext,
    summary,
    changedFiles,
    areas,
    judgments,
    drift,
    testCommands: testCandidates,
    recentHistory: nextHistory.slice(-5),
    decisionCandidates,
    riskDetails,
    nextTask,
    qualityReport
  });
  await Promise.all([
    appendTextFile(fromRoot(root, historyPath), `${JSON.stringify(historyRecord)}\n`),
    writeTextFile(fromRoot(root, reportPath), reportMarkdown),
    writeTextFile(fromRoot(root, historySummaryPath), historySummaryMarkdown),
    writeTextFile(fromRoot(root, decisionCandidatesPath), decisionCandidatesMarkdown),
    writeTextFile(fromRoot(root, qualityReportPath), qualityReportMarkdown),
    writeTextFile(fromRoot(root, promptPath), promptMarkdown),
    writeProjectState(root, {
      ...(await readProjectState(root)),
      lastProcessedAt: new Date().toISOString(),
      lastSummary: summary,
      lastDrift: drift,
      lastQualityVerdict: qualityReport.verdict,
      lastQualityNextAction: qualityReport.nextRecommendedAction,
      lastChangedFiles: changedFiles,
      lastReportPath: reportPath,
      lastPromptPath: promptPath,
      lastHandoffPath: projectHandoffPath
    }),
    resetRuntimeState(root)
  ]);
  await Promise.all([
    generateProjectHandoff(root),
    generateAgentContext(root),
    generateNextClaudePrompt(root),
    generateProjectKnowledge(root)
  ]);
  return {
    changedFiles,
    areas,
    judgments,
    reportPath,
    promptPath,
    historySummaryPath,
    decisionCandidatesPath,
    qualityReportPath,
    projectHandoffPath,
    agentContextPath: devguardPaths.agentContext,
    nextClaudePromptPath: devguardPaths.nextClaudePrompt,
    projectKnowledgePath: devguardPaths.projectKnowledge,
    qualityVerdict: qualityReport.verdict,
    summary,
    drift
  };
}

export async function generateProjectHandoff(root: string): Promise<string> {
  await ensureDevguardWorkspace(root);
  const [project, architecture, decisions, tasks, history, historySummary, decisionCandidates, qualityReport, nextPrompt, hookStatus, state] = await Promise.all([
    readRequiredText(root, devguardPaths.project),
    readRequiredText(root, devguardPaths.architecture),
    readRequiredText(root, devguardPaths.decisions),
    readRequiredText(root, devguardPaths.tasks),
    readRequiredText(root, historyPath),
    readRequiredText(root, historySummaryPath),
    readRequiredText(root, decisionCandidatesPath),
    readRequiredText(root, qualityReportPath),
    readRequiredText(root, promptPath),
    readRequiredText(root, hookStatusPath),
    readJsonFile<ProjectState>(fromRoot(root, statePath), {})
      .then((value) => JSON.stringify(value, null, 2))
      .catch(() => "확인 필요")
  ]);
  const records = parseHistoryRecords(history.content).slice(-5);
  const handoff = renderProjectHandoff({
    project,
    architecture,
    decisions,
    tasks,
    records,
    historySummary,
    decisionCandidates,
    qualityReport,
    nextPrompt,
    hookStatus,
    state
  });
  await writeTextFile(fromRoot(root, projectHandoffPath), handoff);
  return projectHandoffPath;
}

export async function generateAgentContext(root: string): Promise<string> {
  await ensureDevguardWorkspace(root);
  const [project, decisions, qualityContent, historyRecords, state] = await Promise.all([
    readTextFile(fromRoot(root, devguardPaths.project)),
    readTextFile(fromRoot(root, devguardPaths.decisions)),
    readTextFile(fromRoot(root, qualityReportPath)),
    readHistoryRecords(root, 5),
    readJsonFile<ProjectState>(fromRoot(root, statePath), {})
  ]);
  const nextPromptContent = await readTextFile(fromRoot(root, promptPath));
  const projectPurpose = firstSectionBullet(project, "프로젝트 목적") ?? "확인 필요";
  const currentGoal = firstSectionBullet(project, "현재 목표") ?? "확인 필요";
  const quality = parseQuality(qualityContent);
  const nextTask = extractNextTask(nextPromptContent, "", JSON.stringify(state));
  const importantDecisions = extractDecisionLines(decisions);
  const lastChangedFiles = state.lastChangedFiles ?? [];
  const lastSummary = state.lastSummary ?? "확인 필요";
  const recentHistory = historyRecords
    .slice(-3)
    .reverse()
    .map((r) => `${r.timestamp}: ${r.inferredSummary}`);
  const markdown = renderAgentContext({
    projectPurpose,
    currentGoal,
    lastSummary,
    recentHistory,
    lastChangedFiles,
    qualityVerdict: quality.verdict,
    qualityWhy: quality.why,
    nextBestTask: nextTask,
    importantDecisions
  });
  await mkdir(fromRoot(root, devguardPaths.contextDir), { recursive: true });
  await writeTextFile(fromRoot(root, devguardPaths.agentContext), markdown);
  return devguardPaths.agentContext;
}

export async function generateNextClaudePrompt(root: string): Promise<string> {
  await ensureDevguardWorkspace(root);
  const [qualityContent, state] = await Promise.all([
    readTextFile(fromRoot(root, qualityReportPath)),
    readJsonFile<ProjectState>(fromRoot(root, statePath), {})
  ]);
  const nextPromptContent = await readTextFile(fromRoot(root, promptPath));
  const quality = parseQuality(qualityContent);
  const nextTask = extractNextTask(nextPromptContent, "", JSON.stringify(state));
  const markdown = renderNextClaudePrompt({ qualityVerdict: quality.verdict, nextBestTask: nextTask });
  await writeTextFile(fromRoot(root, devguardPaths.nextClaudePrompt), markdown);
  return devguardPaths.nextClaudePrompt;
}

function renderAgentContext(input: {
  projectPurpose: string;
  currentGoal: string;
  lastSummary: string;
  recentHistory: string[];
  lastChangedFiles: string[];
  qualityVerdict: string;
  qualityWhy: string[];
  nextBestTask: string;
  importantDecisions: string[];
}): string {
  return [
    "# Agent Context",
    "",
    "> dev-guard generated — read this before exploring the repository.",
    "",
    "## Current State",
    `- project purpose: ${input.projectPurpose}`,
    `- current goal: ${input.currentGoal}`,
    "",
    "## Last Completed Work",
    `- ${input.lastSummary}`,
    ...input.recentHistory.map((line) => `- ${line}`),
    "",
    "## Quality Status",
    `- verdict: ${input.qualityVerdict}`,
    ...(input.qualityWhy.length > 0 && input.qualityWhy[0] !== "확인 필요"
      ? ["- reason:", ...input.qualityWhy.map((item) => `  - ${item}`)]
      : []),
    "",
    "## Next Best Task",
    `- ${input.nextBestTask}`,
    "",
    "## Important Decisions",
    ...formatBullets(input.importantDecisions),
    "",
    "## Important Files",
    ...formatBullets(input.lastChangedFiles.slice(0, 10).length > 0 ? input.lastChangedFiles.slice(0, 10) : ["확인 필요"]),
    "",
    "## Do Not Touch",
    `- \`${devguardPaths.reportsDir}\`, \`${devguardPaths.promptsDir}\`, \`${devguardPaths.contextDir}\`, \`${devguardPaths.runtime}\` — auto-generated by dev-guard`,
    "- existing public command UX: watch / done / status / reset",
    "- auth / database / api / config unless directly required by current task",
    "- large refactors not explicitly requested",
    "",
    "## Additional Context",
    `- project knowledge: \`${devguardPaths.projectKnowledge}\``,
    `- full handoff: \`${devguardPaths.projectHandoff}\``,
    `- architecture: \`${devguardPaths.architecture}\``,
    `- decisions: \`${devguardPaths.decisions}\``,
    `- quality report: \`${devguardPaths.qualityReport}\``,
    `- next Codex prompt: \`${devguardPaths.nextCodexPrompt}\``
  ].join("\n") + "\n";
}

function renderNextClaudePrompt(input: { qualityVerdict: string; nextBestTask: string }): string {
  return [
    "# Next Claude Prompt",
    "",
    "Before starting any work, read:",
    "",
    `1. \`${devguardPaths.agentContext}\` — current state, quality status, next task`,
    `2. \`${devguardPaths.projectKnowledge}\` — static project structure for AI sessions`,
    `3. \`${devguardPaths.projectHandoff}\` — compressed project resume`,
    `4. \`${devguardPaths.qualityReport}\` — quality verdict and required verification`,
    "",
    "Use dev-guard context as the primary source of project state.",
    "Do not perform repository-wide scans before reading them.",
    "Only open additional files when specifically required for the current task.",
    "",
    "---",
    "",
    `Quality: **${input.qualityVerdict}**`,
    "",
    `Next Task: ${input.nextBestTask}`
  ].join("\n") + "\n";
}

export function classifyAreas(files: string[]): string[] {
  const areas = new Set<string>();
  for (const file of files) {
    if (/(^|\/)(auth|session|login|middleware)\b/i.test(file)) areas.add("auth");
    if (/(^|\/)(db|database|schema|migration|supabase)\b/i.test(file)) areas.add("database");
    if (/^(app\/api|pages\/api|src\/app\/api)\//i.test(file)) areas.add("api");
    if (/(^|\/)(config|package\.json|tsconfig|next\.config|vite\.config|middleware\.ts)/i.test(file)) areas.add("config");
    if (/\.(md|mdx)$/i.test(file) || /^docs\//i.test(file)) areas.add("docs");
    if (/(\.test|\.spec)\.[tj]sx?$|(^|\/)(tests?|__tests__)\//i.test(file)) areas.add("tests");
    if (/^packages\/cli\//i.test(file)) areas.add("cli");
    if (/^packages\/core\//i.test(file)) areas.add("core");
    if (/^(app|pages|components|src\/app|src\/components|styles|public)\//i.test(file)) areas.add("ui");
  }
  return areas.size > 0 ? [...areas].sort() : ["unknown"];
}

export function hashRuntimeFiles(files: string[]): string {
  return createHash("sha1").update(files.join("\n")).digest("hex").slice(0, 12);
}

function normalizeRuntimeState(state: RuntimeState): RuntimeState {
  const now = new Date().toISOString();
  return {
    ...state,
    pendingChangedFiles: [...new Set(state.pendingChangedFiles ?? [])].filter((file) => !isIgnoredWatchPath(file)).sort(),
    revision: (state.revision ?? 0) + 1,
    updatedAt: now
  };
}

function isRuntimeOlderThanProcessed(runtime: RuntimeState, lastProcessedAt?: string): boolean {
  if (!lastProcessedAt || !runtime.lastChangedAt) return false;
  return Date.parse(runtime.lastChangedAt) <= Date.parse(lastProcessedAt);
}

async function logRuntimeWriteWarning(root: string, message: string): Promise<void> {
  await appendTextFile(fromRoot(root, devguardPaths.watchLog), `timestamp=${new Date().toISOString()} ${message}\n`).catch(() => undefined);
  console.warn(`watch warning: ${message}`);
}

async function logAtomicWriteWarning(path: string, message: string): Promise<void> {
  const devguardDir = dirname(path);
  await appendTextFile(join(devguardDir, "logs", "watch.log"), `timestamp=${new Date().toISOString()} ${message}\n`).catch(() => undefined);
  console.warn(`watch warning: ${message}`);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quoteLogValue(value: string): string {
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeEventPath(root: string, path: string): string {
  const relativePath = path.startsWith(root) ? relative(root, path) : path;
  return relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isDevguardManagedDocPath(path: string): boolean {
  return /^(devguard\/)(project|architecture|decisions|tasks)\.md$/.test(path.replace(/\\/g, "/"));
}

async function loadChangesWithFallback(root: string, runtime: RuntimeState): Promise<GitChanges> {
  try {
    return await getGitChanges(root);
  } catch {
    const changeFiles: ChangeFile[] = runtime.pendingChangedFiles.map((path) => ({
      path,
      status: "modified",
      source: "workingTree"
    }));
    return {
      changedFiles: runtime.pendingChangedFiles,
      changeFiles,
      diffText: runtime.pendingChangedFiles.map((path) => `Changed file: ${path}`).join("\n"),
      workingTreeDiffText: "",
      stagedDiffText: ""
    };
  }
}

function buildJudgments(input: {
  areas: string[];
  clusters: ReturnType<typeof inferDiffIntentClusters>;
  checkFindings: string[];
  architectureMarkdown: string;
  decisionsMarkdown: string;
}): string[] {
  const judgments = new Set<string>();
  if (input.areas.includes("auth")) judgments.add("인증 흐름 변경 가능성 있음");
  if (input.areas.includes("database")) judgments.add("데이터 구조 또는 저장 흐름 영향 가능성 있음");
  if (input.areas.includes("api")) judgments.add("API 동작 변경 가능성 있음");
  if (input.areas.includes("config")) judgments.add("config/runtime 설정 확인 필요");
  if (input.clusters.mixedRisk !== "low") judgments.add(`mixed drift risk: ${input.clusters.mixedRisk}`);
  for (const finding of input.checkFindings.slice(0, 3)) judgments.add(finding);
  if (!input.architectureMarkdown.trim()) judgments.add("architecture.md가 비어 있어 구조 충돌 검토가 제한됨");
  if (!input.decisionsMarkdown.trim()) judgments.add("decisions.md가 비어 있어 결정사항 충돌 검토가 제한됨");
  return [...judgments].slice(0, 8);
}

function renderLastRunReport(input: {
  timestamp: string;
  changedFiles: string[];
  areas: string[];
  judgments: string[];
  summary: string;
  drift: string;
  updateSummary: string;
  diffStat: string;
  majorChanges: string[];
  testCandidates: string[];
}): string {
  return [
    "# dev-guard Last Run",
    "",
    "## 작업 시간",
    `- ${input.timestamp}`,
    "",
    "## 변경 파일",
    ...formatBullets(input.changedFiles),
    "",
    "## 변경 영역 분류",
    ...formatBullets(input.areas),
    "",
    "## Git Diff Stat",
    "```txt",
    input.diffStat.trim() || "No git diff stat available.",
    "```",
    "",
    "## 주요 변경 추정",
    `- ${input.summary}`,
    ...formatBullets(input.majorChanges),
    "",
    "## Drift 후보",
    `- drift: ${input.drift}`,
    ...formatBullets(input.judgments),
    "",
    "## 문서 업데이트 필요 후보",
    `- ${input.updateSummary}`,
    "",
    "## 테스트 필요 후보",
    ...formatBullets(input.testCandidates)
  ].join("\n") + "\n";
}

function renderNextPrompt(input: {
  projectContext: ProjectContextSummary;
  summary: string;
  changedFiles: string[];
  areas: string[];
  judgments: string[];
  drift: string;
  testCommands: string[];
  recentHistory: HistoryRecord[];
  decisionCandidates: string[];
  riskDetails: RiskDetail[];
  nextTask: NextTaskPlan;
  qualityReport: QualityReport;
}): string {
  const focusFiles = input.changedFiles.slice(0, 12);
  const recentLines = input.recentHistory
    .slice(-5)
    .reverse()
    .map((record) => `- ${record.timestamp}: ${record.inferredSummary}`);
  return [
    "Before doing any work, read:",
    "",
    `1. \`${devguardPaths.agentContext}\``,
    `2. \`${devguardPaths.projectHandoff}\``,
    "",
    "Use them as the primary source of project context.",
    "Do not perform repository-wide scans before reading them.",
    "",
    "---",
    "",
    "# Codex Handoff Prompt",
    "",
    "아래 인수인계를 기준으로 이어서 작업해줘. 추측보다 파일/명령/검증 결과를 우선하고, 관련 없는 수정은 하지 마.",
    "",
    "## Current Project Context",
    `- project purpose: ${input.projectContext.projectPurpose}`,
    `- current goal: ${input.projectContext.currentGoal}`,
    `- not doing: ${input.projectContext.notDoing}`,
    `- tech stack: ${input.projectContext.techStack}`,
    `- structure: ${input.projectContext.structure}`,
    "- decided:",
    ...formatBullets(input.projectContext.decisions),
    "",
    "## Recent Work Summary",
    "- current done:",
    `  - ${input.summary}`,
    `  - areas: ${input.areas.join(", ")}`,
    `  - drift: ${input.drift}`,
    "- recent history:",
    ...formatBullets(recentLines.map((line) => line.replace(/^- /, ""))),
    "- repeatedly touched areas:",
    ...formatBullets(formatCounts(countItems(input.recentHistory.flatMap((record) => record.areas))).slice(0, 5)),
    "",
    "## Changed Files",
    ...formatBullets(focusFiles.map((file) => `${file} - ${inferFileRole(file)}; area=${classifyAreas([file]).join(",")}`)),
    ...(input.changedFiles.length > focusFiles.length ? [`- ... +${input.changedFiles.length - focusFiles.length} files`] : []),
    "",
    "## Risk / Drift Candidates",
    ...formatRiskDetails(input.riskDetails),
    "",
    "## Quality Gate",
    `- verdict: ${input.qualityReport.verdict}`,
    "- required verification:",
    ...formatBullets(input.qualityReport.requiredVerification),
    "- before commit:",
    ...formatBullets(input.qualityReport.beforeCommit),
    "- blocked/warn items:",
    ...formatBullets(
      input.qualityReport.checklist
        .filter((item) => item.status !== "PASS")
        .map((item) => `${item.status}: ${item.label} - ${item.detail}`)
    ),
    "",
    "## Do Not Change",
    "- 이번 작업과 관련 없는 영역",
    `- ${devguardPaths.reportsDir}, ${devguardPaths.promptsDir}, ${devguardPaths.runtime} 직접 수정 금지`,
    "- 사용자가 명시하지 않은 대규모 리팩터링 금지",
    "- 기존 공개 명령어 UX 유지: watch/done/status/reset",
    "- 기존 문서 원본 직접 수정 금지. 필요한 내용은 후보 파일 또는 보고로 남길 것",
    "- auth/database/api/config 변경은 현재 작업과 직접 관련 있을 때만 수정",
    "",
    "## Already Decided / Decision Candidates",
    ...formatBullets(input.decisionCandidates.length > 0 ? input.decisionCandidates : ["새 결정 후보 없음"]),
    "",
    "## Next Task",
    `- priority: ${input.nextTask.title}`,
    `- goal: ${input.nextTask.goal}`,
    "- scope:",
    ...formatBullets(input.nextTask.scope),
    "- likely files:",
    ...formatBullets(input.nextTask.likelyFiles),
    "- do not edit:",
    ...formatBullets(input.nextTask.doNotEdit),
    "- success:",
    ...formatBullets(input.nextTask.success),
    "",
    "## Verification Commands",
    ...formatBullets(input.testCommands),
    "",
    "## Completion Report Format",
    "1. 수정한 파일",
    "2. 수행한 작업",
    "3. 수정하지 않은 범위",
    "4. 검증 결과",
    "5. 남은 리스크",
    "6. 다음 권장 작업"
  ].join("\n") + "\n";
}

function formatBullets(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- none"];
}

export async function ensureDevguardDirs(root: string): Promise<void> {
  await migrateLegacyDevguardDir(root);
  await Promise.all([
    mkdir(dirname(fromRoot(root, reportPath)), { recursive: true }),
    mkdir(dirname(fromRoot(root, promptPath)), { recursive: true }),
    mkdir(fromRoot(root, devguardPaths.contextDir), { recursive: true }),
    mkdir(dirname(fromRoot(root, runtimePath)), { recursive: true }),
    mkdir(dirname(fromRoot(root, historyPath)), { recursive: true })
  ]);
}

export async function ensureDevguardWorkspace(root: string): Promise<void> {
  await ensureDevguardDirs(root);
  await Promise.all([
    writeFileIfMissing(fromRoot(root, devguardPaths.project), projectTemplate()),
    writeFileIfMissing(fromRoot(root, devguardPaths.architecture), architectureTemplate()),
    writeFileIfMissing(fromRoot(root, devguardPaths.decisions), decisionsTemplate()),
    writeFileIfMissing(fromRoot(root, devguardPaths.tasks), tasksTemplate()),
    writeFileIfMissing(fromRoot(root, statePath), "{}\n"),
    writeFileIfMissing(fromRoot(root, historyPath), ""),
    writeFileIfMissing(fromRoot(root, runtimePath), `${JSON.stringify(defaultRuntime, null, 2)}\n`)
  ]);
}

async function getGitDiffStat(root: string): Promise<string> {
  const [workingTree, staged] = await Promise.all([
    execFileAsync("git", ["diff", "--stat"], { cwd: root }).then((result) => result.stdout).catch(() => ""),
    execFileAsync("git", ["diff", "--cached", "--stat"], { cwd: root }).then((result) => result.stdout).catch(() => "")
  ]);
  return [workingTree, staged].filter((text) => text.trim()).join("\n") || "No tracked/staged diff stat.";
}

function inferMajorChanges(input: { summary: string; changedFiles: string[]; areas: string[]; diffText: string }): string[] {
  const changes = new Set<string>();
  if (input.areas.includes("ui")) changes.add("UI/component surface changed");
  if (input.areas.includes("api")) changes.add("API route or server handler changed");
  if (input.areas.includes("config")) changes.add("configuration/runtime setting changed");
  if (input.areas.includes("docs")) changes.add("documentation changed");
  if (input.diffText.includes("Untracked file:")) changes.add("new untracked files are part of the current worktree");
  if (input.changedFiles.some((file) => file.includes("watch"))) changes.add("watch/event workflow touched");
  if (input.changedFiles.some((file) => file.includes("runtime"))) changes.add("runtime state handling touched");
  if (input.summary.includes("MIXED:")) changes.add("multiple intent clusters detected");
  return [...changes].slice(0, 8);
}

async function inferTestCandidates(root: string, input: { areas: string[]; changedFiles: string[] }): Promise<string[]> {
  const [rootPackage, cliPackage] = await Promise.all([
    readJsonFile<PackageJson>(fromRoot(root, "package.json"), {}),
    readJsonFile<PackageJson>(fromRoot(root, "packages/cli/package.json"), {})
  ]);
  const rootScripts = rootPackage.scripts ?? {};
  const cliScripts = cliPackage.scripts ?? {};
  const usesPnpm = (rootPackage.packageManager ?? "").startsWith("pnpm") || Object.keys(rootScripts).some((script) => script === "cli");
  const tests = new Set<string>();
  const runner = usesPnpm ? "pnpm" : "npm";
  if (rootScripts.build) tests.add(`${runner} run build`);
  if (rootScripts.test) tests.add(`${runner} test`);
  if (rootScripts.cli) {
    if (input.changedFiles.some((file) => file.includes("watch"))) tests.add(`${runner} cli watch --stable-after 1 --compact`);
    if (input.changedFiles.some((file) => file.includes("runtime") || file.includes("index.ts"))) tests.add(`${runner} cli done`);
    tests.add(`${runner} cli status`);
    if (input.areas.includes("docs")) tests.add(`${runner} cli update`);
  } else if (cliScripts.cli && usesPnpm) {
    tests.add("pnpm --filter @dev-guard/cli cli status");
  }
  if (tests.size === 0) tests.add("확인 필요: package.json scripts에서 검증 명령을 찾지 못함");
  return [...tests];
}

async function assessCompletionQuality(
  root: string,
  input: {
    changedFiles: string[];
    rawChangedFiles: string[];
    areas: string[];
    judgments: string[];
    testCandidates: string[];
    nextTaskTitle: string;
  }
): Promise<QualityReport> {
  const [rootPackage, cliPackage] = await Promise.all([
    readJsonFile<PackageJson>(fromRoot(root, "package.json"), {}),
    readJsonFile<PackageJson>(fromRoot(root, "packages/cli/package.json"), {})
  ]);
  const rootScripts = rootPackage.scripts ?? {};
  const checklist: QualityCheckItem[] = [];
  const rawGeneratedFiles = input.rawChangedFiles.filter(isGeneratedRuntimePath);
  checklist.push({
    label: "generated/runtime files",
    status: rawGeneratedFiles.length > 0 ? "BLOCKED" : "PASS",
    detail: rawGeneratedFiles.length > 0 ? `generated files in git changes: ${rawGeneratedFiles.join(", ")}` : "no generated runtime files in git changes"
  });

  const packageChanged = input.changedFiles.some((file) => /(^|\/)package\.json$/.test(file));
  const lockChanged = input.rawChangedFiles.some((file) => /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/.test(file));
  checklist.push({
    label: "package lock consistency",
    status: packageChanged && !lockChanged ? "BLOCKED" : "PASS",
    detail: packageChanged && !lockChanged ? "package.json changed but no lockfile change detected" : "package/lockfile state does not look inconsistent"
  });
  checklist.push({
    label: "package manifest changed",
    status: packageChanged ? "WARN" : "PASS",
    detail: packageChanged ? "package.json changed; verify scripts/dependencies and publish impact" : "package.json not changed"
  });

  const hasBuildScript = Boolean(rootScripts.build);
  const hasBuildVerification = input.testCandidates.some((command) => /\bbuild\b/.test(command));
  checklist.push({
    label: "build verification candidate",
    status: hasBuildScript && !hasBuildVerification ? "BLOCKED" : "PASS",
    detail: hasBuildScript ? (hasBuildVerification ? "build verification candidate found" : "build script exists but no build command was suggested") : "no build script found"
  });

  checklist.push({
    label: "change breadth",
    status: input.changedFiles.length >= 10 ? "WARN" : "PASS",
    detail: `${input.changedFiles.length} changed file(s)`
  });

  const riskyAreas = input.areas.filter((area) => ["auth", "database", "api", "config"].includes(area));
  checklist.push({
    label: "risky areas",
    status: riskyAreas.length > 0 ? "WARN" : "PASS",
    detail: riskyAreas.length > 0 ? `risky area(s): ${riskyAreas.join(", ")}` : "no auth/database/api/config area detected"
  });

  const commandRouterChanged = input.changedFiles.some((file) => /packages\/cli\/src\/index\.tsx?$/.test(file));
  checklist.push({
    label: "CLI router/help verification",
    status: commandRouterChanged ? "WARN" : "PASS",
    detail: commandRouterChanged ? "CLI command router changed; verify help/status output" : "CLI router not changed"
  });

  const watchChanged = input.changedFiles.some((file) => /watch\.[tj]sx?$/.test(file));
  checklist.push({
    label: "watch verification",
    status: watchChanged ? "WARN" : "PASS",
    detail: watchChanged ? "watch changed; verify --poll and --depth behavior" : "watch implementation not changed"
  });

  const stateHistoryChanged = input.changedFiles.some((file) => /(runtime-state|history|state|prompt)\.[tj]sx?$/.test(file));
  checklist.push({
    label: "state/history verification",
    status: stateHistoryChanged ? "WARN" : "PASS",
    detail: stateHistoryChanged ? "state/history/prompt generation changed; verify done/status output" : "state/history generation not changed"
  });

  const codeChanged = input.changedFiles.some((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file));
  const docsChanged = input.changedFiles.some((file) => /\.(md|mdx)$/.test(file) || file.startsWith("docs/"));
  checklist.push({
    label: "docs update candidate",
    status: "PASS",
    detail: codeChanged && !docsChanged ? "source changed without docs changes; recorded as doc update candidate only" : "docs/source balance does not require warning",
    affectsVerdict: false
  });

  const hasDrift = input.judgments.some((item) => /drift|Generated diff/i.test(item));
  checklist.push({
    label: "drift clarity",
    status: hasDrift ? "WARN" : "PASS",
    detail: hasDrift ? `drift candidate present; next task=${input.nextTaskTitle || "missing"}` : "no drift candidate"
  });

  const verdictItems = checklist.filter((item) => item.affectsVerdict !== false);
  const blocked = verdictItems.filter((item) => item.status === "BLOCKED");
  const warns = verdictItems.filter((item) => item.status === "WARN");
  const verdict: QualityVerdict = blocked.length > 0 ? "BLOCKED" : warns.length > 0 ? "NEEDS_REVIEW" : "PASS";
  const requiredVerification = input.testCandidates.length > 0 ? input.testCandidates : ["확인 필요: package.json scripts에서 검증 명령을 찾지 못함"];
  const beforeCommit = [
    ...requiredVerification.map((command) => `run ${command}`),
    `review ${devguardPaths.qualityReport}`,
    `review ${devguardPaths.nextCodexPrompt}`
  ];
  const nextRecommendedAction =
    verdict === "BLOCKED"
      ? "fix BLOCKED items before commit"
      : verdict === "NEEDS_REVIEW"
        ? `run ${requiredVerification[0]}, then review ${devguardPaths.qualityReport}`
        : "ready for final review or commit";
  return {
    verdict,
    why:
      verdict === "PASS"
        ? ["change scope is small, verification exists, and no blocking local quality rule fired"]
        : [...blocked, ...warns].map((item) => `${item.status}: ${item.label} - ${item.detail}`),
    requiredVerification,
    checklist,
    beforeCommit,
    nextRecommendedAction
  };
}

function renderQualityReport(report: QualityReport): string {
  const blocked = report.checklist.filter((item) => item.status === "BLOCKED");
  const warnings = report.checklist.filter((item) => item.status === "WARN");
  return [
    "# Completion Quality Report",
    "",
    "## Verdict",
    `- ${report.verdict}`,
    "",
    "## Why",
    ...formatBullets(report.why),
    "",
    "## Required Verification",
    ...formatBullets(report.requiredVerification),
    "",
    "## Blocked Items",
    ...formatBullets(blocked.map((item) => `${item.label} - ${item.detail}`)),
    "",
    "## Warnings",
    ...formatBullets(warnings.map((item) => `${item.label} - ${item.detail}`)),
    "",
    "## Risk Checklist",
    ...report.checklist.map((item) => `- ${item.status}: ${item.label} - ${item.detail}`),
    "",
    "## Before Commit",
    ...formatBullets(report.beforeCommit),
    "",
    "## Next Recommended Action",
    `- ${report.nextRecommendedAction}`
  ].join("\n") + "\n";
}

interface RequiredText {
  path: string;
  content: string;
  missing: boolean;
}

function renderProjectHandoff(input: {
  project: RequiredText;
  architecture: RequiredText;
  decisions: RequiredText;
  tasks: RequiredText;
  records: HistoryRecord[];
  historySummary: RequiredText;
  decisionCandidates: RequiredText;
  qualityReport: RequiredText;
  nextPrompt: RequiredText;
  hookStatus: RequiredText;
  state: string;
}): string {
  const quality = parseQuality(input.qualityReport.content);
  const nextTask = extractNextTask(input.nextPrompt.content, input.tasks.content, input.state);
  const decisions = importantDecisions(input.decisions.content, input.decisionCandidates.content);
  return [
    "# Project Handoff",
    "",
    "## Current State",
    ...formatBullets(currentStateSummary(input)),
    ...missingInputs([input.project, input.architecture, input.tasks]),
    "",
    "## Active Workflow",
    "- `dev-guard watch` keeps the pending file buffer current and auto-finalizes after the filesystem settles.",
    "- Claude/Codex edits files in the normal agent session.",
    "- After filesystem inactivity, watch waits a grace period then automatically runs the equivalent of `dev-guard done`.",
    "- Trusted Claude Code / Codex Stop Hooks also trigger `dev-guard done` if they fire first.",
    "- `dev-guard done` writes history, quality-report, next-codex-prompt, and project-handoff.",
    "- Manual fallback: run `dev-guard done` only when watch crashed, hooks failed, or manual recovery is needed.",
    "- `dev-guard status` shows hook state, quality state, and the handoff path.",
    "",
    "## Recent Changes",
    ...formatBullets(
      input.records.length > 0
        ? input.records
            .slice(-5)
            .reverse()
            .map((record) => `${record.timestamp}: ${record.inferredSummary}`)
        : extractBullets(input.historySummary.content, 5)
    ),
    ...missingInputs([input.historySummary]),
    "",
    "## Important Decisions",
    ...formatBullets(decisions),
    ...missingInputs([input.decisions, input.decisionCandidates]),
    "",
    "## Quality Status",
    `- verdict: ${quality.verdict}`,
    "- reason:",
    ...formatBullets(quality.why),
    "- required verification:",
    ...formatBullets(quality.requiredVerification),
    ...missingInputs([input.qualityReport]),
    "",
    "## Open Risks",
    ...formatBullets(openRisks(input)),
    "",
    "## Next Best Task",
    `- ${nextTask}`,
    "",
    "## Do Not Change",
    "- Do not add polling-based completion guessing.",
    "- Do not call LLM APIs automatically.",
    "- Do not run git commit automatically.",
    "- Do not change the existing watch/done/status/reset UX.",
    "- Do not change the verified Claude/Codex hook structure unless official docs require it.",
    "- Auto-finalization grace period is configurable via --auto-complete-delay; default is 8 seconds.",
    "",
    "## Resume Prompt",
    ".devguard/reports/project-handoff.md를 읽고 Current State, Quality Status, Next Best Task를 기준으로 이어서 작업해라. 구현되지 않은 기능을 추측하지 말고 현재 파일 기준으로 확인한 뒤 진행해라."
  ].join("\n") + "\n";
}

async function readRequiredText(root: string, path: string): Promise<RequiredText> {
  const content = await readTextFile(fromRoot(root, path));
  const missing = !content.trim();
  return {
    path,
    content: missing ? "확인 필요" : content,
    missing
  };
}

function parseHistoryRecords(text: string): HistoryRecord[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as HistoryRecord;
      } catch {
        return undefined;
      }
    })
    .filter((record): record is HistoryRecord => Boolean(record));
}

function parseQuality(markdown: string): { verdict: string; why: string[]; requiredVerification: string[] } {
  return {
    verdict: firstSectionBullet(markdown, "Verdict") ?? "확인 필요",
    why: extractSectionBullets(markdown, "Why", 4),
    requiredVerification: extractSectionBullets(markdown, "Required Verification", 5)
  };
}

function extractNextTask(nextPrompt: string, tasks: string, state: string): string {
  const priority = firstSectionBullet(nextPrompt, "Next Task")?.replace(/^priority:\s*/i, "");
  if (priority && priority !== "none") return priority;
  const fromTasks = firstSectionBullet(tasks, "다음 작업") ?? firstSectionBullet(tasks, "진행 중");
  if (fromTasks && !/TODO|확인 필요/i.test(fromTasks)) return fromTasks;
  return summarizeFromState(state, "lastQualityNextAction") ?? "확인 필요";
}

function importantDecisions(decisions: string, candidates: string): string[] {
  const merged = [...extractDecisionLines(decisions), ...extractSectionBullets(candidates, "기록 후보", 5)];
  return [...new Set(merged.filter(isUsefulText))].slice(0, 6);
}

function openRisks(input: {
  qualityReport: RequiredText;
  hookStatus: RequiredText;
  state: string;
  project: RequiredText;
  architecture: RequiredText;
  decisions: RequiredText;
  tasks: RequiredText;
  historySummary: RequiredText;
  decisionCandidates: RequiredText;
  nextPrompt: RequiredText;
}): string[] {
  const risks = new Set<string>();
  for (const item of [...extractSectionBullets(input.qualityReport.content, "Blocked Items", 5), ...extractSectionBullets(input.qualityReport.content, "Warnings", 5)]) {
    if (item !== "none" && item !== "확인 필요") risks.add(item);
  }
  if (/NOT_INSTALLED|unknown|no/i.test(input.hookStatus.content)) risks.add("Hook status needs verification in the actual Claude/Codex environment.");
  if (/Codex CLI: INSTALLED/.test(input.hookStatus.content)) risks.add("Codex Stop Hook format is configured; actual Codex runtime trust/execution still needs environment verification.");
  if (/lastQualityVerdict":\s*"NEEDS_REVIEW"|lastQualityVerdict":\s*"BLOCKED"/.test(input.state)) {
    risks.add(`Quality state is ${summarizeFromState(input.state, "lastQualityVerdict")}; review quality-report before commit.`);
  }
  for (const doc of [input.project, input.architecture, input.decisions, input.tasks, input.historySummary, input.decisionCandidates, input.nextPrompt]) {
    if (doc.missing) risks.add(`${doc.path} missing or empty; 확인 필요`);
  }
  return risks.size > 0 ? [...risks].slice(0, 8) : ["확인 필요: no open risk was identified from current .devguard/ artifacts."];
}

function currentStateSummary(input: {
  project: RequiredText;
  architecture: RequiredText;
  tasks: RequiredText;
  qualityReport: RequiredText;
  hookStatus: RequiredText;
  state: string;
}): string[] {
  const summary = new Set<string>();
  summary.add("watch / done / status / reset workflow is implemented.");
  summary.add("done writes history, quality-report, next-codex-prompt, and project-handoff.");
  summary.add("install-hooks writes Claude Code and Codex Stop Hook integration files.");
  summary.add("Claude Code Stop Hook uses .claude/settings.json.");
  summary.add("Codex Stop Hook uses .codex/hooks.json; turn.completed is treated as codex exec --json JSONL, not as a hook.");
  if (/Claude Code: INSTALLED/.test(input.hookStatus.content)) summary.add("Claude Code hook status is currently INSTALLED.");
  if (/Codex CLI: INSTALLED/.test(input.hookStatus.content)) summary.add("Codex CLI hook status is currently INSTALLED.");
  const quality = parseQuality(input.qualityReport.content);
  if (quality.verdict !== "확인 필요") summary.add(`latest quality verdict is ${quality.verdict}.`);
  const stateSummary = summarizeFromState(input.state, "lastSummary");
  if (stateSummary) summary.add(`latest done summary: ${stateSummary}`);
  for (const item of [summarizeSection(input.project.content, "현재 목표"), summarizeSection(input.architecture.content, "기술 스택"), summarizeSection(input.tasks.content, "진행 중")]) {
    if (isUsefulText(item)) summary.add(item);
  }
  return [...summary].slice(0, 10);
}

function summarizeSection(markdown: string, heading: string): string | undefined {
  const bullet = firstSectionBullet(markdown, heading);
  return bullet && !/TODO/i.test(bullet) ? bullet : undefined;
}

function summarizeFromState(stateJson: string, key: keyof ProjectState): string | undefined {
  try {
    const state = JSON.parse(stateJson) as ProjectState;
    const value = state[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

function extractSectionBullets(markdown: string, heading: string, limit: number): string[] {
  const bullets = sectionLines(markdown, heading)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(isUsefulText);
  return bullets.length > 0 ? bullets.slice(0, limit) : ["확인 필요"];
}

function extractBullets(markdown: string, limit: number): string[] {
  const bullets = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(isUsefulText);
  return bullets.length > 0 ? bullets.slice(0, limit) : ["확인 필요"];
}

function missingInputs(inputs: RequiredText[]): string[] {
  return inputs.filter((input) => input.missing).map((input) => `- ${input.path}: 확인 필요`);
}

function isUsefulText(value: string | undefined): value is string {
  return Boolean(value && value.trim() && value.trim() !== "none");
}

function isGeneratedRuntimePath(file: string): boolean {
  return (
    file === devguardPaths.runtime ||
    file === devguardPaths.state ||
    file === devguardPaths.history ||
    file.startsWith(`${devguardPaths.reportsDir}/`) ||
    file.startsWith(`${devguardPaths.promptsDir}/`) ||
    file.startsWith(`${devguardPaths.contextDir}/`) ||
    file.startsWith(`${devguardPaths.logsDir}/`) ||
    file.startsWith(`${devguardPaths.hooksDir}/`) ||
    file.startsWith(".devguard/runs/") ||
    file === ".devguard/project-index.json" ||
    file === ".devguard/file-summaries.json" ||
    file === ".devguard/code-graph.json"
  );
}

function inferDecisionCandidates(input: { areas: string[]; changedFiles: string[]; judgments: string[]; summary: string }): string[] {
  const candidates = new Set<string>();
  if (input.changedFiles.some((file) => file.includes("watch"))) {
    candidates.add("watch는 파일 시스템 안정 후 자동 완료 처리를 수행하며, Stop Hook도 함께 지원한다.");
    candidates.add("watch는 polling fallback과 depth 제한을 지원한다.");
  }
  if (input.changedFiles.some((file) => file.includes("runtime-state"))) {
    candidates.add(".devguard/ runtime 문서는 자동 생성하되 기존 파일은 덮어쓰지 않는다.");
    candidates.add("done은 last-run뿐 아니라 history/report/prompt 산출물을 함께 생성한다.");
  }
  if (input.summary.includes("MIXED:")) {
    candidates.add("mixed intent는 즉시 실패가 아니라 drift 후보로 기록하고 다음 작업에서 확인한다.");
  }
  if (input.areas.includes("config")) {
    candidates.add("config/runtime 변경은 완료 전 build와 status 확인을 기본 검증으로 둔다.");
  }
  for (const judgment of input.judgments) {
    if (/auth|database|API|config/.test(judgment)) {
      candidates.add(`${judgment} 변경 시 architecture/decisions 문서 확인이 필요하다.`);
    }
  }
  return [...candidates].slice(0, 8);
}

function renderHistorySummary(records: HistoryRecord[]): string {
  const recent = records.slice(-5).reverse();
  const areaCounts = countItems(records.flatMap((record) => record.areas));
  const driftCounts = countItems(records.flatMap((record) => record.driftCandidates.filter((item) => item.toLowerCase().includes("drift"))));
  const testCounts = countItems(records.flatMap((record) => record.testCandidates));
  return [
    "# dev-guard History Summary",
    "",
    "## 최근 변경 흐름",
    ...formatBullets(recent.map((record) => `${record.timestamp} - ${record.inferredSummary}`)),
    "",
    "## 반복적으로 수정된 영역",
    ...formatBullets(formatCounts(areaCounts).slice(0, 8)),
    "",
    "## 누적 drift 후보",
    ...formatBullets(formatCounts(driftCounts).slice(0, 8)),
    "",
    "## 아직 테스트가 필요한 영역",
    ...formatBullets(formatCounts(testCounts).slice(0, 8)),
    "",
    "## 다음 작업 전 확인할 점",
    ...formatBullets(inferNextHistoryChecks(records))
  ].join("\n") + "\n";
}

function renderDecisionCandidates(input: { timestamp: string; summary: string; candidates: string[]; changedFiles: string[] }): string {
  return [
    "# Decision Candidates",
    "",
    `- generatedAt: ${input.timestamp}`,
    `- source: ${input.summary}`,
    "",
    "## 기록 후보",
    ...formatBullets(input.candidates.length > 0 ? input.candidates : ["이번 done 결과에서 새 결정 후보를 찾지 못함"]),
    "",
    "## 근거 파일",
    ...formatBullets(input.changedFiles.slice(0, 12))
  ].join("\n") + "\n";
}

function summarizeProjectContext(input: { projectMarkdown: string; architectureMarkdown: string; decisionsMarkdown: string }): ProjectContextSummary {
  return {
    projectPurpose: firstSectionBullet(input.projectMarkdown, "프로젝트 목적") ?? "확인 필요",
    currentGoal: firstSectionBullet(input.projectMarkdown, "현재 목표") ?? "확인 필요",
    notDoing: firstSectionBullet(input.projectMarkdown, "하지 않을 것") ?? "확인 필요",
    techStack: firstSectionBullet(input.architectureMarkdown, "기술 스택") ?? "확인 필요",
    structure: firstSectionBullet(input.architectureMarkdown, "주요 디렉토리") ?? "확인 필요",
    decisions: extractDecisionLines(input.decisionsMarkdown)
  };
}

function firstSectionBullet(markdown: string, heading: string): string | undefined {
  const lines = sectionLines(markdown, heading);
  const bullet = lines.map((line) => line.trim()).find((line) => /^[-*]\s+/.test(line) && !/TODO|확인 필요/i.test(line));
  return bullet?.replace(/^[-*]\s+/, "").trim();
}

function sectionLines(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.replace(/^#+\s*/, "").trim() === heading);
  if (start < 0) return [];
  const result: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s+/.test(line)) break;
    result.push(line);
  }
  return result;
}

function extractDecisionLines(markdown: string): string[] {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#|^\| --- |TODO/.test(line) && !/^\|\s*날짜\s*\|/.test(line));
  const meaningful = lines.filter((line) => /\|/.test(line) || /^[-*]\s+/.test(line)).slice(0, 5);
  return meaningful.length > 0 ? meaningful.map((line) => line.replace(/^[-*]\s+/, "")) : ["확인 필요"];
}

function inferFileRole(file: string): string {
  if (file.endsWith("package.json")) return "script/dependency config";
  if (file.endsWith("pnpm-lock.yaml") || file.endsWith("package-lock.json") || file.endsWith("yarn.lock")) return "lockfile/dependency snapshot";
  if (file === ".gitignore") return "generated artifacts exclusion";
  if (/src\/index\.tsx?$/.test(file) || /src\/index\.jsx?$/.test(file)) return "CLI command router / entrypoint";
  if (/watch\.[tj]sx?$/.test(file)) return "watch command / file watcher";
  if (/runtime-state\.[tj]sx?$/.test(file)) return "runtime state / history persistence";
  if (/review\.[tj]sx?$/.test(file)) return "review command / drift analysis";
  if (/update\.[tj]sx?$/.test(file)) return "docs update preview/write logic";
  if (/\.mdx?$/.test(file)) return "documentation";
  if (/(\.test|\.spec)\.[tj]sx?$/.test(file)) return "test file";
  if (/app\/api|pages\/api|route\.[tj]s$/.test(file)) return "API/server route";
  if (/components|app|pages/.test(file)) return "UI/component surface";
  if (/config|tsconfig|vite|next\.config/.test(file)) return "build/runtime config";
  return "source file";
}

function buildRiskDetails(input: { judgments: string[]; changedFiles: string[]; areas: string[] }): RiskDetail[] {
  const relatedFiles = input.changedFiles.slice(0, 6);
  const risks = input.judgments.slice(0, 5).map((judgment) => ({
    content: judgment,
    relatedFiles,
    reason: riskReason(judgment, input.areas),
    checkMethod: riskCheckMethod(judgment, input.areas),
    decisionRule: riskDecisionRule(judgment)
  }));
  return risks.length > 0
    ? risks
    : [
        {
          content: "명시적 drift 후보 없음",
          relatedFiles,
          reason: "local heuristic에서 blocking 후보를 찾지 못함",
          checkMethod: "변경 파일을 직접 확인하고 검증 명령 실행",
          decisionRule: "검증 통과 시 추가 수정 없이 종료"
        }
      ];
}

function riskReason(judgment: string, areas: string[]): string {
  if (/mixed|drift/i.test(judgment)) return "여러 변경 의도가 섞였거나 현재 task와 다른 방향일 수 있음";
  if (/auth|database|API|config/.test(judgment)) return `${areas.join(", ")} 영역은 런타임 동작 영향이 클 수 있음`;
  if (/docs|문서/i.test(judgment)) return "코드 변경과 문서 상태가 어긋날 수 있음";
  return "rule-based check에서 확인 후보로 분류됨";
}

function riskCheckMethod(judgment: string, areas: string[]): string {
  if (/mixed|drift/i.test(judgment)) return "변경 파일이 하나의 작업 목표로 설명되는지 확인";
  if (areas.includes("config")) return "빌드와 CLI status를 실행해 설정 영향 확인";
  if (areas.includes("api")) return "API route 변경 diff와 호출 파일 확인";
  return "관련 파일 diff를 읽고 package scripts 기반 검증 명령 실행";
}

function riskDecisionRule(judgment: string): string {
  if (/high|drift/i.test(judgment)) return "현재 작업 목표와 직접 관련 없으면 수정/분리 후보";
  if (/docs|문서/i.test(judgment)) return "코드 동작 변경이면 update 후보 생성, 직접 원본 문서 수정 금지";
  return "검증 명령 통과와 관련 파일 일치 여부로 판단";
}

function formatRiskDetails(details: RiskDetail[]): string[] {
  return details.flatMap((detail, index) => [
    `- candidate ${index + 1}: ${detail.content}`,
    `  - related files: ${detail.relatedFiles.length > 0 ? detail.relatedFiles.join(", ") : "none"}`,
    `  - why check: ${detail.reason}`,
    `  - how to check: ${detail.checkMethod}`,
    `  - decision rule: ${detail.decisionRule}`
  ]);
}

function chooseNextTask(input: {
  drift: "low" | "medium" | "high";
  judgments: string[];
  areas: string[];
  changedFiles: string[];
  testCandidates: string[];
}): NextTaskPlan {
  if (input.changedFiles.some((file) => file.includes("watch")) && input.judgments.some((item) => /EMFILE|watch|mixed/i.test(item))) {
    return nextTask("watch stability verification", "watch가 안정적으로 변경을 감지하고 EMFILE fallback 안내를 유지하는지 확인한다.", input);
  }
  if (input.changedFiles.some((file) => file.includes("runtime-state") || file.includes("prompt")) || input.judgments.some((item) => /prompt|history/i.test(item))) {
    return nextTask("handoff prompt quality", "next-codex-prompt.md가 다음 에이전트가 바로 작업할 수 있는 인수인계 문서인지 확인한다.", input);
  }
  if (input.testCandidates.length > 0 && input.drift !== "low") {
    return nextTask("verification before commit", "현재 변경을 추가 수정하기 전에 검증 명령을 실행하고 drift 후보를 정리한다.", input);
  }
  if (input.judgments.some((item) => /docs|문서/i.test(item))) {
    return nextTask("docs update candidate review", "문서 원본을 직접 수정하지 않고 update 후보가 필요한지 확인한다.", input);
  }
  return nextTask("final review", "변경 파일을 확인하고 빌드/status 결과 기준으로 커밋 가능 여부를 판단한다.", input);
}

function nextTask(title: string, goal: string, input: { changedFiles: string[]; areas: string[]; testCandidates: string[] }): NextTaskPlan {
  const likelyFiles = input.changedFiles.slice(0, 8);
  return {
    title,
    goal,
    scope: [`areas: ${input.areas.join(", ")}`, "현재 changed files 안에서만 최소 수정"],
    likelyFiles: likelyFiles.length > 0 ? likelyFiles : ["확인 필요"],
    doNotEdit: [`${devguardPaths.reportsDir}/*`, `${devguardPaths.promptsDir}/*`, devguardPaths.runtime, "관련 없는 product/source files"],
    success: ["검증 명령 통과", "drift 후보가 설명되거나 해소됨", "next-codex-prompt가 현재 변경과 일치"]
  };
}

function countItems(items: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items.filter(Boolean)) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return counts;
}

function formatCounts(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([item, count]) => `${item} (${count})`);
}

function inferNextHistoryChecks(records: HistoryRecord[]): string[] {
  const recent = records.slice(-5);
  const checks = new Set<string>();
  if (recent.some((record) => record.areas.includes("auth") || record.areas.includes("database") || record.areas.includes("api"))) {
    checks.add("auth/database/api 관련 변경은 architecture.md와 decisions.md 반영 여부 확인");
  }
  if (recent.some((record) => record.inferredSummary.includes("MIXED:"))) {
    checks.add("mixed intent가 누적되어 다음 작업 전 변경 범위 분리 여부 확인");
  }
  if (recent.some((record) => record.testCandidates.length > 0)) {
    checks.add("최근 작업의 테스트 후보 명령 실행 여부 확인");
  }
  checks.add(`다음 Codex 작업 전 ${devguardPaths.nextCodexPrompt} 확인`);
  return [...checks];
}

function projectTemplate(): string {
  return [
    "# Project",
    "",
    "## 프로젝트 목적",
    "- TODO",
    "",
    "## 핵심 사용자",
    "- TODO",
    "",
    "## 현재 목표",
    "- TODO",
    "",
    "## 하지 않을 것",
    "- TODO"
  ].join("\n") + "\n";
}

function architectureTemplate(): string {
  return [
    "# Architecture",
    "",
    "## 기술 스택",
    "- TODO",
    "",
    "## 주요 디렉토리",
    "- TODO",
    "",
    "## 인증/DB/API 구조",
    "- TODO",
    "",
    "## 외부 서비스",
    "- TODO"
  ].join("\n") + "\n";
}

function decisionsTemplate(): string {
  return [
    "# Decisions",
    "",
    "| 날짜 | 결정 | 이유 | 영향 |",
    "| --- | --- | --- | --- |",
    "| TODO | TODO | TODO | TODO |"
  ].join("\n") + "\n";
}

function tasksTemplate(): string {
  return [
    "# Tasks",
    "",
    "## 진행 중",
    "- TODO",
    "",
    "## 다음 작업",
    "- TODO",
    "",
    "## 보류",
    "- TODO",
    "",
    "## 완료",
    "- TODO"
  ].join("\n") + "\n";
}
