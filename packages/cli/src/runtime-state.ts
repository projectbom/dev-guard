import { createHash } from "node:crypto";
import { dirname, relative } from "node:path";
import { mkdir } from "node:fs/promises";
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
import { fromRoot, readJsonFile, readTextFile, writeTextFile } from "./fs.js";
import { getDiffForChangeFiles, getGitChanges, type GitChanges } from "./git.js";

export interface RuntimeState {
  pendingChangedFiles: string[];
  firstChangedAt?: string;
  lastChangedAt?: string;
  lastStableAt?: string;
  lastDiffHash?: string;
  lastStatus?: "idle" | "active" | "ready_for_done" | "processed";
}

export interface ProjectState {
  lastProcessedAt?: string;
  lastSummary?: string;
  lastDrift?: "low" | "medium" | "high";
  lastChangedFiles?: string[];
  lastReportPath?: string;
  lastPromptPath?: string;
}

export interface DoneProcessingResult {
  changedFiles: string[];
  areas: string[];
  judgments: string[];
  reportPath: string;
  promptPath: string;
  summary: string;
  drift: "low" | "medium" | "high";
}

const runtimePath = "devguard/runtime.json";
const statePath = "devguard/state.json";
const reportPath = "devguard/reports/last-run.md";
const promptPath = "devguard/prompts/next-codex-prompt.md";

const defaultRuntime: RuntimeState = {
  pendingChangedFiles: [],
  lastStatus: "idle"
};

export async function readRuntimeState(root: string): Promise<RuntimeState> {
  return readJsonFile<RuntimeState>(fromRoot(root, runtimePath), defaultRuntime);
}

export async function writeRuntimeState(root: string, state: RuntimeState): Promise<void> {
  await writeTextFile(fromRoot(root, runtimePath), `${JSON.stringify(normalizeRuntimeState(state), null, 2)}\n`);
}

export async function resetRuntimeState(root: string): Promise<void> {
  await writeRuntimeState(root, defaultRuntime);
}

export async function readProjectState(root: string): Promise<ProjectState> {
  return readJsonFile<ProjectState>(fromRoot(root, statePath), {});
}

export async function writeProjectState(root: string, state: ProjectState): Promise<void> {
  await writeTextFile(fromRoot(root, statePath), `${JSON.stringify(state, null, 2)}\n`);
}

export async function recordRuntimeChange(root: string, path: string): Promise<RuntimeState> {
  const normalized = normalizeEventPath(root, path);
  if (!normalized || isIgnoredWatchPath(normalized)) {
    return readRuntimeState(root);
  }
  const now = new Date().toISOString();
  const current = await readRuntimeState(root);
  const pendingChangedFiles = [...new Set([...current.pendingChangedFiles, normalized])].sort();
  const next: RuntimeState = {
    ...current,
    pendingChangedFiles,
    firstChangedAt: current.firstChangedAt ?? now,
    lastChangedAt: now,
    lastStatus: "active"
  };
  await writeRuntimeState(root, next);
  return next;
}

export async function markRuntimeStable(root: string, diffHash: string): Promise<RuntimeState> {
  const current = await readRuntimeState(root);
  const next: RuntimeState = {
    ...current,
    lastStableAt: new Date().toISOString(),
    lastDiffHash: diffHash,
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
    normalized.startsWith("devguard/reports/") ||
    normalized.startsWith("devguard/prompts/") ||
    /\.(png|jpe?g|gif|webp|avif|ico|svg|ttf|otf|woff2?|mp4|mov|mp3|wav|pdf|zip|gz)$/i.test(normalized)
  );
}

export async function processDoneEvent(root: string): Promise<DoneProcessingResult> {
  const runtime = await readRuntimeState(root);
  const gitChanges = await loadChangesWithFallback(root, runtime);
  const changeFiles = filterDevGuardContextFiles(gitChanges.changeFiles, false);
  const changedFiles = [...new Set((changeFiles.length > 0 ? changeFiles.map((file) => file.path) : runtime.pendingChangedFiles).filter((file) => !isIgnoredWatchPath(file)))].sort();
  const diffText = changeFiles.length > 0 ? await getDiffForChangeFiles(root, changeFiles).catch(() => gitChanges.diffText) : gitChanges.diffText;
  const [projectMarkdown, architectureMarkdown, decisionsMarkdown, tasksMarkdown, config, codeGraph] = await Promise.all([
    readTextFile(fromRoot(root, "devguard/project.md")),
    readTextFile(fromRoot(root, "devguard/architecture.md")),
    readTextFile(fromRoot(root, "devguard/decisions.md")),
    readTextFile(fromRoot(root, "devguard/tasks.md")),
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
  const reportMarkdown = renderLastRunReport({
    changedFiles,
    areas,
    judgments,
    summary,
    drift,
    updateSummary: updateSuggestions.summary
  });
  const promptMarkdown = renderNextPrompt({
    summary,
    changedFiles,
    areas,
    judgments,
    drift
  });
  await Promise.all([
    writeTextFile(fromRoot(root, reportPath), reportMarkdown),
    writeTextFile(fromRoot(root, promptPath), promptMarkdown),
    writeProjectState(root, {
      ...(await readProjectState(root)),
      lastProcessedAt: new Date().toISOString(),
      lastSummary: summary,
      lastDrift: drift,
      lastChangedFiles: changedFiles,
      lastReportPath: reportPath,
      lastPromptPath: promptPath
    }),
    resetRuntimeState(root)
  ]);
  return {
    changedFiles,
    areas,
    judgments,
    reportPath,
    promptPath,
    summary,
    drift
  };
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
    if (/^(app|pages|components|src\/app|src\/components|styles|public)\//i.test(file)) areas.add("ui");
  }
  return areas.size > 0 ? [...areas].sort() : ["unknown"];
}

export function hashRuntimeFiles(files: string[]): string {
  return createHash("sha1").update(files.join("\n")).digest("hex").slice(0, 12);
}

function normalizeRuntimeState(state: RuntimeState): RuntimeState {
  return {
    ...state,
    pendingChangedFiles: [...new Set(state.pendingChangedFiles ?? [])].filter((file) => !isIgnoredWatchPath(file)).sort()
  };
}

function normalizeEventPath(root: string, path: string): string {
  const relativePath = path.startsWith(root) ? relative(root, path) : path;
  return relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
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
  changedFiles: string[];
  areas: string[];
  judgments: string[];
  summary: string;
  drift: string;
  updateSummary: string;
}): string {
  return [
    "# dev-guard Last Run",
    "",
    `- processedAt: ${new Date().toISOString()}`,
    `- intent: ${input.summary}`,
    `- drift: ${input.drift}`,
    "",
    "## Changed Files",
    ...formatBullets(input.changedFiles),
    "",
    "## Areas",
    ...formatBullets(input.areas),
    "",
    "## Judgments",
    ...formatBullets(input.judgments),
    "",
    "## Docs Update Suggestion",
    `- ${input.updateSummary}`
  ].join("\n") + "\n";
}

function renderNextPrompt(input: {
  summary: string;
  changedFiles: string[];
  areas: string[];
  judgments: string[];
  drift: string;
}): string {
  return [
    "# Next Codex Prompt",
    "",
    "Use this as the next handoff context. Do not treat it as permission to rewrite unrelated files.",
    "",
    `SUMMARY: ${input.summary}`,
    `AREAS: ${input.areas.join(", ")}`,
    `DRIFT: ${input.drift}`,
    "",
    "FILES:",
    ...formatBullets(input.changedFiles.slice(0, 12)),
    "",
    "CHECK:",
    ...formatBullets(input.judgments.length > 0 ? input.judgments : ["No blocking local judgment inferred."]),
    "",
    "NEXT:",
    "- Review the files above.",
    "- Keep fixes scoped to the inferred areas.",
    "- Run build/check before committing."
  ].join("\n") + "\n";
}

function formatBullets(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- none"];
}

export async function ensureDevguardDirs(root: string): Promise<void> {
  await Promise.all([
    mkdir(dirname(fromRoot(root, reportPath)), { recursive: true }),
    mkdir(dirname(fromRoot(root, promptPath)), { recursive: true }),
    mkdir(dirname(fromRoot(root, runtimePath)), { recursive: true })
  ]);
}
