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
  OpenAIProvider,
  type ChangeFile,
  type CodeGraphEntry,
  type DevGuardConfig
} from "@dev-guard/core";
import { appendTextFile, fromRoot, readJsonFile, readTextFile, writeFileIfMissing, writeTextFile } from "./fs.js";
import { getDiffForChangeFiles, getGitChanges, type GitChanges } from "./git.js";
import { migrateLegacyDevguardDir } from "./migration.js";
import { DEVGUARD_DIR, devguardPaths } from "./paths.js";
import { generateProjectKnowledge } from "./knowledge.js";
import { resolveDevGuardLocale, type DevGuardLocale } from "./locale.js";
import { loadConfig, resolveOpenAIApiKey } from "./config.js";

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
  locale?: DevGuardLocale;
  setupStatus?: SetupStatus;
}

export interface SetupStatus {
  active: boolean;
  startedAt?: string;
  completedAt?: string;
  steps: SetupStatusStep[];
}

export interface SetupStatusStep {
  key: "config" | "agent_instructions" | "hooks" | "knowledge" | "dashboard";
  label: string;
  status: "pending" | "running" | "done" | "warning" | "skipped";
  detail?: string;
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
  summary: string[];
  why: string[];
  relatedFiles: string[];
  requiredVerification: string[];
  checklist: QualityCheckItem[];
  reviewItems: QualityReviewItem[];
  beforeCommit: string[];
  nextRecommendedAction: string;
  aiSummary?: {
    status: "generated" | "fallback";
    reason: string;
    source: "openai" | "rule-based";
  };
}

interface QualityReviewItem {
  title: string;
  body: string[];
  files: string[];
  checks: string[];
}

interface ParsedQuality {
  verdict: string;
  why: string[];
  requiredVerification: string[];
  reviewItems: string[];
  blockedItems: string[];
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

export async function refreshRuntimeLocale(root: string): Promise<DevGuardLocale> {
  const locale = await resolveDevGuardLocale(root);
  const current = await readRuntimeState(root);
  if (current.locale !== locale) {
    await writeRuntimeState(root, { ...current, locale });
  }
  return locale;
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
    normalized === DEVGUARD_DIR ||
    normalized.startsWith(`${DEVGUARD_DIR}/`) ||
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
  const locale = await refreshRuntimeLocale(root);
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
  let qualityReport = await assessCompletionQuality(root, {
    changedFiles,
    rawChangedFiles,
    areas,
    judgments,
    testCandidates,
    nextTaskTitle: nextTask.title
  });
  qualityReport = await enhanceQualityReportWithAI(root, {
    locale,
    report: qualityReport,
    changedFiles,
    areas,
    judgments,
    summary,
    nextTaskTitle: nextTask.title,
    projectContext,
    previousHistory
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
  const qualityReportMarkdown = renderQualityReport(qualityReport, locale);
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
  const locale = await refreshRuntimeLocale(root);
  const [project, architecture, decisions, tasks, history, historySummary, decisionCandidates, qualityReport, nextPrompt, hookStatus, state, projectKnowledge] = await Promise.all([
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
      .catch(() => "확인 필요"),
    readRequiredText(root, devguardPaths.projectKnowledge)
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
    state,
    projectKnowledge,
    locale
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
  const semanticChanges = summarizeMeaningfulChanges(input.changedFiles, input.areas, input.summary);
  const outstanding = outstandingIssuesFromQuality(input.qualityReport, input.riskDetails.map((risk) => risk.content));
  const executableSteps = executableNextSteps(input.qualityReport, input.nextTask);
  const recent = formatRecentSessionContext(input.recentHistory).slice(0, 2);
  const fileLine = compactFileList(input.changedFiles);
  return [
    "# Codex Handoff Prompt",
    "",
    `Read \`${devguardPaths.projectHandoff}\` and \`${devguardPaths.agentContext}\` first. Do not scan broadly before that.`,
    "",
    "## Next",
    ...formatBullets(executableSteps),
    "",
    "## State",
    `- goal: ${input.nextTask.goal}`,
    `- status: ${completionStatus(input.qualityReport.verdict, input.drift)}`,
    `- quality: ${input.qualityReport.verdict}`,
    `- verify: ${compactCommandList(input.qualityReport.requiredVerification)}`,
    "",
    "## Changed",
    ...formatBullets(semanticChanges),
    `- files: ${fileLine}`,
    "",
    "## Outstanding",
    ...formatBullets(outstanding),
    "",
    "## Context",
    ...formatBullets(recent),
    `- project: ${compactProjectContextLine(input.projectContext)}`,
    "",
    "## Guardrails",
    "- Do not introduce new features.",
    `- ${devguardPaths.reportsDir}, ${devguardPaths.promptsDir}, ${devguardPaths.runtime} 직접 수정 금지`,
    "- Keep watch/done/status/reset UX unchanged."
  ].join("\n") + "\n";
}

function formatBullets(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- none"];
}

function summarizeMeaningfulChanges(changedFiles: string[], areas: string[], summary?: string): string[] {
  const changes = new Set<string>();
  if (changedFiles.some((file) => /dashboard/i.test(file))) changes.add("Dashboard UX and assistant guidance changed.");
  if (changedFiles.some((file) => /runtime-state|handoff|prompt/i.test(file))) changes.add("Session continuity and handoff generation changed.");
  if (changedFiles.some((file) => /knowledge/i.test(file))) changes.add("Project Knowledge generation or usage changed.");
  if (areas.includes("docs")) changes.add("Documentation updated to match the current workflow.");
  if (areas.includes("api")) changes.add("API contract or route handling changed.");
  if (areas.includes("config")) changes.add("Configuration or dependency setup changed.");
  if (areas.includes("cli") && ![...changes].some((item) => item.includes("Dashboard") || item.includes("handoff"))) {
    changes.add("CLI behavior changed.");
  }
  if (summary && !/확인 필요/i.test(summary)) changes.add(`Latest done summary: ${summary}`);
  return changes.size > 0 ? [...changes].slice(0, 8) : ["확인 필요: no meaningful change summary could be inferred."];
}

function outstandingIssuesFromQuality(report: QualityReport, riskHints: string[] = []): string[] {
  const issues = new Set<string>();
  for (const item of report.checklist) {
    if (item.status !== "PASS") issues.add(`${item.status}: ${item.label} - ${item.detail}`);
  }
  for (const hint of riskHints) {
    if (/drift|blocked|warn|risk|확인 필요/i.test(hint)) issues.add(hint);
  }
  if (report.verdict === "PASS" && issues.size === 0) return ["none"];
  return [...issues].slice(0, 8);
}

function compactOutstanding(items: string[], verdict: string): string[] {
  if (verdict === "PASS") return ["none"];
  return items.filter((item) => item !== "none" && item !== "없음").slice(0, verdict === "BLOCKED" ? 5 : 3);
}

function executableNextSteps(report: QualityReport, nextTask: NextTaskPlan): string[] {
  if (report.verdict === "BLOCKED") {
    return [
      "Review the BLOCKED items in the quality report.",
      "Fix only the files required for the blocked issue.",
      "Run the required verification commands.",
      "Do not introduce new features."
    ];
  }
  if (report.verdict === "NEEDS_REVIEW") {
    return [
      `Start with: ${nextTask.goal}`,
      `Run: ${report.requiredVerification[0] ?? "확인 필요"}`,
      `Review: ${devguardPaths.qualityReport}`,
      "Keep changes scoped; do not introduce new features."
    ];
  }
  return [
    `Continue with: ${nextTask.goal}`,
    "Keep the change scoped to the current task.",
    "Run the relevant verification command before finishing."
  ];
}

function executableNextStepsFromParsedQuality(quality: { verdict: string; requiredVerification: string[] }, nextTask: string, locale: DevGuardLocale = "en-US"): string[] {
  if (locale === "ko-KR") {
    if (quality.verdict === "BLOCKED") {
      return [
        "- 품질 보고서의 차단 항목을 먼저 확인하세요.",
        "- 차단 항목 해결에 필요한 파일만 수정하세요.",
        `- 실행: ${compactCommandList(quality.requiredVerification)}`
      ];
    }
    if (quality.verdict === "NEEDS_REVIEW") {
      return [
        `- 계속 진행: ${localizeSentence(nextTask, locale)}`,
        `- 실행: ${compactCommandList(quality.requiredVerification)}`,
        `- 확인: ${devguardPaths.qualityReport}`
      ];
    }
    return [`- 계속 진행: ${localizeSentence(nextTask, locale)}`, `- 실행: ${compactCommandList(quality.requiredVerification)}`];
  }
  if (quality.verdict === "BLOCKED") {
    return [
      "- Review BLOCKED items in the quality report.",
      "- Fix only the blocked issue.",
      `- Run: ${compactCommandList(quality.requiredVerification)}`
    ];
  }
  if (quality.verdict === "NEEDS_REVIEW") {
    return [
      `- Continue: ${nextTask}`,
      `- Run: ${compactCommandList(quality.requiredVerification)}`,
      `- Review: ${devguardPaths.qualityReport}`
    ];
  }
  return [`- Continue: ${nextTask}`, `- Run: ${compactCommandList(quality.requiredVerification)}`];
}

function completionStatus(verdict: string, drift?: string): string {
  if (verdict === "PASS" && drift !== "high") return "completed";
  if (verdict === "BLOCKED" || drift === "high") return "blocked";
  return "partially completed";
}

function compactFileList(files: string[], limit = 4): string {
  if (files.length === 0) return "none";
  const visible = files.slice(0, limit).join(", ");
  return files.length > limit ? `${visible}, +${files.length - limit}` : visible;
}

function compactCommandList(commands: string[], limit = 3): string {
  if (commands.length === 0) return "확인 필요";
  const visible = commands.slice(0, limit).join("; ");
  return commands.length > limit ? `${visible}; +${commands.length - limit}` : visible;
}

function compactProjectContextLine(projectContext: ProjectContextSummary): string {
  const parts = [projectContext.techStack, projectContext.structure].filter((item) => item && item !== "확인 필요");
  return parts.length > 0 ? parts.join("; ") : `see ${devguardPaths.projectKnowledge}`;
}

function compactQualityLine(quality: { verdict: string; why: string[]; requiredVerification: string[] }, locale: DevGuardLocale = "en-US"): string {
  const why = quality.why.filter((item) => item !== "확인 필요").slice(0, 2).join(" / ");
  const verify = compactCommandList(quality.requiredVerification);
  if (locale === "ko-KR") return `${quality.verdict}${why ? ` - ${why}` : ""}; 검증: ${verify}`;
  return `${quality.verdict}${why ? ` - ${why}` : ""}; verify: ${verify}`;
}

function compactKnowledgeLine(content: string): string {
  try {
    const parsed = JSON.parse(content) as {
      summary?: { framework?: string; language?: string; packageManager?: string; filesIndexed?: number; entryPoints?: string[] };
      architecture?: { modules?: Array<{ name?: string }> };
    };
    const modules = parsed.architecture?.modules?.map((module) => module.name).filter(Boolean).slice(0, 5).join(", ");
    return [
      parsed.summary?.framework,
      parsed.summary?.packageManager,
      typeof parsed.summary?.filesIndexed === "number" ? `${parsed.summary.filesIndexed} files` : undefined,
      modules ? `modules: ${modules}` : undefined
    ].filter(Boolean).join("; ") || "확인 필요";
  } catch {
    return "확인 필요";
  }
}

function handoffQualityScore(input: { missingCount: number; outstandingCount: number; lineCountEstimate: number }): string[] {
  const coverage = input.missingCount === 0 ? "Complete" : `Missing ${input.missingCount}`;
  const redundancy = input.lineCountEstimate <= 55 ? "Low" : input.lineCountEstimate <= 75 ? "Medium" : "High";
  const readability = input.outstandingCount <= 4 && input.lineCountEstimate <= 60 ? "High" : "Medium";
  return [`Coverage: ${coverage}`, `Redundancy: ${redundancy}`, `Readability: ${readability}`];
}

function handoffSectionOrder(verdict: string): string[] {
  if (verdict === "BLOCKED") {
    return ["Outstanding", "Quality", "Goal", "Next", "Changed", "History", "Project", "Decisions", "Workflow", "Missing"];
  }
  if (verdict === "PASS") {
    return ["Goal", "Next", "Changed", "History", "Project", "Quality", "Decisions", "Workflow", "Missing"];
  }
  return ["Goal", "Outstanding", "Quality", "Next", "Changed", "History", "Project", "Decisions", "Workflow", "Missing"];
}

function parseProjectState(stateJson: string): ProjectState {
  try {
    return JSON.parse(stateJson) as ProjectState;
  } catch {
    return {};
  }
}

function lastHistoryFiles(records: HistoryRecord[]): string[] {
  return records.length > 0 ? records[records.length - 1].changedFiles : [];
}

function latestHistorySummary(records: HistoryRecord[]): string | undefined {
  return records.length > 0 ? records[records.length - 1].inferredSummary : undefined;
}

function formatRecentSessionContext(records: HistoryRecord[]): string[] {
  const recent = records.slice(-3).reverse();
  if (recent.length === 0) return ["확인 필요"];
  return recent.map((record, index) => {
    const label = index === 0 ? "Last session" : index === 1 ? "Previous" : "Earlier";
    return `${label}: ${record.inferredSummary} (${record.changedFiles.length} files; quality=${record.qualityVerdict ?? "unknown"})`;
  });
}

function projectKnowledgeBullets(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as {
      projectName?: string;
      summary?: {
        framework?: string;
        language?: string;
        packageManager?: string;
        filesIndexed?: number;
        entryPoints?: string[];
      };
      architecture?: {
        modules?: Array<{ name?: string; files?: string[] }>;
      };
      apis?: Array<{ route?: string; file?: string }>;
    };
    const bullets = new Set<string>();
    if (parsed.projectName) bullets.add(`project: ${parsed.projectName}`);
    if (parsed.summary?.framework) bullets.add(`framework: ${parsed.summary.framework}`);
    if (parsed.summary?.language) bullets.add(`language: ${parsed.summary.language}`);
    if (parsed.summary?.packageManager) bullets.add(`package manager: ${parsed.summary.packageManager}`);
    if (typeof parsed.summary?.filesIndexed === "number") bullets.add(`files indexed: ${parsed.summary.filesIndexed}`);
    if (parsed.summary?.entryPoints?.length) bullets.add(`entry points: ${parsed.summary.entryPoints.slice(0, 5).join(", ")}`);
    const moduleNames = parsed.architecture?.modules?.map((module) => module.name).filter(Boolean) ?? [];
    if (moduleNames.length > 0) bullets.add(`architecture modules: ${moduleNames.slice(0, 8).join(", ")}`);
    if (parsed.apis?.length) bullets.add(`known commands/apis: ${parsed.apis.slice(0, 5).map((api) => api.route ?? api.file).filter(Boolean).join(", ")}`);
    return bullets.size > 0 ? [...bullets].slice(0, 8) : ["확인 필요"];
  } catch {
    return ["확인 필요: project knowledge is missing or invalid JSON."];
  }
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
  const issueItems = [...blocked, ...warns];
  const beforeCommit = [
    ...requiredVerification.map((command) => `run ${command}`),
    `review ${devguardPaths.qualityReport}`,
    `review ${devguardPaths.nextCodexPrompt}`
  ];
  const reviewItems = buildQualityReviewItems({ changedFiles: input.changedFiles, areas: input.areas, issueItems, requiredVerification });
  return {
    verdict,
    summary: buildQualitySummary({ verdict, changedFiles: input.changedFiles, areas: input.areas, issueItems, requiredVerification }),
    why: buildQualityReasons({ verdict, changedFiles: input.changedFiles, areas: input.areas, issueItems }),
    relatedFiles: relatedQualityFiles(input.changedFiles, issueItems, reviewItems),
    requiredVerification,
    checklist,
    reviewItems,
    beforeCommit,
    nextRecommendedAction: buildQualityNextAction({ verdict, changedFiles: input.changedFiles, areas: input.areas, issueItems, requiredVerification })
  };
}

async function enhanceQualityReportWithAI(
  root: string,
  input: {
    locale: DevGuardLocale;
    report: QualityReport;
    changedFiles: string[];
    areas: string[];
    judgments: string[];
    summary: string;
    nextTaskTitle: string;
    projectContext: ProjectContextSummary;
    previousHistory: HistoryRecord[];
  }
): Promise<QualityReport> {
  const key = await resolveOpenAIApiKey(root);
  if (!key.apiKey) {
    return markQualityReportAIFallback(input.report, "missing_key");
  }

  try {
    const [resolvedConfig, previousHandoff, projectKnowledge] = await Promise.all([
      loadConfig(root),
      readTextFile(fromRoot(root, devguardPaths.projectHandoff)),
      readTextFile(fromRoot(root, devguardPaths.projectKnowledge))
    ]);
    const ai = resolvedConfig.config.ai ?? defaultConfig.ai;
    const model = ai.model ?? defaultConfig.ai.model ?? "gpt-4o-mini";
    const provider = new OpenAIProvider({
      apiKey: key.apiKey,
      model,
      temperature: ai.temperature ?? 0.2,
      maxTokens: Math.min(ai.maxTokens ?? 1400, 1800),
      reasoningEffort: ai.reasoningEffort,
      baseURL: ai.baseURL
    });
    const text = await withTimeout(provider.generateText({
      model,
      temperature: ai.temperature ?? 0.2,
      maxTokens: Math.min(ai.maxTokens ?? 1400, 1800),
      system: qualityAISystemPrompt(input.locale),
      prompt: qualityAIUserPrompt({
        ...input,
        previousHandoff,
        projectKnowledge: projectKnowledge.slice(0, 5000)
      })
    }), 12000);
    const generated = parseAIQualityReview(text);
    if (!generated) {
      return markQualityReportAIFallback(input.report, "invalid_response");
    }
    const shouldKeepSeedSummary = isOpenAIKeyUXChange(input.changedFiles) && !aiReviewMentionsOpenAIKeyFlow(generated);
    return {
      ...input.report,
      summary: !shouldKeepSeedSummary && generated.summary.length > 0 ? generated.summary : input.report.summary,
      why: generated.why.length > 0 ? generated.why : input.report.why,
      reviewItems: mergeAIReviewItems(input.report.reviewItems, generated.reviewItems),
      nextRecommendedAction: generated.nextAction || input.report.nextRecommendedAction,
      aiSummary: {
        status: "generated",
        reason: "openai_quality_review",
        source: "openai"
      }
    };
  } catch {
    return markQualityReportAIFallback(input.report, "request_failed");
  }
}

function markQualityReportAIFallback(report: QualityReport, reason: "missing_key" | "request_failed" | "invalid_response"): QualityReport {
  return {
    ...report,
    aiSummary: {
      status: "fallback",
      reason,
      source: "rule-based"
    }
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("OpenAI quality review timed out")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function qualityAISystemPrompt(locale: DevGuardLocale): string {
  return [
    "You are a senior software engineer reviewing the current DevGuard session.",
    "Improve the Quality Report content only. Do not invent problems.",
    "Write as a concise action guide for the user, not as a rule-engine explanation.",
    "Do not expose internal rule names such as scope drift, docs update candidate, runtime candidate, review candidate, or heuristic candidate.",
    "If something is uncertain, say it needs confirmation.",
    `Write user-facing text in ${locale === "ko-KR" ? "natural Korean" : "natural English"}.`,
    "Return strict JSON only with keys: summary, why, nextAction, reviewItems.",
    "summary and why are arrays of short strings.",
    "reviewItems is an array of { title, body, files, checks } where body/files/checks are arrays.",
    "Do not make file count or generic review-needed text the main summary when a concrete change purpose is provided."
  ].join("\n");
}

function qualityAIUserPrompt(input: {
  locale: DevGuardLocale;
  report: QualityReport;
  changedFiles: string[];
  areas: string[];
  judgments: string[];
  summary: string;
  nextTaskTitle: string;
  projectContext: ProjectContextSummary;
  previousHistory: HistoryRecord[];
  previousHandoff: string;
  projectKnowledge: string;
}): string {
  const recent = input.previousHistory.slice(-5).map((record) => ({
    timestamp: record.timestamp,
    files: record.changedFiles.slice(0, 8),
    quality: record.qualityVerdict,
    summary: record.inferredSummary
  }));
  const checklist = input.report.checklist.map((item) => ({
    label: userFacingQualityLabel(item.label),
    status: item.status,
    detail: item.detail
  }));
  return JSON.stringify({
    locale: input.locale,
    sessionGoal: input.nextTaskTitle || "Needs confirmation",
    effectiveTask: input.summary || "Needs confirmation",
    changedFiles: input.changedFiles.map((file) => ({ path: file, purpose: fileRoleDescription(file, input.locale) })),
    seedQualityContext: buildSeedQualityContext(input.changedFiles, input.locale),
    areas: input.areas,
    qualityVerdict: input.report.verdict,
    qualityChecklist: checklist,
    verificationCommands: input.report.requiredVerification,
    currentRuleBasedSummary: input.report.summary,
    currentRuleBasedReasons: input.report.why,
    projectContext: input.projectContext,
    projectKnowledge: input.projectKnowledge,
    handoffSummary: input.previousHandoff.slice(0, 2500),
    recentSessionContext: recent,
    constraints: [
      "Focus only on this change.",
      "Explain what matters, what the user should do now, and why.",
      "Use seedQualityContext as the minimum concrete meaning to preserve.",
      "Do not copy generic verification commands as the main next action unless they are directly relevant.",
      "Do not list files without explaining their role."
    ]
  }, null, 2);
}

function buildSeedQualityContext(changedFiles: string[], locale: DevGuardLocale): string[] {
  if (!isOpenAIKeyUXChange(changedFiles)) return [];
  return locale === "ko-KR"
    ? [
        "이번 변경의 핵심은 OpenAI API Key 설정을 CLI와 Dashboard에 추가한 것입니다.",
        ".devguard/config.json, DEV_GUARD_OPENAI_API_KEY, OPENAI_API_KEY 우선순위를 적용했습니다.",
        "API key raw value는 CLI 출력, Dashboard API, 로그에 노출되면 안 됩니다.",
        "key가 없거나 잘못되었거나 네트워크/timeout이 발생해도 done/status/handoff는 실패하지 않고 rule-based Quality Report와 Handoff를 생성해야 합니다.",
        "Dashboard API는 configured/source만 반환해야 합니다."
      ]
    : [
        "This change adds OpenAI API key setup to the CLI and Dashboard.",
        "Key resolution must prefer .devguard/config.json, then DEV_GUARD_OPENAI_API_KEY, then OPENAI_API_KEY.",
        "Raw API key values must not appear in CLI output, Dashboard API responses, or logs.",
        "When the key is missing, invalid, unavailable, or times out, done/status/handoff must still succeed with rule-based Quality Report and Handoff generation.",
        "Dashboard API should return configured/source only."
      ];
}

function aiReviewMentionsOpenAIKeyFlow(review: AIQualityReview): boolean {
  const text = [
    ...review.summary,
    ...review.why,
    review.nextAction,
    ...review.reviewItems.flatMap((item) => [item.title, ...item.body, ...item.checks])
  ].join("\n").toLowerCase();
  return /openai|api key|apikey|configured\/source|fallback|dashboard/.test(text);
}

interface AIQualityReview {
  summary: string[];
  why: string[];
  nextAction: string;
  reviewItems: QualityReviewItem[];
}

function parseAIQualityReview(text: string): AIQualityReview | null {
  const trimmed = text.trim();
  const jsonText = trimmed.startsWith("{") ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as Partial<AIQualityReview>;
    return {
      summary: stringArray(parsed.summary).slice(0, 4),
      why: stringArray(parsed.why).slice(0, 5),
      nextAction: typeof parsed.nextAction === "string" ? parsed.nextAction.trim() : "",
      reviewItems: Array.isArray(parsed.reviewItems)
        ? parsed.reviewItems.map(normalizeAIReviewItem).filter(Boolean).slice(0, 4) as QualityReviewItem[]
        : []
    };
  } catch {
    return null;
  }
}

function normalizeAIReviewItem(item: unknown): QualityReviewItem | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title) return null;
  return {
    title,
    body: stringArray(record.body).slice(0, 3),
    files: stringArray(record.files).slice(0, 6),
    checks: stringArray(record.checks).slice(0, 4)
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
}

function mergeAIReviewItems(existing: QualityReviewItem[], generated: QualityReviewItem[]): QualityReviewItem[] {
  if (generated.length === 0) return existing;
  return dedupeReviewItems([...generated, ...existing]).slice(0, 5);
}

function userFacingQualityLabel(label: string): string {
  if (label === "generated/runtime files") return "Generated runtime files in source changes";
  if (label === "package lock consistency") return "Package and lockfile consistency";
  if (label === "package manifest changed") return "Package manifest changed";
  if (label === "build verification candidate") return "Build verification availability";
  if (label === "change breadth") return "Change breadth";
  if (label === "risky areas") return "Runtime-sensitive area changed";
  if (label === "CLI router/help verification") return "CLI command and help verification";
  if (label === "watch verification") return "Watch behavior verification";
  if (label === "state/history verification") return "Report, history, and handoff generation verification";
  if (label === "docs update candidate") return "Documentation update need";
  if (label === "drift clarity") return "Change scope clarity";
  return label;
}

function fileRoleDescription(file: string, locale: DevGuardLocale): string {
  const role = inferFileRole(file);
  if (locale !== "ko-KR") return role;
  if (role === "script/dependency config") return "스크립트 또는 의존성 설정";
  if (role === "lockfile/dependency snapshot") return "의존성 잠금 파일";
  if (role === "generated artifacts exclusion") return "생성 산출물 제외 설정";
  if (role === "CLI command router / entrypoint") return "CLI 명령 라우터 또는 진입점";
  if (role === "watch command / file watcher") return "watch 명령 또는 파일 감시";
  if (role === "runtime state / history persistence") return "런타임 상태와 히스토리 저장";
  if (role === "review command / drift analysis") return "리뷰 명령 또는 변경 범위 분석";
  if (role === "docs update preview/write logic") return "문서 업데이트 미리보기 또는 쓰기 로직";
  if (role === "documentation") return "사용자 문서";
  if (role === "test file") return "테스트 파일";
  if (role === "API/server route") return "API 또는 서버 라우트";
  if (role === "UI/component surface") return "UI 또는 컴포넌트 영역";
  if (role === "build/runtime config") return "빌드 또는 런타임 설정";
  return "소스 파일";
}

function buildQualitySummary(input: {
  verdict: QualityVerdict;
  changedFiles: string[];
  areas: string[];
  issueItems: QualityCheckItem[];
  requiredVerification: string[];
}): string[] {
  if (isQualityReportGenerationChange(input.changedFiles)) {
    return [
      "This change turns the generated Quality Report into a QA result document instead of a generic checklist.",
      "The report should explain the verdict, summarize the change, describe what changed per file, and separate completed QA from missing QA.",
      "Because the report generation logic changed, the regenerated markdown must be read directly after `pnpm cli done`.",
      "Build success alone cannot prove the generated QA wording is specific, natural, and free of internal rule labels."
    ];
  }
  if (isOpenAIKeyUXChange(input.changedFiles)) {
    return [
      "This change adds OpenAI API key setup to both the CLI and Dashboard.",
      "DevGuard should resolve keys in this order: .devguard/config.json, DEV_GUARD_OPENAI_API_KEY, then OPENAI_API_KEY.",
      "Raw key values must stay hidden while the Dashboard API reports only configured/source.",
      "If the key is missing, invalid, unavailable, or times out, done/status/handoff should still generate rule-based Quality Report and Handoff files."
    ];
  }
  if (input.verdict === "PASS") {
    return [
      "No blocking quality issues were detected.",
      input.changedFiles.length > 0
        ? `${input.changedFiles.length} changed file(s) are ready for final review after the listed verification commands.`
        : "No source changes are currently pending."
    ];
  }
  const impact = qualityImpactSummary(input.changedFiles, input.areas);
  const issueCount = input.issueItems.length;
  return [
    impact,
    `${input.verdict === "BLOCKED" ? "Completion is blocked" : "Review is recommended"} because ${issueCount} check item(s) need confirmation.`,
    "Use the review items below to confirm the behavior before committing or publishing."
  ];
}

function buildQualityReasons(input: {
  verdict: QualityVerdict;
  changedFiles: string[];
  areas: string[];
  issueItems: QualityCheckItem[];
}): string[] {
  if (input.verdict === "PASS") {
    return ["The change scope is small, verification commands are available, and no blocking local quality rule fired."];
  }
  if (isQualityReportGenerationChange(input.changedFiles)) {
    return [
      "Quality Report generation changed, so the generated markdown itself is the behavior under test.",
      "The report must show what changed, why the verdict was chosen, what QA is complete, and what QA remains.",
      "The implementation should not expose internal analysis labels or replace QA reasoning with generic commands."
    ];
  }
  if (isOpenAIKeyUXChange(input.changedFiles)) {
    return [
      "The change crosses CLI config, Dashboard settings, dashboard API responses, and Quality Report generation.",
      "API key handling is security-sensitive because raw values must never appear in logs, terminal output, dashboard state, or generated reports.",
      "The fallback path matters because DevGuard must remain useful without OpenAI access and must keep generating Quality Report and Handoff files."
    ];
  }
  const reasons = new Set<string>();
  for (const item of input.issueItems) {
    reasons.add(userFacingReason(item, input.changedFiles, input.areas));
  }
  return [...reasons].slice(0, 6);
}

function buildQualityReviewItems(input: {
  changedFiles: string[];
  areas: string[];
  issueItems: QualityCheckItem[];
  requiredVerification: string[];
}): QualityReviewItem[] {
  const items: QualityReviewItem[] = [];
  if (isOpenAIKeyUXChange(input.changedFiles)) {
    items.push(openAIKeyQualityReviewItem(input.changedFiles));
  }
  for (const issue of input.issueItems) {
    items.push(reviewItemForQualityCheck(issue, input.changedFiles, input.areas, input.requiredVerification));
  }
  if (items.length === 0 && input.changedFiles.length > 0) {
    items.push({
      title: "Final behavior check",
      body: ["Review the changed files once and confirm the implementation still matches the user request."],
      files: input.changedFiles.slice(0, 6),
      checks: input.requiredVerification.slice(0, 3)
    });
  }
  return dedupeReviewItems(items).slice(0, 5);
}

function buildQualityNextAction(input: {
  verdict: QualityVerdict;
  changedFiles: string[];
  areas: string[];
  issueItems: QualityCheckItem[];
  requiredVerification: string[];
}): string {
  if (isQualityReportGenerationChange(input.changedFiles)) {
    return "Regenerate the Quality Report, read the generated markdown, and confirm it explains the QA result, changed files, risks, and next QA without generic review wording.";
  }
  if (isOpenAIKeyUXChange(input.changedFiles)) {
    return "Verify that config/env key priority works, raw key values are not exposed, and missing or invalid keys still fall back to rule-based Quality Report and Handoff generation.";
  }
  if (input.verdict === "PASS") {
    return input.changedFiles.length > 0
      ? "Run the listed verification commands, then proceed with final review or commit."
      : "No project changes need review right now.";
  }
  const firstIssue = input.issueItems[0];
  if (firstIssue) {
    const review = reviewItemForQualityCheck(firstIssue, input.changedFiles, input.areas, input.requiredVerification);
    const fileText = review.files.length > 0 ? ` Focus on ${compactFileList(review.files, 3)}.` : "";
    return `${review.body[0]}${fileText} Then run the required verification commands.`;
  }
  return `Run ${input.requiredVerification[0] ?? "the required verification command"}, then review ${devguardPaths.qualityReport}.`;
}

function qualityImpactSummary(changedFiles: string[], areas: string[]): string {
  if (isQualityReportGenerationChange(changedFiles)) {
    return "This change affects how DevGuard explains the current session's QA result in the generated Quality Report.";
  }
  if (isOpenAIKeyUXChange(changedFiles)) {
    return "This change affects OpenAI API key setup, secret handling, Dashboard API state, and Quality Report fallback behavior.";
  }
  if (changedFiles.some((file) => /runtime-state\.ts$/.test(file))) {
    return "This change affects how DevGuard turns local checks into the user-facing Quality Report and handoff guidance.";
  }
  if (changedFiles.some((file) => /locale|dashboard-i18n/i.test(file)) || changedFiles.some((file) => /dashboard/i.test(file) && /config|locale/i.test(changedFiles.join("\n")))) {
    return "This change affects whether Dashboard language choices are reflected in generated reports and handoff files.";
  }
  if (changedFiles.some((file) => /dashboard/i.test(file))) {
    return "This change affects what users see or do in the Dashboard.";
  }
  if (changedFiles.some((file) => /auth|oauth|login|session/i.test(file)) || areas.includes("auth")) {
    return "This change affects the authentication or login flow, so the end-to-end sign-in behavior needs review.";
  }
  if (changedFiles.some((file) => /runtime-state|handoff|prompt|quality/i.test(file))) {
    return "This change affects generated reports, handoff files, or next-session context.";
  }
  if (changedFiles.some((file) => /config|configure|\.devguard|package\.json|tsconfig/i.test(file)) || areas.includes("config")) {
    return "The change can affect configuration or runtime behavior.";
  }
  if (areas.includes("docs")) {
    return "The change affects documentation or user-facing guidance.";
  }
  if (areas.includes("api")) {
    return "The change can affect API behavior or external callers.";
  }
  return "The change should be reviewed against the current user request.";
}

function isOpenAIKeyUXChange(changedFiles: string[]): boolean {
  const text = changedFiles.join("\n");
  const touchesKeyConfig = /packages\/cli\/src\/config\.ts|packages\/cli\/src\/configure\.ts|packages\/core\/src\/types\.ts|packages\/core\/src\/defaults\.ts/.test(text);
  const touchesDashboard = /packages\/cli\/src\/dashboard(?:-i18n)?\.ts/.test(text);
  const touchesQualityFallback = /packages\/cli\/src\/runtime-state\.ts|packages\/cli\/src\/review\.ts|packages\/cli\/src\/task-ai\.ts/.test(text);
  return touchesKeyConfig && (touchesDashboard || touchesQualityFallback);
}

function isQualityReportGenerationChange(changedFiles: string[]): boolean {
  return changedFiles.some((file) => /packages\/cli\/src\/runtime-state\.ts$/.test(file));
}

function openAIKeyQualityReviewItem(changedFiles: string[]): QualityReviewItem {
  const files = changedFiles.filter((file) =>
    /packages\/cli\/src\/config\.ts|packages\/cli\/src\/configure\.ts|packages\/cli\/src\/dashboard(?:-i18n)?\.ts|packages\/cli\/src\/runtime-state\.ts|packages\/cli\/src\/review\.ts|packages\/cli\/src\/task-ai\.ts|packages\/core\/src\/types\.ts|packages\/core\/src\/defaults\.ts|README|docs\//.test(file)
  ).slice(0, 10);
  return {
    title: "OpenAI API key safety and fallback",
    body: [
      "Confirm the CLI and Dashboard can store or report OpenAI key configuration without exposing the raw key value.",
      "Confirm key resolution follows config, DEV_GUARD_OPENAI_API_KEY, then OPENAI_API_KEY.",
      "Confirm missing, invalid, network-failed, or timed-out OpenAI calls still produce rule-based Quality Report and Handoff files."
    ],
    files,
    checks: [
      "pnpm cli config set openaiApiKey <test-key>",
      "pnpm cli done with no OPENAI_API_KEY/DEV_GUARD_OPENAI_API_KEY",
      "Dashboard /api/state exposes configured/source only",
      "Quality Report and Project Handoff are generated after fallback"
    ]
  };
}

function userFacingReason(item: QualityCheckItem, changedFiles: string[], areas: string[]): string {
  const files = relatedFilesForQualityCheck(item, changedFiles);
  const fileText = files.length > 0 ? ` Related file(s): ${compactFileList(files, 4)}.` : "";
  if (item.label === "generated/runtime files") {
    return `DevGuard-generated files appear in the project diff and should not be committed as source changes.${fileText}`;
  }
  if (item.label === "package lock consistency") {
    return `Package metadata changed without a matching lockfile update, so install/publish behavior may be inconsistent.${fileText}`;
  }
  if (item.label === "package manifest changed") {
    return `Package metadata changed. Confirm scripts, dependencies, version, and publish impact before release.${fileText}`;
  }
  if (item.label === "build verification candidate") {
    return `The project has a build script, but the quality flow could not find a build verification command. Add or run the appropriate build check before finishing.${fileText}`;
  }
  if (item.label === "change breadth") {
    return `This session changed ${changedFiles.length} file(s), so review whether the work still belongs to one coherent task.${fileText}`;
  }
  if (item.label === "risky areas") {
    return `The change touches ${areas.join(", ") || "runtime-sensitive"} area(s). Confirm the runtime behavior still matches the intended workflow.${fileText}`;
  }
  if (item.label === "CLI router/help verification") {
    return `CLI routing or help output changed. Verify that documented commands, help text, and status output still match the implementation.${fileText}`;
  }
  if (item.label === "watch verification") {
    return `Watch behavior changed. Verify polling, depth handling, and settle/finalize output with a small file-change scenario.${fileText}`;
  }
  if (item.label === "state/history verification") {
    if (changedFiles.some((file) => /runtime-state\.ts$/.test(file))) {
      return `Quality Report generation changed. Confirm the regenerated report reads like a QA result, explains each relevant file role, and does not expose internal rule names.${fileText}`;
    }
    return `State, history, prompt, or report generation changed. Confirm done/status/handoff regenerate the expected files without stale state.${fileText}`;
  }
  if (item.label === "docs update candidate") {
    return `Source files changed without documentation changes. If user-facing behavior changed, update the relevant README or docs page.${fileText}`;
  }
  if (item.label === "drift clarity") {
    return `The changed files should be checked against the current task. Confirm the diff is limited to Quality Report QA wording and generation behavior.${fileText}`;
  }
  return `${item.detail}${fileText}`;
}

function reviewItemForQualityCheck(item: QualityCheckItem, changedFiles: string[], areas: string[], requiredVerification: string[]): QualityReviewItem {
  const files = relatedFilesForQualityCheck(item, changedFiles);
  if (item.label === "generated/runtime files") {
    return {
      title: "Generated file commit check",
      body: ["Confirm DevGuard runtime artifacts are not included as source changes."],
      files,
      checks: ["Run git status and keep .devguard runtime outputs out of the commit."]
    };
  }
  if (item.label === "package lock consistency" || item.label === "package manifest changed") {
    return {
      title: "Package and release impact",
      body: ["Confirm package scripts, dependencies, versions, and lockfile state match the intended release impact."],
      files,
      checks: requiredVerification.slice(0, 3)
    };
  }
  if (item.label === "CLI router/help verification") {
    return {
      title: "CLI command and help consistency",
      body: ["Confirm changed CLI routing or output still matches README/docs and the commands users will run."],
      files,
      checks: ["pnpm cli --help", "pnpm cli help advanced", "pnpm cli status"]
    };
  }
  if (item.label === "watch verification") {
    return {
      title: "Watch behavior check",
      body: ["Confirm watch still tracks real project changes and ignores DevGuard internal files."],
      files,
      checks: ["pnpm cli watch --stable-after 1 --compact", "pnpm cli done", "pnpm cli status"]
    };
  }
  if (item.label === "state/history verification") {
    if (changedFiles.some((file) => /runtime-state\.ts$/.test(file))) {
      return {
        title: "Quality Report output review",
        body: ["Regenerate the Quality Report and confirm it reads like a QA result: verdict, change summary, file-level changes, completed QA, missing QA, risks, and next QA."],
        files,
        checks: ["pnpm cli done", "Read .devguard/reports/quality-report.md", "Confirm no internal rule names or generic review-only phrases appear in the main sections."]
      };
    }
    return {
      title: "Report and handoff regeneration",
      body: ["Confirm done/status/handoff read the latest runtime state and regenerate user-facing reports correctly."],
      files,
      checks: ["pnpm cli done", "pnpm cli status", "pnpm cli handoff"]
    };
  }
  if (item.label === "risky areas") {
    return {
      title: "Runtime-sensitive behavior",
      body: [`Confirm the ${areas.join(", ") || "changed"} area(s) still behave as intended in the actual workflow.`],
      files,
      checks: requiredVerification.slice(0, 4)
    };
  }
  if (item.label === "change breadth") {
    return {
      title: "Change breadth review",
      body: ["Confirm the changed files still belong to one coherent task and split unrelated work if needed."],
      files,
      checks: requiredVerification.slice(0, 3)
    };
  }
  if (item.label === "docs update candidate") {
    return {
      title: "Documentation update need",
      body: ["Check whether changed source behavior affects commands, Dashboard text, configuration, hooks, reports, or generated files that users read."],
      files,
      checks: ["If behavior changed, update README.md, README.ko.md, docs/commands.md, or docs/configuration.md as appropriate."]
    };
  }
  if (item.label === "drift clarity") {
    return {
      title: "Change scope check",
      body: ["Confirm the diff is focused on Quality Report QA wording and generation behavior without changing Dashboard, Handoff, watch, hook, or release behavior."],
      files,
      checks: ["Review git diff by file.", "Keep only changes required for the current task."]
    };
  }
  return {
    title: item.label,
    body: [item.detail],
    files,
    checks: requiredVerification.slice(0, 3)
  };
}

function relatedQualityFiles(changedFiles: string[], issueItems: QualityCheckItem[], reviewItems: QualityReviewItem[] = []): string[] {
  const files = new Set<string>();
  for (const item of reviewItems) {
    for (const file of item.files) files.add(file);
  }
  for (const item of issueItems) {
    for (const file of relatedFilesForQualityCheck(item, changedFiles)) files.add(file);
  }
  if (files.size === 0) for (const file of changedFiles.slice(0, 8)) files.add(file);
  return [...files].slice(0, 10);
}

function relatedFilesForQualityCheck(item: QualityCheckItem, changedFiles: string[]): string[] {
  if (item.label === "generated/runtime files") return changedFiles.filter(isGeneratedRuntimePath);
  if (item.label === "package lock consistency" || item.label === "package manifest changed") {
    return changedFiles.filter((file) => /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/.test(file));
  }
  if (item.label === "CLI router/help verification") return changedFiles.filter((file) => /packages\/cli\/src\/index\.tsx?$|docs\/commands|README/i.test(file));
  if (item.label === "watch verification") return changedFiles.filter((file) => /watch\.[tj]sx?$|docs\/watch|README/i.test(file));
  if (item.label === "state/history verification") return changedFiles.filter((file) => /(runtime-state|history|state|prompt)\.[tj]sx?$|handoff|quality|README|docs\//i.test(file));
  if (item.label === "risky areas") return changedFiles.filter((file) => /config|configure|\.devguard|package\.json|tsconfig|api|auth|database/i.test(file)).slice(0, 8);
  if (item.label === "docs update candidate") return changedFiles.filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)).slice(0, 8);
  if (item.label === "drift clarity") return changedFiles.slice(0, 8);
  return changedFiles.slice(0, 6);
}

function dedupeReviewItems(items: QualityReviewItem[]): QualityReviewItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const reportCopy = {
  "en-US": {
    title: "Completion Quality Report",
    qaSnapshot: "1. QA Summary",
    finalVerdict: "2. Final Verdict",
    qaSummary: "3. QA Result Summary",
    impact: "4. Impact",
    changed: "5. What Changed",
    qaResult: "6. QA Checklist",
    regressionRisk: "7. Regression Risk",
    why: "8. Why This Verdict",
    nextQa: "9. Next QA",
    aiSummary: "AI Summary",
    riskChecklist: "Risk Checklist",
    beforeCommit: "Before Commit",
    nextRecommendedAction: "Next Recommended Action",
    noItems: "none"
  },
  "ko-KR": {
    title: "완료 품질 보고서",
    qaSnapshot: "1. QA Summary",
    finalVerdict: "2. 최종 판정",
    qaSummary: "3. QA 결과 요약",
    impact: "4. 변경 영향",
    changed: "5. 이번 변경 내용",
    qaResult: "6. QA Checklist",
    regressionRisk: "7. 잠재 회귀 위험",
    why: "8. 왜 이 판정이 나왔는가",
    nextQa: "9. 다음 QA",
    aiSummary: "AI 요약",
    riskChecklist: "위험 점검표",
    beforeCommit: "커밋 전 확인",
    nextRecommendedAction: "다음으로 진행하면 좋은 작업",
    noItems: "없음"
  }
} as const;

const handoffCopy = {
  "en-US": {
    title: "Project Handoff",
    Goal: "1. Current Work Goal",
    Changed: "2. What Changed This Session",
    Quality: "3. Quality State And Reason",
    Outstanding: "4. Remaining Review Items",
    Next: "5. Next Task",
    Verification: "6. Verification Run",
    ResumePrompt: "7. Resume Prompt",
    Project: "Project",
    Decisions: "Decisions",
    Workflow: "Workflow",
    Missing: "Missing",
    HandoffQuality: "Handoff Quality",
    noExecutedVerification: "No external verification result is recorded in DevGuard artifacts. Do not mark commands as passed until they are run in the next session."
  },
  "ko-KR": {
    title: "프로젝트 인수인계",
    Goal: "1. 현재 작업 목표",
    Changed: "2. 이번 세션에서 변경된 내용",
    Quality: "3. 품질 상태와 판단 이유",
    Outstanding: "4. 남아 있는 검토 항목",
    Next: "5. 다음 작업",
    Verification: "6. 실행한 검증",
    ResumePrompt: "7. 재개 프롬프트",
    Project: "프로젝트 정보",
    Decisions: "중요한 결정",
    Workflow: "작업 방식",
    Missing: "확인이 필요한 입력",
    HandoffQuality: "인수인계 품질",
    noExecutedVerification: "DevGuard 산출물에는 외부 검증 명령의 실행 결과가 기록되어 있지 않습니다. 다음 세션에서 직접 실행하기 전에는 pass로 표시하지 마세요."
  }
} as const;

function renderQualityReport(report: QualityReport, locale: DevGuardLocale): string {
  if (report.verdict === "PASS") return renderPassQualityReport(report, locale);
  if (report.verdict === "BLOCKED") return renderBlockedQualityReport(report, locale);
  return renderNeedsReviewQualityReport(report, locale);
}

function renderPassQualityReport(report: QualityReport, locale: DevGuardLocale): string {
  const copy = reportCopy[locale];
  const aiNote = formatAIQualityNote(report, locale);
  return [
    `# ${copy.title}`,
    "",
    `## ${copy.qaSnapshot}`,
    "",
    ...formatQASnapshot(report, locale),
    "",
    `## ${copy.finalVerdict}`,
    "",
    ...formatFinalVerdict(report, locale),
    "",
    `## ${copy.qaSummary}`,
    "",
    ...formatQASummary(report, locale),
    "",
    `## ${copy.impact}`,
    "",
    ...formatQualityImpact(report, locale),
    "",
    `## ${copy.changed}`,
    "",
    ...formatQualityChangedFiles(report, locale),
    "",
    `## ${copy.qaResult}`,
    "",
    ...formatQAResults(report, locale),
    "",
    `## ${copy.regressionRisk}`,
    "",
    ...formatRegressionRisk(report, locale),
    "",
    `## ${copy.why}`,
    "",
    ...formatQualityVerdictReasons(report, locale),
    "",
    `## ${copy.nextQa}`,
    "",
    ...formatNextQAActions(report, [], locale),
    ...(aiNote.length > 0 ? ["", `## ${copy.aiSummary}`, "", ...aiNote] : [])
  ].join("\n") + "\n";
}

function renderNeedsReviewQualityReport(report: QualityReport, locale: DevGuardLocale): string {
  const copy = reportCopy[locale];
  const blocked = report.checklist.filter((item) => item.status === "BLOCKED");
  const blockedReviewItems = report.reviewItems.filter((item) => blocked.some((blockedItem) => reviewItemMatchesQualityItem(item, blockedItem)));
  const warningReviewItems = report.reviewItems.filter((item) => !blockedReviewItems.includes(item));
  return [
    `# ${copy.title}`,
    "",
    `## ${copy.qaSnapshot}`,
    "",
    ...formatQASnapshot(report, locale),
    "",
    `## ${copy.finalVerdict}`,
    "",
    ...formatFinalVerdict(report, locale),
    "",
    `## ${copy.qaSummary}`,
    "",
    ...formatQASummary(report, locale),
    "",
    `## ${copy.impact}`,
    "",
    ...formatQualityImpact(report, locale),
    "",
    `## ${copy.changed}`,
    "",
    ...formatQualityChangedFiles(report, locale),
    "",
    `## ${copy.qaResult}`,
    "",
    ...formatQAResults(report, locale),
    "",
    `## ${copy.regressionRisk}`,
    "",
    ...formatRegressionRisk(report, locale),
    "",
    `## ${copy.why}`,
    "",
    ...formatQualityVerdictReasons(report, locale),
    "",
    `## ${copy.nextQa}`,
    "",
    ...formatNextQAActions(report, warningReviewItems, locale),
    ...formatAIQualitySection(report, locale),
  ].join("\n") + "\n";
}

function renderBlockedQualityReport(report: QualityReport, locale: DevGuardLocale): string {
  const copy = reportCopy[locale];
  const blocked = report.checklist.filter((item) => item.status === "BLOCKED");
  const blockedReviewItems = report.reviewItems.filter((item) => blocked.some((blockedItem) => reviewItemMatchesQualityItem(item, blockedItem)));
  const warningReviewItems = report.reviewItems.filter((item) => !blockedReviewItems.includes(item));
  return [
    `# ${copy.title}`,
    "",
    `## ${copy.qaSnapshot}`,
    "",
    ...formatQASnapshot(report, locale),
    "",
    `## ${copy.finalVerdict}`,
    "",
    ...formatFinalVerdict(report, locale),
    "",
    `## ${copy.qaSummary}`,
    "",
    ...formatQASummary(report, locale),
    "",
    `## ${copy.impact}`,
    "",
    ...formatQualityImpact(report, locale),
    "",
    `## ${copy.changed}`,
    "",
    ...formatQualityChangedFiles(report, locale),
    "",
    `## ${copy.qaResult}`,
    "",
    ...formatQAResults(report, locale),
    "",
    `## ${copy.regressionRisk}`,
    "",
    ...formatRegressionRisk(report, locale),
    "",
    `## ${copy.why}`,
    "",
    ...formatQualityVerdictReasons(report, locale),
    "",
    `## ${copy.nextQa}`,
    "",
    ...formatNextQAActions(report, [...blockedReviewItems, ...warningReviewItems], locale),
    ...formatAIQualitySection(report, locale),
  ].join("\n") + "\n";
}

function formatAIQualitySection(report: QualityReport, locale: DevGuardLocale): string[] {
  const note = formatAIQualityNote(report, locale);
  return note.length > 0 ? ["", `## ${reportCopy[locale].aiSummary}`, "", ...note] : [];
}

function formatQASnapshot(report: QualityReport, locale: DevGuardLocale): string[] {
  const overall = report.verdict === "PASS" ? "🟢 PASS" : report.verdict === "BLOCKED" ? "🔴 BLOCKED" : "🟡 NEEDS_REVIEW";
  const buildStatus = qaCommandStatus(report, /\bbuild\b/i, locale);
  const selfCheckStatus = qaCommandStatus(report, /self-check/i, locale);
  const manualStatus = manualQAStatus(report, locale);
  const regression = regressionRiskLevel(report, locale);
  const labels = locale === "ko-KR"
    ? { overall: "Overall", build: "Build", self: "Self Check", manual: "Manual QA", regression: "Regression Risk" }
    : { overall: "Overall", build: "Build", self: "Self Check", manual: "Manual QA", regression: "Regression Risk" };
  return [
    `| ${locale === "ko-KR" ? "항목" : "Item"} | ${locale === "ko-KR" ? "상태" : "Status"} |`,
    "| --- | --- |",
    `| ${labels.overall} | ${overall} |`,
    `| ${labels.build} | ${buildStatus} |`,
    `| ${labels.self} | ${selfCheckStatus} |`,
    `| ${labels.manual} | ${manualStatus} |`,
    `| ${labels.regression} | ${regression} |`
  ];
}

function qaCommandStatus(report: QualityReport, pattern: RegExp, locale: DevGuardLocale): string {
  const command = report.requiredVerification.find((item) => pattern.test(item));
  if (!command) return locale === "ko-KR" ? "미기록" : "Not recorded";
  return locale === "ko-KR" ? `미기록 (${command})` : `Not recorded (${command})`;
}

function manualQAStatus(report: QualityReport, locale: DevGuardLocale): string {
  if (report.verdict === "PASS") return locale === "ko-KR" ? "현재 규칙상 추가 요구 없음" : "Not required by current rules";
  return locale === "ko-KR" ? "대기" : "Pending";
}

function formatFinalVerdict(report: QualityReport, locale: DevGuardLocale): string[] {
  const icon = report.verdict === "PASS" ? "🟢" : report.verdict === "BLOCKED" ? "🔴" : "🟡";
  const summary = verdictOneLine(report, locale);
  return [`${icon} ${report.verdict}`, "", summary];
}

function verdictOneLine(report: QualityReport, locale: DevGuardLocale): string {
  if (locale === "ko-KR") {
    if (report.verdict === "PASS") return "현재 품질 규칙에서 차단 항목이 발견되지 않았고, 추가 QA 요구가 없습니다.";
    if (report.verdict === "BLOCKED") return "완료를 막는 항목이 있어 먼저 수정해야 합니다.";
    return "자동 품질 규칙은 실행됐지만 생성물 또는 실제 동작 확인이 남아 있습니다.";
  }
  if (report.verdict === "PASS") return "No blocking item was found by the current quality rules.";
  if (report.verdict === "BLOCKED") return "A blocking item must be fixed before this can be considered complete.";
  return "Local checks ran, but generated output or runtime behavior still needs direct QA.";
}

function formatQASummary(report: QualityReport, locale: DevGuardLocale): string[] {
  const lines = report.summary.map(sanitizeQualitySentence).filter(isUsefulQualityLine).slice(0, 5);
  if (lines.length === 0) {
    return locale === "ko-KR"
      ? ["이번 변경의 의미를 자동으로 충분히 요약하지 못했습니다.", "아래 변경 파일과 QA 결과를 기준으로 실제 동작을 확인해야 합니다."]
      : ["DevGuard could not produce a detailed change summary automatically.", "Use the changed files and QA result sections below to verify behavior."];
  }
  return lines.map((line) => localizeSentence(line, locale));
}

function formatQualityImpact(report: QualityReport, locale: DevGuardLocale): string[] {
  const files = new Set(report.relatedFiles);
  const affected = new Set<string>();
  const notAffected = new Set<string>(["Watch", "Hooks", "Release"]);
  if ([...files].some((file) => /runtime-state\.ts$/.test(file))) {
    affected.add("Quality Report");
    affected.add("Generated reports");
    notAffected.add("Dashboard");
    notAffected.add("Hooks");
    notAffected.add("Watch");
  }
  if ([...files].some((file) => /dashboard/i.test(file))) affected.add("Dashboard");
  if ([...files].some((file) => /locale|dashboard-i18n/i.test(file))) affected.add("Locale");
  if ([...files].some((file) => /handoff|prompt/i.test(file))) affected.add("Handoff");
  if ([...files].some((file) => /index\.tsx?$|configure|config/i.test(file))) affected.add("CLI");
  if (affected.size === 0) affected.add(locale === "ko-KR" ? "확인 필요" : "Needs confirmation");
  for (const item of affected) notAffected.delete(item);
  const lines = locale === "ko-KR" ? ["영향 있음"] : ["Affected"];
  for (const item of affected) lines.push(`- ${item}`);
  lines.push("");
  lines.push(locale === "ko-KR" ? "영향 없음 또는 변경 없음" : "No direct change detected");
  for (const item of [...notAffected].slice(0, 6)) lines.push(`- ${item}`);
  return lines;
}

function formatQualityChangedFiles(report: QualityReport, locale: DevGuardLocale): string[] {
  const files = report.relatedFiles.length > 0 ? report.relatedFiles : report.reviewItems.flatMap((item) => item.files);
  const unique = [...new Set(files)].slice(0, 10);
  if (unique.length === 0) {
    return [locale === "ko-KR" ? "- 변경 파일 없음" : "- No changed files recorded."];
  }
  const lines: string[] = [];
  for (const file of unique) {
    lines.push(`- \`${file}\``);
    lines.push(`  - ${locale === "ko-KR" ? "무엇을 변경했는가" : "What changed"}: ${qualityFileChangeDescription(file, locale)}`);
    lines.push(`  - ${locale === "ko-KR" ? "왜 변경했는가" : "Why it changed"}: ${qualityFileReason(file, report, locale)}`);
  }
  return lines;
}

function qualityFileChangeDescription(file: string, locale: DevGuardLocale): string {
  if (/runtime-state\.ts$/.test(file)) {
    return locale === "ko-KR"
      ? "Quality Report의 판정, QA 요약, 변경 파일 설명, 다음 QA 문구를 생성하는 흐름을 조정합니다."
      : "Adjusts the flow that generates Quality Report verdicts, QA summaries, file explanations, and next-QA guidance.";
  }
  if (/dashboard\.ts$/.test(file)) {
    return locale === "ko-KR"
      ? "Dashboard 표시나 사용자 상호작용 동작을 조정합니다."
      : "Adjusts Dashboard display or user interaction behavior.";
  }
  if (/dashboard-i18n\.ts$/.test(file)) {
    return locale === "ko-KR" ? "Dashboard의 사용자-facing 문구와 번역을 조정합니다." : "Adjusts Dashboard user-facing copy and translations.";
  }
  if (/README|docs\//i.test(file)) return locale === "ko-KR" ? "사용자 문서와 명령 안내를 조정합니다." : "Adjusts user documentation and command guidance.";
  if (/package\.json|pnpm-lock\.yaml/i.test(file)) return locale === "ko-KR" ? "패키지 설정이나 의존성 상태를 조정합니다." : "Adjusts package metadata or dependency state.";
  return locale === "ko-KR" ? "변경 내용 확인 필요" : "Change detail needs confirmation";
}

function qualityFileReason(file: string, report: QualityReport, locale: DevGuardLocale): string {
  if (/runtime-state\.ts$/.test(file)) {
    return locale === "ko-KR"
      ? "생성되는 Quality Report가 단순 체크리스트가 아니라 이번 변경의 QA 결과를 설명하도록 하기 위해 변경되었습니다."
      : "Changed so generated Quality Reports explain the QA result for this session instead of acting like a generic checklist.";
  }
  const item = report.reviewItems.find((reviewItem) => reviewItem.files.includes(file));
  if (item?.body[0]) return localizeSentence(sanitizeQualitySentence(item.body[0]), locale);
  if (report.verdict === "NEEDS_REVIEW") return locale === "ko-KR" ? "이 파일이 현재 검토 대상에 포함되어 있어 실제 영향 확인이 필요합니다." : "This file is part of the current review surface and needs impact verification.";
  return locale === "ko-KR" ? "현재 변경 범위에 포함된 파일입니다." : "This file is part of the current change scope.";
}

function formatQAResults(report: QualityReport, locale: DevGuardLocale): string[] {
  const passed = report.checklist.filter((item) => item.status === "PASS" && item.affectsVerdict !== false);
  const blocked = report.checklist.filter((item) => item.status === "BLOCKED");
  const warnings = report.checklist.filter((item) => item.status === "WARN");
  const lines: string[] = [];
  lines.push(locale === "ko-KR" ? "✅ 확인 완료" : "✅ Completed");
  if (passed.length > 0) {
    for (const item of passed.slice(0, 5)) lines.push(`- ${qualityCheckOutcome(item, locale)}`);
  } else {
    lines.push(locale === "ko-KR" ? "- 완료로 기록된 품질 항목이 없습니다." : "- No quality item is recorded as completed.");
  }
  lines.push("");
  lines.push(locale === "ko-KR" ? "⚠ 추가 확인 필요" : "⚠ Needs Additional QA");
  const pending = [...blocked, ...warnings];
  if (pending.length > 0) {
    for (const item of pending.slice(0, 6)) lines.push(`- ${qualityCheckOutcome(item, locale)}`);
  } else {
    lines.push(locale === "ko-KR" ? "- 추가 확인이 필요한 품질 항목은 없습니다." : "- No additional quality item needs review.");
  }
  lines.push(...unrecordedVerificationLines(report.requiredVerification, locale));
  return lines;
}

function qualityCheckOutcome(item: QualityCheckItem, locale: DevGuardLocale): string {
  const label = qualityLabel(item.label, locale);
  const detail = qualityDetail(item, locale);
  if (locale === "ko-KR") {
    if (item.status === "PASS") return `${label}: ${detail}`;
    if (item.status === "BLOCKED") return `${label}: 완료를 막는 항목입니다. ${detail}`;
    return `${label}: 추가 확인이 필요합니다. ${detail}`;
  }
  if (item.status === "PASS") return `${label}: ${detail}`;
  if (item.status === "BLOCKED") return `${label}: blocking item. ${detail}`;
  return `${label}: needs additional QA. ${detail}`;
}

function unrecordedVerificationLines(commands: string[], locale: DevGuardLocale): string[] {
  if (commands.length === 0) return [];
  return commands.slice(0, 5).map((command) =>
    locale === "ko-KR"
      ? `- 실행 결과 미기록: \`${command}\`는 Quality Report 생성 시점에 통과 여부가 기록되어 있지 않습니다.`
      : `- Not recorded: \`${command}\` has no pass/fail result recorded at Quality Report generation time.`
  );
}

function formatRegressionRisk(report: QualityReport, locale: DevGuardLocale): string[] {
  const risks = report.checklist.filter((item) => item.status !== "PASS" && item.affectsVerdict !== false);
  if (risks.length === 0) {
    return locale === "ko-KR"
      ? ["Regression Risk: None", "", "현재 품질 규칙에서 회귀 위험을 높이는 항목은 발견되지 않았습니다."]
      : ["Regression Risk: None", "", "No current quality rule increased regression risk."];
  }
  const level = regressionRiskLevel(report, locale);
  const lines = [locale === "ko-KR" ? `Regression Risk: ${level}` : `Regression Risk: ${level}`, ""];
  lines.push(locale === "ko-KR" ? "잠재 영향" : "Potential impact");
  for (const item of risks.slice(0, 4)) {
    const reason = userFacingReason(item, report.relatedFiles, []);
    lines.push(`- ${localizeSentence(sanitizeQualitySentence(reason), locale)}`);
  }
  return lines;
}

function regressionRiskLevel(report: QualityReport, locale: DevGuardLocale): string {
  if (report.verdict === "BLOCKED") return "High";
  const warnings = report.checklist.filter((item) => item.status === "WARN" && item.affectsVerdict !== false);
  if (warnings.some((item) => /risky areas|package|CLI|watch/i.test(item.label))) return "Medium";
  if (warnings.length > 0) return "Low";
  return "None";
}

function formatQualityVerdictReasons(report: QualityReport, locale: DevGuardLocale): string[] {
  const reasons = report.why.map(sanitizeQualitySentence).filter(isUsefulQualityLine).slice(0, 5);
  if (reasons.length > 0) return reasons.map((reason) => `- ${localizeSentence(reason, locale)}`);
  if (report.verdict === "PASS") {
    return [locale === "ko-KR" ? "- 차단 항목이 없고 현재 품질 규칙에서 추가 QA가 요구되지 않습니다." : "- No blocking item was found and the current quality rules do not require more QA."];
  }
  if (report.verdict === "BLOCKED") {
    return [locale === "ko-KR" ? "- 완료를 막는 항목이 있어 먼저 수정해야 합니다." : "- A blocking item exists and must be fixed first."];
  }
  return [locale === "ko-KR" ? "- 자동 점검만으로 충분하지 않아 실제 생성물 또는 동작 확인이 필요합니다." : "- Automated checks are not enough; generated output or runtime behavior needs direct QA."];
}

function formatNextQAActions(report: QualityReport, items: QualityReviewItem[], locale: DevGuardLocale): string[] {
  const primaryItems = items.length > 0 ? items : report.reviewItems;
  const actions: string[] = [];
  const first = primaryItems[0];
  if (first) {
    actions.push(`1. ${localizeReviewTitle(first.title, locale)}: ${localizeSentence(sanitizeQualitySentence(first.body[0] ?? report.nextRecommendedAction), locale)}`);
    const files = first.files.length > 0 ? first.files : report.relatedFiles;
    if (files.length > 0) {
      actions.push(`2. ${locale === "ko-KR" ? `${compactFileList(files, 3)}에서 위 QA 기준이 실제 변경과 맞는지 확인합니다.` : `Check ${compactFileList(files, 3)} against the QA criterion above.`}`);
    }
  } else {
    actions.push(`1. ${localizeSentence(sanitizeQualitySentence(report.nextRecommendedAction), locale)}`);
  }
  const commands = report.requiredVerification.slice(0, 4);
  const start = actions.length + 1;
  commands.forEach((command, index) => {
    actions.push(`${start + index}. ${locale === "ko-KR" ? `${formatCommandObject(command)} 실행 결과를 이 보고서의 QA 상태와 비교합니다.` : `Run \`${command}\` and compare the result with this QA status.`}`);
  });
  if (report.verdict !== "PASS") {
    actions.push(`${actions.length + 1}. ${locale === "ko-KR" ? "필요한 QA가 끝나면 `pnpm cli done`으로 보고서를 다시 생성해 판정이 바뀌는지 확인합니다." : "After QA is complete, run `pnpm cli done` again and confirm whether the verdict changes."}`);
  }
  return actions.slice(0, 7);
}

function sanitizeQualitySentence(value: string): string {
  return humanizeInternalSentence(value)
    .replace(/INTENT:\s*[^;\n]+;?\s*/gi, "")
    .replace(/SCOPE:\s*[^;\n]+;?\s*/gi, "")
    .replace(/confidence=\w+;?\s*/gi, "")
    .replace(/FLAGS:\s*[^;\n]+;?\s*/gi, "")
    .replace(/DRIFT:\s*\w+;?\s*/gi, "")
    .replace(/scope drift|docs update candidate|runtime candidate|review candidate|heuristic candidate/gi, "")
    .replace(/related file\(s\):/gi, "관련 파일:")
    .replace(/files:/gi, "관련 파일:")
    .replace(/\s{2,}/g, " ")
    .replace(/^[;,\s-]+|[;,\s-]+$/g, "");
}

function formatCommandObject(command: string): string {
  return `\`${command}\``;
}

function isUsefulQualityLine(value: string): boolean {
  const clean = value.trim();
  return clean.length > 0 && !/^(none|없음|확인 필요)$/i.test(clean) && !/^(INTENT|SCOPE|DRIFT):/i.test(clean);
}

function formatAIQualityNote(report: QualityReport, locale: DevGuardLocale): string[] {
  if (!report.aiSummary) return [];
  if (report.aiSummary.status === "generated") {
    return [
      locale === "ko-KR"
        ? "- OpenAI 기반 검토 요약을 반영했습니다."
        : "- OpenAI-assisted review summary was applied."
    ];
  }
  if (report.aiSummary.reason === "missing_key") {
    return [
      locale === "ko-KR"
        ? "- AI 기반 요약은 생성하지 않았습니다. OpenAI API Key가 설정되어 있지 않아 기본 품질 규칙으로 보고서를 생성했습니다."
        : "- AI summary was not generated. No OpenAI API key is configured, so this report was created with local quality rules."
    ];
  }
  return [
    locale === "ko-KR"
      ? "- AI 기반 요약을 사용할 수 없어 기본 품질 규칙으로 보고서를 생성했습니다."
      : "- AI summary was unavailable, so this report was created with local quality rules."
  ];
}

function formatActionSteps(report: QualityReport, items: QualityReviewItem[], locale: DevGuardLocale): string[] {
  const primary = items[0];
  if (!primary) return [`1. ${localizeSentence(report.nextRecommendedAction, locale)}`];
  const steps: string[] = [];
  steps.push(`1. ${localizeReviewTitle(primary.title, locale)}`);
  if (primary.files.length > 0) {
    const files = compactFileList(primary.files, 3);
    steps.push(`2. ${locale === "ko-KR" ? `\`${files}\`에서 변경 이유와 검토 기준을 확인합니다.` : `Confirm the change reason and review criteria in \`${files}\`.`}`);
  }
  const primaryCheck = primary.checks.find((check) => /^pnpm|^npm|^yarn/.test(check)) ?? report.requiredVerification[0];
  if (primaryCheck) {
    steps.push(`${steps.length + 1}. ${locale === "ko-KR" ? "검증 실행" : "Run verification"}: ${primaryCheck}`);
  }
  steps.push(`${steps.length + 1}. ${locale === "ko-KR" ? "보고서 첫 화면이 변경 의미와 다음 행동을 바로 안내하는지 확인" : "Confirm the report starts with the change meaning and next action"}`);
  return steps;
}

function formatReviewQuestions(items: QualityReviewItem[], locale: DevGuardLocale): string[] {
  if (items.length === 0) return [`- ${reportCopy[locale].noItems}`];
  return items.map((item) => `- ${reviewQuestion(item, locale)}`);
}

function reviewQuestion(item: QualityReviewItem, locale: DevGuardLocale): string {
  const title = localizeReviewTitle(item.title, locale);
  const fileText = item.files.length > 0 ? ` (${compactFileList(item.files, 3)})` : "";
  if (locale === "ko-KR") {
    if (item.title === "Quality Report output review") return `Quality Report가 첫 화면에서 변경 의미와 다음 행동을 바로 알려주는가?${fileText}`;
    if (item.title === "OpenAI API key safety and fallback") return `API Key가 없어도 done/status/handoff가 실패하지 않고, Dashboard API가 raw value 없이 configured/source만 반환하는가?${fileText}`;
    if (item.title === "Report and handoff regeneration") return `done/status/handoff 실행 후 사용자용 보고서가 최신 상태로 재생성되는가?${fileText}`;
    if (item.title === "Change scope check") return `이번 변경이 Quality Report intelligence 개선에만 집중되어 있는가?${fileText}`;
    if (item.title === "Change breadth review") return `변경 파일이 하나의 작업 목표로 설명되는가?${fileText}`;
    if (item.title === "Runtime-sensitive behavior") return `설정과 런타임 흐름이 실제 사용 방식과 일치하는가?${fileText}`;
    if (item.title === "Documentation update need") return `사용자-facing 동작이 바뀌었다면 README 또는 docs 설명도 맞게 갱신되었는가?${fileText}`;
    if (item.title === "CLI command and help consistency") return `CLI help/status 출력이 문서와 일치하는가?${fileText}`;
    return `${title} 항목을 검토했는가?${fileText}`;
  }
  if (item.title === "Report and handoff regeneration") return `Do done/status/handoff regenerate the latest user-facing reports?${fileText}`;
  if (item.title === "OpenAI API key safety and fallback") return `Do missing or invalid API keys fall back safely without exposing raw values?${fileText}`;
  if (item.title === "Quality Report output review") return `Does the Quality Report immediately tell the user what changed and what to do next?${fileText}`;
  if (item.title === "Change scope check") return `Is this diff focused only on Quality Report intelligence?${fileText}`;
  if (item.title === "Change breadth review") return `Do the changed files still belong to one coherent task?${fileText}`;
  if (item.title === "Runtime-sensitive behavior") return `Does the configuration and runtime flow still match actual use?${fileText}`;
  if (item.title === "Documentation update need") return `If user-facing behavior changed, do README/docs match it?${fileText}`;
  if (item.title === "CLI command and help consistency") return `Do CLI help/status output and docs still match?${fileText}`;
  return `Has ${title} been checked?${fileText}`;
}

function formatRelatedFiles(files: string[], reviewItems: QualityReviewItem[], locale: DevGuardLocale): string[] {
  if (files.length === 0) return [`- ${reportCopy[locale].noItems}`];
  return files.slice(0, 10).map((file) => {
    const role = relatedFileRole(file, reviewItems, locale);
    return `- ${file}${role ? ` ${locale === "ko-KR" ? "→" : "-"} ${role}` : ""}`;
  });
}

function relatedFileRole(file: string, reviewItems: QualityReviewItem[], locale: DevGuardLocale): string {
  if (/runtime-state\.ts$/.test(file)) {
    return locale === "ko-KR" ? "Quality Report 판단 문장, 실행 안내, handoff 파싱 로직" : "Quality Report review copy, action guidance, and handoff parsing logic";
  }
  if (/dashboard/i.test(file)) {
    return locale === "ko-KR" ? "Dashboard 표시와 사용자 상호작용" : "Dashboard display and user interaction";
  }
  if (/configure|config/i.test(file)) {
    return locale === "ko-KR" ? "설정 저장과 CLI 설정 흐름" : "Configuration persistence and CLI config flow";
  }
  if (/README|docs\//i.test(file)) {
    return locale === "ko-KR" ? "사용자 문서와 명령 설명" : "User documentation and command guidance";
  }
  const item = reviewItems.find((reviewItem) => reviewItem.files.includes(file));
  return item ? localizeReviewTitle(item.title, locale) : "";
}

function reviewItemMatchesQualityItem(reviewItem: QualityReviewItem, item: QualityCheckItem): boolean {
  const title = reviewItem.title.toLowerCase();
  if (item.label === "generated/runtime files") return title.includes("generated") || title.includes("생성");
  if (item.label === "package lock consistency" || item.label === "package manifest changed") return title.includes("package") || title.includes("패키지");
  if (item.label === "CLI router/help verification") return title.includes("cli");
  if (item.label === "watch verification") return title.includes("watch");
  if (item.label === "state/history verification") return title.includes("report") || title.includes("handoff") || title.includes("보고서") || title.includes("인수");
  if (item.label === "risky areas") return title.includes("runtime") || title.includes("런타임");
  if (item.label === "docs update candidate") return title.includes("documentation") || title.includes("문서");
  if (item.label === "drift clarity") return title.includes("scope") || title.includes("범위");
  return false;
}

function formatReviewItems(items: QualityReviewItem[], locale: DevGuardLocale): string[] {
  if (items.length === 0) return [`- ${reportCopy[locale].noItems}`];
  const lines: string[] = [];
  for (const item of items) {
    lines.push(`- ${localizeReviewTitle(item.title, locale)}`);
    for (const body of item.body) lines.push(`  - ${localizeSentence(body, locale)}`);
    if (item.files.length > 0) {
      lines.push(`  - ${locale === "ko-KR" ? "관련 파일" : "Related files"}: ${compactFileList(item.files, 5)}`);
    }
    if (item.checks.length > 0) {
      lines.push(`  - ${locale === "ko-KR" ? "확인 기준" : "Check"}: ${item.checks.slice(0, 4).map((check) => localizeSentence(check, locale)).join("; ")}`);
    }
  }
  return lines;
}

function localizeReviewTitle(value: string, locale: DevGuardLocale): string {
  if (locale === "en-US") return value;
  const titles: Record<string, string> = {
    "Generated file commit check": "생성 파일 커밋 여부 확인",
    "Package and release impact": "패키지와 배포 영향 확인",
    "CLI command and help consistency": "CLI 명령과 도움말 일치 여부",
    "Watch behavior check": "watch 동작 확인",
    "Report and handoff regeneration": "보고서와 인수인계 재생성 확인",
    "Quality Report output review": "Quality Report 출력 검토",
    "OpenAI API key safety and fallback": "OpenAI API Key 저장, 미노출, fallback 확인",
    "Runtime-sensitive behavior": "런타임 영향 확인",
    "Change breadth review": "변경 범위 확인",
    "Documentation update need": "문서 업데이트 필요 여부",
    "Change scope check": "변경 범위 확인",
    "Final behavior check": "최종 동작 확인"
  };
  return titles[value] ?? value;
}

function formatLocalizedBullets(items: string[], locale: DevGuardLocale): string[] {
  const filtered = items.filter((item) => item && item !== "none" && item !== "확인 필요");
  if (filtered.length === 0) return [`- ${reportCopy[locale].noItems}`];
  return filtered.map((item) => `- ${localizeSentence(item, locale)}`);
}

function formatQualityItem(item: QualityCheckItem, locale: DevGuardLocale): string {
  return `${qualityLabel(item.label, locale)} - ${qualityDetail(item, locale)}`;
}

function qualityLabel(label: string, locale: DevGuardLocale): string {
  const labels: Record<string, { en: string; ko: string }> = {
    "generated/runtime files": { en: "Generated files", ko: "생성 파일 포함 여부" },
    "package lock consistency": { en: "Package lock consistency", ko: "패키지 잠금 파일 일치 여부" },
    "package manifest changed": { en: "Package metadata", ko: "패키지 설정 변경" },
    "build verification candidate": { en: "Build verification", ko: "빌드 검증 명령" },
    "change breadth": { en: "Change breadth", ko: "변경 범위" },
    "risky areas": { en: "Runtime-sensitive areas", ko: "주의가 필요한 영역" },
    "CLI router/help verification": { en: "CLI command and help consistency", ko: "CLI 라우터와 도움말 검증" },
    "watch verification": { en: "Watch behavior", ko: "watch 동작 검증" },
    "state/history verification": { en: "Report and state generation", ko: "상태와 히스토리 생성 검증" },
    "docs update candidate": { en: "Documentation update need", ko: "문서 업데이트 후보" },
    "drift clarity": { en: "Change scope clarity", ko: "작업 범위 명확성" }
  };
  const entry = labels[label];
  if (!entry) return label;
  return locale === "ko-KR" ? entry.ko : entry.en;
}

function qualityDetail(item: QualityCheckItem, locale: DevGuardLocale): string {
  const detail = item.detail;
  if (item.label === "drift clarity" && /drift candidate present/i.test(detail)) {
    return locale === "ko-KR"
      ? "변경 범위 이탈 가능성이 있습니다. 관련 파일이 모두 같은 작업 목표에 속하는지 확인하세요."
      : "A scope mismatch is possible. Confirm the changed files all belong to the same user request.";
  }
  if (item.label === "CLI router/help verification" && item.status !== "PASS" && /changed/i.test(detail)) {
    return locale === "ko-KR"
      ? "CLI 라우팅 또는 도움말 출력이 바뀌었습니다. README/docs와 실제 help/status 출력이 일치하는지 확인하세요."
      : "CLI routing or help output changed. Confirm README/docs match the actual help and status output.";
  }
  if (item.label === "docs update candidate" && /source changed without docs/i.test(detail)) {
    return locale === "ko-KR"
      ? "소스 변경이 사용자 동작에 영향을 준다면 관련 문서 업데이트가 필요합니다."
      : "If the source change affects user-facing behavior, update the relevant docs.";
  }
  if (item.label === "state/history verification" && item.status !== "PASS" && /changed/i.test(detail)) {
    return locale === "ko-KR"
      ? "상태, 히스토리, 프롬프트 또는 보고서 생성 흐름이 바뀌었습니다. done/status/handoff 출력과 생성 파일을 확인하세요."
      : "State, history, prompt, or report generation changed. Confirm done/status/handoff output and generated files.";
  }
  return locale === "ko-KR" ? localizeSentence(detail, locale) : humanizeInternalSentence(detail);
}

function humanizeInternalSentence(value: string): string {
  return value
    .replace(/risky area\(s\): /g, "runtime-sensitive area(s): ")
    .replace(/drift candidate present; next task=.*/gi, "scope mismatch needs review")
    .replace(/source changed without docs changes; recorded as doc update candidate only/gi, "source changed; confirm whether docs need an update");
}

function localizeSentence(value: string, locale: DevGuardLocale): string {
  if (locale === "en-US") return value;
  const exact: Record<string, string> = {
    "none": "없음",
    "no generated runtime files in git changes": "git 변경 목록에 DevGuard 생성 파일이 포함되지 않았습니다.",
    "package/lockfile state does not look inconsistent": "package 파일과 lockfile 상태가 어긋나 보이지 않습니다.",
    "package.json not changed": "package.json은 변경되지 않았습니다.",
    "build verification candidate found": "빌드 검증 명령을 찾았습니다.",
    "no auth/database/api/config area detected": "인증, 데이터베이스, API, 설정 영역 변경은 감지되지 않았습니다.",
    "CLI router not changed": "CLI 라우터는 변경되지 않았습니다.",
    "watch implementation not changed": "watch 구현은 변경되지 않았습니다.",
    "state/history generation not changed": "상태와 히스토리 생성 로직은 변경되지 않았습니다.",
    "docs/source balance does not require warning": "문서와 소스 변경의 균형에 추가 경고는 필요하지 않습니다.",
    "no drift candidate": "작업 범위 이탈 후보는 없습니다.",
    "change scope is small, verification exists, and no blocking local quality rule fired": "변경 범위가 작고 검증 후보가 있으며, 차단 수준의 로컬 품질 규칙은 감지되지 않았습니다.",
    "ready for final review or commit": "최종 검토 또는 커밋을 진행할 수 있습니다.",
    "fix BLOCKED items before commit": "커밋 전에 차단 항목을 먼저 해결하세요.",
    "Coverage: Complete": "포함 범위: 충분함",
    "Redundancy: Low": "중복도: 낮음",
    "Redundancy: Medium": "중복도: 보통",
    "Readability: High": "가독성: 높음",
    "Readability: Medium": "가독성: 보통",
    "No blocking quality issues were detected.": "차단 수준의 품질 문제는 감지되지 않았습니다.",
    "No source changes are currently pending.": "현재 대기 중인 소스 변경은 없습니다.",
    "Use the review items below to confirm the behavior before committing or publishing.": "커밋 또는 배포 전에 아래 검토 항목으로 실제 동작을 확인하세요.",
    "This change adds OpenAI API key setup to both the CLI and Dashboard.": "이번 변경은 OpenAI API Key 설정을 CLI와 Dashboard에 추가합니다.",
    "DevGuard should resolve keys in this order: .devguard/config.json, DEV_GUARD_OPENAI_API_KEY, then OPENAI_API_KEY.": "DevGuard는 .devguard/config.json, DEV_GUARD_OPENAI_API_KEY, OPENAI_API_KEY 순서로 key를 읽어야 합니다.",
    "Raw key values must stay hidden while the Dashboard API reports only configured/source.": "Dashboard API는 configured/source만 반환하고 raw key 값은 숨겨야 합니다.",
    "If the key is missing, invalid, unavailable, or times out, done/status/handoff should still generate rule-based Quality Report and Handoff files.": "key가 없거나 잘못되었거나 네트워크 실패/timeout이 발생해도 done/status/handoff는 rule-based Quality Report와 Handoff를 생성해야 합니다.",
    "The change crosses CLI config, Dashboard settings, dashboard API responses, and Quality Report generation.": "이번 변경은 CLI config, Dashboard 설정, Dashboard API 응답, Quality Report 생성 흐름을 함께 바꿉니다.",
    "API key handling is security-sensitive because raw values must never appear in logs, terminal output, dashboard state, or generated reports.": "API key는 민감 정보이므로 로그, 터미널 출력, Dashboard 상태, 생성 보고서에 raw value가 나타나면 안 됩니다.",
    "The fallback path matters because DevGuard must remain useful without OpenAI access and must keep generating Quality Report and Handoff files.": "OpenAI에 접근할 수 없어도 DevGuard는 계속 유용해야 하며 Quality Report와 Handoff를 생성해야 하므로 fallback 경로 검증이 중요합니다.",
    "Confirm the CLI and Dashboard can store or report OpenAI key configuration without exposing the raw key value.": "CLI와 Dashboard가 OpenAI key 설정 상태를 다루더라도 raw key 값을 노출하지 않는지 확인하세요.",
    "Confirm key resolution follows config, DEV_GUARD_OPENAI_API_KEY, then OPENAI_API_KEY.": "key 읽기 순서가 config, DEV_GUARD_OPENAI_API_KEY, OPENAI_API_KEY 순서인지 확인하세요.",
    "Confirm missing, invalid, network-failed, or timed-out OpenAI calls still produce rule-based Quality Report and Handoff files.": "key 없음, 잘못된 key, 네트워크 실패, timeout 상황에서도 rule-based Quality Report와 Handoff가 생성되는지 확인하세요.",
    "Verify that config/env key priority works, raw key values are not exposed, and missing or invalid keys still fall back to rule-based Quality Report and Handoff generation.": "config/env key 우선순위, raw key 미노출, key 없음/오류 시 rule-based Quality Report와 Handoff fallback이 모두 동작하는지 확인하세요.",
    "The change can affect what users see in the Dashboard.": "이번 변경은 사용자가 Dashboard에서 보는 내용에 영향을 줄 수 있습니다.",
    "The change can affect generated reports, handoff files, or next-session context.": "이번 변경은 생성 보고서, 인수인계 파일, 다음 세션 컨텍스트에 영향을 줄 수 있습니다.",
    "This change affects how DevGuard turns local checks into the user-facing Quality Report and handoff guidance.": "이번 변경은 DevGuard가 로컬 점검 결과를 사용자용 Quality Report와 인수인계 안내로 바꾸는 방식에 영향을 줍니다.",
    "This change turns the generated Quality Report into a QA result document instead of a generic checklist.": "이번 변경은 생성되는 Quality Report를 일반 체크리스트가 아니라 QA 결과 보고서로 바꾸는 작업입니다.",
    "The report should explain the verdict, summarize the change, describe what changed per file, and separate completed QA from missing QA.": "보고서는 판정 이유, 변경 요약, 파일별 변경 내용, 완료된 QA와 남은 QA를 구분해서 설명해야 합니다.",
    "Because the report generation logic changed, the regenerated markdown must be read directly after `pnpm cli done`.": "보고서 생성 로직이 바뀌었으므로 `pnpm cli done` 후 재생성된 markdown을 직접 읽어야 합니다.",
    "Build success alone cannot prove the generated QA wording is specific, natural, and free of internal rule labels.": "빌드 통과만으로는 생성된 QA 문구가 구체적이고 자연스러우며 내부 rule label을 노출하지 않는지 보장할 수 없습니다.",
    "Quality Report generation changed, so the generated markdown itself is the behavior under test.": "Quality Report 생성 로직이 바뀌었으므로 생성된 markdown 자체가 이번 QA 대상입니다.",
    "The report must show what changed, why the verdict was chosen, what QA is complete, and what QA remains.": "보고서는 무엇이 바뀌었는지, 왜 이 판정이 나왔는지, 어떤 QA가 끝났고 무엇이 남았는지 보여줘야 합니다.",
    "The implementation should not expose internal analysis labels or replace QA reasoning with generic commands.": "구현은 내부 분석 label을 노출하거나 QA 이유를 일반 명령 목록으로 대체하면 안 됩니다.",
    "Regenerate the Quality Report, read the generated markdown, and confirm it explains the QA result, changed files, risks, and next QA without generic review wording.": "Quality Report를 재생성한 뒤 markdown을 직접 읽고, 일반적인 검토 문구 없이 QA 결과, 변경 파일, 위험 요소, 다음 QA를 설명하는지 확인하세요.",
    "This change affects how DevGuard explains the current session's QA result in the generated Quality Report.": "이번 변경은 DevGuard가 현재 세션의 QA 결과를 생성된 Quality Report에서 설명하는 방식에 영향을 줍니다.",
    "This change affects whether Dashboard language choices are reflected in generated reports and handoff files.": "이번 변경은 Dashboard 언어 선택이 생성 보고서와 인수인계 파일에 반영되는 흐름에 영향을 줍니다.",
    "This change affects what users see or do in the Dashboard.": "이번 변경은 사용자가 Dashboard에서 보고 실행하는 흐름에 영향을 줍니다.",
    "This change affects the authentication or login flow, so the end-to-end sign-in behavior needs review.": "이번 변경은 인증 또는 로그인 흐름에 영향을 주므로 실제 로그인 동작 검토가 필요합니다.",
    "This change affects generated reports, handoff files, or next-session context.": "이번 변경은 생성 보고서, 인수인계 파일, 다음 세션 컨텍스트에 영향을 줍니다.",
    "The change can affect configuration or runtime behavior.": "이번 변경은 설정 또는 런타임 동작에 영향을 줄 수 있습니다.",
    "The change affects documentation or user-facing guidance.": "이번 변경은 문서 또는 사용자 안내에 영향을 줍니다.",
    "The change can affect API behavior or external callers.": "이번 변경은 API 동작 또는 외부 호출자에 영향을 줄 수 있습니다.",
    "The change should be reviewed against the current user request.": "이번 변경이 현재 사용자 요청과 맞는지 확인해야 합니다.",
    "The change scope is small, verification commands are available, and no blocking local quality rule fired.": "변경 범위가 작고 검증 명령이 있으며, 차단 수준의 로컬 품질 규칙은 감지되지 않았습니다.",
    "Confirm DevGuard runtime artifacts are not included as source changes.": "DevGuard 런타임 산출물이 소스 변경으로 포함되지 않았는지 확인하세요.",
    "Confirm package scripts, dependencies, versions, and lockfile state match the intended release impact.": "package scripts, dependencies, version, lockfile 상태가 의도한 배포 영향과 맞는지 확인하세요.",
    "Confirm changed CLI routing or output still matches README/docs and the commands users will run.": "변경된 CLI 라우팅 또는 출력이 README/docs와 사용자가 실행할 명령과 일치하는지 확인하세요.",
    "CLI routing or help output changed. Verify that documented commands, help text, and status output still match the implementation.": "CLI 라우팅 또는 도움말 출력이 바뀌었습니다. 문서의 명령 설명과 실제 help/status 출력이 일치하는지 확인하세요.",
    "Confirm watch still tracks real project changes and ignores DevGuard internal files.": "watch가 실제 프로젝트 변경만 추적하고 DevGuard 내부 파일은 무시하는지 확인하세요.",
    "Confirm done/status/handoff read the latest runtime state and regenerate user-facing reports correctly.": "done/status/handoff가 최신 runtime state를 읽고 사용자용 보고서를 올바르게 재생성하는지 확인하세요.",
    "Regenerate the Quality Report and confirm the first screen tells the user what changed, what to do now, and why it matters.": "Quality Report를 재생성한 뒤 첫 화면에서 무엇이 바뀌었고 지금 무엇을 해야 하며 왜 중요한지 바로 보이는지 확인하세요.",
    "Quality Report or handoff generation changed. Confirm the regenerated report tells the user what to do first, names the relevant file role, and does not expose internal rule names.": "Quality Report 또는 인수인계 생성 흐름이 바뀌었습니다. 재생성된 보고서가 사용자가 먼저 할 일을 알려주고, 관련 파일의 역할을 설명하며, 내부 규칙 이름을 노출하지 않는지 확인하세요.",
    "The changed files should be checked against the current task, not against a generic rule. Confirm the diff is only improving the Quality Report review experience.": "변경 파일은 일반 규칙이 아니라 현재 작업 목표를 기준으로 확인해야 합니다. diff가 Quality Report 리뷰 경험 개선에만 집중되어 있는지 확인하세요.",
    "Confirm the diff is focused on Quality Report intelligence and does not change unrelated watch, hook, dashboard, or release behavior.": "diff가 Quality Report intelligence 개선에 집중되어 있고 관련 없는 watch, hook, Dashboard, release 동작을 바꾸지 않는지 확인하세요.",
    "Quality Report generation changed. Confirm the regenerated report reads like a QA result, explains each relevant file role, and does not expose internal rule names.": "Quality Report 생성 흐름이 바뀌었습니다. 재생성된 보고서가 QA 결과처럼 읽히고, 관련 파일의 역할을 설명하며, 내부 rule 이름을 노출하지 않는지 확인하세요.",
    "The changed files should be checked against the current task. Confirm the diff is limited to Quality Report QA wording and generation behavior.": "변경 파일을 현재 작업 기준으로 확인해야 합니다. diff가 Quality Report QA 문구와 생성 동작에만 한정되는지 확인하세요.",
    "Regenerate the Quality Report and confirm it reads like a QA result: verdict, change summary, file-level changes, completed QA, missing QA, risks, and next QA.": "Quality Report를 재생성하고 판정, 변경 요약, 파일별 변경, 완료된 QA, 남은 QA, 위험 요소, 다음 QA를 설명하는 QA 결과 보고서처럼 읽히는지 확인하세요.",
    "Confirm the diff is focused on Quality Report QA wording and generation behavior without changing Dashboard, Handoff, watch, hook, or release behavior.": "diff가 Dashboard, Handoff, watch, hook, release 동작을 바꾸지 않고 Quality Report QA 문구와 생성 동작에만 집중되어 있는지 확인하세요.",
    "Confirm no internal rule names appear in the main sections.": "주요 섹션에 내부 규칙 이름이 그대로 노출되지 않는지 확인하세요.",
    "Check whether changed source behavior affects commands, Dashboard text, configuration, hooks, reports, or generated files that users read.": "변경된 소스 동작이 명령어, Dashboard 문구, 설정, hook, 보고서, 사용자가 읽는 생성 파일에 영향을 주는지 확인하세요.",
    "Confirm the changed files all support the current request and remove or split unrelated work before finishing.": "변경된 파일이 모두 현재 요청을 뒷받침하는지 확인하고, 관련 없는 작업은 제거하거나 분리하세요.",
    "Confirm the changed files still belong to one coherent task and split unrelated work if needed.": "변경 파일이 하나의 작업 목표에 속하는지 확인하고, 관련 없는 작업은 필요하면 분리하세요.",
    "Review the changed files once and confirm the implementation still matches the user request.": "변경 파일을 한 번 검토하고 구현이 여전히 사용자 요청과 일치하는지 확인하세요.",
    "Run git status and keep .devguard runtime outputs out of the commit.": "git status를 실행하고 .devguard 런타임 산출물이 커밋에 포함되지 않게 하세요.",
    "Review git diff by file.": "파일별 git diff를 검토하세요.",
    "Keep only changes required for the current task.": "현재 작업에 필요한 변경만 남기세요.",
    "Run the listed verification commands, then proceed with final review or commit.": "나열된 검증 명령을 실행한 뒤 최종 검토 또는 커밋을 진행하세요.",
    "No project changes need review right now.": "지금 검토할 프로젝트 변경은 없습니다.",
    "State, history, prompt, or report generation changed. Confirm done/status/handoff regenerate the expected files without stale state.": "상태, 히스토리, 프롬프트 또는 보고서 생성 흐름이 바뀌었습니다. done/status/handoff가 오래된 상태 없이 필요한 파일을 재생성하는지 확인하세요.",
    "The changed files may include work outside the current request. Confirm each changed file supports the same task before finishing.": "변경 파일에 현재 요청 밖의 작업이 섞였을 수 있습니다. 마무리 전에 각 파일이 같은 작업 목표를 뒷받침하는지 확인하세요."
  };
  if (exact[value]) return exact[value];
  return value
    .replace(/^(\d+) changed file\(s\)$/, "$1개 파일 변경")
    .replace(/^Review is recommended because (\d+) check item\(s\) need confirmation\.$/, "확인이 필요한 항목이 $1개 있어 검토를 권장합니다.")
    .replace(/^Completion is blocked because (\d+) check item\(s\) need confirmation\.$/, "확인이 필요한 항목이 $1개 있어 완료가 차단되었습니다.")
    .replace(/^(\d+) changed file\(s\) are ready for final review after the listed verification commands\.$/, "$1개 변경 파일은 나열된 검증 명령 실행 후 최종 검토할 수 있습니다.")
    .replace(/^This session changed (\d+) file\(s\), so review whether the work still belongs to one coherent task\./, "이번 세션에서 $1개 파일이 변경되었습니다. 변경 범위가 하나의 작업 목표로 설명되는지 확인하세요.")
    .replace(/^The change touches (.+) area\(s\)\. Confirm the runtime behavior still matches the intended workflow\./, "이번 변경은 $1 영역에 닿아 있습니다. 런타임 동작이 의도한 흐름과 일치하는지 확인하세요.")
    .replace(/^CLI routing or help output changed\. Verify that documented commands, help text, and status output still match the implementation\./, "CLI 라우팅 또는 도움말 출력이 바뀌었습니다. 문서의 명령 설명과 실제 help/status 출력이 일치하는지 확인하세요.")
    .replace(/^Confirm the (.+) area\(s\) still behave as intended in the actual workflow\.$/, "$1 영역이 실제 워크플로우에서 의도대로 동작하는지 확인하세요.")
    .replace(/^State, history, prompt, or report generation changed\. Confirm done\/status\/handoff regenerate the expected files without stale state\./, "상태, 히스토리, 프롬프트 또는 보고서 생성 흐름이 바뀌었습니다. done/status/handoff가 오래된 상태 없이 필요한 파일을 재생성하는지 확인하세요.")
    .replace(/^The changed files may include work outside the current request\. Confirm each changed file supports the same task before finishing\./, "변경 파일에 현재 요청 밖의 작업이 섞였을 수 있습니다. 마무리 전에 각 파일이 같은 작업 목표를 뒷받침하는지 확인하세요.")
    .replace(/^Quality Report or handoff generation changed\. Confirm the regenerated report tells the user what to do first, names the relevant file role, and does not expose internal rule names\./, "Quality Report 또는 인수인계 생성 흐름이 바뀌었습니다. 재생성된 보고서가 사용자가 먼저 할 일을 알려주고, 관련 파일의 역할을 설명하며, 내부 규칙 이름을 노출하지 않는지 확인하세요.")
    .replace(/^The changed files should be checked against the current task, not against a generic rule\. Confirm the diff is only improving the Quality Report review experience\./, "변경 파일은 일반 규칙이 아니라 현재 작업 목표를 기준으로 확인해야 합니다. diff가 Quality Report 리뷰 경험 개선에만 집중되어 있는지 확인하세요.")
    .replace(/^Quality Report generation changed\. Confirm the regenerated report reads like a QA result, explains each relevant file role, and does not expose internal rule names\./, "Quality Report 생성 흐름이 바뀌었습니다. 재생성된 보고서가 QA 결과처럼 읽히고, 관련 파일의 역할을 설명하며, 내부 rule 이름을 노출하지 않는지 확인하세요.")
    .replace(/^The changed files should be checked against the current task\. Confirm the diff is limited to Quality Report QA wording and generation behavior\./, "변경 파일을 현재 작업 기준으로 확인해야 합니다. diff가 Quality Report QA 문구와 생성 동작에만 한정되는지 확인하세요.")
    .replace(/^Confirm done\/status\/handoff read the latest runtime state and regenerate user-facing reports correctly\. Focus on (.+)\. Then run the required verification commands\.$/, "done/status/handoff가 최신 runtime state를 읽고 사용자용 보고서를 올바르게 재생성하는지 확인하세요. 관련 파일: $1. 그런 다음 필요한 검증 명령을 실행하세요.")
    .replace(/^(.+) Focus on (.+)\. Then run the required verification commands\.$/, "$1 관련 파일: $2. 그런 다음 필요한 검증 명령을 실행하세요.")
    .replace(/ Related file\(s\): /g, " 관련 파일: ")
    .replace(/^run /, "실행: ")
    .replace(/^review /, "확인: ")
    .replace(/^Continue: /, "계속 진행: ")
    .replace(/^Run: /, "실행: ")
    .replace(/^Review: /, "확인: ")
    .replace(/^BLOCKED: /, "차단: ")
    .replace(/^WARN: /, "검토 권장: ")
    .replace(/risky areas -/g, "주의가 필요한 영역 -")
    .replace(/watch verification -/g, "watch 동작 검증 -")
    .replace(/state\/history verification -/g, "상태와 히스토리 생성 검증 -")
    .replace(/drift clarity -/g, "작업 범위 명확성 -")
    .replace(/package manifest changed -/g, "패키지 설정 변경 -")
    .replace(/package lock consistency -/g, "패키지 잠금 파일 일치 여부 -")
    .replace(/, then review /g, " 실행 후 확인: ")
    .replace(/; verify: /g, "; 검증: ")
    .replace(/package\.json changed but no lockfile change detected/g, "package.json은 변경되었지만 lockfile 변경이 감지되지 않았습니다")
    .replace(/package\.json changed; verify scripts\/dependencies and publish impact/g, "package.json이 변경되었습니다. scripts, dependencies, 배포 영향을 확인하세요")
    .replace(/risky area\(s\): ([\w, ]+)/g, "주의가 필요한 영역: $1")
    .replace(/watch changed; verify --poll and --depth behavior/g, "watch가 변경되었습니다. --poll 및 --depth 동작을 확인하세요")
    .replace(/state\/history\/prompt generation changed; verify done\/status output/g, "상태, 히스토리, 프롬프트 생성이 변경되었습니다. done/status 출력을 확인하세요")
    .replace(/source changed without docs changes; recorded as doc update candidate only/g, "소스 변경이 있지만 문서 변경은 없습니다. 문서 업데이트 후보로만 기록합니다")
    .replace(/drift candidate present; next task=/g, "작업 범위 이탈 후보가 있습니다. 다음 작업: ")
    .replace(/changed file\(s\)/g, "개 파일 변경");
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
  projectKnowledge: RequiredText;
  locale: DevGuardLocale;
}): string {
  const copy = handoffCopy[input.locale];
  const quality = parseQuality(input.qualityReport.content);
  const nextTask = extractNextTask(input.nextPrompt.content, input.tasks.content, input.state);
  const state = parseProjectState(input.state);
  const changedFiles = state.lastChangedFiles ?? lastHistoryFiles(input.records);
  const goal = handoffGoal(nextTask, changedFiles, quality, input.locale);
  const fileChanges = handoffFileChanges(changedFiles, quality, input.locale);
  const qualityLines = handoffQualityLines(quality, changedFiles, input.locale);
  const outstanding = handoffOutstandingItems(quality, changedFiles, input.locale);
  const nextSteps = handoffNextActions(quality, nextTask, changedFiles, input.locale);
  const verification = handoffVerificationLines(quality, input.locale, changedFiles);
  const resumePrompt = handoffResumePrompt(goal, nextSteps, changedFiles, input.locale);
  const missing = missingInputs([input.project, input.architecture, input.tasks, input.qualityReport, input.projectKnowledge, input.historySummary]);
  const body: string[] = [`# ${copy.title}`, ""];
  body.push(`## ${copy.Goal}`, "", ...goal, "");
  body.push(`## ${copy.Changed}`, "", ...fileChanges, "");
  body.push(`## ${copy.Quality}`, "", ...qualityLines, "");
  body.push(`## ${copy.Outstanding}`, "", ...outstanding, "");
  body.push(`## ${copy.Next}`, "", ...nextSteps, "");
  body.push(`## ${copy.Verification}`, "", ...verification, "");
  if (missing.length > 0) body.push(`## ${copy.Missing}`, ...missing, "");
  body.push(`## ${copy.ResumePrompt}`, "", resumePrompt);
  const score = handoffQualityScore({
    missingCount: missing.length,
    outstandingCount: outstanding.filter((item) => !/없음|none/i.test(item)).length,
    lineCountEstimate: body.length
  });
  body.push(
    "",
    `## ${copy.HandoffQuality}`,
    ...formatLocalizedBullets(score, input.locale)
  );
  return body.join("\n") + "\n";
}

function handoffGoal(nextTask: string, changedFiles: string[], quality: ParsedQuality, locale: DevGuardLocale): string[] {
  const cleanTask = sanitizeHandoffText(nextTask);
  const inferred = inferGoalFromFiles(changedFiles, locale);
  const goal = isUsefulHandoffText(cleanTask) && !looksStaleHandoffTask(cleanTask, changedFiles) ? cleanTask : inferred;
  const status = completionStatus(quality.verdict);
  if (locale === "ko-KR") {
    return [
      `- ${goal}`,
      `- 현재 상태: ${status === "completed" ? "완료" : status === "blocked" ? "차단됨" : "일부 완료"}`,
      ...(goal === "목표 확인 필요" ? ["- 근거: 변경 파일과 Quality Report만으로는 사용자의 원래 요청을 특정하기 어렵습니다."] : [])
    ];
  }
  return [
    `- ${goal}`,
    `- Current status: ${status === "completed" ? "completed" : status === "blocked" ? "blocked" : "partially completed"}`,
    ...(goal === "Goal needs confirmation" ? ["- Basis: changed files and Quality Report do not identify the original user request clearly."] : [])
  ];
}

function inferGoalFromFiles(files: string[], locale: DevGuardLocale): string {
  if (files.some((file) => /runtime-state\.ts$/.test(file))) {
    return locale === "ko-KR"
      ? "Smart Handoff가 다음 작업자가 바로 이어서 작업할 수 있는 인수인계 문서를 생성하도록 개선하는 작업입니다."
      : "Improve Smart Handoff so the next worker can continue from an actionable handoff document.";
  }
  if (files.some((file) => /dashboard/i.test(file))) {
    return locale === "ko-KR"
      ? "Dashboard UI QA에서 발견된 spacing, details open state, PASS Next Action 표시 문제를 수정하는 작업입니다."
      : "Fix Dashboard UI QA issues around spacing, details open state, and the PASS Next Action display.";
  }
  if (files.some((file) => /quality|report/i.test(file))) {
    return locale === "ko-KR"
      ? "Quality Report가 사용자의 다음 행동을 더 구체적으로 안내하도록 개선하는 작업입니다."
      : "Improve Quality Report guidance so it tells the user the concrete next action.";
  }
  return locale === "ko-KR" ? "목표 확인 필요" : "Goal needs confirmation";
}

function handoffFileChanges(files: string[], quality: ParsedQuality, locale: DevGuardLocale): string[] {
  if (files.length === 0) {
    return [locale === "ko-KR" ? "- 변경 파일 없음" : "- No changed files recorded."];
  }
  const lines: string[] = [];
  for (const file of files.slice(0, 8)) {
    const role = handoffFileRole(file, locale);
    const reason = handoffFileReason(file, locale);
    const change = handoffFileMajorChange(file, locale);
    const review = handoffFileReviewNeed(file, quality, locale);
    lines.push(`- \`${file}\``);
    lines.push(`  - ${locale === "ko-KR" ? "변경 이유" : "Reason"}: ${reason}`);
    lines.push(`  - ${locale === "ko-KR" ? "주요 변경" : "Main change"}: ${change || role}`);
    lines.push(`  - ${locale === "ko-KR" ? "확인 필요" : "Needs check"}: ${review}`);
  }
  if (files.length > 8) {
    lines.push(locale === "ko-KR" ? `- 그 외 ${files.length - 8}개 파일은 Quality Report의 관련 파일 목록을 확인하세요.` : `- ${files.length - 8} more files are listed in the Quality Report related files section.`);
  }
  return lines;
}

function handoffFileRole(file: string, locale: DevGuardLocale): string {
  if (/runtime-state\.ts$/.test(file)) {
    return locale === "ko-KR" ? "Quality Report, Handoff, Next Prompt 생성 로직" : "Quality Report, Handoff, and Next Prompt generation logic";
  }
  if (/dashboard-i18n\.ts$/.test(file)) return locale === "ko-KR" ? "Dashboard 사용자 문구와 locale dictionary" : "Dashboard user copy and locale dictionary";
  if (/dashboard\.ts$/.test(file)) return locale === "ko-KR" ? "Dashboard 렌더링과 사용자 상호작용" : "Dashboard rendering and user interaction";
  if (/configure|config/i.test(file)) return locale === "ko-KR" ? "설정 저장과 CLI 설정 흐름" : "Configuration persistence and CLI config flow";
  if (/README|docs\//i.test(file)) return locale === "ko-KR" ? "사용자 문서와 명령 안내" : "User documentation and command guidance";
  if (/package\.json|pnpm-lock\.yaml/i.test(file)) return locale === "ko-KR" ? "패키지와 배포 설정" : "Package and release configuration";
  return locale === "ko-KR" ? "변경 파일 역할 확인 필요" : "File role needs confirmation";
}

function handoffFileReason(file: string, locale: DevGuardLocale): string {
  if (/runtime-state\.ts$/.test(file)) {
    return locale === "ko-KR"
      ? "생성되는 인수인계가 내부 분석 로그를 노출하지 않고 다음 작업 지시서처럼 읽히도록 하기 위해 수정되었습니다."
      : "Updated so generated handoffs read like next-session instructions and do not expose internal analysis logs.";
  }
  if (/dashboard\.ts$/.test(file)) {
    return locale === "ko-KR"
      ? "Dashboard QA에서 발견된 layout 또는 interaction 문제를 해결하기 위해 수정되었습니다."
      : "Updated to address layout or interaction issues found during Dashboard QA.";
  }
  if (/dashboard-i18n\.ts$/.test(file)) return locale === "ko-KR" ? "Dashboard 문구를 자연스럽게 조정하기 위해 수정되었습니다." : "Updated to refine Dashboard wording.";
  if (/README|docs\//i.test(file)) return locale === "ko-KR" ? "문서가 실제 사용 흐름과 맞도록 수정되었습니다." : "Updated so docs match the actual workflow.";
  return locale === "ko-KR" ? "이번 작업 범위에 포함된 변경인지 확인이 필요합니다." : "Confirm this file belongs to the current task scope.";
}

function handoffFileMajorChange(file: string, locale: DevGuardLocale): string {
  if (/runtime-state\.ts$/.test(file)) {
    return locale === "ko-KR"
      ? "Handoff 섹션을 목표, 파일별 변경 이유, 품질 판단, 행동 단위 다음 작업 중심으로 재구성합니다."
      : "Reworks Handoff sections around goal, per-file rationale, quality reasoning, and action-oriented next steps.";
  }
  if (/dashboard\.ts$/.test(file)) {
    return locale === "ko-KR"
      ? "Dashboard 렌더링 또는 details open state 같은 사용자 상호작용을 조정합니다."
      : "Adjusts Dashboard rendering or user interaction such as details open state.";
  }
  if (/dashboard-i18n\.ts$/.test(file)) return locale === "ko-KR" ? "사용자에게 보이는 Dashboard 문구를 조정합니다." : "Adjusts user-facing Dashboard copy.";
  if (/README|docs\//i.test(file)) return locale === "ko-KR" ? "사용자 안내 문구를 최신 동작에 맞춥니다." : "Aligns user guidance with current behavior.";
  return locale === "ko-KR" ? "주요 변경 내용 확인 필요" : "Main change needs confirmation";
}

function handoffFileReviewNeed(file: string, quality: ParsedQuality, locale: DevGuardLocale): string {
  if (/runtime-state\.ts$/.test(file)) {
    return locale === "ko-KR"
      ? "재생성된 Handoff에 내부 분석값이나 rule id가 그대로 노출되지 않는지 확인합니다."
      : "Confirm the regenerated Handoff does not expose internal analysis values or rule identifiers.";
  }
  if (/dashboard\.ts$/.test(file)) {
    return locale === "ko-KR"
      ? "실제 브라우저에서 변경된 interaction이 의도대로 동작하는지 확인합니다."
      : "Confirm the changed interaction works in a real browser.";
  }
  if (quality.verdict === "NEEDS_REVIEW") {
    return locale === "ko-KR" ? "Quality Report의 검토 항목이 이 파일과 직접 관련되는지 확인합니다." : "Confirm Quality Report review items are directly related to this file.";
  }
  return locale === "ko-KR" ? "추가 확인 없음" : "No extra check identified";
}

function handoffQualityLines(quality: ParsedQuality, files: string[], locale: DevGuardLocale): string[] {
  const generatedReasons = files.some((file) => /runtime-state\.ts$/.test(file))
    ? locale === "ko-KR"
      ? [
          "인수인계 생성 로직이 바뀌었으므로 재생성된 문서가 실제 다음 작업 지시서처럼 읽히는지 확인해야 합니다.",
          "내부 분석값이나 rule id가 사용자-facing 본문에 그대로 노출되면 안 됩니다."
        ]
      : [
          "Handoff generation changed, so the regenerated document must be checked as a real next-session instruction.",
          "Internal analysis values or rule identifiers must not appear in the user-facing body."
        ]
    : [];
  const reasons = (generatedReasons.length > 0 ? generatedReasons : quality.why.map(sanitizeHandoffText).filter(isUsefulHandoffText)).slice(0, 4);
  if (locale === "ko-KR") {
    return [
      `- 상태: ${quality.verdict}`,
      "- 이유:",
      ...(reasons.length > 0 ? reasons.map((reason) => `  - ${localizeSentence(reason, locale)}`) : [`  - ${quality.verdict === "PASS" ? "필수 검증 기준에서 차단 항목이 없습니다." : "Quality Report에서 구체적인 이유를 읽지 못했습니다. 생성 로직과 관련 파일을 확인해야 합니다."}`]),
      ...(quality.verdict === "NEEDS_REVIEW" && files.some((file) => /runtime-state\.ts$/.test(file)) ? ["  - 빌드 통과만으로 문서 내용의 자연스러움과 구체성을 보장할 수 없으므로 직접 읽어서 확인해야 합니다."] : [])
    ];
  }
  return [
    `- Status: ${quality.verdict}`,
    "- Reason:",
    ...(reasons.length > 0 ? reasons.map((reason) => `  - ${reason}`) : [`  - ${quality.verdict === "PASS" ? "No blocking quality item was found." : "Quality Report did not provide a specific reason; inspect generated output and related files."}`]),
    ...(quality.verdict === "NEEDS_REVIEW" && files.some((file) => /runtime-state\.ts$/.test(file)) ? ["  - Build success cannot prove the generated document is concrete and natural, so read it directly."] : [])
  ];
}

function handoffOutstandingItems(quality: ParsedQuality, files: string[], locale: DevGuardLocale): string[] {
  if (quality.verdict === "PASS") return [locale === "ko-KR" ? "- 없음" : "- none"];
  if (files.some((file) => /runtime-state\.ts$/.test(file))) {
    return locale === "ko-KR"
      ? [
          "- 재생성된 `.devguard/reports/project-handoff.md`에서 내부 분석값이나 rule id가 노출되지 않는지 확인",
          "- 변경 파일별로 변경 이유, 주요 변경, 확인 필요 항목이 모두 채워져 있는지 확인",
          "- NEEDS_REVIEW 이유가 Handoff 생성물 직접 확인 필요성으로 설명되는지 확인",
          "- 재개 프롬프트가 다음 작업자가 바로 실행할 수 있는 행동 단위인지 확인"
        ]
      : [
          "- Confirm `.devguard/reports/project-handoff.md` does not expose internal analysis values or rule identifiers after regeneration",
          "- Confirm each changed file includes reason, main change, and check needed fields",
          "- Confirm NEEDS_REVIEW is explained as a need to inspect the generated Handoff directly",
          "- Confirm the resume prompt gives action-level instructions the next worker can run immediately"
        ];
  }
  const items = quality.reviewItems
    .map(sanitizeHandoffText)
    .filter((item) => isUsefulHandoffText(item) && isRelevantHandoffReviewItem(item, files))
    .slice(0, 5);
  const generated = files.some((file) => /runtime-state\.ts$/.test(file))
    ? locale === "ko-KR"
      ? "재생성된 `.devguard/reports/project-handoff.md`에서 내부 분석값이나 rule id가 노출되지 않는지 확인"
      : "Confirm `.devguard/reports/project-handoff.md` does not expose internal analysis values or rule identifiers after regeneration"
    : undefined;
  const concrete = [...(generated ? [generated] : []), ...items].slice(0, 5);
  if (concrete.length === 0) {
    return [locale === "ko-KR" ? "- Quality Report가 왜 검토를 요구하는지 구체 항목을 확인해야 합니다." : "- Confirm the concrete reason Quality Report asks for review."];
  }
  return concrete.map((item) => `- ${localizeSentence(item, locale)}`);
}

function handoffNextActions(quality: ParsedQuality, nextTask: string, files: string[], locale: DevGuardLocale): string[] {
  const targetFile = files.find((file) => /runtime-state\.ts$|dashboard\.ts$|dashboard-i18n\.ts$/.test(file)) ?? files[0];
  if (locale === "ko-KR") {
    const actions = [
      targetFile ? `1. 먼저 \`${targetFile}\` 변경이 현재 요청 범위에만 해당하는지 확인합니다.` : "1. 먼저 변경 파일 목록을 확인하고 현재 요청과 직접 관련된 파일만 남깁니다.",
      quality.verdict === "BLOCKED"
        ? "2. BLOCKED 이유에 해당하는 파일과 실패 원인을 먼저 수정합니다."
        : "2. 문제가 있으면 해당 파일의 Handoff 생성 문구와 필터링 로직만 수정합니다.",
      `3. 수정 후 ${formatCommandRunList(handoffVerificationCommands(quality, files))}을 실행합니다.`,
      "4. `pnpm cli done`으로 Handoff를 재생성하고 내부 분석값이나 rule id가 노출되지 않는지 직접 엽니다."
    ];
    return actions;
  }
  return [
    targetFile ? `1. First confirm \`${targetFile}\` is scoped to the current request.` : "1. First review changed files and keep only files directly tied to the current request.",
    quality.verdict === "BLOCKED" ? "2. Fix the file and cause named by the BLOCKED reason first." : "2. If needed, adjust only the Handoff copy and filtering logic in the related file.",
    `3. Run ${compactCommandList(handoffVerificationCommands(quality, files))} after changes.`,
    "4. Run `pnpm cli done` to regenerate Handoff, then open it and confirm internal analysis values or rule identifiers are not exposed."
  ];
}

function handoffVerificationLines(quality: ParsedQuality, locale: DevGuardLocale, files: string[] = []): string[] {
  const planned = handoffVerificationCommands(quality, files);
  if (locale === "ko-KR") {
    return [
      "- `pnpm cli done`: pass. 현재 인수인계 파일이 생성되었습니다.",
      `- 외부 검증 결과: ${handoffCopy[locale].noExecutedVerification}`,
      ...planned.map((command) => `- 다음 세션에서 실행할 검증: \`${command}\``)
    ];
  }
  return [
    "- `pnpm cli done`: pass. The current Handoff file was generated.",
    `- External verification result: ${handoffCopy[locale].noExecutedVerification}`,
    ...planned.map((command) => `- Verification to run next: \`${command}\``)
  ];
}

function handoffResumePrompt(goal: string[], nextSteps: string[], files: string[], locale: DevGuardLocale): string {
  const cleanGoal = goal.map((line) => line.replace(/^- /, "")).find(isUsefulHandoffText) ?? (locale === "ko-KR" ? "목표 확인 필요" : "Goal needs confirmation");
  const fileText = files.slice(0, 3).map((file) => `\`${file}\``).join(", ") || (locale === "ko-KR" ? "변경 파일" : "changed files");
  const firstStep = nextSteps[0]?.replace(/^\d+\.\s*/, "").replace(/^먼저\s+/, "") ?? (locale === "ko-KR" ? "현재 Handoff를 확인합니다." : "Review the current Handoff.");
  if (locale === "ko-KR") {
    return [
      `이번 세션의 목표는 ${cleanGoal}`,
      `먼저 ${fileText}를 열어 변경 이유와 현재 요청 범위가 일치하는지 확인하세요.`,
      `그다음 ${firstStep}`,
      "문제가 있으면 관련 파일의 Handoff 생성 문구와 내부 분석값 필터링만 수정하세요.",
      "`pnpm run build`, `pnpm cli self-check`, `pnpm cli done`을 실행한 뒤 `.devguard/reports/project-handoff.md`를 직접 열어 결과를 확인하세요."
    ].join("\n");
  }
  return [
    `The current goal is: ${cleanGoal}`,
    `Open ${fileText} first and confirm the change rationale matches the current request.`,
    firstStep,
    "If there is a problem, only adjust the Handoff copy and internal-analysis filtering in the related file.",
    "Run `pnpm run build`, `pnpm cli self-check`, and `pnpm cli done`, then open `.devguard/reports/project-handoff.md` to verify the result."
  ].join("\n");
}

function formatCommandRunList(commands: string[]): string {
  return commands.map((command) => `\`${command}\``).join(", ");
}

function handoffVerificationCommands(quality: ParsedQuality, files: string[]): string[] {
  const commands = new Set<string>();
  if (files.some((file) => /runtime-state\.ts$/.test(file))) {
    commands.add("pnpm run build");
    commands.add("pnpm cli self-check");
    commands.add("pnpm cli done");
    return [...commands];
  }
  for (const command of quality.requiredVerification) commands.add(command);
  if (commands.size === 0) commands.add("pnpm run build");
  return [...commands];
}

function isRelevantHandoffReviewItem(item: string, files: string[]): boolean {
  if (files.some((file) => /runtime-state\.ts$/.test(file))) {
    return /handoff|quality report|보고서|인수|변경 범위|scope|문서|document/i.test(item) && !/api key|openai key|raw value|configured\/source/i.test(item);
  }
  return true;
}

function sanitizeHandoffText(value: string): string {
  return humanizeInternalSentence(value)
    .replace(/INTENT:\s*[^;\n]+;?\s*/gi, "")
    .replace(/SCOPE:\s*[^;\n]+;?\s*/gi, "")
    .replace(/confidence=\w+;?\s*/gi, "")
    .replace(/FLAGS:\s*[^;\n]+;?\s*/gi, "")
    .replace(/DRIFT:\s*\w+;?\s*/gi, "")
    .replace(/severity=\w+,?\s*/gi, "")
    .replace(/score=\d+,?\s*/gi, "")
    .replace(/alignment=\d+,?\s*/gi, "")
    .replace(/driftRisk=\d+,?\s*/gi, "")
    .replace(/semantic zone mismatch:[^;.\n]+;?\s*/gi, "")
    .replace(/low requirement similarity:[^;.\n]+;?\s*/gi, "")
    .replace(/conflicting domain:[^;.\n]+;?\s*/gi, "")
    .replace(/missing primary requirement domain;?\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[;,\s-]+|[;,\s-]+$/g, "");
}

function isUsefulHandoffText(value: string): boolean {
  const clean = value.trim();
  return clean.length > 0 && !/^(none|확인 필요|low|medium|high)$/i.test(clean) && !/^(INTENT|SCOPE|DRIFT):/i.test(clean);
}

function looksStaleHandoffTask(value: string, files: string[]): boolean {
  if (files.some((file) => /runtime-state\.ts$/.test(file)) && /api key|openai|raw key|configured\/source|config\/env key|missing or invalid keys|rule-based quality report|fallback/i.test(value)) {
    return true;
  }
  if (files.some((file) => /runtime-state\.ts$/.test(file)) && /regenerate the quality report|quality report.*first screen|what changed, what to do now/i.test(value) && !/handoff|인수/i.test(value)) {
    return true;
  }
  if (files.some((file) => /dashboard\.ts$/.test(file)) && /quality report intelligence|openai|api key/i.test(value)) {
    return true;
  }
  return false;
}

function localizeHandoffLines(lines: string[], locale: DevGuardLocale): string[] {
  if (locale === "en-US") return lines;
  return lines.map((line) => {
    if (!line.startsWith("- ")) return line;
    return `- ${localizeSentence(localizeHandoffSentence(line.slice(2)), locale)}`;
  });
}

function localizeHandoffSentence(value: string): string {
  return value
    .replace(/^status: completed$/, "상태: 완료")
    .replace(/^status: blocked$/, "상태: 차단됨")
    .replace(/^status: partially completed$/, "상태: 일부 완료")
    .replace(/^files: none$/, "변경 파일: 없음")
    .replace(/^files: /, "변경 파일: ")
    .replace(/^Last session:/, "마지막 세션:")
    .replace(/^Previous:/, "이전 세션:")
    .replace(/^Earlier:/, "그 이전 세션:")
    .replace(/^project:/, "프로젝트:")
    .replace(/^framework:/, "프레임워크:")
    .replace(/^language:/, "언어:")
    .replace(/^package manager:/, "패키지 매니저:")
    .replace(/^files indexed:/, "색인된 파일:")
    .replace(/^architecture modules:/, "아키텍처 모듈:")
    .replace(/^known commands\/apis:/, "알려진 명령/API:")
    .replace(/^Coverage: Complete$/, "포함 범위: 충분함")
    .replace(/^Redundancy: Low$/, "중복도: 낮음")
    .replace(/^Redundancy: Medium$/, "중복도: 보통")
    .replace(/^Readability: High$/, "가독성: 높음")
    .replace(/^Readability: Medium$/, "가독성: 보통")
    .replace("Dashboard UX and assistant guidance changed.", "Dashboard UX와 작업 안내가 변경되었습니다.")
    .replace("Session continuity and handoff generation changed.", "세션 연속성과 인수인계 생성 흐름이 변경되었습니다.")
    .replace("Project Knowledge generation or usage changed.", "Project Knowledge 생성 또는 사용 방식이 변경되었습니다.")
    .replace("Documentation updated to match the current workflow.", "현재 워크플로우에 맞게 문서가 업데이트되었습니다.")
    .replace("Configuration or dependency setup changed.", "설정 또는 의존성 구성이 변경되었습니다.")
    .replace("CLI behavior changed.", "CLI 동작이 변경되었습니다.")
    .replace("Hook status needs verification in the actual Claude/Codex environment.", "실제 Claude/Codex 환경에서 Hook 상태 확인이 필요합니다.")
    .replace("Codex Stop Hook format is configured; actual Codex runtime trust/execution still needs environment verification.", "Codex Stop Hook 형식은 설정되어 있지만, 실제 Codex 런타임 trust/execution 확인이 필요합니다.")
    .replace("Do not add polling completion, LLM API calls, git commits, or unrelated UX changes.", "polling 기반 완료 감지, LLM API 호출, git commit, 관련 없는 UX 변경은 추가하지 마세요.")
    .replace("`dev-guard watch` is the normal entry point; `done` writes reports, prompts, handoff, context, and project knowledge.", "`dev-guard watch`가 기본 시작점입니다. `done`은 보고서, 프롬프트, 인수인계, 컨텍스트, Project Knowledge를 생성합니다.");
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

function parseQuality(markdown: string): ParsedQuality {
  return {
    verdict: firstSectionBulletAny(markdown, ["Verdict", "판정", "Final Verdict", "최종 판정"]) ?? "확인 필요",
    why: extractSectionBulletsAny(markdown, ["Why", "판단 이유", "Why Review Is Needed", "왜 검토가 필요한가", "Why This Verdict", "왜 이 판정이 나왔는가"], 4),
    requiredVerification: extractSectionBulletsAny(markdown, ["Required Verification", "필요한 검증", "Verification To Run", "실행할 검증", "Next QA", "다음 QA"], 5),
    reviewItems: extractSectionBulletsAny(markdown, ["Additional Checks", "Review Items", "검토 권장 항목", "추가로 검토하면 좋은 점"], 6),
    blockedItems: extractSectionBulletsAny(markdown, ["Blocked Items", "먼저 해결해야 할 항목"], 6)
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
  for (const item of [
    ...extractSectionBulletsAny(input.qualityReport.content, ["Blocked Items", "먼저 해결해야 할 항목"], 5),
    ...extractSectionBulletsAny(input.qualityReport.content, ["Warnings", "Review Items", "검토 권장 항목"], 5)
  ]) {
    if (item !== "none" && item !== "확인 필요" && item !== "없음") risks.add(item);
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
  return extractSectionBulletsAny(markdown, [heading], limit);
}

function extractSectionBulletsAny(markdown: string, headings: string[], limit: number): string[] {
  const bullets = sectionLinesAny(markdown, headings)
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
  return firstSectionBulletAny(markdown, [heading]);
}

function firstSectionBulletAny(markdown: string, headings: string[]): string | undefined {
  const lines = sectionLinesAny(markdown, headings);
  const bullet = lines.map((line) => line.trim()).find((line) => /^[-*]\s+/.test(line) && !/TODO|확인 필요/i.test(line));
  return bullet?.replace(/^[-*]\s+/, "").trim();
}

function sectionLines(markdown: string, heading: string): string[] {
  return sectionLinesAny(markdown, [heading]);
}

function sectionLinesAny(markdown: string, headings: string[]): string[] {
  const lines = markdown.split(/\r?\n/);
  const headingSet = new Set(headings);
  const start = lines.findIndex((line) => headingSet.has(line.replace(/^#+\s*/, "").trim()));
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
