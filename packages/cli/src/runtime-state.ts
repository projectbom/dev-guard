import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { dirname, relative } from "node:path";
import { mkdir } from "node:fs/promises";
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
import { fromRoot, readJsonFile, readTextFile, writeFileIfMissing, writeTextFile } from "./fs.js";
import { getDiffForChangeFiles, getGitChanges, type GitChanges } from "./git.js";

const execFileAsync = promisify(execFile);

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
  await ensureDevguardWorkspace(root);
  return readJsonFile<RuntimeState>(fromRoot(root, runtimePath), defaultRuntime);
}

export async function writeRuntimeState(root: string, state: RuntimeState): Promise<void> {
  await ensureDevguardWorkspace(root);
  await writeTextFile(fromRoot(root, runtimePath), `${JSON.stringify(normalizeRuntimeState(state), null, 2)}\n`);
}

export async function resetRuntimeState(root: string): Promise<void> {
  await writeRuntimeState(root, defaultRuntime);
}

export async function readProjectState(root: string): Promise<ProjectState> {
  await ensureDevguardWorkspace(root);
  return readJsonFile<ProjectState>(fromRoot(root, statePath), {});
}

export async function writeProjectState(root: string, state: ProjectState): Promise<void> {
  await ensureDevguardWorkspace(root);
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
  await ensureDevguardWorkspace(root);
  const runtime = await readRuntimeState(root);
  const gitChanges = await loadChangesWithFallback(root, runtime);
  const changeFiles = filterDevGuardContextFiles(gitChanges.changeFiles, false);
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
    updateSummary: updateSuggestions.summary,
    diffStat,
    majorChanges: inferMajorChanges({ summary, changedFiles, areas, diffText }),
    testCandidates: inferTestCandidates({ areas, changedFiles })
  });
  const promptMarkdown = renderNextPrompt({
    summary,
    changedFiles,
    areas,
    judgments,
    drift,
    testCommands: inferTestCommands({ areas, changedFiles })
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
    `- ${new Date().toISOString()}`,
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
  summary: string;
  changedFiles: string[];
  areas: string[];
  judgments: string[];
  drift: string;
  testCommands: string[];
}): string {
  const focusFiles = input.changedFiles.slice(0, 12);
  return [
    "# Next Codex Prompt",
    "",
    "아래 현재 변경사항을 검토하고, 필요한 최소 수정만 진행해줘.",
    "",
    "## 현재 변경 요약",
    `- ${input.summary}`,
    `- areas: ${input.areas.join(", ")}`,
    `- drift: ${input.drift}`,
    "",
    "## 확인해야 할 파일",
    ...formatBullets(focusFiles),
    ...(input.changedFiles.length > focusFiles.length ? [`- ... +${input.changedFiles.length - focusFiles.length} files`] : []),
    "",
    "## 수정 목표",
    "- 위 변경사항이 현재 의도한 작업 범위와 맞는지 확인한다.",
    "- 누락된 마무리 수정이 있으면 관련 파일 안에서만 최소 변경한다.",
    "- 문서 업데이트가 필요하면 직접 덮어쓰지 말고 update 후보로 남긴다.",
    "",
    "## 수정 금지 범위",
    "- unrelated feature 추가 금지",
    "- auth/database/api/config 변경은 현재 변경 의도와 직접 관련 있을 때만 수정",
    "- devguard/reports, devguard/prompts, devguard/runtime.json 직접 수정 금지",
    "- 대규모 리팩터링 금지",
    "",
    "## 현재 확인 포인트",
    ...formatBullets(input.judgments.length > 0 ? input.judgments : ["No blocking local judgment inferred."]),
    "",
    "## 테스트 명령어",
    ...formatBullets(input.testCommands),
    "",
    "## 완료 후 보고 형식",
    "1. 수정한 파일",
    "2. 수정 이유",
    "3. 테스트 결과",
    "4. 남은 위험 또는 확인 필요 사항"
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

export async function ensureDevguardWorkspace(root: string): Promise<void> {
  await ensureDevguardDirs(root);
  await Promise.all([
    writeFileIfMissing(fromRoot(root, "devguard/project.md"), projectTemplate()),
    writeFileIfMissing(fromRoot(root, "devguard/architecture.md"), architectureTemplate()),
    writeFileIfMissing(fromRoot(root, "devguard/decisions.md"), decisionsTemplate()),
    writeFileIfMissing(fromRoot(root, "devguard/tasks.md"), tasksTemplate()),
    writeFileIfMissing(fromRoot(root, statePath), "{}\n"),
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

function inferTestCandidates(input: { areas: string[]; changedFiles: string[] }): string[] {
  const tests = new Set<string>();
  tests.add("pnpm run build");
  if (input.changedFiles.some((file) => file.includes("watch"))) tests.add("pnpm cli watch --stable-after 1 --compact");
  if (input.changedFiles.some((file) => file.includes("runtime") || file.includes("index.ts"))) tests.add("pnpm cli done");
  if (input.areas.includes("config")) tests.add("pnpm cli status");
  if (input.areas.includes("docs")) tests.add("pnpm cli update");
  return [...tests];
}

function inferTestCommands(input: { areas: string[]; changedFiles: string[] }): string[] {
  return inferTestCandidates(input);
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
