import { classifyTaskType, taskTypeStrategyNotes } from "./task-router.js";
import { buildTaskCompletionCriteria, formatCompletionCriteria } from "./completion.js";
import { analyzeSemanticDrift, defaultContextPriority } from "./drift.js";
import type {
  AIProvider,
  CodeGraphEntry,
  FileSummary,
  GenerateTextInput,
  ProjectIndexEntry,
  TaskAIContext,
  TaskAIFileCandidate,
  TaskMarkdownResult,
  TaskTypeResult
} from "./types.js";

interface OpenAIResponsesResult {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
}

export class NoneAIProvider implements AIProvider {
  name = "none" as const;

  async generateText(): Promise<string> {
    throw new Error("AI provider is set to none. Configure it with `dev-guard configure ai --provider openai --model gpt-4o-mini`.");
  }
}

export class OpenAIProvider implements AIProvider {
  name = "openai" as const;

  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      temperature?: number;
      maxTokens?: number;
      reasoningEffort?: string;
      baseURL?: string;
    }
  ) {}

  async generateText(input: GenerateTextInput): Promise<string> {
    const response = await fetch(`${this.options.baseURL ?? "https://api.openai.com/v1"}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model ?? this.options.model,
        instructions: input.system,
        input: input.prompt,
        temperature: input.temperature ?? this.options.temperature,
        max_output_tokens: input.maxTokens ?? this.options.maxTokens,
        reasoning: (input.reasoningEffort ?? this.options.reasoningEffort)
          ? { effort: input.reasoningEffort ?? this.options.reasoningEffort }
          : undefined
      })
    });
    const json = (await response.json()) as OpenAIResponsesResult;

    if (!response.ok) {
      throw new Error(json.error?.message ?? `OpenAI API request failed with status ${response.status}`);
    }

    return extractResponseText(json);
  }
}

export async function generateTaskMarkdown(provider: AIProvider, context: TaskAIContext, model?: string): Promise<string> {
  return (await generateTaskMarkdownResult(provider, context, model)).markdown;
}

export async function generateTaskMarkdownResult(provider: AIProvider, context: TaskAIContext, model?: string): Promise<TaskMarkdownResult> {
  const fileCandidates = context.fileCandidates ?? analyzeFileRelevance(context.requirement, context.projectFiles ?? []);
  const relatedFileCandidates = context.relatedFileCandidates ?? fileCandidates.filter((candidate) => candidate.role !== "ignored").map((candidate) => candidate.path);
  const firstText = await provider.generateText({
    model,
    system: taskAISystemPrompt(),
    prompt: buildTaskAIPrompt(context)
  });
  let taskMarkdown = ensureTaskMarkdownSections(firstText);

  if (hasUnsupportedEmailPasswordSpeculation(context.requirement, taskMarkdown)) {
    const retryText = await provider.generateText({
      model,
      system: taskAISystemPrompt(),
      prompt: `${buildTaskAIPrompt(context)}

이전 응답에는 사용자 요구사항에 없는 이메일/비밀번호 추측이 포함되었습니다.
카카오 로그인 요구사항을 이메일/비밀번호 문제로 바꾸지 말고 다시 생성하세요.
관련 파일이 불명확하면 "현재 코드 확인 필요" 또는 "관련 파일 확인 필요"라고 쓰세요.`
    });
    taskMarkdown = ensureTaskMarkdownSections(retryText);
  }

  if (hasUnsupportedEmailPasswordSpeculation(context.requirement, taskMarkdown)) {
    throw new Error("AI output included unsupported email/password speculation for a Kakao login requirement. No file was written.");
  }

  return postProcessTaskMarkdown(taskMarkdown, context, relatedFileCandidates);
}

export function inferRelatedFileCandidates(requirement: string, projectFiles: string[]): string[] {
  return analyzeFileRelevance(requirement, projectFiles)
    .filter((candidate) => candidate.role === "edit" || candidate.role === "reference")
    .map((candidate) => candidate.path);
}

export function analyzeFileRelevance(
  requirement: string,
  projectFiles: string[],
  metadata: {
    index?: ProjectIndexEntry[];
    summaries?: FileSummary[];
    runTargetFiles?: string[];
    codeGraph?: CodeGraphEntry[];
  } = {}
): TaskAIFileCandidate[] {
  const explicitRoutes = inferExplicitRouteTargets(requirement);
  const tokens = extractRelevanceTokens(requirement);
  const indexByPath = new Map((metadata.index ?? []).map((entry) => [entry.path, entry]));
  const summaryByPath = new Map((metadata.summaries ?? []).map((summary) => [summary.path, summary]));
  const graphByPath = new Map((metadata.codeGraph ?? []).map((entry) => [entry.file, entry]));
  const runTargets = new Set((metadata.runTargetFiles ?? []).filter((file) => requestMatchesFile(requirement, file)));
  const candidateByPath = new Map<string, TaskAIFileCandidate>();
  const seen = new Set(projectFiles);
  for (const route of explicitRoutes.modifyTargets) {
    if (!seen.has(route.path)) {
      seen.add(route.path);
      projectFiles = [...projectFiles, route.path];
    }
  }

  for (const file of projectFiles) {
    const index = indexByPath.get(file);
    const summary = summaryByPath.get(file);
    const graph = graphByPath.get(file);
    const scored = scoreFileRelevance(file, requirement, tokens, explicitRoutes, { index, summary, runTargets, graph });

    candidateByPath.set(file, scored);
  }

  applyGraphImpactScoring(candidateByPath, graphByPath, tokens);

  return [...candidateByPath.values()]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 30);
}

export function extractTaskAIKeywords(requirement: string): string[] {
  const normalized = requirement.toLowerCase();
  const keywords = new Set<string>();
  const keywordGroups = [
    ["settings", "설정"],
    ["admin", "관리자"],
    ["feedback", "의견", "피드백"],
    ["kakao", "카카오"],
    ["login", "로그인"],
    ["auth", "인증"],
    ["previous", "prev", "back", "이전", "뒤로"],
    ["navigation", "navigate", "경로", "이동"],
    ["state", "상태", "유지"],
    ["question", "질문", "문제", "문항"],
    ["dashboard", "대시보드"],
    ["home", "홈"],
    ["tree", "트리"],
    ["leaf", "잎"],
    ["theme", "테마"],
    ["dark", "다크"],
    ["light", "라이트"],
    ["supabase"]
  ];

  for (const group of keywordGroups) {
    if (group.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
      for (const keyword of group) {
        keywords.add(keyword);
      }
    }
  }

  for (const token of extractRequirementTokens(requirement)) {
    keywords.add(token);
  }

  return [...keywords].slice(0, 20);
}

export function buildTaskAIPrompt(context: TaskAIContext): string {
  const taskType = context.taskType ?? classifyTaskType(context.requirement);
  const completionCriteria = context.completionCriteria ?? buildTaskCompletionCriteria(taskType);
  const fileCandidates = context.fileCandidates ?? analyzeFileRelevance(context.requirement, context.projectFiles ?? []);
  const relatedFileCandidates = context.relatedFileCandidates ?? fileCandidates.filter((candidate) => candidate.role !== "ignored").map((candidate) => candidate.path);
  return `사용자 요구사항:
${context.requirement}

Context Priority:
${formatContextPriority()}

Requirement Anchor:
- 원문 requirement를 최상위 기준으로 고정하세요.
- 목표, 현재 문제, 완료 조건은 반드시 이 원문과 같은 주제를 말해야 합니다.
- 아래 프로젝트 상태, 결정, cache, 후보 파일은 참고 자료일 뿐이며 requirement를 덮어쓸 수 없습니다.
- 이전 run/task/docs에 있는 목표나 문장을 현재 requirement와 직접 관련 없으면 사용하지 마세요.
- navigation/back/previous/question/state 문제를 text cleanup/result wording 작업으로 바꾸지 마세요.
- text/result wording 요청을 navigation/state bugfix로 바꾸지 마세요.

프로젝트 규칙:
${context.rulesMarkdown || "(비어 있음)"}

반복하면 안 되는 실수:
${context.mistakesMarkdown || "(비어 있음)"}

프로젝트 상태:
${context.projectStateMarkdown || "(비어 있음)"}

최근 결정:
${context.decisionsMarkdown || "(비어 있음)"}

작업 유형:
${formatTaskType(taskType)}

완료 기준/리뷰 기준:
${formatCompletionCriteria(completionCriteria)}

현재 변경 파일:
${formatChangedFiles(context)}

프로젝트 파일 목록 요약:
${formatProjectFiles(context.projectFiles ?? [])}

키워드 기반 관련 파일 후보:
${formatListOrNeedsCheck(relatedFileCandidates)}

점수 기반 후보 분리:
${formatScoredCandidates(fileCandidates)}

영향도 힌트:
${formatTaskImpactHints(context.impactHints ?? [])}

관련 코드 컨텍스트:
${formatCodeContexts(context.codeContexts ?? [])}

diff 요약:
${context.diffText || "(diff 본문 없음)"}

명시 route 기반 대상 분리:
${formatExplicitRouteGuidance(context.requirement, relatedFileCandidates)}

task.md 생성 규칙:
- "사용자 요구사항 해석" 섹션을 반드시 포함하세요.
- "사용자 요구사항 해석"에는 원문, 해석, 작업 유형, 이 작업이 아닌 것을 짧게 쓰세요.
- "이 작업이 아닌 것"에는 현재 requirement와 혼동하기 쉬운 이전 문맥/다른 작업을 배제하세요.
- "작업 유형" 섹션을 반드시 포함하고, 아래 task type strategy를 파일 후보보다 우선하세요.
${taskTypeStrategyNotes(taskType).map((note) => `- ${note}`).join("\n")}
- "완료 기준" 섹션을 반드시 포함하고, 빌드 성공만 완료 기준으로 쓰지 마세요.
- 완료 기준에는 작업 결과에서 반드시 관찰되어야 할 상태와 blocking failure를 포함하세요.
- i18n/ui_text_cleanup 계열은 수정 전에 사용자 노출 문자열 inventory를 만든다는 기준을 포함하세요.
- 현재 사용자 요구사항을 최우선 기준으로 삼으세요.
- 기존 task.md, run 기록, 프로젝트 문서의 오래된 목표를 복사하지 말고 현재 사용자 요청을 기준으로 새 task.md를 재작성하세요.
- 현재 요청이 기존에 추가된 기능의 UI 개선, 자연스러운 통합, 어색함 제거라면 목표를 "기능 추가"가 아니라 "기존 UI의 자연스러운 통합/개선"으로 작성하세요.
- 새 요청과 이전 컨텍스트가 충돌하면 새 요청을 따르세요.
- userRequest/task/rules/run context에 없는 이해관계자를 만들지 마세요. 예: "디자이너의 요구", "PM 요구사항", "QA 피드백", "사용자 조사 결과", "브랜드 정책" 같은 표현은 사용자가 말한 경우에만 쓰세요.
- UI-only 요청은 기능 추가가 아니라 배치/문구/시각적 위계/기존 흐름 통합으로 해석하세요.
- UI-only 요청에서는 로직, 상태 관리, 저장/복원, fetch/auth, 결과 계산, routing 변경을 기본적으로 보호 대상으로 분리하세요.
- "현재 문제"는 사용자 원문 요구사항에 근거해서만 작성하세요.
- 코드에 근거 없는 원인 추측을 하지 마세요.
- 파일을 확인하지 못했거나 후보가 불충분하면 "현재 코드 확인 필요" 또는 "관련 파일 확인 필요"라고 적으세요.
- 사용자 요구사항에 없는 문제를 만들어내지 마세요.
- 특히 카카오 로그인 요구사항을 이메일/비밀번호 문제로 바꾸지 마세요.
- 반드시 "수정 대상", "참고 대상", "보호 대상"을 분리하세요.
- "수정 대상"은 실제 수정/삭제/생성할 파일만 넣으세요.
- "참고 대상"은 UI/구조를 참고할 수 있지만 직접 수정하지 않는 파일을 넣으세요.
- "보호 대상"은 건드리면 안 되는 실제 기능/데이터/인증 파일을 넣으세요.
- 점수 기반 후보 분리에서 role=edit인 파일은 특별한 반대 근거가 없으면 "수정 대상"에 포함하세요.
- role=reference인 파일은 "참고 대상"에 넣고 기본 수정 대상으로 올리지 마세요.
- role=protected인 파일은 "보호 대상"에 넣고 수정하지 마세요.
- role=ignored인 파일은 task.md에 넣지 마세요.
- edit candidate를 임의로 reference로 낮추지 마세요. 낮출 경우 이유를 Codex 주의사항에 쓰세요.
- "그대로 사용"은 기존 기능 파일을 수정하라는 뜻이 아닐 수 있습니다. 기존 UI를 참고하거나 preview/mock으로 재현한다는 의미인지 먼저 보수적으로 해석하세요.
- public/about/service/screening/소개용 페이지에서는 실제 기능 로직을 건드리지 말고 about/service 전용 preview/mock 구조를 우선 제안하세요.
- 사용자 요청에 명시된 route는 반드시 "수정 대상"과 "수정 범위"에 우선 반영하세요.
- 삭제 요청이 있는 route는 "삭제 대상"으로 명시하세요.
- 관련 파일 후보가 제공된 경우 "수정 범위"에 반드시 후보 파일 경로를 포함하세요.
- 확실하지 않으면 파일명 뒤에 "(후보)"를 붙이세요.
- 후보가 있는데도 "관련 파일 확인 필요"만 단독으로 쓰지 마세요.
- 관련 코드 컨텍스트가 있으면 "수정 범위"에 구체적 파일 경로를 넣되, 근거가 약하면 "(후보)"라고 표시하세요.
- 코드 컨텍스트는 참고용입니다. 실제 수정 전 Codex가 파일을 직접 확인해야 한다고 주의사항에 적으세요.
- "수정 범위"는 관련 파일 후보 또는 코드 컨텍스트를 우선 사용하고, 확실하지 않으면 "관련 파일 확인 필요"로 표시하세요.
- "보호 대상"과 "건드리면 안 되는 것"은 실제 보호해야 할 로직/파일을 짧게 쓰세요. 문서 업데이트 정책 같은 generic 문장은 넣지 마세요.
- "완료 조건"은 사용자가 눈으로 확인할 수 있는 결과 중심으로 쓰세요.
- "검증 명령어"에는 항상 \`pnpm run build\`를 포함하세요.
- about/service, 심사, 서비스 화면, 샘플 데이터, preview, 실제 화면 그대로, 로그인하지 않아도 같은 키워드가 있으면 실제 기능 컴포넌트, Supabase/Auth/fetch 로직은 보호 대상으로 분리하세요.
- about/service 심사용/preview 작업에서는 app/auth/**, components/landing/*login*, components/landing/*start*, lib/auth/**, auth callback 파일을 수정 대상이나 수정 범위 후보에 넣지 말고 보호 대상에만 넣으세요.
- 명시 route가 확인된 경우 "현재 문제"에 "관련 파일 확인 필요" 같은 일반 문장을 반복하지 말고 route 정리 문제를 구체적으로 쓰세요.
- about/service 심사용/preview 작업의 완료 조건에는 /about/service 접근, /review/kakao 제거 또는 접근 불가, 로그인 없는 샘플 데이터 화면, 실제 데이터 fetch 없음, 실제 dashboard/home/auth 로직 직접 수정 없음, pnpm run build 성공을 포함하세요.
- "전체 영문 변환", "다국어", "i18n", "localization", "translation", "언어 전환" 같은 요청은 대규모 i18n 구조 도입 작업으로 해석하세요.
- i18n 작업은 기존 한국어 원본을 덮어쓰지 말고, 번역 리소스와 언어 전환 구조를 추가한 뒤 대표 화면 1개에만 샘플 적용하는 1단계 작업으로 분해하세요.
- i18n 작업에서는 전체 app/page 파일, admin/dashboard/settings/checklist 같은 전역 화면을 무차별 수정 대상으로 나열하지 마세요.
- i18n 작업 task.md에는 "1단계 목표", "이번 작업 범위", "이후 단계", "이번 작업에서 제외할 것" 섹션을 포함하세요.
- architecture/migration처럼 requiresPhasing=true인 작업은 "이번 단계", "이후 단계", "이번 작업에서 제외할 것"을 포함하세요.
- product_strategy 작업은 바로 코드 수정하지 말고 discovery-first product brief 작업으로 작성하세요.
- product_strategy 작업에서는 관련 파일을 "참고 대상"으로만 두고, "수정 대상"은 승인 전까지 없음으로 표시하세요.
- product_strategy 작업에는 "구현 전 정의해야 할 것" 섹션을 포함하고, 왜 써야 하는지/공유 이유/재미 요소/검증 기준/최소 구현 범위를 정의하게 하세요.
- product_strategy 작업에는 "추천 실험 방향" 섹션을 포함하고, implementation 이전 단계의 lightweight experiment proposal을 3~5개 compact하게 제안하세요.
- "추천 실험 방향"은 feature spec, UI redesign, 코드 수정 지시가 아닌 user reaction 중심의 실험 단위여야 합니다. "왜 공유하고 싶어지는지", "왜 다시 해보고 싶어지는지" 기준으로 작성하세요.

위 정보를 바탕으로 .devguard/task.md에 바로 저장할 Markdown만 생성하세요.`;
}

function taskAISystemPrompt(): string {
  return [
    "You generate precise task.md files for a rule-based developer guard CLI.",
    "Return only Markdown. Do not wrap the result in code fences.",
    "The Markdown must include these exact Korean section headings:",
    "## 목표",
    "## 사용자 요구사항 해석",
    "## 작업 유형",
    "## 현재 문제",
    "## 수정 범위",
    "## 수정 대상",
    "## 참고 대상",
    "## 보호 대상",
    "## 반드시 지킬 규칙",
    "## 건드리면 안 되는 것",
    "## 완료 기준",
    "## 완료 조건",
    "## 검증 명령어",
    "## Codex에게 전달할 주의사항",
    "Keep the task narrow, concrete, and verifiable. Never include API keys or secrets.",
    "The current user requirement is the highest-priority source. Do not reuse an old task goal when the user asks for a new refinement.",
    "Add a 사용자 요구사항 해석 section and keep every generated section anchored to the current raw requirement.",
    "If cached context conflicts with the requirement, ignore the cached context.",
    "For UI refinement requests about already-added behavior, frame the goal as natural integration or polish, not adding the feature again.",
    "Do not invent stakeholders such as designer, PM, QA, user research, or brand policy unless explicitly present in the user request or context.",
    "For UI-only tasks, protect logic, state, storage/restore, fetch/auth, result calculation, routing, animation state, cache, providers, and layout shells unless explicitly requested.",
    "Always include pnpm run build in verification commands.",
    "For product_strategy tasks, do not start code edits. Generate a discovery-first brief with reference files only, no primary edit targets until scope is approved.",
    "Do not invent causes that are not supported by the provided project files or user requirement.",
    "If the relevant file is unclear, write 확인 필요 instead of guessing.",
    "Do not transform social-login requirements into email/password issues unless the user explicitly says email/password.",
    "Separate modification targets, reference-only files, and protected files.",
    "Explicit routes in the user requirement must take priority over fuzzy file candidates.",
    "For about/service or screening/preview pages, prefer mock/sample-data preview components and protect real Auth/Supabase/data-fetching logic.",
    "For whole-project English, multilingual, i18n, localization, locale, or translation requests, decompose the work into a first structural step. Preserve existing Korean copy, add translation resources, and apply only one representative screen as a sample."
  ].join("\n");
}

function formatChangedFiles(context: TaskAIContext): string {
  const files = context.changeFiles?.length
    ? context.changeFiles.map((file) => `${file.path} (${file.source}/${file.status})`)
    : context.changedFiles;

  if (files.length === 0) {
    return "- 변경 파일 없음";
  }

  return files.map((file) => `- ${file}`).join("\n");
}

function formatTaskType(taskType: TaskTypeResult): string {
  return [
    `- type: ${taskType.type}`,
    `- confidence: ${taskType.confidence}`,
    `- strategy: ${taskType.strategy}`,
    `- risk: ${taskType.riskLevel}`,
    `- requires phasing: ${taskType.requiresPhasing ? "true" : "false"}`,
    `- reasons: ${taskType.reasons.length > 0 ? taskType.reasons.join("; ") : "none"}`
  ].join("\n");
}

function formatContextPriority(): string {
  const priority = defaultContextPriority();
  return [
    `- requirement: ${priority.requirement}`,
    `- relatedCode: ${priority.relatedCode}`,
    `- taskSubtypeContext: ${priority.taskSubtypeContext}`,
    `- recentRun: ${priority.recentRun}`,
    `- projectMemory: ${priority.projectMemory}`,
    `- staleDocs: ${priority.staleDocs}`,
    "- rule: Requirement > Current code context > subtype context > previous runs/docs"
  ].join("\n");
}

function extractResponseText(json: OpenAIResponsesResult): string {
  if (json.output_text?.trim()) {
    return json.output_text.trim();
  }

  const text = json.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("OpenAI API response did not include text output.");
  }

  return text;
}

function formatProjectFiles(projectFiles: string[]): string {
  if (projectFiles.length === 0) {
    return "- 프로젝트 파일 목록 없음";
  }

  return projectFiles.slice(0, 200).map((file) => `- ${file}`).join("\n");
}

function formatListOrNeedsCheck(items: string[]): string {
  if (items.length === 0) {
    return "- 관련 파일 확인 필요";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function formatScoredCandidates(candidates: TaskAIFileCandidate[]): string {
  if (candidates.length === 0) {
    return "- 후보 없음";
  }

  const groups = [
    ["edit candidates", candidates.filter((candidate) => candidate.role === "edit")],
    ["reference candidates", candidates.filter((candidate) => candidate.role === "reference")],
    ["protected candidates", candidates.filter((candidate) => candidate.role === "file-protected" || candidate.role === "logic-protected" || candidate.role === "protected")]
  ] as const;

  return groups
    .map(([title, items]) => {
      const body =
        items.length > 0
          ? items
              .slice(0, 8)
              .map((candidate) => {
                const reasons = candidate.reasons.length > 0 ? candidate.reasons.join("; ") : "no positive reason";
                const negative =
                  candidate.negativeReasons.length > 0 ? ` negative: ${candidate.negativeReasons.join("; ")}` : "";
                return `- ${candidate.path} (score ${candidate.score}) reasons: ${reasons}${negative}`;
              })
              .join("\n")
          : "- 없음";
      return `### ${title}\n${body}`;
    })
    .join("\n\n");
}

function formatCodeContexts(codeContexts: NonNullable<TaskAIContext["codeContexts"]>): string {
  if (codeContexts.length === 0) {
    return "- 관련 코드 컨텍스트 없음";
  }

  return codeContexts
    .map((context) => {
      const keywords = context.matchedKeywords.length > 0 ? context.matchedKeywords.join(", ") : "키워드 직접 발견 없음";
      const truncated = context.truncated ? "yes" : "no";
      return `### ${context.path}\n- 발견 키워드: ${keywords}\n- truncated: ${truncated}\n\n\`\`\`\n${context.excerpt}\n\`\`\``;
    })
    .join("\n\n");
}

function formatTaskImpactHints(impactHints: NonNullable<TaskAIContext["impactHints"]>): string {
  if (impactHints.length === 0) {
    return "- 영향도 힌트 없음";
  }
  return impactHints
    .slice(0, 5)
    .map((hint) => `- ${hint.file}: imported by ${hint.importedByCount}; affected ${hint.affectedAreas.join(", ") || "unknown"}`)
    .join("\n");
}

function extractRequirementTokens(requirement: string): string[] {
  return [...new Set(requirement.toLowerCase().match(/[a-z0-9가-힣]{3,}/g) ?? [])].slice(0, 12);
}

function extractRelevanceTokens(requirement: string): string[] {
  const tokens = new Set(extractRequirementTokens(requirement));
  const groups = [
    ["result", "결과"],
    ["question", "질문", "문항"],
    ["choice", "선택"],
    ["previous", "prev", "back", "이전", "뒤로"],
    ["navigation", "navigate", "이동", "경로"],
    ["state", "상태", "유지"],
    ["auth", "인증", "로그인", "login"],
    ["settings", "설정"],
    ["admin", "관리자"],
    ["feedback", "피드백", "의견"],
    ["theme", "테마", "다크", "dark", "light"],
    ["dashboard", "대시보드"],
    ["home", "홈"],
    ["tree", "트리"]
  ];
  const lower = requirement.toLowerCase();

  for (const group of groups) {
    if (group.some((token) => lower.includes(token.toLowerCase()))) {
      for (const token of group) {
        tokens.add(token.toLowerCase());
      }
    }
  }

  return [...tokens].filter((token) => token.length >= 2).slice(0, 24);
}

function scoreFileRelevance(
  file: string,
  requirement: string,
  tokens: string[],
  explicitRoutes: ExplicitRouteTargets,
  metadata: {
    index?: ProjectIndexEntry;
    summary?: FileSummary;
    runTargets: Set<string>;
    graph?: CodeGraphEntry;
  }
): TaskAIFileCandidate {
  const reasons: string[] = [];
  const negativeReasons: string[] = [];
  let score = scoreExplicitCandidate(file, explicitRoutes);
  if (score > 0) {
    reasons.push("explicit route match");
  }

  const pathTokens = tokenizePath(file);
  const keywordTokens = new Set([...(metadata.index?.keywords ?? []), ...(metadata.summary?.keywords ?? [])].flatMap(tokenizeText));
  const categoryTokens = new Set(tokenizeText(metadata.index?.category ?? ""));
  const featureTokens = new Set((metadata.summary?.features ?? []).flatMap(tokenizeText));
  const routeTokens = new Set(extractRouteSegments(file).flatMap(tokenizeText));
  const exportTokens = new Set((metadata.graph?.exports ?? []).flatMap(tokenizeText));
  const usageTokens = new Set((metadata.graph?.usageHints ?? []).flatMap(tokenizeText));

  for (const token of tokens) {
    if (pathTokens.has(token)) {
      score += 12;
      reasons.push(`path token:${token}`);
    } else if ([...pathTokens].some((pathToken) => pathToken.includes(token) || token.includes(pathToken))) {
      score += 5;
      reasons.push(`path partial:${token}`);
    }

    if (keywordTokens.has(token)) {
      score += 8;
      reasons.push(`summary keyword:${token}`);
    }

    if (categoryTokens.has(token)) {
      score += 8;
      reasons.push(`category:${token}`);
    }

    if (routeTokens.has(token)) {
      score += 10;
      reasons.push(`route segment:${token}`);
    }

    if (featureTokens.has(token)) {
      score += 6;
      reasons.push(`related feature:${token}`);
    }

    if (exportTokens.has(token)) {
      score += 7;
      reasons.push(`export:${token}`);
    }

    if (usageTokens.has(token)) {
      score += 4;
      reasons.push(`usage hint:${token}`);
    }
  }

  if (metadata.runTargets.has(file)) {
    score += 6;
    reasons.push("matching saved run target");
  }

  for (const conflict of conflictingConcepts(requirement)) {
    if (pathTokens.has(conflict) || keywordTokens.has(conflict) || categoryTokens.has(conflict) || featureTokens.has(conflict)) {
      score -= 16;
      negativeReasons.push(`conflicting token:${conflict}`);
    }
  }

  if (shouldExcludeExplicitCandidate(file, explicitRoutes)) {
    score -= 100;
    negativeReasons.push("excluded by explicit route intent");
  }

  const role = score >= 12 ? "edit" : score >= 5 ? "reference" : score <= -20 ? "ignored" : "ignored";
  return {
    path: file,
    score,
    reasons: [...new Set(reasons)].slice(0, 8),
    negativeReasons: [...new Set(negativeReasons)].slice(0, 6),
    role
  };
}

function applyGraphImpactScoring(
  candidates: Map<string, TaskAIFileCandidate>,
  graphByPath: Map<string, CodeGraphEntry>,
  tokens: string[]
): void {
  const directMatches = [...candidates.values()].filter((candidate) => candidate.score >= 12);
  for (const candidate of directMatches) {
    const graph = graphByPath.get(candidate.path);
    if (!graph) {
      continue;
    }
    for (const importer of graph.importedBy.slice(0, 12)) {
      bumpGraphCandidate(candidates, importer, 7, `reverse dependency of ${candidate.path}`);
    }
    for (const imported of graph.imports.slice(0, 8)) {
      bumpGraphCandidate(candidates, imported, 4, `dependency of ${candidate.path}`);
    }
  }

  for (const [path, graph] of graphByPath.entries()) {
    const haystack = [path, graph.category, ...graph.exports, ...graph.usageHints].join(" ").toLowerCase();
    if (tokens.some((token) => haystack.includes(token))) {
      continue;
    }
    const sameCluster = [...candidates.values()].some((candidate) => {
      const candidateGraph = graphByPath.get(candidate.path);
      return candidate.score >= 12 && candidateGraph?.category === graph.category;
    });
    if (sameCluster) {
      bumpGraphCandidate(candidates, path, 2, `same feature cluster:${graph.category}`);
    }
  }
}

function bumpGraphCandidate(candidates: Map<string, TaskAIFileCandidate>, path: string, delta: number, reason: string): void {
  const current =
    candidates.get(path) ??
    ({
      path,
      score: 0,
      reasons: [],
      negativeReasons: [],
      role: "ignored"
    } satisfies TaskAIFileCandidate);
  current.score += delta;
  current.reasons = [...new Set([...current.reasons, reason])].slice(0, 8);
  if (current.score >= 12) {
    current.role = "edit";
  } else if (current.score >= 5 && current.role !== "edit") {
    current.role = "reference";
  }
  candidates.set(path, current);
}

function tokenizePath(path: string): Set<string> {
  return new Set(tokenizeText(path.replace(/\.[^.]+$/, "")));
}

function tokenizeText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9가-힣]+/)
    .filter((token) => token.length >= 2);
}

function extractRouteSegments(file: string): string[] {
  const parts = file.split("/");
  const appIndex = parts.indexOf("app");
  if (appIndex >= 0) {
    return parts.slice(appIndex + 1, -1);
  }
  const pagesIndex = parts.indexOf("pages");
  if (pagesIndex >= 0) {
    return parts.slice(pagesIndex + 1, -1);
  }
  return [];
}

function conflictingConcepts(requirement: string): string[] {
  const lower = requirement.toLowerCase();
  const conflicts: string[] = [];
  const wantsResult = /result|결과/.test(lower);
  const wantsQuestion = /question|choice|질문|문제|문항|선택/.test(lower);
  const wantsNavigationState = /이전|뒤로|돌아가|previous|prev|back|navigation|navigate|state|상태|유지|바뀌/.test(lower);

  if (wantsResult && !wantsQuestion) {
    conflicts.push("question", "choice", "질문", "문항", "선택");
  }

  if ((wantsQuestion || wantsNavigationState) && !wantsResult) {
    conflicts.push("result", "결과");
  }

  if (wantsNavigationState) {
    conflicts.push("wording", "copy", "text", "문구", "텍스트", "표현");
  }

  return conflicts;
}

function requestMatchesFile(requirement: string, file: string): boolean {
  const fileTokens = tokenizePath(file);
  return extractRelevanceTokens(requirement).some((token) => fileTokens.has(token));
}

interface ExplicitRouteTarget {
  path: string;
  label?: string;
}

interface ExplicitRouteTargets {
  modifyTargets: ExplicitRouteTarget[];
  deletionTargets: ExplicitRouteTarget[];
  referenceTargets: ExplicitRouteTarget[];
  protectedTargets: ExplicitRouteTarget[];
  previewIntent: boolean;
}

function ensureTaskMarkdownSections(markdown: string): string {
  const requiredHeadings = [
    "## 목표",
    "## 사용자 요구사항 해석",
    "## 작업 유형",
    "## 현재 문제",
    "## 수정 범위",
    "## 수정 대상",
    "## 참고 대상",
    "## 보호 대상",
    "## 반드시 지킬 규칙",
    "## 건드리면 안 되는 것",
    "## 완료 조건",
    "## 검증 명령어",
    "## Codex에게 전달할 주의사항"
  ];
  const trimmed = markdown.replace(/^```(?:md|markdown)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const missing = requiredHeadings.filter((heading) => !trimmed.includes(heading));

  if (missing.length === 0) {
    return `${trimmed}\n`;
  }

  return `${trimmed}\n\n${missing
    .map((heading) => `${heading}\n- TODO: AI output omitted this required section. Fill this before handing to Codex.`)
    .join("\n\n")}\n`;
}

function postProcessTaskMarkdown(markdown: string, context: TaskAIContext, candidates: string[]): TaskMarkdownResult {
  const explicitRoutes = inferExplicitRouteTargets(context.requirement);
  const taskType = context.taskType ?? classifyTaskType(context.requirement);
  const i18nTask = taskType.type === "i18n";
  let nextMarkdown = sanitizeHallucinatedTaskText(markdown);
  let changed = false;

  const taskTypeResult = applyTaskTypeSection(nextMarkdown, taskType);
  nextMarkdown = taskTypeResult.markdown;
  changed ||= taskTypeResult.changed;

  const interpretationResult = applyRequirementInterpretationSection(nextMarkdown, context);
  nextMarkdown = interpretationResult.markdown;
  changed ||= interpretationResult.changed;

  const criteriaResult = applyCompletionCriteriaSection(nextMarkdown, context.completionCriteria ?? buildTaskCompletionCriteria(taskType));
  nextMarkdown = criteriaResult.markdown;
  changed ||= criteriaResult.changed;

  const currentRequestResult = applyCurrentRequestPrioritySections(nextMarkdown, context.requirement);
  nextMarkdown = currentRequestResult.markdown;
  changed ||= currentRequestResult.changed;

  if (i18nTask) {
    const i18nResult = applyI18nTaskDecomposition(nextMarkdown, context, taskType);
    nextMarkdown = i18nResult.markdown;
    changed ||= i18nResult.changed;
    const compactResult = compactRedundantTaskSections(nextMarkdown);
    nextMarkdown = compactResult.markdown;
    changed ||= compactResult.changed;
    return {
      markdown: nextMarkdown,
      scopeFilledFromCandidates: changed
    };
  } else {
    if (taskType.type === "product_strategy") {
      const productResult = applyProductStrategySections(nextMarkdown, context, candidates);
      nextMarkdown = productResult.markdown;
      changed ||= productResult.changed;
      const compactResult = compactRedundantTaskSections(nextMarkdown);
      nextMarkdown = compactResult.markdown;
      changed ||= compactResult.changed;
      return {
        markdown: nextMarkdown,
        scopeFilledFromCandidates: changed
      };
    }

    const scopeResult = fillScopeFromCandidates(nextMarkdown, candidates, explicitRoutes);
    nextMarkdown = scopeResult.markdown;
    changed ||= scopeResult.scopeFilledFromCandidates;

    const targetResult = applyExplicitTargetSections(nextMarkdown, explicitRoutes, candidates);
    nextMarkdown = targetResult.markdown;
    changed ||= targetResult.changed;

    const directTargetResult = applyDirectModificationTargets(nextMarkdown, context.requirement, candidates);
    nextMarkdown = directTargetResult.markdown;
    changed ||= directTargetResult.changed;

    const qualityResult = applyIntentQualitySections(nextMarkdown, explicitRoutes);
    nextMarkdown = qualityResult.markdown;
    changed ||= qualityResult.changed;

    if (taskType.requiresPhasing) {
      const phasingResult = applyGenericPhasingSections(nextMarkdown, taskType);
      nextMarkdown = phasingResult.markdown;
      changed ||= phasingResult.changed;
    }
  }

  const safetyResult = applyGeneralTaskQualitySections(nextMarkdown, context, candidates);
  nextMarkdown = safetyResult.markdown;
  changed ||= safetyResult.changed;

  const normalizationResult = normalizeTaskTargetProtectionSeparation(nextMarkdown);
  nextMarkdown = normalizationResult.markdown;
  changed ||= normalizationResult.changed;

  const mismatchResult = applyRequirementMismatchGuard(nextMarkdown, context, candidates);
  nextMarkdown = mismatchResult.markdown;
  changed ||= mismatchResult.changed;

  const compactResult = compactRedundantTaskSections(nextMarkdown);
  nextMarkdown = compactResult.markdown;
  changed ||= compactResult.changed;

  return {
    markdown: nextMarkdown,
    scopeFilledFromCandidates: changed
  };
}

function compactRedundantTaskSections(markdown: string): { markdown: string; changed: boolean } {
  let nextMarkdown = markdown;
  let changed = false;
  const protectedLines = sectionLines(readMarkdownSection(nextMarkdown, "보호 대상"));

  for (const section of ["건드리면 안 되는 것", "Codex에게 전달할 주의사항"]) {
    const lines = sectionLines(readMarkdownSection(nextMarkdown, section));
    const compacted = removeDuplicateMeaning(lines, protectedLines);
    if (compacted.join("\n") !== lines.join("\n")) {
      nextMarkdown = replaceMarkdownSection(nextMarkdown, section, compacted.join("\n") || "- 보호 대상에 적힌 로직/영역을 건드리지 않는다.");
      changed = true;
    }
  }

  const criteriaLines = sectionLines(readMarkdownSection(nextMarkdown, "완료 기준"));
  const conditionLines = sectionLines(readMarkdownSection(nextMarkdown, "완료 조건"));
  const compactConditions = removeDuplicateMeaning(conditionLines, criteriaLines);
  if (compactConditions.join("\n") !== conditionLines.join("\n")) {
    nextMarkdown = replaceMarkdownSection(nextMarkdown, "완료 조건", compactConditions.join("\n") || "- 완료 기준을 충족한다.");
    changed = true;
  }

  return { markdown: nextMarkdown, changed };
}

function sectionLines(section: string | undefined): string[] {
  return (section ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function removeDuplicateMeaning(lines: string[], existing: string[]): string[] {
  const existingKeys = new Set(existing.map(normalizeMeaningKey).filter(Boolean));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const key = normalizeMeaningKey(line);
    if (!key || existingKeys.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(line);
  }
  return result;
}

function normalizeMeaningKey(line: string): string {
  return line
    .replace(/^[-*]\s*/, "")
    .replace(/\s+/g, "")
    .replace(/[./]/g, "")
    .replace(/수정하지않는다|변경하지않는다|건드리지않는다|보호한다/g, "보호")
    .toLowerCase();
}

function sanitizeHallucinatedTaskText(markdown: string): string {
  const bannedFragments = [
    "디자이너의 요구",
    "디자이너 요구",
    "PM 요구사항",
    "QA 피드백",
    "사용자 조사 결과",
    "브랜드 정책"
  ];
  const genericForbiddenPatterns = [
    /[-*]\s*구조 또는 문서 설정이 변경되면 문서를 업데이트해야 한다\.\s*/g,
    /[-*]\s*문서 업데이트가 필요한 경우.*$/gm
  ];
  let next = markdown;

  for (const fragment of bannedFragments) {
    next = next.replaceAll(fragment, "사용자 요청");
  }

  for (const pattern of genericForbiddenPatterns) {
    next = next.replace(pattern, "");
  }

  next = next
    .replace(/페이지에\s*ai가\s*것처럼/gi, "페이지에 AI가 쓴 것처럼 느껴지는")
    .replace(/AI가\s*것처럼/gi, "AI가 쓴 것처럼")
    .replace(/것처럼\s*어색하거나\s*의미가\s*불분명한/gi, "AI가 쓴 것처럼 어색하거나 의미가 불분명한");

  return next.replace(/\n{4,}/g, "\n\n\n");
}

function applyCurrentRequestPrioritySections(markdown: string, requirement: string): { markdown: string; changed: boolean } {
  const taskType = classifyTaskType(requirement);
  if (taskType.subtype === "bugfix.navigation_state") {
    let nextMarkdown = markdown;
    let changed = false;
    const target = inferNavigationStateTarget(requirement);
    const goal = `${target}에서 이전 항목으로 돌아갈 때 원래 보던 항목과 상태가 유지되도록 navigation/state 버그를 수정한다.`;
    const problem = `${target}에서 이전으로 돌아가면 원래 있던 항목이 유지되지 않고 다른 항목으로 바뀌는 문제가 있다.`;
    const goalSection = readMarkdownSection(nextMarkdown, "목표") ?? "";
    const problemSection = readMarkdownSection(nextMarkdown, "현재 문제") ?? "";
    if (isWeakOrMismatchedSubject(goalSection, requirement, taskType)) {
      nextMarkdown = replaceMarkdownSection(nextMarkdown, "목표", goal);
      changed = true;
    }
    if (isWeakOrMismatchedSubject(problemSection, requirement, taskType)) {
      nextMarkdown = replaceMarkdownSection(nextMarkdown, "현재 문제", problem);
      changed = true;
    }
    const rulesResult = ensureSectionLines(
      nextMarkdown,
      "반드시 지킬 규칙",
      [
        "- 이전/뒤로 이동 전후의 항목 identity와 선택 상태를 유지한다.",
        "- 새 질문 흐름이나 결과 페이지 문구 수정으로 범위를 바꾸지 않는다.",
        "- 상태 저장/복원, navigation history, 선택 값 갱신 지점을 먼저 확인한다."
      ],
      inferExplicitRouteTargets(requirement)
    );
    nextMarkdown = rulesResult.markdown;
    changed ||= rulesResult.changed;
    return { markdown: nextMarkdown, changed };
  }

  if (!isUiOnlyRefinementRequest(requirement)) {
    return { markdown, changed: false };
  }

  let nextMarkdown = markdown;
  let changed = false;
  const target = inferUiRefinementTarget(requirement);
  const goal = isResultPageRequest(requirement)
    ? "결과 페이지의 어색한 표현을 사용자가 바로 이해할 수 있는 말로 다듬는다."
    : `${target} UI를 새 기능처럼 튀지 않게 기존 흐름 안에 자연스럽게 통합한다.`;
  const problem = isResultPageRequest(requirement)
    ? "결과 페이지에 AI가 쓴 것처럼 느껴지는 어색하거나 의미가 불분명한 단어가 있다."
    : `${target} 동작 자체는 구현되었지만, UI가 기존 화면 흐름과 어울리지 않아 불필요한 요소가 갑자기 추가된 것처럼 보인다.`;

  const currentGoal = readMarkdownSection(nextMarkdown, "목표")?.trim() ?? "";
  if (!currentGoal || /기능\s*추가|수단\s*추가|추가한다|돌아갈 수 있는 수단|적절하게|AI가 쓴 것처럼 느껴지는 단어/i.test(currentGoal)) {
    nextMarkdown = replaceMarkdownSection(nextMarkdown, "목표", goal);
    changed = true;
  }

  const currentProblem = readMarkdownSection(nextMarkdown, "현재 문제")?.trim() ?? "";
  if (
    !currentProblem ||
    /기능\s*추가|수단\s*추가|확인 필요|자연스럽게 수정 필요|판단 필요|적절한|올바르게/i.test(currentProblem) ||
    (isResultPageRequest(requirement) && !currentProblem.includes("결과 페이지"))
  ) {
    nextMarkdown = replaceMarkdownSection(nextMarkdown, "현재 문제", problem);
    changed = true;
  }

  const ruleLines = [
    "- 이미 구현된 동작을 다시 추가하는 작업으로 해석하지 않는다.",
    "- 기존 기능은 유지하고, 배치/문구/시각적 위계를 최소 수정으로 자연스럽게 다듬는다.",
    "- 새 버튼/카드/섹션을 무리하게 추가하지 않고 기존 UI 흐름 안에 흡수하는 방향을 우선한다."
  ];
  const rulesResult = ensureSectionLines(nextMarkdown, "반드시 지킬 규칙", ruleLines, inferExplicitRouteTargets(requirement));
  nextMarkdown = rulesResult.markdown;
  changed ||= rulesResult.changed;

  return { markdown: nextMarkdown, changed };
}

function inferNavigationStateTarget(requirement: string): string {
  if (/설문|survey|질문|문제|question/i.test(requirement)) {
    return "설문 질문 흐름";
  }
  if (/페이지|page/i.test(requirement)) {
    return "페이지 이동 흐름";
  }
  return "이전 이동 흐름";
}

function isWeakOrMismatchedSubject(text: string, requirement: string, taskType: TaskTypeResult): boolean {
  if (!text.trim() || /확인 필요|판단 필요|적절한|올바르게/i.test(text)) {
    return true;
  }
  return detectRequirementMismatch(text, requirement, taskType).length > 0;
}

function applyGeneralTaskQualitySections(markdown: string, context: TaskAIContext, candidates: string[]): { markdown: string; changed: boolean } {
  let nextMarkdown = markdown;
  let changed = false;
  const explicitRoutes = inferExplicitRouteTargets(context.requirement);
  const uiOnly = isUiOnlyRefinementRequest(context.requirement);
  const protectionLines = inferProtectionLines(context, candidates, uiOnly);
  const forbiddenLines = inferForbiddenLines(protectionLines, uiOnly);
  const completionLines = inferCompletionLines(context.requirement, uiOnly);

  const protectedResult = uiOnly
    ? replaceSectionWithLines(nextMarkdown, "보호 대상", protectionLines)
    : ensureSectionLines(nextMarkdown, "보호 대상", protectionLines, explicitRoutes);
  nextMarkdown = protectedResult.markdown;
  changed ||= protectedResult.changed;

  const forbiddenResult = uiOnly
    ? replaceSectionWithLines(nextMarkdown, "건드리면 안 되는 것", forbiddenLines)
    : replaceWeakOrGenericSectionLines(nextMarkdown, "건드리면 안 되는 것", forbiddenLines);
  nextMarkdown = forbiddenResult.markdown;
  changed ||= forbiddenResult.changed;

  const completionResult = uiOnly
    ? replaceSectionWithLines(nextMarkdown, "완료 조건", completionLines)
    : replaceWeakOrGenericSectionLines(nextMarkdown, "완료 조건", completionLines);
  nextMarkdown = completionResult.markdown;
  changed ||= completionResult.changed;

  const verificationResult = ensureBuildVerification(nextMarkdown);
  nextMarkdown = verificationResult.markdown;
  changed ||= verificationResult.changed;

  const rules = uiOnly
    ? [
        "- 기능을 다시 추가하지 않는다.",
        "- 로직 변경 없이 배치, 문구, 시각적 위계 중심으로 최소 수정한다.",
        "- 기존 흐름 안에 흡수할 수 있으면 새 UI 요소를 추가하지 않는다."
      ]
    : ["- 사용자 요청에 없는 이해관계자나 배경 설명을 만들지 않는다."];
  const rulesResult = uiOnly
    ? replaceSectionWithLines(nextMarkdown, "반드시 지킬 규칙", rules)
    : replaceWeakOrGenericSectionLines(nextMarkdown, "반드시 지킬 규칙", rules);
  nextMarkdown = rulesResult.markdown;
  changed ||= rulesResult.changed;

  const cautionLines = [
    "- 기능/결과 계산 로직은 수정하지 않는다.",
    "- 텍스트와 최소 UI 표현만 수정한다.",
    "- 새 UI 섹션을 추가하지 않는다."
  ];
  const cautionResult = uiOnly
    ? replaceSectionWithLines(nextMarkdown, "Codex에게 전달할 주의사항", cautionLines)
    : replaceWeakOrGenericSectionLines(nextMarkdown, "Codex에게 전달할 주의사항", cautionLines);
  nextMarkdown = cautionResult.markdown;
  changed ||= cautionResult.changed;

  return { markdown: nextMarkdown, changed };
}

function isUiOnlyRefinementRequest(requirement: string): boolean {
  const normalized = requirement.toLowerCase();
  const hasUi = /ui|화면|버튼|요소|디자인|배치|흐름|시각적|위계|표현/.test(normalized);
  const hasRefinement = /자연스럽|부자연|어색|뜬금|위화감|시각적 위계|배치 조정|표현 수정|더 매끄럽|흐름 안에|녹아들|다듬|개선|정리|튀지 않|불필요/.test(normalized);
  const referencesExistingWork = /잘 이뤄졌|이미|기존|추가된|돌아가|이전/.test(normalized);
  return hasUi && hasRefinement && (referencesExistingWork || !/새로|추가|구현|만들/.test(normalized));
}

function inferUiRefinementTarget(requirement: string): string {
  if (isResultPageRequest(requirement)) {
    return "결과 페이지 표현";
  }

  if (/이전|돌아가|back/i.test(requirement)) {
    return "이전으로 돌아가기";
  }

  const tokens = extractRequirementTokens(requirement).slice(0, 3);
  return tokens.length > 0 ? tokens.join(" ") : "요청된";
}

function applyTaskTypeSection(markdown: string, taskType: TaskTypeResult): { markdown: string; changed: boolean } {
  const body = [
    `- type: ${taskType.type}`,
    ...(taskType.subtype ? [`- subtype: ${taskType.subtype}`] : []),
    `- confidence: ${taskType.confidence}`,
    `- strategy: ${taskType.strategy}`,
    `- risk: ${taskType.riskLevel}`,
    ...(taskType.domainKeywords?.length ? [`- domain: ${taskType.domainKeywords.join(", ")}`] : [])
  ].join("\n");
  const existing = readMarkdownSection(markdown, "작업 유형")?.trim();
  if (existing === body) {
    return { markdown, changed: false };
  }

  return {
    markdown: replaceMarkdownSection(markdown, "작업 유형", body),
    changed: true
  };
}

function applyRequirementInterpretationSection(markdown: string, context: TaskAIContext): { markdown: string; changed: boolean } {
  const taskType = context.taskType ?? classifyTaskType(context.requirement);
  const body = [
    `- 원문: ${context.requirement}`,
    `- inferred intent: ${interpretRequirement(context.requirement, taskType)}`,
    `- inferred domain: ${taskType.domainKeywords?.length ? taskType.domainKeywords.join(", ") : "확인 필요"}`,
    `- inferred subtype: ${taskType.subtype ?? taskType.type}`,
    `- inferred risk: ${taskType.riskLevel}`,
    "- 이 작업이 아닌 것:",
    ...notThisTaskLines(context.requirement, taskType).map((line) => `  - ${line}`)
  ].join("\n");
  const existing = readMarkdownSection(markdown, "사용자 요구사항 해석")?.trim();
  if (existing === body) {
    return { markdown, changed: false };
  }
  return {
    markdown: replaceMarkdownSection(markdown, "사용자 요구사항 해석", body),
    changed: true
  };
}

function interpretRequirement(requirement: string, taskType: TaskTypeResult): string {
  if (taskType.type === "product_strategy") {
    return "제품 가치, 사용 이유, 재미/공유/리텐션 요소를 코드 수정 전에 정의하는 discovery-first 작업이다.";
  }
  if (taskType.subtype === "bugfix.navigation_state") {
    return "이전/뒤로 이동 시 원래 보던 항목과 상태가 유지되지 않고 다른 항목으로 바뀌는 navigation/state 버그를 재현하고 수정한다.";
  }
  if (taskType.type === "ui_text_cleanup" || taskType.subtype === "bugfix.text_content") {
    return "사용자가 보는 문구와 표현을 더 명확하고 자연스럽게 다듬는다.";
  }
  if (taskType.type === "i18n") {
    return "기존 언어를 유지하면서 다국어/영어 지원 구조를 단계적으로 추가한다.";
  }
  return "사용자 원문 요구사항 범위 안에서 문제를 해결한다.";
}

function notThisTaskLines(requirement: string, taskType: TaskTypeResult): string[] {
  if (taskType.type === "product_strategy") {
    return [
      "바로 UI 섹션이나 기능을 추가하는 구현 작업",
      "결과 페이지 파일을 primary edit target으로 확정하는 작업",
      "결과 계산, 저장, 인증, routing 로직 변경"
    ];
  }
  if (taskType.subtype === "bugfix.navigation_state") {
    return [
      "결과 페이지 문구 수정",
      "UI 카피라이팅 정리",
      "결과 계산 로직 변경",
      "새 질문 흐름 추가"
    ];
  }
  if (taskType.type === "ui_text_cleanup" || taskType.subtype === "bugfix.text_content") {
    return [
      "navigation/state 버그 수정",
      "결과 계산 로직 변경",
      "데이터 저장/복원 구조 변경"
    ];
  }
  if (taskType.type === "i18n") {
    return [
      "전체 페이지 한국어 문구를 한 번에 영어로 덮어쓰기",
      "인증/데이터 저장/분석 로직 수정",
      "모든 화면 번역 완료로 간주하기"
    ];
  }
  return ["사용자 입력에 없는 이전 task 목표 재사용", "관련 없는 파일/도메인 수정"];
}

function applyCompletionCriteriaSection(markdown: string, criteria: ReturnType<typeof buildTaskCompletionCriteria>): { markdown: string; changed: boolean } {
  const lines = [
    ...criteria.requiredChecks,
    ...(criteria.blockingFailures ?? []).map((item) => `실패 조건: ${item}`)
  ].map((item) => `- ${item}`);
  const body = lines.join("\n");
  const existing = readMarkdownSection(markdown, "완료 기준")?.trim();
  if (existing === body) {
    return { markdown, changed: false };
  }

  return {
    markdown: replaceMarkdownSection(markdown, "완료 기준", body),
    changed: true
  };
}

function inferExperimentIdeas(subtype: string | undefined, requirement: string): string[] {
  if (subtype === "viral_loop") {
    return [
      "- 결과 공유 시 '내 점수 vs 친구 점수' 비교 포맷 노출",
      "- 결과 일부를 blur 처리하고 '공유하면 전체 공개' 유도",
      "- 공유 버튼 문구를 '결과 공유' 대신 감정 반응 유발 문장으로 교체",
      "- 결과 카드에 '상위 X%' 수치 추가로 자랑 동기 강화",
      "- '친구가 본 당신' 형식으로 타인 시선 비교 요소 추가"
    ];
  }
  if (subtype === "retention_hook") {
    return [
      "- 진행 중 '상위 3%만 여기까지 왔습니다' 희소성 카피 실험",
      "- 결과 화면에 '답을 바꾸면 결과가 달라질 수 있어요' 재시도 훅",
      "- 마지막 문항 진입 시 '거의 다 왔어요' 기대감 카피 강화",
      "- 결과 저장 + 일정 기간 후 '결과가 바뀌었을까?' 재방문 유도",
      "- 테스트 완료 직후 '한 번 더 해볼까요?' 재시작 진입점 강화"
    ];
  }
  if (subtype === "fun_factor") {
    return [
      "- 결과 제목을 현재 유행 밈 문법으로 재구성",
      "- 문항 표현에 공감/유머 추가 (딱딱한 질문 → 대화체)",
      "- 결과 화면에 과장된 감탄사/이모지로 감정 반응 강화",
      "- TikTok/Threads 스타일 짧고 강한 문장 구조 실험",
      "- '당신은 X형 인간' 같은 정체성 라벨링으로 공감 자극"
    ];
  }
  if (subtype === "result_shareability") {
    return [
      "- 결과 제목을 더 공격적/밈 스타일로 교체",
      "- 결과 카드를 스크린샷하기 좋은 짧은 문장 구조로 재구성",
      "- '친구가 본 당신' 형식의 비교 요소 추가",
      "- 결과 일부를 blur 처리하고 공유 후 전체 공개 유도",
      "- 결과 공유 시 친구와 점수 비교 유도"
    ];
  }
  // engagement_positioning default — also covers concept_validation, product_copy
  return [
    "- 서비스 진입 카피를 '왜 해야 하는지' 동기 유발 한 문장으로 교체",
    "- 결과 제목을 더 공격적/밈 스타일로 변경",
    "- 결과 공유 시 친구 비교 유도",
    "- 테스트 진행 중 기대감 카피 강화",
    "- TikTok/Threads 스타일 짧은 문장 구조 실험"
  ];
}

function applyProductStrategySections(markdown: string, context: TaskAIContext, candidates: string[]): { markdown: string; changed: boolean } {
  const references = candidates.slice(0, 6).map((candidate) => `- ${candidate}`);
  let nextMarkdown = markdown;

  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "목표",
    "서비스를 꼭 써야 하는 이유와 재미/공유/재방문 동기를 코드 수정 전에 정의한다."
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "현재 문제",
    "서비스의 핵심 사용 이유, 재미 요소, 유행성/공유성이 아직 명확하지 않아 바로 기능 추가로 해결할 수 있는 상태가 아니다."
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "수정 범위",
    "- 코드 수정 전 기획 정의 필요\n- 직접 수정 대상 없음"
  );
  nextMarkdown = replaceMarkdownSection(nextMarkdown, "수정 대상", "- 없음. product brief 승인 전까지 코드 수정하지 않는다.");
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "참고 대상",
    references.length > 0 ? references.join("\n") : "- 현재 결과/공유/진입 흐름 관련 파일은 필요 시 reference로만 확인한다."
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "보호 대상",
    [
      "- 결과 계산 로직",
      "- 상태 저장/복원 로직",
      "- routing/auth/fetch 처리",
      "- 검증되지 않은 데이터 구조",
      "- 기존 공유/결과 렌더링 동작"
    ].join("\n")
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "구현 전 정의해야 할 것",
    [
      "- 사용자가 이 서비스를 굳이 해야 하는 한 문장 이유",
      "- 결과를 친구에게 공유하고 싶은 이유",
      "- 끝까지 진행하게 만드는 긴장감/기대감",
      "- 결과 페이지에서 기억에 남는 표현 방식",
      "- 현재 유행 문법과 연결할 수 있는 요소",
      "- 코드로 구현할 최소 범위와 검증 기준"
    ].join("\n")
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "추천 실험 방향",
    inferExperimentIdeas(context.taskType?.subtype, context.requirement).join("\n")
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "반드시 지킬 규칙",
    [
      "- 바로 코드 수정하지 말고 product brief 또는 implementation proposal을 먼저 작성한다.",
      "- 관련 파일은 reference로만 보고 수정 대상으로 확정하지 않는다.",
      "- 구현이 필요하면 최소 변경 범위와 검증 기준을 먼저 제안한다."
    ].join("\n")
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "건드리면 안 되는 것",
    [
      "- 바로 UI 섹션 추가",
      "- 결과 계산 로직",
      "- 상태 저장/복원",
      "- routing/auth/fetch",
      "- 검증되지 않은 데이터 구조 변경"
    ].join("\n")
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "완료 조건",
    [
      "- 서비스의 핵심 hook이 한 문장으로 정의된다.",
      "- 공유하고 싶은 이유와 다시 써볼 이유가 분리되어 적힌다.",
      "- 구현 후보가 최소 범위와 검증 기준으로 정리된다.",
      "- 코드 수정이 필요하면 승인받을 수 있는 implementation proposal이 있다."
    ].join("\n")
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "검증 명령어",
    "- 코드 수정 전에는 실행 명령 없음\n- 코드 수정 범위가 승인되면 `pnpm run build`"
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "Codex에게 전달할 주의사항",
    [
      "- 바로 코드 수정하지 말고 먼저 product brief 또는 implementation proposal을 작성한다.",
      "- 코드 수정이 필요하면 최소 변경 범위를 제안한 뒤 진행한다.",
      "- 결과/공유 관련 파일은 reference일 뿐 primary target이 아니다."
    ].join("\n")
  );

  return { markdown: nextMarkdown, changed: true };
}

function applyI18nTaskDecomposition(markdown: string, context: TaskAIContext, taskType: TaskTypeResult): { markdown: string; changed: boolean } {
  const plan = inferI18nPlan(context.projectFiles ?? []);
  let nextMarkdown = markdown;

  nextMarkdown = replaceMarkdownSection(nextMarkdown, "목표", "기존 한국어 UI를 유지한 채 영어 리소스와 언어 전환 기반을 추가하는 1단계 i18n 구조를 도입한다.");
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "현재 문제",
    "전체 영문 변환은 단순 문자열 치환이 아니라 번역 리소스와 언어 선택 구조가 필요한 대규모 작업이다. 한 번에 모든 페이지의 한국어를 영어로 덮어쓰면 기존 UI와 기능을 깨뜨릴 수 있다."
  );
  nextMarkdown = replaceMarkdownSection(nextMarkdown, "수정 범위", plan.editTargets.join("\n"));
  nextMarkdown = replaceMarkdownSection(nextMarkdown, "수정 대상", plan.editTargets.join("\n"));
  nextMarkdown = replaceMarkdownSection(nextMarkdown, "참고 대상", plan.referenceTargets.join("\n"));
  nextMarkdown = replaceMarkdownSection(nextMarkdown, "보호 대상", i18nProtectionLines().join("\n"));
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "완료 기준",
    [
      "- 사용자 노출 문자열 inventory가 먼저 정리된다.",
      "- 대상 페이지에서 locale=en 시 한국어 UI가 섞이지 않는다.",
      "- 사용자 노출 문자열은 locale resource로 이동한다.",
      "- aria-label/title/placeholder/metadata 문자열도 locale resource 기준으로 처리한다.",
      "- locale resource key가 ko/en 사이에서 대응된다.",
      "- 실패 조건: 고유명사 외 하드코딩 사용자 노출 문자열 잔존",
      "- 실패 조건: locale=en 화면에 한국어 문구 혼입",
      "- 실패 조건: ko/en resource key 불일치",
      "- 실패 조건: metadata/aria-label/title/placeholder 미처리"
    ].join("\n")
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "1단계 목표",
    [
      "- 프로젝트 전체 번역을 바로 끝내려 하지 않는다.",
      "- 번역 리소스 구조와 언어 전환 기반을 먼저 만든다.",
      "- 대표 public 화면 1개에서만 ko/en 리소스 사용을 샘플로 연결한다."
    ].join("\n")
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "이번 단계",
    [
      "- i18n 리소스와 설정 구조를 추가한다.",
      "- 대표 화면 1개에서만 언어 리소스 사용을 연결한다.",
      "- 전체 화면 번역은 다음 단계로 남긴다."
    ].join("\n")
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "이번 작업 범위",
    [
      "- 기존 한국어 원본 유지",
      "- 영어 리소스 추가",
      "- messages/ko, messages/en 또는 lib/i18n 기반 구조 추가",
      "- 언어 선택/조회 helper 또는 provider 최소 구조 추가",
      "- 대표 public/landing/about 화면 1개에만 샘플 적용"
    ].join("\n")
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "이후 단계",
    [
      "- dashboard 화면 번역 적용",
      "- record flow 번역 적용",
      "- settings/archive/admin 화면 번역 적용",
      "- 알림, 에러 메시지, 빈 상태 문구 번역 확장",
      "- 필요 시 locale routing 또는 middleware 도입 검토"
    ].join("\n")
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "이번 작업에서 제외할 것",
    [
      "- 전체 페이지 텍스트를 한 번에 직접 수정",
      "- 한국어 문구를 영어로 덮어쓰기",
      "- admin/dashboard/settings/checklist 등 전역 화면 무차별 수정",
      "- locale routing/middleware 변경. 명시적으로 필요할 때만 별도 단계에서 검토",
      "- auth/session, Supabase, 저장/분석 로직 수정"
    ].join("\n")
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "반드시 지킬 규칙",
    [
      "- i18n은 1단계 구조 도입 작업으로 분해한다.",
      "- 기존 한국어 UI와 문구는 기본값으로 유지한다.",
      "- 영어는 별도 리소스로 추가한다.",
      "- 대표 화면 1개만 샘플 적용하고 전체 번역은 이후 단계로 남긴다.",
      "- 기능 로직, 데이터 로직, 인증 로직은 변경하지 않는다."
    ].join("\n")
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "건드리면 안 되는 것",
    [
      "- 기존 한국어 copy 삭제 또는 영어 덮어쓰기",
      "- auth/session 처리",
      "- Supabase query/mutation",
      "- record 저장/분석 로직",
      "- Edge Functions",
      "- notification logic",
      "- locale routing이 이번 범위로 확정되지 않은 상태의 routing behavior"
    ].join("\n")
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "완료 조건",
    [
      "- 한국어 기존 UI가 유지된다.",
      "- 영어 리소스 구조가 추가된다.",
      "- 샘플 화면에서 언어 리소스를 사용할 수 있다.",
      "- 전체 번역은 다음 단계로 남긴다.",
      "- `pnpm run build`가 성공한다."
    ].join("\n")
  );
  nextMarkdown = replaceMarkdownSection(nextMarkdown, "검증 명령어", "- `pnpm run build`");
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "Codex에게 전달할 주의사항",
    [
      "- 전체 페이지를 한 번에 번역하지 말고 i18n 구조와 샘플 적용만 구현한다.",
      "- 한국어 원본은 유지하고 영어 메시지를 별도 파일/구조로 추가한다.",
      "- 페이지별 텍스트 교체가 필요하면 대표 public 화면 1개로 제한한다.",
      "- 데이터, 인증, 저장, 분석, 알림 로직은 수정하지 않는다."
    ].join("\n")
  );

  return { markdown: nextMarkdown, changed: true };
}

function applyGenericPhasingSections(markdown: string, taskType: TaskTypeResult): { markdown: string; changed: boolean } {
  let nextMarkdown = markdown;
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "이번 단계",
    [
      `- ${taskType.type} 작업을 한 번에 전체 적용하지 않고 1단계 범위로 제한한다.`,
      "- 영향 범위와 위험을 확인할 수 있는 최소 구조 또는 대표 경로만 다룬다.",
      "- 다음 단계로 넘길 파일/화면을 명시한다."
    ].join("\n")
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "이후 단계",
    [
      "- 남은 화면/모듈로 점진 확장한다.",
      "- 호환성, 회귀 위험, 검증 결과를 확인한 뒤 다음 범위를 연다.",
      "- 필요하면 rollback point를 기준으로 단계별 반영한다."
    ].join("\n")
  );
  nextMarkdown = replaceMarkdownSection(
    nextMarkdown,
    "이번 작업에서 제외할 것",
    [
      "- 전체 프로젝트 일괄 수정",
      "- 요청과 직접 관련 없는 전역 파일 수정",
      "- 검증 없이 구조를 대체하는 변경",
      "- 기존 정상 동작을 바꾸는 리팩터링"
    ].join("\n")
  );

  return { markdown: nextMarkdown, changed: true };
}

function inferI18nPlan(projectFiles: string[]): { editTargets: string[]; referenceTargets: string[] } {
  const existingI18nFiles = projectFiles
    .filter((file) => /(^|\/)(i18n|locale|locales|messages|translations|dictionaries)(\/|\.|-|_)/i.test(file))
    .slice(0, 5)
    .map((file) => `- ${file}`);
  const editTargets = existingI18nFiles.length > 0 ? existingI18nFiles : [
    "- lib/i18n/config.ts (신규 후보)",
    "- messages/ko.json (신규 후보)",
    "- messages/en.json (신규 후보)"
  ];

  const layoutFile = firstExisting(projectFiles, ["app/layout.tsx", "src/app/layout.tsx", "pages/_app.tsx", "src/pages/_app.tsx"]);
  if (layoutFile) {
    editTargets.push(`- ${layoutFile} (provider 필요 시 최소 수정)`);
  }

  const representativePage = findRepresentativePublicPage(projectFiles);
  if (representativePage) {
    editTargets.push(`- ${representativePage} (샘플 적용 후보)`);
  } else {
    editTargets.push("- 대표 public page 1개 (확인 필요, 샘플 적용 후보)");
  }

  const referenceTargets = [
    representativePage ? `- ${representativePage} (대표 화면 구조 참고)` : "- 대표 public/landing/about 화면 1개 확인 필요",
    "- 기존 한국어 문구와 화면 흐름",
    "- package.json (i18n 라이브러리 도입 여부 확인)"
  ];

  return {
    editTargets: [...new Set(editTargets)].slice(0, 8),
    referenceTargets
  };
}

function firstExisting(projectFiles: string[], candidates: string[]): string | undefined {
  const fileSet = new Set(projectFiles);
  return candidates.find((candidate) => fileSet.has(candidate));
}

function findRepresentativePublicPage(projectFiles: string[]): string | undefined {
  const preferred = [
    "app/about/page.tsx",
    "src/app/about/page.tsx",
    "app/about/service/page.tsx",
    "src/app/about/service/page.tsx",
    "app/page.tsx",
    "src/app/page.tsx",
    "pages/index.tsx",
    "src/pages/index.tsx"
  ];
  const direct = firstExisting(projectFiles, preferred);
  if (direct) {
    return direct;
  }

  return projectFiles.find((file) => /(^|\/)(about|landing|public|home)(\/|[-_.])/.test(file) && /\.(tsx|jsx|ts|js)$/.test(file));
}

function i18nProtectionLines(): string[] {
  return [
    "- auth/session 처리",
    "- Supabase query/mutation",
    "- record 저장/분석 로직",
    "- Edge Functions",
    "- notification logic",
    "- existing Korean copy",
    "- routing behavior. locale routing이 명시 범위일 때만 별도 검토"
  ];
}

function inferProtectionLines(context: TaskAIContext, candidates: string[], uiOnly: boolean): string[] {
  const text = [context.requirement, ...(context.codeContexts ?? []).map((item) => `${item.path}\n${item.excerpt}`), ...candidates].join("\n").toLowerCase();
  const lines = new Set<string>();

  if (uiOnly) {
    lines.add("- 결과 계산/타입 산출 로직");
    lines.add("- 상태 저장/복원 로직");
    lines.add("- routing/provider 설정");
    lines.add("- fetch/auth/session 처리");
  }

  const rules: Array<[RegExp, string]> = [
    [/localstorage|sessionstorage|저장|복원|restore|state|useState|zustand|reducer|상태/i, "- 상태 저장/복원 로직"],
    [/auth|session|login|로그인|인증|fetch|api|cache|캐시/i, "- fetch/auth/session 처리"],
    [/calculate|calculation|score|결과\s*계산|계산|type|타입/i, "- 결과 계산/타입 산출 로직"],
    [/route|router|navigation|routing|경로|라우팅|provider|context/i, "- routing/provider 설정"],
    [/animation|motion|transition|애니메이션/i, "- animation state와 transition 동작"],
    [/layout|shell|wrapper|레이아웃/i, "- 기존 layout/shell/wrapper 구조"]
  ];

  for (const [pattern, line] of rules) {
    if (pattern.test(text)) {
      lines.add(line);
    }
  }

  if (lines.size === 0) {
    lines.add("- 사용자 요청과 직접 관련 없는 기존 동작");
    lines.add("- 기존 데이터 처리와 상태 관리 로직");
  }

  return compactProtectionLines([...lines]).slice(0, 8);
}

function compactProtectionLines(lines: string[]): string[] {
  const canonical = new Map<string, string>();
  const mappings: Array<[RegExp, string]> = [
    [/결과|계산|타입|score|calculation/i, "- 결과 계산/타입 산출 로직"],
    [/localStorage|sessionStorage|저장|복원|state|상태/i, "- 상태 저장/복원 로직"],
    [/fetch|auth|session|login|api|인증|로그인/i, "- fetch/auth/session 처리"],
    [/routing|route|router|navigation|provider|context|라우팅/i, "- routing/provider 설정"],
    [/animation|transition|motion|애니메이션/i, "- animation/transition 상태"],
    [/cache|query|캐시/i, "- cache/query 상태 관리"],
    [/layout|shell|wrapper|레이아웃/i, "- layout/shell/wrapper 구조"]
  ];

  for (const line of lines) {
    const normalized = line.replace(/^-\s*/, "").trim();
    if (looksLikeFilePath(normalized)) {
      continue;
    }
    const mapped = mappings.find(([pattern]) => pattern.test(normalized))?.[1] ?? `- ${normalized}`;
    canonical.set(mapped, mapped);
  }

  return [...canonical.values()];
}

function inferForbiddenLines(protectionLines: string[], uiOnly: boolean): string[] {
  const base = protectionLines.map((line) => line.replace(/^-\s*/, "- 수정 금지: "));
  if (uiOnly) {
    base.unshift("- 기능 추가로 해석하지 않고 텍스트와 최소 UI 표현만 수정한다.");
  }

  return [...new Set(base)].slice(0, 8);
}

function inferCompletionLines(requirement: string, uiOnly: boolean): string[] {
  if (!uiOnly) {
    return ["- 사용자 요청의 관찰 가능한 결과가 동작한다.", "- 기존 핵심 동작이 유지된다."];
  }

  const target = inferUiRefinementTarget(requirement);
  if (isResultPageRequest(requirement)) {
    return [
      "- 결과 페이지 문구가 사용자가 바로 이해할 수 있는 말로 정리된다.",
      "- AI가 쓴 것처럼 어색하거나 의미가 불분명한 단어가 줄어든다.",
      "- 기능, 결과 계산, 상태 저장/복원 로직은 유지된다.",
      "- 텍스트와 필요한 최소 UI 표현만 수정된다."
    ];
  }

  return [
    `- ${target} UI가 기존 화면 흐름 안에 자연스럽게 녹아든다.`,
    "- 기존 기능 동작은 유지된다.",
    "- 새로 덧붙인 UI 요소처럼 튀어 보이지 않는다.",
    "- 불필요한 카드, 버튼, 설명 문구를 추가하지 않는다."
  ];
}

function replaceWeakOrGenericSectionLines(markdown: string, section: string, lines: string[]): { markdown: string; changed: boolean } {
  const existingBody = readMarkdownSection(markdown, section);
  const uniqueLines = [...new Set(lines.filter(Boolean))];
  if (existingBody === undefined) {
    return {
      markdown: `${markdown.trimEnd()}\n\n## ${section}\n${uniqueLines.join("\n")}\n`,
      changed: true
    };
  }

  const cleanBody = existingBody
    .split("\n")
    .filter((line) => !/문서 업데이트|문서 설정|정책|판단 필요|적절한|올바르게|확인할 수 있어야 한다|자연스럽게 수정 필요/i.test(line))
    .join("\n")
    .trim();
  const shouldReplace = isWeakScopeBody(cleanBody) || cleanBody.length === 0;
  if (shouldReplace) {
    return {
      markdown: replaceMarkdownSection(markdown, section, uniqueLines.join("\n")),
      changed: true
    };
  }

  const missingLines = uniqueLines.filter((line) => !cleanBody.includes(line.replace(/^-\s+/, "")));
  if (missingLines.length === 0 && cleanBody === existingBody.trim()) {
    return { markdown, changed: false };
  }

  return {
    markdown: replaceMarkdownSection(markdown, section, [cleanBody, ...missingLines].filter(Boolean).join("\n")),
    changed: true
  };
}

function replaceSectionWithLines(markdown: string, section: string, lines: string[]): { markdown: string; changed: boolean } {
  const body = [...new Set(lines.filter(Boolean))].join("\n");
  const existingBody = readMarkdownSection(markdown, section)?.trim();
  if (existingBody === body) {
    return { markdown, changed: false };
  }

  return {
    markdown: replaceMarkdownSection(markdown, section, body),
    changed: true
  };
}

function normalizeTaskTargetProtectionSeparation(markdown: string): { markdown: string; changed: boolean } {
  const editTargets = extractSectionPathSet(markdown, "수정 대상");
  const scopeTargets = extractSectionPathSet(markdown, "수정 범위");
  const targets = new Set([...editTargets, ...scopeTargets]);
  if (targets.size === 0) {
    return { markdown, changed: false };
  }

  const protectedBody = readMarkdownSection(markdown, "보호 대상");
  if (protectedBody === undefined) {
    return { markdown, changed: false };
  }

  const filtered = compactProtectionLines(
    protectedBody
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => {
        const path = extractPathFromLine(line);
        return !path || !targets.has(path);
      })
  );
  const nextBody = filtered.length > 0 ? filtered.join("\n") : "- 사용자 요청과 직접 관련 없는 기존 동작";
  if (nextBody === protectedBody.trim()) {
    return { markdown, changed: false };
  }

  return {
    markdown: replaceMarkdownSection(markdown, "보호 대상", nextBody),
    changed: true
  };
}

function applyRequirementMismatchGuard(markdown: string, context: TaskAIContext, candidates: string[]): { markdown: string; changed: boolean } {
  const taskType = context.taskType ?? classifyTaskType(context.requirement);
  const checkedSections = ["목표", "현재 문제", "완료 조건", "Codex에게 전달할 주의사항"]
    .map((section) => readMarkdownSection(markdown, section) ?? "")
    .join("\n");
  const drift = analyzeSemanticDrift(context.requirement, checkedSections, taskType);
  const reasons = detectRequirementMismatch(checkedSections, context.requirement, taskType);
  if (reasons.length === 0 && drift.severity === "low") {
    return { markdown, changed: false };
  }

  let nextMarkdown = markdown;
  if (drift.severity === "medium") {
    nextMarkdown = replaceWeakOrGenericSectionLines(nextMarkdown, "Codex에게 전달할 주의사항", [
      "- 현재 사용자 요구사항을 기준으로만 수정한다.",
      "- 이전 context가 다른 주제를 말하면 참고하지 않는다.",
      "- 애매한 파일은 수정 전에 직접 확인한다."
    ]).markdown;
    nextMarkdown = applyRequirementInterpretationSection(nextMarkdown, context).markdown;
    return { markdown: nextMarkdown, changed: true };
  }

  if (drift.severity === "high" && taskType.subtype === "bugfix.navigation_state") {
    const target = inferNavigationStateTarget(context.requirement);
    nextMarkdown = replaceMarkdownSection(
      nextMarkdown,
      "목표",
      `${target}에서 이전 항목으로 돌아갈 때 원래 보던 항목과 상태가 유지되도록 navigation/state 버그를 수정한다.`
    );
    nextMarkdown = replaceMarkdownSection(
      nextMarkdown,
      "현재 문제",
      `${target}에서 이전으로 돌아가면 원래 있던 항목이 유지되지 않고 다른 항목으로 바뀌는 문제가 있다.`
    );
    nextMarkdown = replaceMarkdownSection(
      nextMarkdown,
      "완료 조건",
      [
        "- 이전으로 돌아가도 원래 보던 항목이 다른 항목으로 바뀌지 않는다.",
        "- 사용자가 선택했던 값과 진행 상태가 의도한 범위에서 유지된다.",
        "- 결과 페이지 문구나 카피라이팅 수정으로 범위가 바뀌지 않는다.",
        "- 기존 결과 계산/저장 로직은 유지된다.",
        "- `pnpm run build`가 성공한다."
      ].join("\n")
    );
    nextMarkdown = replaceMarkdownSection(
      nextMarkdown,
      "반드시 지킬 규칙",
      [
        "- 이전/뒤로 이동 전후의 항목 identity와 선택 상태를 유지한다.",
        "- 새 질문 흐름이나 결과 페이지 문구 수정으로 범위를 바꾸지 않는다.",
        "- 상태 저장/복원, navigation history, 선택 값 갱신 지점을 먼저 확인한다.",
        "- 사용자 요청과 직접 관련 없는 UI copy 변경을 하지 않는다."
      ].join("\n")
    );
    nextMarkdown = replaceMarkdownSection(
      nextMarkdown,
      "건드리면 안 되는 것",
      [
        "- 결과 페이지 문구 수정",
        "- UI 카피라이팅 정리",
        "- 결과 계산 로직",
        "- 사용자 요청과 직접 관련 없는 기존 동작"
      ].join("\n")
    );
    nextMarkdown = replaceMarkdownSection(
      nextMarkdown,
      "Codex에게 전달할 주의사항",
      [
        "- 현재 사용자 요구사항을 기준으로 navigation/state 버그만 수정한다.",
        "- 이전 task/run/docs의 다른 목표가 섞이면 무시한다.",
        "- 결과 페이지 문구나 copy 정리 작업으로 바꾸지 않는다.",
        "- 원래 요구사항과 직접 관련 없는 파일은 수정하지 않는다."
      ].join("\n")
    );
    const scopedCandidates = candidates
      .filter((candidate) => !/(result|결과|wording|copy|text)/i.test(candidate))
      .slice(0, 6);
    if (scopedCandidates.length > 0 && isWeakScopeBody(readMarkdownSection(nextMarkdown, "수정 범위") ?? "")) {
      nextMarkdown = replaceMarkdownSection(nextMarkdown, "수정 범위", scopedCandidates.map((candidate) => `- ${candidate} (후보)`).join("\n"));
    }
  }

  nextMarkdown = applyRequirementInterpretationSection(nextMarkdown, context).markdown;
  if (drift.severity === "high" && taskType.subtype !== "bugfix.navigation_state") {
    nextMarkdown = replaceWeakOrGenericSectionLines(nextMarkdown, "Codex에게 전달할 주의사항", [
      "- 현재 사용자 요구사항을 기준으로만 수정한다.",
      "- 이전 task/run/docs의 다른 목표가 섞이면 무시한다.",
      "- 원래 요구사항과 직접 관련 없는 파일은 수정하지 않는다."
    ]).markdown;
  }

  return { markdown: nextMarkdown, changed: true };
}

export function detectRequirementMismatch(text: string, requirement: string, taskType: TaskTypeResult = classifyTaskType(requirement)): string[] {
  const reasons: string[] = [];
  if (!text.trim()) {
    return reasons;
  }
  const drift = analyzeSemanticDrift(requirement, text, taskType);
  if (drift.severity !== "low") {
    reasons.push(...drift.reasons);
  }
  const normalizedText = text.toLowerCase();
  const normalizedRequirement = requirement.toLowerCase();

  if (taskType.subtype === "bugfix.navigation_state") {
    const hasNavigationSubject = /(이전|뒤로|돌아가|previous|prev|back|navigation|navigate|질문|문제|question|state|상태|유지|바뀌|변경)/i.test(text);
    const hasTextCleanupSubject = /(결과\s*페이지.*(문구|텍스트|표현|단어)|문구\s*수정|카피라이팅|copy|wording|어색한\s*표현|모호한\s*표현)/i.test(text);
    if (!hasNavigationSubject) {
      reasons.push("generated text does not mention navigation/back/question/state subject");
    }
    if (hasTextCleanupSubject && !/(문구|텍스트|표현|copy|wording)/i.test(requirement)) {
      reasons.push("generated text appears to use stale text/result wording context");
    }
  }

  if ((taskType.type === "ui_text_cleanup" || taskType.subtype === "bugfix.text_content") && /(이전|뒤로|돌아가|previous|back|navigation|state|상태)/i.test(text) && !/(이전|뒤로|돌아가|previous|back|navigation|state|상태)/i.test(requirement)) {
    reasons.push("generated text appears to use stale navigation/state context");
  }

  const suspiciousTokens = ["피하는 방향", "모순"];
  for (const token of suspiciousTokens) {
    if (normalizedText.includes(token.toLowerCase()) && !normalizedRequirement.includes(token.toLowerCase())) {
      reasons.push(`generated text includes token not anchored to requirement: ${token}`);
    }
  }

  if (/(^|[^가-힣])결([^가-힣]|$)/.test(text) && !/(^|[^가-힣])결([^가-힣]|$)/.test(requirement)) {
    reasons.push("generated text includes unexplained shorthand token");
  }

  return [...new Set(reasons)];
}

function extractSectionPathSet(markdown: string, section: string): Set<string> {
  const body = readMarkdownSection(markdown, section) ?? "";
  return new Set(body.split("\n").map(extractPathFromLine).filter((path): path is string => Boolean(path)));
}

function extractPathFromLine(line: string): string | undefined {
  const cleaned = line
    .trim()
    .replace(/^[-*]\s*/, "")
    .replace(/`/g, "")
    .replace(/\s+\([^)]*\).*$/, "")
    .replace(/\s+-\s+.*$/, "")
    .trim();
  return looksLikeFilePath(cleaned) ? cleaned : undefined;
}

function looksLikeFilePath(value: string): boolean {
  return /^(app|apps|components|src|lib|hooks|utils|pages|packages|supabase|styles|constants|public)\//.test(value);
}

function applyDirectModificationTargets(markdown: string, requirement: string, candidates: string[]): { markdown: string; changed: boolean } {
  const directTargets = inferDirectModificationTargets(requirement, candidates);
  if (directTargets.length === 0) {
    return { markdown, changed: false };
  }

  let nextMarkdown = markdown;
  let changed = false;
  const targetLines = directTargets.map((target) => `- ${target}`);

  const targetResult = ensureDirectSectionTargets(nextMarkdown, "수정 대상", targetLines, requirement);
  nextMarkdown = targetResult.markdown;
  changed ||= targetResult.changed;

  const scopeResult = ensureDirectSectionTargets(nextMarkdown, "수정 범위", targetLines, requirement);
  nextMarkdown = scopeResult.markdown;
  changed ||= scopeResult.changed;

  const references = (readMarkdownSection(nextMarkdown, "참고 대상") ?? "")
    .split("\n")
    .filter((line) => !directTargets.some((target) => line.includes(target)))
    .join("\n")
    .trim();
  if (references !== (readMarkdownSection(nextMarkdown, "참고 대상") ?? "").trim()) {
    nextMarkdown = replaceMarkdownSection(nextMarkdown, "참고 대상", references || "- 주변 파일은 필요할 때만 확인한다.");
    changed = true;
  }

  return { markdown: nextMarkdown, changed };
}

function inferDirectModificationTargets(requirement: string, candidates: string[]): string[] {
  return analyzeFileRelevance(requirement, candidates)
    .filter((candidate) => candidate.role === "edit")
    .map((candidate) => candidate.path)
    .slice(0, 5);
}

function ensureDirectSectionTargets(markdown: string, section: string, targetLines: string[], requirement: string): { markdown: string; changed: boolean } {
  const existingBody = readMarkdownSection(markdown, section);
  if (existingBody === undefined || isWeakScopeBody(existingBody)) {
    return {
      markdown: replaceMarkdownSection(markdown, section, targetLines.join("\n")),
      changed: true
    };
  }

  const cleaned = existingBody
    .split("\n")
    .filter((line) => !isIrrelevantTargetLine(line, requirement))
    .join("\n")
    .trim();
  const missing = targetLines.filter((line) => !cleaned.includes(line.replace(/^-\s*/, "")));
  const nextBody = [cleaned, ...missing].filter(Boolean).join("\n");
  if (nextBody === existingBody.trim()) {
    return { markdown, changed: false };
  }

  return {
    markdown: replaceMarkdownSection(markdown, section, nextBody),
    changed: true
  };
}

function isIrrelevantTargetLine(line: string, requirement: string): boolean {
  return conflictingConcepts(requirement).some((token) => tokenizeText(line).includes(token));
}

function ensureBuildVerification(markdown: string): { markdown: string; changed: boolean } {
  const existingBody = readMarkdownSection(markdown, "검증 명령어");
  const buildLine = "- `pnpm run build`";
  if (existingBody === undefined) {
    return {
      markdown: `${markdown.trimEnd()}\n\n## 검증 명령어\n${buildLine}\n`,
      changed: true
    };
  }

  if (/pnpm\s+run\s+build/.test(existingBody)) {
    return { markdown, changed: false };
  }

  return {
    markdown: replaceMarkdownSection(markdown, "검증 명령어", `${existingBody.trim()}\n${buildLine}`.trim()),
    changed: true
  };
}

function fillScopeFromCandidates(markdown: string, candidates: string[], explicitRoutes: ExplicitRouteTargets): TaskMarkdownResult {
  const candidateList = candidates.filter((candidate) => isScopeCandidate(candidate, explicitRoutes)).slice(0, 8);
  const explicitScopeItems = [
    ...explicitRoutes.modifyTargets.map((target) => formatTargetLine(target)),
    ...explicitRoutes.deletionTargets.map((target) => formatTargetLine(target, "삭제 대상"))
  ];
  if (candidateList.length === 0 && explicitScopeItems.length === 0) {
    return {
      markdown,
      scopeFilledFromCandidates: false
    };
  }
  const candidateScope = formatCandidateScope(candidateList.filter((candidate) => !explicitScopeItems.some((item) => item.includes(candidate))));
  const scopeBody = [...explicitScopeItems.map((item) => `- ${item}`), candidateScope].filter(Boolean).join("\n");

  const existingScope = readMarkdownSection(markdown, "수정 범위");
  if (existingScope === undefined) {
    return {
      markdown: `${markdown.trimEnd()}\n\n## 수정 범위\n${scopeBody}\n`,
      scopeFilledFromCandidates: true
    };
  }

  const body = existingScope.trim();
  const withoutUnsupportedAboutRoot = removeProtectedCandidateLines(
    removeReferenceOnlyScopeLines(removeUnsupportedAboutPage(body, explicitRoutes), explicitRoutes),
    explicitRoutes
  );
  const missingExplicitItems = explicitScopeItems.filter((item) => !withoutUnsupportedAboutRoot.includes(item.split(" ")[0] ?? item));
  if (!isWeakScopeBody(withoutUnsupportedAboutRoot) && missingExplicitItems.length === 0 && withoutUnsupportedAboutRoot === body) {
    return {
      markdown,
      scopeFilledFromCandidates: false
    };
  }

  const nextBody = isWeakScopeBody(withoutUnsupportedAboutRoot)
    ? scopeBody
    : [...missingExplicitItems.map((item) => `- ${item}`), withoutUnsupportedAboutRoot].filter(Boolean).join("\n");
  return {
    markdown: replaceMarkdownSection(markdown, "수정 범위", nextBody),
    scopeFilledFromCandidates: true
  };
}

function isWeakScopeBody(body: string): boolean {
  if (!body) {
    return true;
  }

  const normalized = body.replace(/^[-*\s]+/gm, "").trim();
  return /^(관련 파일 확인 필요|확인 필요|비어 있음|없음|없다|none)$/i.test(normalized);
}

function formatCandidateScope(candidates: string[]): string {
  return candidates.map((candidate) => `- ${candidate} (후보)`).join("\n");
}

function applyExplicitTargetSections(
  markdown: string,
  explicitRoutes: ExplicitRouteTargets,
  candidates: string[]
): { markdown: string; changed: boolean } {
  let nextMarkdown = markdown;
  let changed = false;
  const modifyLines = [
    ...explicitRoutes.modifyTargets.map((target) => `- ${formatTargetLine(target)}`),
    ...explicitRoutes.deletionTargets.map((target) => `- ${formatTargetLine(target, "삭제 대상")}`)
  ];
  const referenceLines = [
    ...explicitRoutes.referenceTargets.map((target) => `- ${formatTargetLine(target)}`),
    ...candidates.filter(isLikelyRealFeatureFile).slice(0, 8).map((candidate) => `- ${candidate} (참고 대상)`)
  ];
  const protectedLines = explicitRoutes.protectedTargets.map((target) => `- ${formatTargetLine(target)}`);

  const targetResult = ensureSectionLines(nextMarkdown, "수정 대상", modifyLines, explicitRoutes);
  nextMarkdown = targetResult.markdown;
  changed ||= targetResult.changed;

  const referenceResult = ensureSectionLines(nextMarkdown, "참고 대상", referenceLines, explicitRoutes);
  nextMarkdown = referenceResult.markdown;
  changed ||= referenceResult.changed;

  const protectedResult = ensureSectionLines(nextMarkdown, "보호 대상", protectedLines, explicitRoutes);
  nextMarkdown = protectedResult.markdown;
  changed ||= protectedResult.changed;

  if (explicitRoutes.previewIntent) {
    const ruleLines = [
      "- 실제 기능 컴포넌트는 기본 수정하지 않는다.",
      "- 실제 기능 UI는 참고하되 about/service 전용 preview 컴포넌트에서 샘플 데이터로 재현한다.",
      "- Supabase/Auth/실제 사용자 데이터 fetch 로직은 수정하지 않는다."
    ];
    const rulesResult = ensureSectionLines(nextMarkdown, "반드시 지킬 규칙", ruleLines, explicitRoutes);
    nextMarkdown = rulesResult.markdown;
    changed ||= rulesResult.changed;
  }

  return { markdown: nextMarkdown, changed };
}

function applyIntentQualitySections(markdown: string, explicitRoutes: ExplicitRouteTargets): { markdown: string; changed: boolean } {
  if (!explicitRoutes.previewIntent) {
    return { markdown, changed: false };
  }

  let nextMarkdown = markdown;
  let changed = false;

  if (
    explicitRoutes.modifyTargets.some((target) => target.path === "app/about/service/page.tsx") &&
    explicitRoutes.deletionTargets.some((target) => target.path === "app/review/kakao/page.tsx")
  ) {
    const problem =
      "심사용 서비스 화면이 /about/service와 /review/kakao로 분산되어 있고, 실제 기능 UI와 샘플 화면의 일관성을 /about/service 중심으로 정리해야 한다.";
    const currentProblem = readMarkdownSection(nextMarkdown, "현재 문제")?.trim() ?? "";
    if (!currentProblem || /관련 파일.*확인 필요|정확한 수정 지점.*확인/i.test(currentProblem) || !currentProblem.includes("/about/service")) {
      nextMarkdown = replaceMarkdownSection(nextMarkdown, "현재 문제", problem);
      changed = true;
    }
  }

  const completionLines = [
    "- `/about/service` 경로로 심사용 서비스 화면에 접속할 수 있다.",
    "- `/review/kakao` 경로는 제거되었거나 접근할 수 없다.",
    "- 로그인 없이 샘플 데이터 기반으로 대시보드 나무, 기록 작성, 기록으로 보는 나 화면을 확인할 수 있다.",
    "- 실제 사용자 데이터 fetch, Supabase 호출, Auth/session 로직을 추가하거나 수정하지 않는다.",
    "- 실제 dashboard/home/auth 기능 로직을 직접 수정하지 않는다.",
    "- `pnpm run build`가 성공한다."
  ];
  const completionResult = ensureSectionLines(nextMarkdown, "완료 조건", completionLines, explicitRoutes);
  nextMarkdown = completionResult.markdown;
  changed ||= completionResult.changed;

  return { markdown: nextMarkdown, changed };
}

function ensureSectionLines(
  markdown: string,
  section: string,
  lines: string[],
  explicitRoutes: ExplicitRouteTargets
): { markdown: string; changed: boolean } {
  const uniqueLines = [...new Set(lines.filter(Boolean))];
  if (uniqueLines.length === 0) {
    return { markdown, changed: false };
  }

  const existingBody = readMarkdownSection(markdown, section);
  if (existingBody === undefined) {
    return {
      markdown: `${markdown.trimEnd()}\n\n## ${section}\n${uniqueLines.join("\n")}\n`,
      changed: true
    };
  }

  const rawBody = removeProtectedCandidateLines(removeUnsupportedAboutPage(existingBody.trim(), explicitRoutes), explicitRoutes);
  const body = isWeakScopeBody(rawBody) ? "" : rawBody;
  const missingLines = uniqueLines.filter((line) => !body.includes(line.replace(/^-\s+/, "").split(" ")[0] ?? line));
  if (missingLines.length === 0 && body === existingBody.trim()) {
    return { markdown, changed: false };
  }

  const nextBody = [body, ...missingLines].filter(Boolean).join("\n");
  return {
    markdown: replaceMarkdownSection(markdown, section, nextBody),
    changed: true
  };
}

function readMarkdownSection(markdown: string, section: string): string | undefined {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${section}`);
  if (start < 0) {
    return undefined;
  }

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) {
      break;
    }
    body.push(line);
  }
  return body.join("\n");
}

function replaceMarkdownSection(markdown: string, section: string, body: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${section}`);
  if (start < 0) {
    return `${markdown.trimEnd()}\n\n## ${section}\n${body.trim()}\n`;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index]?.trim() ?? "")) {
      end = index;
      break;
    }
  }

  return [...lines.slice(0, start + 1), body.trim(), "", ...lines.slice(end)].join("\n").replace(/\n{4,}/g, "\n\n\n");
}

function inferExplicitRouteTargets(requirement: string): ExplicitRouteTargets {
  const normalized = requirement.toLowerCase();
  const hasAboutService = /about\/service|about service/i.test(requirement);
  const hasReviewKakao = /review\/kakao|review kakao/i.test(requirement);
  const hasDelete = /삭제|delete|remove/i.test(requirement);
  const previewIntent = /(about\/service|심사|서비스 화면|샘플 데이터|preview|실제 화면 그대로|로그인하지 않아도)/i.test(requirement);
  const modifyTargets: ExplicitRouteTarget[] = [];
  const deletionTargets: ExplicitRouteTarget[] = [];
  const referenceTargets: ExplicitRouteTarget[] = [];
  const protectedTargets: ExplicitRouteTarget[] = [];

  if (hasAboutService) {
    modifyTargets.push({ path: "app/about/service/page.tsx" });
    modifyTargets.push({ path: "app/about/service/**", label: "생성/수정 대상" });
  }

  if (hasReviewKakao) {
    const target = { path: "app/review/kakao/page.tsx", label: hasDelete ? "삭제 대상" : "수정 대상" };
    if (hasDelete) {
      deletionTargets.push(target);
      deletionTargets.push({ path: "app/review/kakao/**", label: "삭제 대상" });
    } else {
      modifyTargets.push(target);
    }
  }

  if (previewIntent) {
    referenceTargets.push({ path: "components/home/*", label: "참고 대상: 실제 홈/나무 UI 구조" });
    referenceTargets.push({ path: "app/dashboard/page.tsx", label: "참고 대상: 실제 대시보드 화면" });
    referenceTargets.push({ path: "record 관련 실제 기능 파일", label: "참고 대상" });
    protectedTargets.push({ path: "components/home/*", label: "보호 대상: 실제 기능 컴포넌트 직접 수정 금지" });
    protectedTargets.push({ path: "app/dashboard/**", label: "보호 대상: 실제 대시보드 기능 수정 금지" });
    protectedTargets.push({ path: "lib/supabase/**", label: "보호 대상: 실제 데이터 fetch 수정 금지" });
    protectedTargets.push({ path: "supabase/**", label: "보호 대상: DB/Edge Function 수정 금지" });
    protectedTargets.push({ path: "auth/session/login 관련 파일", label: "보호 대상: 인증 로직 수정 금지" });
    protectedTargets.push({ path: "app/auth/**", label: "보호 대상: auth/callback 수정 금지" });
    protectedTargets.push({ path: "components/landing/*login*", label: "보호 대상: 로그인 버튼 수정 금지" });
    protectedTargets.push({ path: "components/landing/*start*", label: "보호 대상: 시작/로그인 유도 버튼 수정 금지" });
    protectedTargets.push({ path: "lib/auth/**", label: "보호 대상: 인증 유틸 수정 금지" });
    protectedTargets.push({ path: "supabase auth 관련 파일", label: "보호 대상" });
  }

  if (/기록|record/i.test(normalized)) {
    referenceTargets.push({ path: "record 관련 실제 기능 파일", label: "참고 대상: 화면 구조만 참고" });
  }

  return {
    modifyTargets,
    deletionTargets,
    referenceTargets: dedupeTargets(referenceTargets),
    protectedTargets: dedupeTargets(protectedTargets),
    previewIntent
  };
}

function formatExplicitRouteGuidance(requirement: string, candidates: string[]): string {
  const targets = inferExplicitRouteTargets(requirement);
  const sections: Array<[string, string[]]> = [
    ["수정/생성 대상", targets.modifyTargets.map((target) => `- ${formatTargetLine(target)}`)],
    ["삭제 대상", targets.deletionTargets.map((target) => `- ${formatTargetLine(target, "삭제 대상")}`)],
    ["참고 대상", targets.referenceTargets.map((target) => `- ${formatTargetLine(target)}`)],
    ["보호 대상", targets.protectedTargets.map((target) => `- ${formatTargetLine(target)}`)],
    [
      "기타 후보",
      candidates
        .filter((candidate) => !targets.modifyTargets.some((target) => target.path === candidate))
        .filter((candidate) => !shouldExcludeExplicitCandidate(candidate, targets))
        .slice(0, 8)
        .map((candidate) => `- ${candidate}`)
    ]
  ];

  return sections
    .map(([title, lines]) => `### ${title}\n${lines.length > 0 ? lines.join("\n") : "- 없음"}`)
    .join("\n\n");
}

function scoreExplicitCandidate(candidate: string, explicitRoutes: ExplicitRouteTargets): number {
  if (explicitRoutes.modifyTargets.some((target) => target.path === candidate)) {
    return 100;
  }
  if (explicitRoutes.deletionTargets.some((target) => target.path === candidate)) {
    return 95;
  }
  if (/^app\/about\/page\.(tsx|ts|jsx|js)$/i.test(candidate) && explicitRoutes.modifyTargets.some((target) => target.path.startsWith("app/about/service/"))) {
    return -100;
  }
  if (isLikelyRealFeatureFile(candidate) && explicitRoutes.previewIntent) {
    return 10;
  }
  return 0;
}

function isResultPageRequest(requirement: string): boolean {
  return /result|결과\s*페이지|결과/.test(requirement.toLowerCase());
}

function isQuestionRequest(requirement: string): boolean {
  return /question|choice|질문|문항|선택/.test(requirement.toLowerCase());
}

function shouldExcludeExplicitCandidate(candidate: string, explicitRoutes: ExplicitRouteTargets): boolean {
  if (/^app\/about\/page\.(tsx|ts|jsx|js)$/i.test(candidate) && explicitRoutes.modifyTargets.some((target) => target.path.startsWith("app/about/service/"))) {
    return true;
  }

  return explicitRoutes.previewIntent && isAuthLoginFile(candidate);
}

function isLikelyRealFeatureFile(path: string): boolean {
  return (
    path.startsWith("components/home/") ||
    path.startsWith("app/dashboard/") ||
    /record/i.test(path) ||
    /tree/i.test(path) ||
    /feedback/i.test(path)
  );
}

function isScopeCandidate(path: string, explicitRoutes: ExplicitRouteTargets): boolean {
  if (/^app\/about\/page\.(tsx|ts|jsx|js)$/i.test(path) && explicitRoutes.modifyTargets.some((target) => target.path.startsWith("app/about/service/"))) {
    return false;
  }

  if (explicitRoutes.previewIntent && isLikelyRealFeatureFile(path)) {
    return false;
  }

  if (explicitRoutes.previewIntent && isAuthLoginFile(path)) {
    return false;
  }

  return true;
}

function removeReferenceOnlyScopeLines(body: string, explicitRoutes: ExplicitRouteTargets): string {
  if (!explicitRoutes.previewIntent) {
    return body;
  }

  return body
    .split("\n")
    .filter((line) => {
      const normalized = line.replace(/^[-*\s]+/, "").trim();
      return !isLikelyRealFeatureFile(normalized) && !isAuthLoginFile(normalized);
    })
    .join("\n")
    .trim();
}

function removeProtectedCandidateLines(body: string, explicitRoutes: ExplicitRouteTargets): string {
  if (!explicitRoutes.previewIntent) {
    return body;
  }

  return body
    .split("\n")
    .filter((line) => !isAuthLoginFile(line.replace(/^[-*\s]+/, "").trim()))
    .join("\n")
    .trim();
}

function formatTargetLine(target: ExplicitRouteTarget, fallbackLabel?: string): string {
  const label = target.label ?? fallbackLabel;
  return label ? `${target.path} (${label})` : target.path;
}

function isAuthLoginFile(path: string): boolean {
  const normalized = path
    .trim()
    .replace(/^[-*\s]+/, "")
    .replace(/\s+\([^)]*\)$/, "")
    .replace(/\s+-\s+.*$/, "");

  return (
    /^app\/auth\//i.test(normalized) ||
    /^lib\/auth\//i.test(normalized) ||
    /^components\/landing\/.*login.*\.(tsx|ts|jsx|js)$/i.test(normalized) ||
    /^components\/landing\/.*start.*\.(tsx|ts|jsx|js)$/i.test(normalized) ||
    /auth\/callback/i.test(normalized) ||
    /supabase.*auth|auth.*supabase/i.test(normalized)
  );
}

function removeUnsupportedAboutPage(body: string, explicitRoutes: ExplicitRouteTargets): string {
  if (!explicitRoutes.modifyTargets.some((target) => target.path.startsWith("app/about/service/"))) {
    return body;
  }

  return body
    .split("\n")
    .filter((line) => !/app\/about\/page\.(tsx|ts|jsx|js)/i.test(line))
    .join("\n")
    .trim();
}

function dedupeTargets(targets: ExplicitRouteTarget[]): ExplicitRouteTarget[] {
  const seen = new Set<string>();
  const result: ExplicitRouteTarget[] = [];
  for (const target of targets) {
    const key = `${target.path}:${target.label ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(target);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasUnsupportedEmailPasswordSpeculation(requirement: string, markdown: string): boolean {
  const mentionsKakaoLogin = /(kakao|카카오).*(login|로그인)|(login|로그인).*(kakao|카카오)/i.test(requirement);
  const userMentionedEmailPassword = /(email|이메일|password|비밀번호)/i.test(requirement);

  if (!mentionsKakaoLogin || userMentionedEmailPassword) {
    return false;
  }

  return /(email|이메일|password|비밀번호)/i.test(markdown);
}
