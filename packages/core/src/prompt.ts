import { filterDevGuardContextFiles } from "./context-files.js";
import type { ChangeFile, CodexPrompt, CodexPromptInput, ImpactHint } from "./types.js";

export function generateCodexPrompt(input: CodexPromptInput): CodexPrompt {
  const changeFiles = normalizeChangeFiles(input.changeFiles, input.changedFiles);
  const relatedChangeFiles = filterDevGuardContextFiles(changeFiles, input.includeContextFiles);
  const relatedChangedFiles = normalizeFiles(relatedChangeFiles.map((file) => file.path));
  const summary = buildSummary(relatedChangeFiles, input.diffText);
  const density = resolveDensity(input, relatedChangeFiles);

  if (density === "ultra") {
    return buildUltraCompactPrompt(input, relatedChangeFiles, relatedChangedFiles, summary);
  }

  if (density === "compact" || density === "compact+") {
    return buildCompactPrompt(input, relatedChangeFiles, relatedChangedFiles, summary, density);
  }

  return buildFullPrompt(input, relatedChangeFiles, relatedChangedFiles, summary);
}

function buildFullPrompt(input: CodexPromptInput, changeFiles: ChangeFile[], changedFiles: string[], summary: string): CodexPrompt {
  const taskSections = extractTaskSections(input.taskMarkdown);
  const sections = [
    ["현재 작업 목표", fallbackMarkdown(input.taskMarkdown, "현재 작업 목표가 비어 있습니다.")],
    ["프로젝트 상태 요약", fallbackMarkdown(input.projectStateMarkdown, "프로젝트 상태 문서가 비어 있습니다.")],
    ["반드시 지켜야 할 규칙", fallbackMarkdown(input.rulesMarkdown, "규칙 문서가 비어 있습니다.")],
    ["반복하면 안 되는 실수", fallbackMarkdown(input.mistakesMarkdown, "반복 방지 문서가 비어 있습니다.")],
    ["최근 결정", fallbackMarkdown(input.decisionsMarkdown, "결정 문서가 비어 있습니다.")],
    ["핵심 Guard", formatSymbolicProtection(taskSections, input.rulesMarkdown, input.mistakesMarkdown)],
    ["현재 변경 파일", formatChangedFiles(changeFiles)],
    ["영향도 힌트", formatImpactHints(input.impactHints ?? [])],
    ["Codex 작업 지시", codexInstruction()],
    ["완료 조건", completionConditions()],
    ["검증 명령어", verificationCommands(changedFiles)]
  ] as const;

  const promptText = compressPrompt(renderPrompt("Codex 작업 프롬프트", `${summary}; density=verbose`, sections), input.maxPromptTokens);
  return {
    promptText: addTokenEstimate(promptText, "verbose"),
    summary,
    includedSections: sections.map(([title]) => title)
  };
}

function buildCompactPrompt(
  input: CodexPromptInput,
  changeFiles: ChangeFile[],
  changedFiles: string[],
  summary: string,
  density: "compact" | "compact+"
): CodexPrompt {
  const taskSections = extractTaskSections(input.taskMarkdown);
  const sections = [
    ["작업", compactTaskSummary(taskSections)],
    ["작업 유형", taskSections.taskType || "type 확인 필요"],
    ["관련 파일", formatCompactRelatedFiles(changeFiles, taskSections)],
    ["영향도", formatImpactHints(input.impactHints ?? [])],
    ["보호/금지", compactProtection(taskSections, input.rulesMarkdown, input.mistakesMarkdown)],
    ["완료 기준", taskSections.completionCriteria || taskSections.completionConditions || completionConditions()],
    ["검증 명령어", verificationCommands(changedFiles)]
  ] as const;

  return {
    promptText: addTokenEstimate(
      compressPrompt(renderBudgetedPrompt("Codex 작업 프롬프트 compact", `${summary}; density=${density}`, sections, input.maxPromptTokens), input.maxPromptTokens),
      density
    ),
    summary,
    includedSections: sections.map(([title]) => title)
  };
}

function buildUltraCompactPrompt(input: CodexPromptInput, changeFiles: ChangeFile[], changedFiles: string[], summary: string): CodexPrompt {
  const taskSections = extractTaskSections(input.taskMarkdown);
  const ultraIdeas = formatUltraIdeas(taskSections);
  const sections: Array<[string, string]> = [
    ["TASK", oneLine([taskSections.goal, taskSections.problem].filter(Boolean).join(" | ")) || "Complete requested scoped task."],
    ["TYPE", oneLine(taskSections.taskType) || "unknown"],
    ["FILES", formatUltraFiles(changeFiles, taskSections)],
    ["IMPACT", formatUltraImpactHints(input.impactHints ?? [])],
    ["PROTECT", formatSymbolicProtection(taskSections, input.rulesMarkdown, input.mistakesMarkdown)],
    ["SUCCESS", formatUltraSuccess(taskSections)],
    ["VERIFY", formatUltraVerify(taskSections, changedFiles)]
  ];
  if (ultraIdeas !== "none") {
    const successIdx = sections.findIndex(([key]) => key === "SUCCESS");
    sections.splice(successIdx, 0, ["IDEAS", ultraIdeas]);
  }
  const promptText = addTokenEstimate(
    renderBudgetedUltraPrompt(`${summary}; density=ultra`, sections, input.maxPromptTokens ?? 2500),
    "ultra"
  );

  return {
    promptText,
    summary,
    includedSections: sections.map(([title]) => title)
  };
}

function renderPrompt(title: string, summary: string, sections: ReadonlyArray<readonly [string, string]>): string {
  const body = sections.map(([sectionTitle, content]) => `## ${sectionTitle}\n${content.trim()}`).join("\n\n");
  return `# ${title}\n\n요약: ${summary}\n\n${body}\n`;
}

function renderBudgetedPrompt(
  title: string,
  summary: string,
  sections: ReadonlyArray<readonly [string, string]>,
  maxPromptTokens?: number
): string {
  const priority = ["작업", "작업 유형", "완료 기준", "보호/금지", "검증 명령어", "관련 파일", "영향도"];
  let active = [...sections];
  let prompt = renderPrompt(title, summary, active);
  while (maxPromptTokens && estimateTokens(prompt) > maxPromptTokens && active.length > 5) {
    const removableIndex = [...active]
      .map(([name], index) => ({ name, index, priority: priority.indexOf(name) >= 0 ? priority.indexOf(name) : 99 }))
      .sort((a, b) => b.priority - a.priority)[0]?.index;
    if (removableIndex === undefined || removableIndex < 0) {
      break;
    }
    active.splice(removableIndex, 1);
    prompt = renderPrompt(title, `${summary}; budget_trimmed=true`, active);
  }
  return prompt;
}

function renderBudgetedUltraPrompt(
  summary: string,
  sections: ReadonlyArray<readonly [string, string]>,
  maxPromptTokens: number
): string {
  const priority = ["TASK", "TYPE", "SUCCESS", "IDEAS", "PROTECT", "VERIFY", "FILES", "IMPACT"];
  let active = [...sections];
  const build = (items: ReadonlyArray<readonly [string, string]>, trimmed = false) =>
    `# dev-guard ultra-compact\nSUMMARY: ${summary}${trimmed ? "; budget_trimmed=true" : ""}\n${items
      .map(([title, content]) => `${title}: ${content.trim()}`)
      .join("\n")}\n`;
  let prompt = build(active);
  while (estimateTokens(prompt) > maxPromptTokens && active.length > 5) {
    const removableIndex = [...active]
      .map(([name], index) => ({ name, index, priority: priority.indexOf(name) >= 0 ? priority.indexOf(name) : 99 }))
      .sort((a, b) => b.priority - a.priority)[0]?.index;
    if (removableIndex === undefined || removableIndex < 0) {
      break;
    }
    active.splice(removableIndex, 1);
    prompt = build(active, true);
  }
  return sectionSafeCompressPrompt(prompt, maxPromptTokens);
}

function normalizeChangeFiles(changeFiles: ChangeFile[] | undefined, changedFiles: string[]): ChangeFile[] {
  const source: ChangeFile[] =
    changeFiles ?? changedFiles.map((path) => ({ path, status: "modified" as const, source: "workingTree" as const }));
  const seen = new Set<string>();
  const normalized: ChangeFile[] = [];

  for (const file of source) {
    const path = file.path.trim();
    if (!path) {
      continue;
    }

    const key = `${file.source}:${file.status}:${file.oldPath ?? ""}:${path}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push({ ...file, path });
  }

  return normalized.sort((a, b) => a.path.localeCompare(b.path) || a.source.localeCompare(b.source));
}

type PromptDensity = "ultra" | "compact" | "compact+" | "verbose";

function resolveDensity(input: CodexPromptInput, changeFiles: ChangeFile[]): PromptDensity {
  if (input.density) {
    return input.density;
  }
  if (input.ultraCompact) {
    return "ultra";
  }
  if (!input.compact) {
    return "verbose";
  }

  const taskSections = extractTaskSections(input.taskMarkdown);
  const task = inferTaskTypeName(taskSections, input.taskMarkdown);
  const complex = estimateComplexity(input.taskMarkdown, changeFiles);
  if (task.type === "ui_text_cleanup" || task.subtype === "bugfix.text_content") {
    return "ultra";
  }
  if (task.type === "i18n") {
    return "compact+";
  }
  if (task.type === "architecture" || task.type === "migration") {
    return "verbose";
  }
  if (task.type === "bugfix") {
    return complex >= 3 ? "compact+" : "compact";
  }
  return complex >= 4 ? "verbose" : "compact";
}

function inferTaskTypeName(taskSections: TaskSections, taskMarkdown = ""): { type: string; subtype: string } {
  const source = [taskSections.taskType, taskMarkdown].filter(Boolean).join("\n");
  return {
    type: source.match(/type:\s*([a-z0-9_]+)/i)?.[1] ?? "",
    subtype: source.match(/subtype:\s*([a-z0-9_.]+)/i)?.[1] ?? ""
  };
}

function estimateComplexity(taskMarkdown: string, changeFiles: ChangeFile[]): number {
  let score = 0;
  if (changeFiles.length > 10) {
    score += 2;
  } else if (changeFiles.length > 4) {
    score += 1;
  }
  if (/requires\s*phasing:\s*true|requiresPhasing:\s*true|##\s*(이번 단계|이후 단계|이번 작업에서 제외할 것)/i.test(taskMarkdown)) {
    score += 2;
  }
  if (/subtype:\s*bugfix\.(navigation_state|data_persistence|api_error|build_error)/i.test(taskMarkdown)) {
    score += 1;
  }
  if (/type:\s*(architecture|migration)/i.test(taskMarkdown)) {
    score += 3;
  }
  if (/drift\s*(risk|score)|Potential drift|semantic drift/i.test(taskMarkdown)) {
    score += 1;
  }
  return score;
}

function addTokenEstimate(promptText: string, density: string): string {
  return promptText.replace(/\n/, `\ndensity=${density}; estimated_tokens=~${estimateTokens(promptText)}\n`);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function normalizeFiles(files: string[]): string[] {
  return [...new Set(files.map((file) => file.trim()).filter(Boolean))].sort();
}

function buildSummary(changeFiles: ChangeFile[], diffText: string): string {
  if (changeFiles.length === 0) {
    return "변경 파일 없음";
  }

  const workingTreeCount = changeFiles.filter((file) => file.source === "workingTree").length;
  const stagedCount = changeFiles.filter((file) => file.source === "staged").length;
  const untrackedCount = changeFiles.filter((file) => file.source === "untracked").length;
  const diffLineCount = diffText.split("\n").filter((line) => line.startsWith("+") || line.startsWith("-")).length;

  return `${changeFiles.length}개 파일 변경: working tree ${workingTreeCount}, staged ${stagedCount}, untracked ${untrackedCount}, diff line ${diffLineCount}`;
}

function fallbackMarkdown(markdown: string, fallback: string): string {
  const trimmed = markdown.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function summarizeMarkdown(markdown: string, fallback: string): string {
  const lines = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 12);

  return lines.length > 0 ? lines.join("\n") : fallback;
}

function formatChangedFiles(changeFiles: ChangeFile[]): string {
  if (changeFiles.length === 0) {
    return "- 현재 코드 변경 파일 없음\n- 수정 후보 파일은 task.md의 수정 범위를 참고";
  }

  const visible = changeFiles.slice(0, 20);
  const lines = visible
    .map((file) => {
      const rename = file.oldPath ? ` from ${file.oldPath}` : "";
      const state = file.source === file.status ? file.source : `${file.source}/${file.status}`;
      const newFileNote = file.source === "untracked" ? " - 새 파일 생성됨" : "";
      return `- ${file.path} (${state}${rename})${newFileNote}`;
    });
  if (changeFiles.length > visible.length) {
    lines.push(`- ... ${changeFiles.length - visible.length} more files`);
  }
  return lines.join("\n");
}

function formatCompactRelatedFiles(changeFiles: ChangeFile[], taskSections: TaskSections): string {
  const changedFilesText = formatChangedFiles(changeFiles);
  const taskFileSections = [
    taskSections.targets ? `### 수정 대상\n${limitLines(taskSections.targets, 8)}` : "",
    taskSections.references ? `### 참고 대상\n${limitLines(taskSections.references, 5)}` : ""
  ].filter(Boolean);

  if (taskFileSections.length === 0) {
    return changedFilesText;
  }

  if (changeFiles.length === 0) {
    return [`- 현재 코드 변경 파일 없음`, ...taskFileSections].join("\n\n");
  }

  return [changedFilesText, ...taskFileSections].join("\n\n");
}

function formatUltraFiles(changeFiles: ChangeFile[], taskSections: TaskSections): string {
  if (/type:\s*product_strategy/i.test(taskSections.taskType)) {
    const references = compactFileLines(taskSections.references, 3);
    return references.length > 0 ? `none; REF: ${references.join(", ")}` : "none";
  }
  const targets = compactFileLines(taskSections.targets, 8);
  if (targets.length > 0) {
    return targets.join(", ");
  }
  if (changeFiles.length === 0) {
    return "none; see task scope";
  }
  return groupFilePaths(changeFiles.map((file) => file.path)).slice(0, 8).join(", ");
}

function formatImpactHints(impactHints: ImpactHint[]): string {
  if (impactHints.length === 0) {
    return "- none";
  }
  return impactHints
    .slice(0, 5)
    .map((hint) => {
      const usedBy = hint.importedBy.slice(0, 3).join(", ") || "unknown";
      const areas = hint.affectedAreas.slice(0, 4).join(", ") || "unknown";
      return `- ${hint.file}: imported by ${hint.importedByCount}; used by ${usedBy}; areas ${areas}`;
    })
    .join("\n");
}

function formatUltraImpactHints(impactHints: ImpactHint[]): string {
  if (impactHints.length === 0) {
    return "none";
  }
  return impactHints
    .slice(0, 3)
    .map((hint) => `${compactImpactPath(hint.file)} used_by=${hint.importedByCount}`)
    .join("; ");
}

function compactImpactPath(path: string): string {
  if (path.length <= 56) {
    return path;
  }
  const parts = path.split("/");
  if (parts.length <= 2) {
    return `...${path.slice(-53)}`;
  }
  return `${parts[0]}/.../${parts.at(-1)}`;
}

function formatUltraSuccess(taskSections: TaskSections): string {
  const source = [taskSections.goal, taskSections.problem, taskSections.taskType, taskSections.completionCriteria, taskSections.completionConditions]
    .join("\n")
    .toLowerCase();
  const flags = new Set<string>();

  if (/cli_output_polish|명령|command|출력|output|요약|summary|preview|done|status|help/.test(source)) {
    flags.add("cli_output_clear=true");
  }
  if (/done/.test(source)) {
    flags.add("done_output_clear=true");
  }
  if (/update\s*preview|preview|업데이트/.test(source)) {
    flags.add("update_preview_summary_visible=true");
  }
  if (/update|preview|write|자동/.test(source)) {
    flags.add("no_auto_write=true");
  }
  if (/i18n|locale|translation|영어|영문/.test(source)) {
    flags.add("inventory_required=true");
    flags.add("key_parity=true");
    flags.add("hardcoded_text_check=true");
  }
  if (/architecture|migration|마이그레이션|아키텍처/.test(source)) {
    flags.add("migration_plan_required=true");
    flags.add("rollback_or_verification_required=true");
  }
  if (/product_strategy|discovery-first|공유하고 싶은 이유|구현 전 정의/.test(source)) {
    flags.add("hook_defined=true");
    flags.add("share_reason=true");
    flags.add("fun_factor=true");
    flags.add("implementation_scope=true");
  }

  if (flags.size > 0) {
    return [...flags].slice(0, 6).join(", ");
  }

  const lines = (taskSections.completionCriteria || taskSections.completionConditions || completionConditions())
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .slice(0, 3);
  return lines.length > 0 ? lines.join("; ") : "requested_outcome_verified=true";
}

function toUltraExperimentKey(idea: string): string {
  const mappings: Array<[RegExp, string]> = [
    // more specific patterns first
    [/친구가.*본|타인.*시선|비교.*요소/, "friend_view_comparison"],
    [/비교.*포맷|점수.*비교|친구.*점수|내.*점수.*vs|비교.*유도|친구.*비교.*유도/, "share_comparison"],
    [/blur.*처리|전체.*공개|blur.*공유/, "blur_reveal_share"],
    [/공유.*버튼|감정.*반응.*유발|버튼.*문구/, "emotional_share_cta"],
    [/상위.*%.*수치|자랑.*동기|수치.*추가/, "social_proof_score"],
    [/희소성|상위.*%만|여기까지/, "scarcity_copy"],
    [/재시도.*훅|답.*바꾸면|결과.*달라질/, "replay_trigger"],
    [/기대감|거의.*다.*왔|마지막.*문항|진행.*중.*카피/, "suspense_progression"],
    [/재방문|결과가.*바뀌|일정.*기간/, "time_retest_hook"],
    [/한.*번.*더|재시작|완료.*직후/, "restart_entry"],
    [/밈.*문법|유행.*밈|밈.*스타일/, "meme_copy"],
    [/공감.*유머|유머.*추가|대화체/, "empathy_humor_copy"],
    [/과장|감탄사|이모지.*감정|감정.*반응.*강화/, "emotional_result_reaction"],
    [/TikTok|Threads|짧고.*강한|짧은.*문장/, "short_copy_format"],
    [/정체성.*라벨|X형.*인간|라벨링/, "identity_label"],
    [/결과.*제목.*공격|공격적.*스타일|밈.*교체|제목.*더.*공격|제목.*변경/, "stronger_result_titles"],
    [/스크린샷|비주얼.*구조/, "screenshot_ready_copy"],
    [/진입.*카피|왜.*해야|동기.*유발/, "hook_entry_copy"],
    [/공유.*시.*친구|친구.*공유|공유.*유도/, "share_comparison"]
  ];
  for (const [pattern, key] of mappings) {
    if (pattern.test(idea)) {
      return key;
    }
  }
  return idea
    .replace(/^[-*]\s*/, "")
    .replace(/['"''""\s]+/g, "_")
    .replace(/[^a-z0-9_가-힣]/gi, "")
    .slice(0, 28)
    .toLowerCase();
}

function formatUltraIdeas(taskSections: TaskSections): string {
  if (!taskSections.experimentIdeas) {
    return "none";
  }
  const keys = taskSections.experimentIdeas
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-") || line.startsWith("*"))
    .map((line) => toUltraExperimentKey(line))
    .filter(Boolean)
    .slice(0, 5);
  return keys.length > 0 ? keys.join(", ") : "none";
}

function formatUltraVerify(taskSections: TaskSections, changedFiles: string[]): string {
  if (/type:\s*product_strategy/i.test(taskSections.taskType)) {
    return "no code change required unless scope approved";
  }
  return verificationCommands(changedFiles);
}

function compactFileLines(text: string, max: number): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").replace(/\s*\(.+?\)\s*$/, "").trim())
    .filter(Boolean)
    .slice(0, max);
}

function groupFilePaths(paths: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const parts = path.split("/");
    const key = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    groups.set(key, [...(groups.get(key) ?? []), path]);
  }
  return [...groups.entries()].map(([dir, files]) => (files.length >= 3 ? `${dir}/* (${files.length})` : files.join(", ")));
}

function limitLines(text: string, maxLines: number): string {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const visible = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    visible.push(`- ... ${lines.length - maxLines} more`);
  }
  return visible.join("\n");
}

interface TaskSections {
  goal: string;
  problem: string;
  taskType: string;
  scope: string;
  rules: string;
  targets: string;
  references: string;
  protectedTargets: string;
  forbidden: string;
  completionCriteria: string;
  completionConditions: string;
  cautions: string;
  experimentIdeas: string;
}

function extractTaskSections(taskMarkdown: string): TaskSections {
  return {
    goal: cleanSectionContent(extractMarkdownSection(taskMarkdown, "목표")),
    problem: cleanSectionContent(extractMarkdownSection(taskMarkdown, "현재 문제")),
    taskType: cleanSectionContent(extractMarkdownSection(taskMarkdown, "작업 유형")),
    scope: cleanSectionContent(extractMarkdownSection(taskMarkdown, "수정 범위")),
    rules: cleanSectionContent(extractMarkdownSection(taskMarkdown, "반드시 지킬 규칙")),
    targets: cleanSectionContent(extractMarkdownSection(taskMarkdown, "수정 대상")),
    references: cleanSectionContent(extractMarkdownSection(taskMarkdown, "참고 대상")),
    protectedTargets: cleanSectionContent(extractMarkdownSection(taskMarkdown, "보호 대상")),
    forbidden: cleanSectionContent(extractMarkdownSection(taskMarkdown, "건드리면 안 되는 것")),
    completionCriteria: cleanSectionContent(extractMarkdownSection(taskMarkdown, "완료 기준")),
    completionConditions: cleanSectionContent(extractMarkdownSection(taskMarkdown, "완료 조건")),
    cautions: cleanSectionContent(extractMarkdownSection(taskMarkdown, "Codex에게 전달할 주의사항")),
    experimentIdeas: cleanSectionContent(extractMarkdownSection(taskMarkdown, "추천 실험 방향"))
  };
}

function compactTaskSummary(taskSections: TaskSections): string {
  const summary = [taskSections.goal, taskSections.problem ? `현재 문제: ${taskSections.problem}` : ""]
    .filter(Boolean)
    .map((text) => limitLines(text, 4))
    .join("\n");
  return summary || "요청된 작업을 범위 안에서 완료한다.";
}

function compactProtection(taskSections: TaskSections, rulesMarkdown: string, mistakesMarkdown: string): string {
  const primary = [
    taskSections.protectedTargets ? `### 보호 대상\n${limitLines(taskSections.protectedTargets, 6)}` : "",
    taskSections.forbidden ? `### 금지\n${limitLines(taskSections.forbidden, 5)}` : "",
    taskSections.cautions ? `### 주의\n${limitLines(taskSections.cautions, 4)}` : ""
  ].filter(Boolean);

  if (primary.length > 0) {
    return primary.join("\n\n");
  }

  return summarizeMarkdown([rulesMarkdown, mistakesMarkdown].filter(Boolean).join("\n"), "관련 없는 파일 수정, 범위 확장, 검증 없는 완료 보고를 피한다.");
}

function formatSymbolicProtection(taskSections: TaskSections, rulesMarkdown: string, mistakesMarkdown: string): string {
  const text = [taskSections.protectedTargets, taskSections.forbidden, taskSections.cautions, rulesMarkdown, mistakesMarkdown]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const flags = new Set<string>(["scope_lock=true", "preserve_behavior=true"]);
  const task = inferTaskTypeName(taskSections);
  if (task.type === "i18n" || /i18n|locale|translation|번역|영어|영문/.test(text)) {
    for (const flag of [
      "inventory_required=true",
      "key_parity=true",
      "hardcoded_text_check=true",
      "metadata_aria_included=true",
      "partial_translation_fail=true",
      "preserve_source_locale=true"
    ]) {
      flags.add(flag);
    }
  }
  if (task.type === "architecture" || task.type === "migration") {
    for (const flag of [
      "preserve_public_api=true",
      "no_unrelated_refactor=true",
      "migration_plan_required=true",
      "rollback_or_verification_required=true"
    ]) {
      flags.add(flag);
    }
  }
  if (/ui|화면|layout|레이아웃|redesign|리디자인/.test(text)) {
    flags.add("avoid_ui_redesign=true");
  }
  if (/logic|로직|state|상태|계산|routing|router|fetch|auth|인증/.test(text)) {
    flags.add("protect_logic=true");
  }
  if (/data|데이터|fetch|api|supabase|저장/.test(text)) {
    flags.add("protect_data=true");
  }
  return [...flags].join(", ");
}

function compressPrompt(prompt: string, maxPromptTokens = 2500): string {
  const replacements: Array<[RegExp, string]> = [
    [/기존 정상 동작을 보존/g, "preserve_behavior=true"],
    [/관련 없는 파일 수정/g, "scope_lock=true"],
    [/범위 확장/g, "scope_lock=true"],
    [/불필요한 구조 변경/g, "avoid_restructure=true"],
    [/UI redesign|UI 리디자인|리디자인/g, "avoid_ui_redesign=true"]
  ];
  let next = prompt;
  for (const [pattern, replacement] of replacements) {
    next = next.replace(pattern, replacement);
  }
  next = dedupeSymbolicFlags(next);
  const seen = new Set<string>();
  const lines = next
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      const key = line.trim();
      if (!key) {
        return true;
      }
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  next = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return sectionSafeCompressPrompt(next, maxPromptTokens);
}

function sectionSafeCompressPrompt(prompt: string, maxPromptTokens = 2500): string {
  if (estimateTokens(prompt) <= maxPromptTokens) {
    return prompt;
  }

  const lines = prompt.split("\n");
  const protectedPrefixes = ["TASK:", "TYPE:", "SUCCESS:", "PROTECT:", "VERIFY:"];
  const result: string[] = [];
  let used = 0;
  for (const line of lines) {
    const required = protectedPrefixes.some((prefix) => line.startsWith(prefix)) || /^#|^density=|^SUMMARY:/.test(line);
    const cost = estimateTokens(`${line}\n`);
    if (!required && used + cost > maxPromptTokens) {
      continue;
    }
    result.push(line);
    used += cost;
  }

  const next = result.join("\n").replace(/\n{3,}/g, "\n\n");
  if (estimateTokens(next) <= maxPromptTokens || result.length === lines.length) {
    return next;
  }

  return next;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function dedupeSymbolicFlags(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const flags = line.match(/[a-z_]+=(?:true|false)/g);
      if (!flags || flags.length < 2) {
        return line;
      }
      const deduped = [...new Set(flags)];
      return line.replace(flags.join(", "), deduped.join(", ")).replace(/,\s*,/g, ",");
    })
    .join("\n");
}

function extractMarkdownSection(taskMarkdown: string, title: string): string {
  const lines = taskMarkdown.split("\n");
  const headingIndex = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(title)}\\s*$`).test(line.trim()));

  if (headingIndex < 0) {
    return "";
  }

  const sectionLines: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^##\s+/.test(line.trim())) {
      break;
    }

    sectionLines.push(line);
  }

  return sectionLines.join("\n").trim();
}

function cleanSectionContent(content: string): string {
  return content
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1))
    .join("\n")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codexInstruction(): string {
  return [
    "- 위 컨텍스트를 기준으로 현재 작업만 수행한다.",
    "- 관련 없는 파일 수정, 대규모 리팩토링, 불필요한 구조 변경을 피한다.",
    "- 기존 정상 동작을 보존하고, 변경 이유가 명확한 최소 수정으로 해결한다.",
    "- 파일을 수정했다면 변경 내용과 검증 결과를 짧게 보고한다."
  ].join("\n");
}

function completionConditions(): string {
  return [
    "- 요청된 기능 또는 수정이 동작한다.",
    "- 변경 파일이 작업 범위를 벗어나지 않는다.",
    "- 문서 업데이트가 필요한 경우 반영하거나 후보를 명확히 남긴다.",
    "- 검증 명령어를 실행하고 결과를 확인한다."
  ].join("\n");
}

function verificationCommands(changedFiles: string[]): string {
  const commands = ["pnpm run build"];
  if (changedFiles.some((file) => file.startsWith("packages/cli/"))) {
    commands.push("pnpm cli check");
  }
  if (changedFiles.some((file) => file.startsWith("packages/core/") || file.startsWith("packages/cli/"))) {
    commands.push("pnpm cli update");
  }

  return commands.map((command) => `- \`${command}\``).join("\n");
}
