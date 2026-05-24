import {
  defaultConfig,
  analyzeFileRelevance,
  analyzeSemanticDrift,
  buildImpactHints,
  buildTaskCompletionCriteria,
  classifyTaskType,
  detectRequirementMismatch,
  defaultContextPriority,
  extractTaskAIKeywords,
  filterDevGuardContextFiles,
  generateCodexPrompt,
  generateTaskMarkdownResult,
  inferRelatedFileCandidates,
  isAlwaysIgnoredContextPath,
  NoneAIProvider,
  OpenAIProvider,
  selectRelatedFilesFromScan,
  type CodeGraphEntry,
  type FileSummary,
  type ImpactHint,
  type ProjectIndexEntry,
  type ProjectIdentity,
  type TaskAICodeContext,
  type TaskAIFileCandidate,
  type TaskTypeResult
} from "@dev-guard/core";
import { copyTextToClipboard } from "./clipboard.js";
import { filterCommandTargetCandidates, inferCommandTargetFiles, mergeCommandTargetCandidates } from "./command-targets.js";
import { loadConfig } from "./config.js";
import { fromRoot, readJsonFile, readTextFile, writeTextFile } from "./fs.js";
import { getGitChanges, getProjectFiles } from "./git.js";
import {
  formatProjectIdentityWarning,
  loadCurrentProjectIdentity,
  readStoredProjectIdentity,
  sameProjectIdentity
} from "./project-identity.js";
import { filterRelevantMarkdown, type MarkdownFilterResult } from "./rule-filter.js";
import { createRunLog, listRunLogs, logRunSaved } from "./runs.js";

interface TaskAIOptions {
  requirement: string;
  write: boolean;
  prompt: boolean;
  copy: boolean;
  contextFiles: number;
  codeContext: boolean;
  noCache: boolean;
  fresh: boolean;
  debugContext: boolean;
  saveRun: boolean;
}

const defaultContextFileLimit = 5;
const perFileCharacterLimit = 4000;
const totalCodeContextCharacterLimit = 12000;

export async function runTaskAI(root: string, args: string[]): Promise<void> {
  const options = parseTaskAIOptions(args);
  const resolvedConfig = await loadConfig(root);
  const config = resolvedConfig.config;
  const providerName = config.ai?.provider ?? defaultConfig.ai.provider ?? "none";
  const model = config.ai?.model ?? defaultConfig.ai.model ?? "gpt-4o-mini";
  const currentIdentity = await loadCurrentProjectIdentity(root).catch(() => undefined);

  const [gitChanges, projectMemory, rulesMarkdown, mistakesMarkdown, projectStateMarkdown, decisionsMarkdown] = await Promise.all([
    getGitChanges(root),
    loadProjectMemory(root, options.noCache || options.fresh, currentIdentity),
    readTextFile(fromRoot(root, ".devguard/rules.md")),
    readTextFile(fromRoot(root, ".devguard/mistakes.md")),
    readTextFile(fromRoot(root, "docs/PROJECT_STATE.md")),
    readTextFile(fromRoot(root, "docs/DECISIONS.md"))
  ]);
  if (projectMemory.fromCache && gitChanges.changedFiles.length > 0) {
    console.error("dev-guard task-ai: warning: scan cache may be stale because git changes exist. Run `dev-guard refresh` to update project memory.");
  }
  const taskChangeFiles = filterDevGuardContextFiles(gitChanges.changeFiles, false);
  const taskChangedFiles = [...new Set(taskChangeFiles.map((file) => file.path))].sort();
  const taskType = classifyTaskType(options.requirement);
  const completionCriteria = buildTaskCompletionCriteria(taskType);
  const scopedMemory = options.fresh
    ? { targetFiles: [], summary: ["fresh mode suppresses run memory"] }
    : await loadScopedTaskMemory(root, options.requirement, taskType, currentIdentity);
  const relevanceText = [options.requirement, taskChangedFiles.join("\n"), projectMemory.projectMapMarkdown].join("\n");
  const filteredRules = filterRelevantMarkdown(rulesMarkdown, relevanceText, currentIdentity, projectMemory.projectFiles.slice(0, 20));
  const filteredMistakes = filterRelevantMarkdown(mistakesMarkdown, relevanceText, currentIdentity, projectMemory.projectFiles.slice(0, 20));
  const filteredProjectState = options.fresh
    ? emptyMarkdownFilter(projectStateMarkdown, "fresh mode suppresses project docs")
    : filterRelevantMarkdown(projectStateMarkdown, relevanceText, currentIdentity, projectMemory.projectFiles.slice(0, 20));
  const filteredDecisions = options.fresh
    ? emptyMarkdownFilter(decisionsMarkdown, "fresh mode suppresses decisions")
    : filterRelevantMarkdown(decisionsMarkdown, relevanceText, currentIdentity, projectMemory.projectFiles.slice(0, 20));

  const relevanceCandidates = analyzeFileRelevance(options.requirement, projectMemory.projectFiles, {
    index: projectMemory.index,
    summaries: projectMemory.summaries,
    runTargetFiles: scopedMemory.targetFiles,
    codeGraph: projectMemory.codeGraph
  }).filter((candidate) => !isAlwaysIgnoredContextPath(candidate.path));
  const routedCandidates = routeCandidateFiles(taskType, options.requirement, projectMemory.projectFiles, relevanceCandidates, projectMemory);
  const relatedFileCandidates = routedCandidates.relatedFileCandidates;
  const scoredCandidates = routedCandidates.scoredCandidates;
  const impactHints = buildImpactHints([...taskChangedFiles, ...relatedFileCandidates], projectMemory.codeGraph);
  if (taskType.requiresPhasing) {
    console.error(`dev-guard task-ai: ${taskType.type}/large-task decomposition enabled. Strategy: ${taskType.strategy}.`);
  }
  const codeContexts = options.codeContext
    ? await collectCodeContexts(root, prioritizeChangedCandidates(scoredCandidates.filter((candidate) => candidate.role !== "ignored").map((candidate) => candidate.path), projectMemory.index), extractTaskAIKeywords(options.requirement), {
        maxFiles: options.contextFiles,
        perFileLimit: perFileCharacterLimit,
        totalLimit: totalCodeContextCharacterLimit
      })
    : [];

  if (options.debugContext) {
    printDebugContext({
      fromCache: projectMemory.fromCache,
      keywords: extractTaskAIKeywords(options.requirement),
      relatedFileCandidates,
      codeContextFiles: codeContexts.map((context) => context.path),
      scoredCandidates,
      impactHints,
      taskType,
      completionCriteria,
      requirementAnchor: options.requirement,
      taskSubtype: taskType.subtype,
      ignoredStaleContextSummary: summarizeSuppressedContext(filteredRules, filteredMistakes, filteredProjectState, filteredDecisions),
      scopedMemorySummary: scopedMemory.summary,
      mismatchResult: detectRequirementMismatch(
        [filteredProjectState.filteredMarkdown, filteredDecisions.filteredMarkdown].join("\n"),
        options.requirement,
        taskType
      ),
      driftResult: analyzeSemanticDrift(
        options.requirement,
        [filteredProjectState.filteredMarkdown, filteredDecisions.filteredMarkdown].join("\n"),
        taskType
      ),
      contextPriority: defaultContextPriority(),
      fresh: options.fresh,
      provider: providerName,
      model,
      configSource: resolvedConfig.source,
      rulesFilter: filteredRules,
      mistakesFilter: filteredMistakes
    });
  }

  if (providerName === "none") {
    throw new Error("AI provider가 none입니다. `dev-guard configure ai --provider openai --model gpt-4o-mini`로 먼저 설정하세요.");
  }

  if (providerName === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY 환경변수가 없습니다. API key는 config에 저장하지 말고 `OPENAI_API_KEY=...`로 설정해 주세요.");
  }

  const provider =
    providerName === "openai"
      ? new OpenAIProvider({
          apiKey: process.env.OPENAI_API_KEY ?? "",
          model,
          temperature: config.ai?.temperature,
          maxTokens: config.ai?.maxTokens,
          reasoningEffort: config.ai?.reasoningEffort,
          baseURL: config.ai?.baseURL
        })
      : new NoneAIProvider();
  const taskResult = await generateTaskMarkdownResult(
    provider,
    {
      requirement: options.requirement,
      rulesMarkdown: filteredRules.filteredMarkdown,
      mistakesMarkdown: filteredMistakes.filteredMarkdown,
      projectStateMarkdown: [filteredProjectState.filteredMarkdown, projectMemory.projectMapMarkdown].filter(Boolean).join("\n\n"),
      decisionsMarkdown: filteredDecisions.filteredMarkdown,
      changedFiles: taskChangedFiles,
      changeFiles: taskChangeFiles,
      diffText: buildFilteredDiffSummary(gitChanges.diffText, taskChangedFiles),
      projectFiles: projectMemory.projectFiles,
      relatedFileCandidates,
      fileCandidates: scoredCandidates,
      codeGraph: projectMemory.codeGraph,
      impactHints,
      codeContexts,
      taskType,
      completionCriteria
    },
    model
  );
  const taskMarkdown = taskResult.markdown;
  if (taskResult.scopeFilledFromCandidates) {
    console.error("dev-guard task-ai: scope filled from related file candidates");
  }

  if (options.write) {
    await writeTextFile(fromRoot(root, ".devguard/task.md"), taskMarkdown);
    console.error("dev-guard task-ai: .devguard/task.md updated");
  } else {
    console.error("dev-guard task-ai: preview only. 저장하려면 --write를 사용하세요.");
    console.error("dev-guard task-ai: Codex 프롬프트도 보려면 --prompt, 클립보드 복사는 --copy를 사용하세요.");
  }

  const codexPrompt =
    options.prompt || options.copy || options.saveRun
      ? generateCodexPrompt({
          taskMarkdown,
          rulesMarkdown: filteredRules.filteredMarkdown,
          mistakesMarkdown: filteredMistakes.filteredMarkdown,
          projectStateMarkdown: filteredProjectState.filteredMarkdown,
          decisionsMarkdown: filteredDecisions.filteredMarkdown,
          changedFiles: taskChangedFiles,
          changeFiles: taskChangeFiles,
          diffText: buildFilteredDiffSummary(gitChanges.diffText, taskChangedFiles),
          compact: true,
          density: "ultra",
          maxPromptTokens: 2500,
          impactHints
        }).promptText
      : undefined;

  if (options.copy && codexPrompt) {
    const result = await copyTextToClipboard(codexPrompt);
    if (result.ok) {
      console.error("dev-guard task-ai: copied Codex prompt to clipboard.");
    } else {
      console.error(`dev-guard task-ai: clipboard copy failed (${result.reason}).`);
    }
  }

  console.log(taskMarkdown);

  if (options.prompt && codexPrompt) {
    console.log("\n---\n");
    console.log(codexPrompt);
  }

  if ((options.write && options.prompt && options.copy) || options.saveRun) {
    const run = await createRunLog(root, {
      command: "task-ai",
      userRequest: options.requirement,
      generatedTaskMarkdown: taskMarkdown,
      generatedCodexPrompt: codexPrompt,
      relatedFiles: relatedFileCandidates,
      model,
      provider: providerName,
      changedFilesAtCreation: taskChangedFiles,
      projectIdentity: currentIdentity,
      status: "created"
    });
    logRunSaved(run);
  }
}

function parseTaskAIOptions(args: string[]): TaskAIOptions {
  const write = args.includes("--write");
  const prompt = args.includes("--prompt");
  const copy = args.includes("--copy");
  const codeContext = !args.includes("--no-code-context");
  const noCache = args.includes("--no-cache");
  const fresh = args.includes("--fresh");
  const debugContext = args.includes("--debug-context");
  const saveRun = args.includes("--save-run");
  const contextFiles = parseNumberOption(args, "--context-files", defaultContextFileLimit);
  const requirement = collectRequirementArgs(args).join(" ").trim();

  if (!requirement) {
    throw new Error('요구사항을 입력해 주세요. 예: dev-guard task-ai "README 사용법을 보강해줘"');
  }

  return {
    requirement,
    write,
    prompt,
    copy,
    contextFiles,
    codeContext,
    noCache,
    fresh,
    debugContext,
    saveRun
  };
}

function summarizeSuppressedContext(...filters: MarkdownFilterResult[]): string[] {
  return filters
    .flatMap((filter) => filter.suppressed ?? [])
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function emptyMarkdownFilter(markdown: string, reason: string): MarkdownFilterResult {
  const suppressed = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((line) => `${reason}: ${line.slice(0, 80)}`);
  return {
    filteredMarkdown: "",
    loaded: suppressed.length,
    relevant: 0,
    suppressed
  };
}

async function loadScopedTaskMemory(
  root: string,
  requirement: string,
  taskType: TaskTypeResult,
  currentIdentity?: ProjectIdentity
): Promise<{ targetFiles: string[]; summary: string[] }> {
  const runs = await listRunLogs(root);
  const requirementDrift = (text: string) => analyzeSemanticDrift(requirement, text, taskType);
  const related = runs
    .filter((run) => !currentIdentity || !run.projectIdentity || sameProjectIdentity(currentIdentity, run.projectIdentity))
    .map((run) => {
      const text = [run.title, run.userRequest, run.generatedTaskMarkdown].filter(Boolean).join("\n");
      const drift = requirementDrift(text);
      const decay = memoryDecay(run.createdAt);
      const subtypeBoost = text.includes(taskType.subtype ?? taskType.type) ? 1.5 : 0;
      const rawScore = (drift.severity === "low" ? 4 : drift.severity === "medium" ? 1 : -4) + (run.relatedFiles?.length ? 1 : 0) + subtypeBoost;
      const score = Number((rawScore * decay).toFixed(2));
      return { run, drift, score, decay };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.run.createdAt) - Date.parse(a.run.createdAt))
    .slice(0, 5);

  return {
    targetFiles: [...new Set(related.flatMap((entry) => entry.run.relatedFiles ?? []))].slice(0, 12),
    summary: related.map((entry) => `${entry.run.id} score=${entry.score} decay=${entry.decay.toFixed(2)} drift=${entry.drift.severity}`)
  };
}

function memoryDecay(createdAt: string): number {
  const ageDays = (Date.now() - Date.parse(createdAt)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays <= 7) {
    return 1;
  }
  if (ageDays <= 30) {
    return 0.8;
  }
  if (ageDays <= 90) {
    return 0.5;
  }
  if (ageDays <= 180) {
    return 0.25;
  }
  return 0.1;
}

function printDebugContext(debug: {
  fromCache: boolean;
  keywords: string[];
  relatedFileCandidates: string[];
  codeContextFiles: string[];
  scoredCandidates: TaskAIFileCandidate[];
  impactHints: ImpactHint[];
  taskType: TaskTypeResult;
  completionCriteria: ReturnType<typeof buildTaskCompletionCriteria>;
  requirementAnchor: string;
  taskSubtype?: string;
  ignoredStaleContextSummary: string[];
  scopedMemorySummary: string[];
  mismatchResult: string[];
  driftResult: ReturnType<typeof analyzeSemanticDrift>;
  contextPriority: ReturnType<typeof defaultContextPriority>;
  fresh: boolean;
  provider: string;
  model: string;
  configSource: string;
  rulesFilter: MarkdownFilterResult;
  mistakesFilter: MarkdownFilterResult;
}): void {
  console.error("dev-guard task-ai debug context");
  console.error(`- scan cache: ${debug.fromCache ? "yes" : "no"}`);
  console.error(`- fresh mode: ${debug.fresh ? "yes" : "no"}`);
  console.error(`- requirement anchor: ${debug.requirementAnchor}`);
  console.error("- context priority:");
  console.error(`  requirement=${debug.contextPriority.requirement}, relatedCode=${debug.contextPriority.relatedCode}, subtype=${debug.contextPriority.taskSubtypeContext}, run=${debug.contextPriority.recentRun}, memory=${debug.contextPriority.projectMemory}, staleDocs=${debug.contextPriority.staleDocs}`);
  console.error(`- provider: ${debug.provider}`);
  console.error(`- model: ${debug.model}`);
  console.error(`- config source: ${debug.configSource}`);
  console.error("- task type:");
  console.error(`  type: ${debug.taskType.type}`);
  if (debug.taskSubtype) {
    console.error(`  subtype: ${debug.taskSubtype}`);
  }
  console.error(`  confidence: ${debug.taskType.confidence}`);
  console.error(`  strategy: ${debug.taskType.strategy}`);
  console.error(`  risk: ${debug.taskType.riskLevel}`);
  console.error(`  requires phasing: ${debug.taskType.requiresPhasing ? "true" : "false"}`);
  console.error(`  reasons: ${debug.taskType.reasons.length > 0 ? debug.taskType.reasons.join("; ") : "none"}`);
  console.error(`  domain: ${debug.taskType.domainKeywords?.length ? debug.taskType.domainKeywords.join(", ") : "none"}`);
  console.error("- stale context guard:");
  console.error(`  ignored stale contexts: ${debug.ignoredStaleContextSummary.length}`);
  for (const item of debug.ignoredStaleContextSummary.slice(0, 5)) {
    console.error(`  - ${item}`);
  }
  console.error(`  mismatch check: ${debug.mismatchResult.length > 0 ? debug.mismatchResult.join("; ") : "pass"}`);
  console.error(`  drift: ${debug.driftResult.severity} score=${debug.driftResult.driftScore} similarity=${debug.driftResult.similarity.toFixed(2)}`);
  console.error(`  drift domains: requirement=${debug.driftResult.requirementDomains.join(", ") || "none"} generated=${debug.driftResult.generatedDomains.join(", ") || "none"}`);
  console.error("- scoped task memory:");
  console.error(`  related memories: ${debug.scopedMemorySummary.length}`);
  for (const item of debug.scopedMemorySummary.slice(0, 5)) {
    console.error(`  - ${item}`);
  }
  console.error("- completion criteria:");
  for (const check of debug.completionCriteria.requiredChecks.slice(0, 8)) {
    console.error(`  required: ${check}`);
  }
  for (const failure of (debug.completionCriteria.blockingFailures ?? []).slice(0, 6)) {
    console.error(`  blocking: ${failure}`);
  }
  console.error(`- extracted keywords: ${debug.keywords.length > 0 ? debug.keywords.join(", ") : "none"}`);
  console.error(`- scored candidates (${debug.scoredCandidates.length}):`);
  for (const candidate of debug.scoredCandidates.slice(0, 20)) {
    console.error(`  - ${candidate.path}`);
    console.error(`    score: ${candidate.score}`);
    console.error(`    role: ${candidate.role}`);
    console.error(`    reasons: ${candidate.reasons.length > 0 ? candidate.reasons.join("; ") : "none"}`);
    console.error(`    negative reasons: ${candidate.negativeReasons.length > 0 ? candidate.negativeReasons.join("; ") : "none"}`);
  }
  console.error(`- impact hints (${debug.impactHints.length}):`);
  for (const hint of debug.impactHints.slice(0, 8)) {
    console.error(`  - ${hint.file}`);
    console.error(`    imported by: ${hint.importedByCount}`);
    console.error(`    affected areas: ${hint.affectedAreas.join(", ") || "unknown"}`);
    console.error(`    examples: ${hint.importedBy.slice(0, 4).join(", ") || "none"}`);
  }
  console.error(`- code context files (${debug.codeContextFiles.length}):`);
  for (const file of debug.codeContextFiles) {
    console.error(`  - ${file}`);
  }
  console.error(`- candidate files sent to AI: ${debug.relatedFileCandidates.length}`);
  printMarkdownFilterDebug("rules", debug.rulesFilter);
  printMarkdownFilterDebug("mistakes", debug.mistakesFilter);
}

function printMarkdownFilterDebug(label: string, filter: MarkdownFilterResult): void {
  console.error(`- loaded ${label}: ${filter.loaded}`);
  console.error(`- relevant ${label}: ${filter.relevant}`);
  console.error(`- suppressed ${label}: ${filter.suppressed.length}`);
  for (const item of filter.suppressed.slice(0, 10)) {
    console.error(`  - ${item}`);
  }
}

async function loadProjectMemory(
  root: string,
  noCache: boolean,
  currentIdentity?: ProjectIdentity
): Promise<{
  fromCache: boolean;
  projectFiles: string[];
  index: ProjectIndexEntry[];
  summaries: FileSummary[];
  projectMapMarkdown: string;
  codeGraph: CodeGraphEntry[];
}> {
  if (!noCache) {
    const [index, summaries, projectMapMarkdown, codeGraph, storedIdentity] = await Promise.all([
      readJsonFile<ProjectIndexEntry[]>(fromRoot(root, ".devguard/project-index.json"), []),
      readJsonFile<FileSummary[]>(fromRoot(root, ".devguard/file-summaries.json"), []),
      readTextFile(fromRoot(root, ".devguard/project-map.md")),
      readJsonFile<CodeGraphEntry[]>(fromRoot(root, ".devguard/code-graph.json"), []),
      readStoredProjectIdentity(root)
    ]);

    if (index.length > 0) {
      if (!currentIdentity || !sameProjectIdentity(currentIdentity, storedIdentity)) {
        console.error(
          `dev-guard task-ai: warning: ${formatProjectIdentityWarning(
            "scan cache",
            currentIdentity ?? { fingerprint: "unknown", root, frameworkKeywords: [] },
            storedIdentity
          )}`
        );
      } else {
        const projectFiles = index.map((entry) => entry.path).filter((path) => !isAlwaysIgnoredContextPath(path));
        console.error("dev-guard task-ai: using scan cache from .devguard/project-index.json");
        return {
          fromCache: true,
          projectFiles,
          index: index.filter((entry) => !isAlwaysIgnoredContextPath(entry.path)),
          summaries: summaries.filter((summary) => !isAlwaysIgnoredContextPath(summary.path)),
          projectMapMarkdown,
          codeGraph: codeGraph.filter((entry) => !isAlwaysIgnoredContextPath(entry.file))
        };
      }
    }
  }

  const projectFiles = await getProjectFiles(root);
  return {
    fromCache: false,
    projectFiles,
    index: [],
    summaries: [],
    projectMapMarkdown: "",
    codeGraph: []
  };
}

function mergeCandidates(...candidateGroups: string[][]): string[] {
  return [...new Set(candidateGroups.flat())].slice(0, 30);
}

function mergeScoredCandidates(scored: TaskAIFileCandidate[], paths: string[]): TaskAIFileCandidate[] {
  const byPath = new Map(scored.map((candidate) => [candidate.path, candidate]));
  for (const path of paths) {
    if (!byPath.has(path)) {
      byPath.set(path, {
        path,
        score: 5,
        reasons: ["fallback candidate"],
        negativeReasons: [],
        role: "reference"
      });
    }
  }

  return [...byPath.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 30);
}

function filterCandidateFiles(candidates: string[]): string[] {
  return candidates.filter((candidate) => !isAlwaysIgnoredContextPath(candidate));
}

function routeCandidateFiles(
  taskType: TaskTypeResult,
  requirement: string,
  projectFiles: string[],
  relevanceCandidates: TaskAIFileCandidate[],
  projectMemory: { fromCache: boolean; index: ProjectIndexEntry[]; summaries: FileSummary[] }
): { relatedFileCandidates: string[]; scoredCandidates: TaskAIFileCandidate[] } {
  const commandTarget = inferCommandTargetFiles(requirement, projectFiles);
  const genericCandidates = filterCandidateFiles(
    mergeCandidates(
      relevanceCandidates.filter((candidate) => candidate.role !== "ignored").map((candidate) => candidate.path),
      projectMemory.fromCache ? selectRelatedFilesFromScan(requirement, projectMemory.index, projectMemory.summaries) : [],
      inferRelatedFileCandidates(requirement, projectFiles)
    )
  );

  if (taskType.type === "i18n") {
    const relatedFileCandidates = inferI18nCandidateFiles(projectFiles);
    return {
      relatedFileCandidates,
      scoredCandidates: scoreTaskTypeCandidates(taskType, relatedFileCandidates, projectFiles)
    };
  }

  if (taskType.type === "docs" || taskType.type === "infra_config" || taskType.type === "architecture" || taskType.type === "migration") {
    const relatedFileCandidates = inferTaskTypeCandidateFiles(taskType, projectFiles, genericCandidates);
    return {
      relatedFileCandidates,
      scoredCandidates: scoreTaskTypeCandidates(taskType, relatedFileCandidates, projectFiles)
    };
  }

  if (commandTarget && (taskType.subtype === "cli_output_polish" || /명령|command|출력|output|요약|summary|preview/i.test(requirement))) {
    const commandRelated = [...commandTarget.edit, ...commandTarget.reference];
    const nonCommandGeneric = genericCandidates.filter((file) => !/(^|\/)update\.ts$/.test(file) || commandRelated.includes(file));
    const scopedRelevanceCandidates = filterCommandTargetCandidates(relevanceCandidates, commandTarget);
    const scoredCandidates = mergeCommandTargetCandidates(mergeScoredCandidates(scopedRelevanceCandidates, nonCommandGeneric), commandTarget);
    return {
      relatedFileCandidates: filterCandidateFiles(scoredCandidates.filter((candidate) => candidate.role !== "ignored").map((candidate) => candidate.path)),
      scoredCandidates
    };
  }

  return {
    relatedFileCandidates: genericCandidates,
    scoredCandidates: mergeScoredCandidates(relevanceCandidates, genericCandidates)
  };
}

function inferI18nCandidateFiles(projectFiles: string[]): string[] {
  const fileSet = new Set(projectFiles);
  const existingI18n = projectFiles.filter((file) => /(^|\/)(i18n|locale|locales|messages|translations|dictionaries)(\/|\.|-|_)/i.test(file));
  const candidates = existingI18n.length > 0 ? existingI18n.slice(0, 5) : ["lib/i18n/config.ts", "messages/ko.json", "messages/en.json"];
  const layout = ["app/layout.tsx", "src/app/layout.tsx", "pages/_app.tsx", "src/pages/_app.tsx"].find((file) => fileSet.has(file));
  if (layout) {
    candidates.push(layout);
  }

  const samplePage =
    [
      "app/about/page.tsx",
      "src/app/about/page.tsx",
      "app/about/service/page.tsx",
      "src/app/about/service/page.tsx",
      "app/page.tsx",
      "src/app/page.tsx",
      "pages/index.tsx",
      "src/pages/index.tsx"
    ].find((file) => fileSet.has(file)) ??
    projectFiles.find((file) => /(^|\/)(about|landing|public|home)(\/|[-_.])/.test(file) && /\.(tsx|jsx|ts|js)$/.test(file));
  if (samplePage) {
    candidates.push(samplePage);
  }

  return filterCandidateFiles([...new Set(candidates)]).slice(0, 8);
}

function inferTaskTypeCandidateFiles(taskType: TaskTypeResult, projectFiles: string[], fallback: string[]): string[] {
  const docsCandidates = projectFiles.filter((file) => /(^|\/)(README|CHANGELOG|CONTRIBUTING|docs\/|\.md$)/i.test(file));
  const infraCandidates = projectFiles.filter((file) =>
    /(^|\/)(package\.json|pnpm-workspace\.yaml|tsconfig|next\.config|vite\.config|tailwind\.config|postcss\.config|eslint\.config|biome\.json|\.github\/|vercel\.json|netlify\.toml|Dockerfile|docker-compose|supabase\/config)/i.test(file)
  );
  const architectureCandidates = projectFiles.filter((file) =>
    /(^|\/)(lib|src|packages|app\/layout|providers?|context|config|middleware)\//i.test(file) || /(^|\/)(middleware|next\.config|vite\.config|package\.json)/i.test(file)
  );

  if (taskType.type === "docs") {
    return filterCandidateFiles(docsCandidates.length > 0 ? docsCandidates : ["README.md", "docs/"]);
  }

  if (taskType.type === "infra_config") {
    return filterCandidateFiles(infraCandidates.length > 0 ? infraCandidates : ["package.json", ".env.example", "next.config.ts"]);
  }

  if (taskType.type === "architecture" || taskType.type === "migration") {
    return filterCandidateFiles((architectureCandidates.length > 0 ? architectureCandidates : fallback).slice(0, 8));
  }

  return filterCandidateFiles(fallback);
}

function scoreTaskTypeCandidates(taskType: TaskTypeResult, candidates: string[], projectFiles: string[]): TaskAIFileCandidate[] {
  const fileSet = new Set(projectFiles);
  return candidates.map((path, index) => {
    const isStructure = /(^|\/)(i18n|locale|locales|messages|translations|dictionaries)(\/|\.|-|_)/i.test(path);
    const isLayout = /(^|\/)(layout|_app)\.(tsx|jsx|ts|js)$/i.test(path);
    const isDocs = taskType.type === "docs";
    const isInfra = taskType.type === "infra_config";
    const role: TaskAIFileCandidate["role"] =
      taskType.type === "i18n" ? (isStructure || isLayout ? "edit" : "reference") : index < 5 ? "edit" : "reference";
    const reasons = [
      taskType.type === "i18n" && isStructure ? "i18n structure candidate" : "",
      taskType.type === "i18n" && isLayout ? "provider/wiring candidate" : "",
      isDocs ? "docs strategy candidate" : "",
      isInfra ? "infra/config strategy candidate" : "",
      taskType.type === "architecture" || taskType.type === "migration" ? "phased structure candidate" : "",
      !fileSet.has(path) ? "new file candidate" : "existing project file",
      role === "reference" ? "single representative sample screen" : ""
    ].filter(Boolean);
    return {
      path,
      score: 100 - index,
      reasons,
      negativeReasons: [],
      role
    };
  });
}

function buildFilteredDiffSummary(diffText: string, changedFiles: string[]): string {
  if (!diffText.trim() || changedFiles.length === 0) {
    return "";
  }

  const allowed = new Set(changedFiles);
  const blocks = diffText.split(/(?=^diff --git\s+)/m);
  const keptBlocks = blocks.filter((block) => {
    if (!block.startsWith("diff --git ")) {
      return block
        .split("\n")
        .some((line) => {
          const match = line.match(/^Untracked file:\s+(.+?)\s+-/);
          return match?.[1] ? allowed.has(match[1]) : false;
        });
    }

    const match = block.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/m);
    return Boolean(match && (allowed.has(match[1]) || allowed.has(match[2])));
  });

  return keptBlocks.join("").trim();
}

function prioritizeChangedCandidates(candidates: string[], index: ProjectIndexEntry[]): string[] {
  if (index.length === 0) {
    return candidates;
  }

  const lastModifiedByPath = new Map(index.map((entry) => [entry.path, entry.lastModified]));
  return [...candidates].sort((a, b) => {
    const aTime = Date.parse(lastModifiedByPath.get(a) ?? "1970-01-01T00:00:00.000Z");
    const bTime = Date.parse(lastModifiedByPath.get(b) ?? "1970-01-01T00:00:00.000Z");
    return bTime - aTime;
  });
}

async function collectCodeContexts(
  root: string,
  candidateFiles: string[],
  keywords: string[],
  limits: {
    maxFiles: number;
    perFileLimit: number;
    totalLimit: number;
  }
): Promise<TaskAICodeContext[]> {
  const contexts: TaskAICodeContext[] = [];
  let totalLength = 0;

  for (const file of candidateFiles.slice(0, limits.maxFiles)) {
    if (totalLength >= limits.totalLimit) {
      break;
    }

    const remaining = limits.totalLimit - totalLength;
    const perFileLimit = Math.min(limits.perFileLimit, remaining);
    const content = await readTextFile(fromRoot(root, file));
    if (!content.trim()) {
      continue;
    }

    const context = buildCodeContext(file, content, keywords, perFileLimit);
    contexts.push(context);
    totalLength += context.excerpt.length;
  }

  return contexts;
}

function buildCodeContext(path: string, content: string, keywords: string[], maxCharacters: number): TaskAICodeContext {
  const lines = content.split("\n");
  const matchedKeywords = keywords.filter((keyword) => content.toLowerCase().includes(keyword.toLowerCase()));
  const excerpt = matchedKeywords.length > 0 ? keywordExcerpt(lines, matchedKeywords, maxCharacters) : headExcerpt(content, maxCharacters);

  return {
    path,
    matchedKeywords,
    excerpt,
    truncated: content.length > excerpt.length
  };
}

function keywordExcerpt(lines: string[], keywords: string[], maxCharacters: number): string {
  const selected = new Set<number>();
  const headLineCount = Math.min(lines.length, 40);

  for (let index = 0; index < headLineCount; index += 1) {
    selected.add(index);
  }

  for (const keyword of keywords) {
    const lowerKeyword = keyword.toLowerCase();
    lines.forEach((line, index) => {
      if (!line.toLowerCase().includes(lowerKeyword)) {
        return;
      }

      for (let cursor = Math.max(0, index - 8); cursor <= Math.min(lines.length - 1, index + 12); cursor += 1) {
        selected.add(cursor);
      }
    });
  }

  if (selected.size === 0) {
    return headExcerpt(lines.join("\n"), maxCharacters);
  }

  const chunks: string[] = [];
  let previous = -2;
  for (const lineIndex of [...selected].sort((a, b) => a - b)) {
    if (lineIndex > previous + 1 && chunks.length > 0) {
      chunks.push("...");
    }
    chunks.push(`${lineIndex + 1}: ${lines[lineIndex]}`);
    previous = lineIndex;

    if (chunks.join("\n").length >= maxCharacters) {
      break;
    }
  }

  return trimToLimit(chunks.join("\n"), maxCharacters);
}

function headExcerpt(content: string, maxCharacters: number): string {
  return trimToLimit(content, maxCharacters);
}

function trimToLimit(content: string, maxCharacters: number): string {
  if (content.length <= maxCharacters) {
    return content;
  }

  return `${content.slice(0, Math.max(0, maxCharacters - 80)).trimEnd()}\n... truncated by dev-guard code context limit ...`;
}

function parseNumberOption(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index < 0) {
    return fallback;
  }

  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 옵션에는 1 이상의 숫자가 필요합니다.`);
  }

  return value;
}

function collectRequirementArgs(args: string[]): string[] {
  const requirement: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--context-files") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }
    requirement.push(arg);
  }

  return requirement;
}
