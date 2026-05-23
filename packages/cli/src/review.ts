import {
  defaultConfig,
  analyzeGeneratedDiffDrift,
  scoreWorkflowQuality,
  filterDevGuardContextFiles,
  buildReviewFixPrompt,
  generateReviewResult,
  isAlwaysIgnoredContextPath,
  NoneAIProvider,
  OpenAIProvider,
  type DevGuardRunLog,
  type FileSummary,
  type ProjectIdentity,
  type ReviewResult,
  type ReviewFileContext,
  type ReviewMemorySummary
} from "@dev-guard/core";
import { copyTextToClipboard } from "./clipboard.js";
import { loadConfig } from "./config.js";
import { fromRoot, readJsonFile, readTextFile, writeTextFile } from "./fs.js";
import { getCommitGitChanges, getDiffForChangeFiles, getGitChanges, getStagedGitChanges, type GitChanges } from "./git.js";
import {
  formatProjectIdentityWarning,
  loadCurrentProjectIdentity,
  readStoredProjectIdentity,
  sameProjectIdentity
} from "./project-identity.js";
import { filterRelevantMarkdown } from "./rule-filter.js";
import { listRunLogs, readLatestRun, readRunById, updateRunLog } from "./runs.js";
import { recordDriftTelemetry } from "./drift-telemetry.js";

interface ReviewOptions {
  output?: string;
  copyFix: boolean;
  copy: boolean;
  fixPrompt: boolean;
  includeContextFiles: boolean;
  staged: boolean;
  commit?: string;
  runId?: string;
  noRun: boolean;
  heuristic: boolean;
}

interface FixPromptOptions {
  output?: string;
  copy: boolean;
  includeContextFiles: boolean;
  staged: boolean;
  commit?: string;
  runId?: string;
  noRun: boolean;
}

interface ReviewTargetOptions {
  includeContextFiles: boolean;
  staged: boolean;
  commit?: string;
  runId?: string;
  noRun?: boolean;
  heuristic?: boolean;
}

const untrackedFileLimit = 5;
const perFileCharacterLimit = 4000;
const totalUntrackedCharacterLimit = 12000;

export async function runReview(root: string, args: string[]): Promise<void> {
  const options = parseReviewOptions(args);
  const review = await executeReview(root, options);

  if (!review) {
    return;
  }

  const fixPrompt = buildReviewFixPrompt({
    review: review.result,
    taskMarkdown: review.taskMarkdown,
    changedFiles: review.changedFiles,
    changeFiles: review.changeFiles
  });

  if (options.output) {
    await writeTextFile(fromRoot(root, options.output), `${review.result.markdown}\n`);
    console.error(`dev-guard review: wrote ${options.output}`);
  }

  if (options.copyFix) {
    const copyResult = await copyTextToClipboard(review.result.fixPrompt);
    if (copyResult.ok) {
      console.error("dev-guard review: copied Codex 재수정 프롬프트 to clipboard.");
    } else {
      console.error(`dev-guard review: clipboard copy failed (${copyResult.reason}).`);
    }
  }

  if (options.fixPrompt && options.copy) {
    const copyResult = await copyTextToClipboard(fixPrompt.promptText);
    if (copyResult.ok) {
      console.error("dev-guard review: copied generated fix prompt to clipboard.");
    } else {
      console.error(`dev-guard review: fix prompt clipboard copy failed (${copyResult.reason}).`);
    }
  }

  if (review.runLog) {
    await updateRunLog(root, review.runLog.id, {
      status: "reviewed",
      reviewResult: review.result.markdown,
      fixPrompt: fixPrompt.promptText,
      targetFiles: review.changedFiles,
      reason: review.result.status
    });
  }

  console.log(review.result.markdown);

  if (options.fixPrompt) {
    console.log("\n---\n");
    console.log(fixPrompt.promptText);
  }
}

export async function runFixPrompt(root: string, args: string[]): Promise<void> {
  const options = parseFixPromptOptions(args);
  const review = await executeReview(root, {
    includeContextFiles: options.includeContextFiles,
    staged: options.staged,
    commit: options.commit,
    runId: options.runId,
    noRun: options.noRun
  });

  if (!review) {
    return;
  }

  const fixPrompt = buildReviewFixPrompt({
    review: review.result,
    taskMarkdown: review.taskMarkdown,
    changedFiles: review.changedFiles,
    changeFiles: review.changeFiles
  });

  if (options.output) {
    await writeTextFile(fromRoot(root, options.output), `${fixPrompt.promptText}\n`);
    console.error(`dev-guard fix-prompt: wrote ${options.output}`);
  }

  if (options.copy) {
    const copyResult = await copyTextToClipboard(fixPrompt.promptText);
    if (copyResult.ok) {
      console.error("dev-guard fix-prompt: copied to clipboard.");
    } else {
      console.error(`dev-guard fix-prompt: clipboard copy failed (${copyResult.reason}).`);
    }
  }

  if (review.runLog) {
    await updateRunLog(root, review.runLog.id, {
      status: "reviewed",
      reviewResult: review.result.markdown,
      fixPrompt: fixPrompt.promptText,
      targetFiles: review.changedFiles,
      reason: review.result.status
    });
  }

  console.log(fixPrompt.promptText);
}

async function executeReview(
  root: string,
  options: ReviewTargetOptions
): Promise<
  | {
      result: Awaited<ReturnType<typeof generateReviewResult>>;
      taskMarkdown: string;
      changedFiles: string[];
      changeFiles: GitChanges["changeFiles"];
      runLog?: DevGuardRunLog;
    }
  | undefined
> {
  const rawGitChanges = await loadReviewGitChanges(root, options);
  const reviewChangeFiles = filterDevGuardContextFiles(rawGitChanges.changeFiles, options.includeContextFiles);
  const reviewChangedFiles = [...new Set(reviewChangeFiles.map((file) => file.path))].sort();

  if (reviewChangeFiles.length === 0) {
    console.log("dev-guard review");
    console.log("");
    console.log("리뷰할 변경 사항 없음");
    if (rawGitChanges.changeFiles.length > 0 && !options.includeContextFiles) {
      console.log("Context files changed only. Include them with --include-context-files.");
    }
    return undefined;
  }

  const resolvedConfig = await loadConfig(root);
  const config = resolvedConfig.config;
  const providerName = config.ai?.provider ?? defaultConfig.ai.provider ?? "none";
  const model = config.ai?.model ?? defaultConfig.ai.model ?? "gpt-4o-mini";
  const currentIdentity = await loadCurrentProjectIdentity(root).catch(() => undefined);

  const [taskMarkdown, rulesMarkdown, mistakesMarkdown, projectStateMarkdown, decisionsMarkdown, memory, diffText] = await Promise.all([
    readTextFile(fromRoot(root, ".devguard/task.md")),
    readTextFile(fromRoot(root, ".devguard/rules.md")),
    readTextFile(fromRoot(root, ".devguard/mistakes.md")),
    readTextFile(fromRoot(root, "docs/PROJECT_STATE.md")),
    readTextFile(fromRoot(root, "docs/DECISIONS.md")),
    loadReviewMemory(root, reviewChangedFiles, currentIdentity),
    getDiffForChangeFiles(root, reviewChangeFiles, { stagedOnly: options.staged, commitRef: options.commit })
  ]);
  const ruleRelevanceText = [taskMarkdown, reviewChangedFiles.join("\n"), projectStateMarkdown, decisionsMarkdown].join("\n");
  const filteredRules = filterRelevantMarkdown(rulesMarkdown, ruleRelevanceText, currentIdentity);
  const filteredMistakes = filterRelevantMarkdown(mistakesMarkdown, ruleRelevanceText, currentIdentity);
  const runSelection = await selectReviewRun(root, options, reviewChangedFiles, taskMarkdown, currentIdentity);
  printRunSelection(runSelection);
  const untrackedFileContexts = await collectUntrackedFileContexts(
    root,
    reviewChangeFiles.filter((file) => file.source === "untracked").map((file) => file.path),
    extractReviewKeywords(taskMarkdown)
  );

  if (options.heuristic || providerName === "none") {
    console.error("dev-guard review");
    console.error("- review mode: heuristic");
    console.error(`- provider: ${providerName}`);
    console.error(`- model: ${model}`);
    console.error(`- config source: ${resolvedConfig.source}`);
    if (providerName === "none" && !options.heuristic) {
      console.error("- note: AI provider is none; using local heuristic fallback. Use --heuristic to request this explicitly.");
    }
    const heuristicResult = generateHeuristicReview({
      changedFiles: reviewChangedFiles,
      changeFiles: reviewChangeFiles,
      diffText,
      taskMarkdown,
      untrackedFileContexts
    });
    const drift = analyzeGeneratedDiffDrift({
      requirementText: taskMarkdown,
      taskMarkdown,
      diffText,
      changedFiles: reviewChangedFiles,
      changeFiles: reviewChangeFiles
    });
    await recordDriftTelemetry(root, {
      result: drift,
      source: "review:heuristic",
      subtype: extractTaskSubtype(taskMarkdown)
    }).catch((error) => console.error(`dev-guard review: telemetry warning: ${errorMessage(error)}`));
    return {
      result: heuristicResult,
      taskMarkdown,
      changedFiles: reviewChangedFiles,
      changeFiles: reviewChangeFiles,
      runLog: runSelection.run
    };
  }

  if (providerName === "openai" && !process.env.OPENAI_API_KEY) {
    if (options.heuristic) {
      // Unreachable because heuristic returns above, but keeps the error path explicit.
      throw new Error("OPENAI_API_KEY 환경변수가 없습니다. heuristic review에는 API key가 필요 없습니다.");
    }
    throw new Error("OPENAI_API_KEY 환경변수가 없습니다. API key는 config에 저장하지 말고 `OPENAI_API_KEY=...`로 설정해 주세요. 로컬 검토는 `dev-guard review --heuristic`를 사용하세요.");
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
  const result = await generateReviewResult(
    provider,
    {
      taskMarkdown,
      rulesMarkdown: filteredRules.filteredMarkdown,
      mistakesMarkdown: filteredMistakes.filteredMarkdown,
      projectStateMarkdown,
      decisionsMarkdown,
      changedFiles: reviewChangedFiles,
      changeFiles: reviewChangeFiles,
      diffText,
      untrackedFileContexts,
      memorySummaries: memory.summaries,
      projectMapMarkdown: memory.projectMapMarkdown,
      runLog: runSelection.run,
      runSelectionSummary: formatRunSelectionSummary(runSelection)
    },
    model
  );
  const drift = analyzeGeneratedDiffDrift({
    requirementText: taskMarkdown,
    taskMarkdown,
    diffText,
    changedFiles: reviewChangedFiles,
    changeFiles: reviewChangeFiles
  });
  await recordDriftTelemetry(root, {
    result: drift,
    source: "review:ai",
    subtype: extractTaskSubtype(taskMarkdown)
  }).catch((error) => console.error(`dev-guard review: telemetry warning: ${errorMessage(error)}`));

  return {
    result,
    taskMarkdown,
    changedFiles: reviewChangedFiles,
    changeFiles: reviewChangeFiles,
    runLog: runSelection.run
  };
}

interface RunSelection {
  run?: DevGuardRunLog;
  score?: number;
  mode: "none" | "explicit" | "latest" | "matched";
  warning?: string;
}

async function selectReviewRun(
  root: string,
  options: ReviewTargetOptions,
  changedFiles: string[],
  taskMarkdown: string,
  currentIdentity?: ProjectIdentity
): Promise<RunSelection> {
  if (options.noRun) {
    return { mode: "none" };
  }

  if (options.runId === "latest") {
    const latest = await readLatestRun(root);
    if (!latest) {
      return { mode: "latest", warning: "latest run not found" };
    }
    const identityWarning = runIdentityWarning("latest run", latest, currentIdentity);
    if (identityWarning) {
      return { mode: "latest", warning: identityWarning };
    }

    return {
      run: latest,
      score: scoreRunAgainstDiff(latest, changedFiles, taskMarkdown),
      mode: "latest"
    };
  }

  if (options.runId) {
    const run = await readRunById(root, options.runId);
    if (!run) {
      return { mode: "explicit", warning: `run ${options.runId} not found; falling back to task.md` };
    }
    const identityWarning = runIdentityWarning(`run ${options.runId}`, run, currentIdentity);
    if (identityWarning) {
      return { mode: "explicit", warning: identityWarning };
    }

    return {
      run,
      score: scoreRunAgainstDiff(run, changedFiles, taskMarkdown),
      mode: "explicit"
    };
  }

  const [latest, runs] = await Promise.all([readLatestRun(root), listRunLogs(root)]);
  const usableRuns = runs.filter((run) => !runIdentityWarning(`run ${run.id}`, run, currentIdentity));
  const scoredRuns = usableRuns
    .map((run) => ({ run, score: scoreRunAgainstDiff(run, changedFiles, taskMarkdown) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.run.createdAt) - Date.parse(a.run.createdAt));
  const selected = scoredRuns[0];
  const latestIdentityWarning = latest ? runIdentityWarning("latest run", latest, currentIdentity) : undefined;
  const latestScore = latest && !latestIdentityWarning ? scoreRunAgainstDiff(latest, changedFiles, taskMarkdown) : undefined;

  if (selected) {
    return {
      run: selected.run,
      score: selected.score,
      mode: "matched",
      warning: latestIdentityWarning ?? (latest && latest.id !== selected.run.id && latestScore === 0 ? "latest run does not match current diff" : undefined)
    };
  }

  return {
    mode: "none",
    score: latestScore,
    warning: latestIdentityWarning ?? (latest && latestScore === 0 ? "latest run does not match current diff" : undefined)
  };
}

function runIdentityWarning(source: string, run: DevGuardRunLog, currentIdentity?: ProjectIdentity): string | undefined {
  if (!currentIdentity) {
    return undefined;
  }

  if (!run.projectIdentity) {
    return `${source} has no project identity; ignoring run`;
  }

  return sameProjectIdentity(currentIdentity, run.projectIdentity) ? undefined : `${source} project identity mismatch; ignoring run`;
}

function printRunSelection(selection: RunSelection): void {
  if (selection.warning) {
    console.error(`dev-guard review: warning: ${selection.warning}`);
  }

  if (selection.run) {
    console.error(`dev-guard review: using run ${selection.run.id}`);
    console.error(`dev-guard review: run match score ${selection.score ?? 0}`);
  } else {
    console.error("dev-guard review: using task.md");
    if (selection.score !== undefined) {
      console.error(`dev-guard review: run match score ${selection.score}`);
    }
  }
}

function formatRunSelectionSummary(selection: RunSelection): string {
  const lines = [
    selection.run ? `- using run: ${selection.run.id}` : "- using task.md",
    `- run match score: ${selection.score ?? "none"}`,
    `- run selection mode: ${selection.mode}`
  ];
  if (selection.warning) {
    lines.push(`- warning: ${selection.warning}`);
  }
  return lines.join("\n");
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

  return file === normalizedHint || file.startsWith(`${normalizedHint}/`);
}

function parseReviewOptions(args: string[]): ReviewOptions {
  const output = readOption(args, "--output");
  const copyFix = args.includes("--copy-fix");
  const copy = args.includes("--copy");
  const fixPrompt = args.includes("--fix-prompt");
  const includeContextFiles = args.includes("--include-context-files");
  const staged = args.includes("--staged");
  const commit = readOption(args, "--commit");
  const runId = readOption(args, "--run");
  const noRun = args.includes("--no-run");
  const heuristic = args.includes("--heuristic");

  if (staged && commit) {
    throw new Error("--staged와 --commit은 함께 사용할 수 없습니다.");
  }
  if (noRun && runId) {
    throw new Error("--no-run과 --run은 함께 사용할 수 없습니다.");
  }

  return {
    output,
    copyFix,
    copy,
    fixPrompt,
    includeContextFiles,
    staged,
    commit,
    runId,
    noRun,
    heuristic
  };
}

function parseFixPromptOptions(args: string[]): FixPromptOptions {
  const output = readOption(args, "--output");
  const copy = args.includes("--copy");
  const includeContextFiles = args.includes("--include-context-files");
  const staged = args.includes("--staged");
  const commit = readOption(args, "--commit");
  const runId = readOption(args, "--run");
  const noRun = args.includes("--no-run");

  if (staged && commit) {
    throw new Error("--staged와 --commit은 함께 사용할 수 없습니다.");
  }
  if (noRun && runId) {
    throw new Error("--no-run과 --run은 함께 사용할 수 없습니다.");
  }

  return {
    output,
    copy,
    includeContextFiles,
    staged,
    commit,
    runId,
    noRun
  };
}

function generateHeuristicReview(input: {
  changedFiles: string[];
  changeFiles: GitChanges["changeFiles"];
  diffText: string;
  taskMarkdown: string;
  untrackedFileContexts: ReviewFileContext[];
}): ReviewResult {
  const findings: Array<{ severity: "info" | "warning" | "critical"; text: string }> = [];
  const drift = analyzeGeneratedDiffDrift({
    requirementText: input.taskMarkdown,
    taskMarkdown: input.taskMarkdown,
    diffText: input.diffText,
    changedFiles: input.changedFiles,
    changeFiles: input.changeFiles
  });
  const quality = scoreWorkflowQuality({
    drift,
    changedFiles: input.changedFiles,
    diffText: input.diffText,
    changeFiles: input.changeFiles
  });
  const addedLines = input.diffText
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  const removedLines = input.diffText
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---"))
    .map((line) => line.slice(1));
  const taskType = extractTaskType(input.taskMarkdown);
  const largeChange = input.changedFiles.length >= 12 || input.diffText.length > 30000;
  const hasMarkdownMarkerProblem = /dev-guard:update:start/.test(input.diffText) && !/dev-guard:update:end/.test(input.diffText);
  const addedKoreanOutsideLocale =
    taskType === "i18n" &&
    addedLines.some((line) => /[가-힣]/.test(line)) &&
    !input.changedFiles.some((file) => /(^|\/)(messages|locales?|i18n)\//i.test(file));
  const duplicateHeadings = detectDuplicateMarkdownHeadings([...addedLines, ...input.untrackedFileContexts.map((context) => context.excerpt).join("\n")]);

  if (largeChange) {
    findings.push({ severity: "warning", text: "변경 파일 수나 diff 크기가 큽니다. 이번 task 범위 안의 변경인지 확인하세요." });
  }
  if (input.changeFiles.some((file) => file.source === "untracked")) {
    findings.push({ severity: "info", text: "untracked 파일이 포함되어 있습니다. 새 파일이 commit 대상인지 확인하세요." });
  }
  if (addedKoreanOutsideLocale) {
    findings.push({ severity: "critical", text: "i18n 작업에서 locale resource 밖에 한국어 사용자 노출 문자열이 추가된 정황이 있습니다." });
  }
  if (hasMarkdownMarkerProblem) {
    findings.push({ severity: "critical", text: "dev-guard managed markdown marker가 깨진 정황이 있습니다." });
  }
  if (duplicateHeadings.length > 0) {
    findings.push({ severity: "warning", text: `중복 markdown heading 후보: ${duplicateHeadings.slice(0, 5).join(", ")}` });
  }
  if (removedLines.length > 120 && addedLines.length < 10) {
    findings.push({ severity: "warning", text: "삭제 라인이 많고 대체 추가가 적습니다. 의도한 삭제인지 확인하세요." });
  }
  if (drift.severity !== "low") {
    findings.push({
      severity: drift.severity === "high" ? "critical" : "warning",
      text: `Potential drift detected: ${drift.reasons.join("; ") || "domain mismatch"} (score ${drift.driftScore})`
    });
  }

  const status = findings.some((finding) => finding.severity === "critical")
    ? "needs_changes"
    : findings.some((finding) => finding.severity === "warning")
      ? "warning"
      : "pass";
  const findingLines = findings.length > 0 ? findings.map((finding) => `- [${finding.severity}] ${finding.text}`).join("\n") : "- 로컬 휴리스틱에서 blocking 문제를 찾지 못했습니다.";
  const fixPrompt =
    status === "pass"
      ? "재수정 프롬프트 불필요: heuristic review status가 pass입니다."
      : [
          "현재 diff를 로컬 휴리스틱 지적 기준으로 다시 확인해 주세요.",
          "원래 요구사항과 직접 관련 없는 변경만 되돌리고, 필요한 수정은 최소 범위로 유지하세요.",
          `확인 파일: ${input.changedFiles.slice(0, 12).join(", ") || "none"}`,
          "blocking/warning 항목을 먼저 해결한 뒤 pnpm run build를 실행하세요."
        ].join("\n");

  return {
    status,
    fixPrompt,
    markdown: `status: ${status}

## 결론
${status === "pass" ? "로컬 휴리스틱 기준으로 커밋을 막을 명확한 문제는 없습니다." : "로컬 휴리스틱 기준으로 확인할 문제가 있습니다."}

## 요구사항 충족 여부
- AI semantic review는 실행하지 않았습니다.
- 현재 결과는 diff/static heuristic 기준입니다.

## 범위 초과 수정
${largeChange ? "- broad diff입니다. task scope와 변경 파일을 다시 비교하세요." : "- 뚜렷한 broad scope 신호는 없습니다."}

## 규칙 위반 가능성
${findingLines}

## Drift 분석
- severity: ${drift.severity}
- score: ${drift.driftScore}
- requirement domains: ${drift.requirementDomains.join(", ") || "none"}
- diff domains: ${drift.generatedDomains.join(", ") || "none"}
- requirement zones: ${drift.requirementZones.join(", ") || "none"}
- diff zones: ${drift.generatedZones.join(", ") || "none"}
- reasons: ${drift.reasons.join("; ") || "none"}

## Workflow Quality Score
- Requirement Alignment Score: ${quality.requirementAlignment}
- Drift Risk: ${quality.driftRisk}
- Scope Safety: ${quality.scopeSafety}
- Confidence: ${quality.confidence}

## 반복 실수 가능성
- provider 없이 실행된 fallback review입니다. 의미 검토가 필요하면 provider 설정 후 AI review를 실행하세요.

## 확인이 필요한 파일
${input.changedFiles.length > 0 ? input.changedFiles.slice(0, 20).map((file) => `- ${file}`).join("\n") : "- 없음"}

## Codex 재수정 프롬프트
${fixPrompt}

## 커밋 가능 여부
${status === "pass" ? "- 가능: build/check 결과를 추가 확인하세요." : "- 보류: 위 항목을 확인하세요."}`
  };
}

function extractTaskType(markdown: string): string {
  const match = markdown.match(/type:\s*([a-z_]+)/i);
  return match?.[1] ?? "";
}

function extractTaskSubtype(markdown: string): string | undefined {
  return markdown.match(/subtype:\s*([a-z_.]+)/i)?.[1];
}

function detectDuplicateMarkdownHeadings(lines: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^#{1,4}\s+(.+)$/);
    if (!match) {
      continue;
    }
    const heading = match[1].trim().toLowerCase();
    if (seen.has(heading)) {
      duplicates.add(match[1].trim());
    }
    seen.add(heading);
  }
  return [...duplicates];
}

async function loadReviewGitChanges(root: string, options: ReviewTargetOptions): Promise<GitChanges> {
  if (options.commit) {
    return getCommitGitChanges(root, options.commit);
  }

  if (options.staged) {
    return getStagedGitChanges(root);
  }

  return getGitChanges(root);
}

async function loadReviewMemory(
  root: string,
  changedFiles: string[],
  currentIdentity?: ProjectIdentity
): Promise<{ summaries: ReviewMemorySummary[]; projectMapMarkdown: string }> {
  const [summaries, projectMapMarkdown, storedIdentity] = await Promise.all([
    readJsonFile<FileSummary[]>(fromRoot(root, ".devguard/file-summaries.json"), []),
    readTextFile(fromRoot(root, ".devguard/project-map.md")),
    readStoredProjectIdentity(root)
  ]);
  if (summaries.length > 0 && currentIdentity && !sameProjectIdentity(currentIdentity, storedIdentity)) {
    console.error(`dev-guard review: warning: ${formatProjectIdentityWarning("scan cache", currentIdentity, storedIdentity)}`);
    return { summaries: [], projectMapMarkdown: "" };
  }
  const changedFileSet = new Set(changedFiles);
  const relatedSummaries = summaries
    .filter((summary) => !isAlwaysIgnoredContextPath(summary.path))
    .filter((summary) => changedFileSet.has(summary.path) || summary.relatedFiles.some((file) => changedFileSet.has(file)))
    .slice(0, 12)
    .map((summary) => ({
      path: summary.path,
      role: summary.role,
      keywords: summary.keywords,
      features: summary.features
    }));

  return {
    summaries: relatedSummaries,
    projectMapMarkdown
  };
}

async function collectUntrackedFileContexts(root: string, paths: string[], keywords: string[]): Promise<ReviewFileContext[]> {
  const contexts: ReviewFileContext[] = [];
  let totalLength = 0;

  for (const path of paths.filter(isTextReviewFile).slice(0, untrackedFileLimit)) {
    if (totalLength >= totalUntrackedCharacterLimit) {
      break;
    }

    const remaining = totalUntrackedCharacterLimit - totalLength;
    const content = await readTextFile(fromRoot(root, path));
    if (!content.trim()) {
      continue;
    }

    const excerpt = buildReviewExcerpt(content, keywords, Math.min(perFileCharacterLimit, remaining));
    totalLength += excerpt.length;
    contexts.push({
      path,
      excerpt,
      truncated: content.length > excerpt.length
    });
  }

  return contexts;
}

function extractReviewKeywords(markdown: string): string[] {
  const tokens = markdown.toLowerCase().match(/[a-z0-9가-힣]{3,}/g) ?? [];
  const routeTokens = markdown.match(/[a-z0-9_.-]+\/[a-z0-9_./*-]+/gi) ?? [];
  return [...new Set([...routeTokens, ...tokens])].slice(0, 30);
}

function buildReviewExcerpt(content: string, keywords: string[], maxCharacters: number): string {
  const lines = content.split("\n");
  const selected = new Set<number>();
  const headLineCount = Math.min(lines.length, 50);
  for (let index = 0; index < headLineCount; index += 1) {
    selected.add(index);
  }

  for (const keyword of keywords) {
    const normalizedKeyword = keyword.toLowerCase().replace(/\*\*?$/g, "");
    if (normalizedKeyword.length < 3) {
      continue;
    }

    lines.forEach((line, index) => {
      if (!line.toLowerCase().includes(normalizedKeyword)) {
        return;
      }

      for (let cursor = Math.max(0, index - 8); cursor <= Math.min(lines.length - 1, index + 12); cursor += 1) {
        selected.add(cursor);
      }
    });
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

function isTextReviewFile(path: string): boolean {
  if (
    path.startsWith("node_modules/") ||
    path.startsWith(".next/") ||
    path.startsWith("dist/") ||
    path.startsWith("build/") ||
    path.startsWith("coverage/")
  ) {
    return false;
  }

  if (/\.(png|jpe?g|gif|webp|avif|ico|svg|ttf|otf|woff2?|mp4|mov|mp3|wav|pdf|zip|gz)$/i.test(path)) {
    return false;
  }

  return /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|sass|sql|toml|ya?ml|txt)$/i.test(path);
}

function trimToLimit(content: string, maxCharacters: number): string {
  if (content.length <= maxCharacters) {
    return content;
  }

  return `${content.slice(0, Math.max(0, maxCharacters - 80)).trimEnd()}\n... truncated by dev-guard review context limit ...`;
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} 옵션에는 값이 필요합니다.`);
  }

  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
