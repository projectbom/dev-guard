import type { AIProvider, ChangeFile, ReviewContext, ReviewFixPrompt, ReviewFixPromptInput, ReviewResult, ReviewStatus } from "./types.js";

const requiredReviewSections = [
  "결론",
  "요구사항 충족 여부",
  "범위 초과 수정",
  "규칙 위반 가능성",
  "반복 실수 가능성",
  "확인이 필요한 파일",
  "Codex 재수정 프롬프트",
  "커밋 가능 여부"
];

export async function generateReviewResult(provider: AIProvider, context: ReviewContext, model?: string): Promise<ReviewResult> {
  const markdown = normalizeReviewMarkdown(
    await provider.generateText({
      model,
      system: reviewSystemPrompt(),
      prompt: buildReviewPrompt(context)
    })
  );

  if (!markdown) {
    throw new Error("AI review result is empty. No files were modified.");
  }

  const missingSections = requiredReviewSections.filter((section) => !hasSection(markdown, section));
  const status = extractStatus(markdown);
  if (missingSections.length > 0 || !status) {
    const missing = missingSections.length > 0 ? ` missing sections: ${missingSections.join(", ")}.` : "";
    const statusMessage = status ? "" : " missing valid status.";
    throw new Error(`AI review result format is invalid.${missing}${statusMessage}`);
  }

  return {
    markdown,
    status,
    fixPrompt: extractSection(markdown, "Codex 재수정 프롬프트") || "재수정 프롬프트를 생성하지 못했습니다. 리뷰 결과를 직접 확인하세요."
  };
}

export function buildReviewPrompt(context: ReviewContext): string {
  return `현재 작업 목표와 완료 조건:
${context.taskMarkdown || "(task.md 비어 있음)"}

반드시 지켜야 할 규칙:
${context.rulesMarkdown || "(rules.md 비어 있음)"}

반복하면 안 되는 실수:
${context.mistakesMarkdown || "(mistakes.md 비어 있음)"}

프로젝트 상태:
${context.projectStateMarkdown || "(PROJECT_STATE.md 비어 있음)"}

최근 결정:
${context.decisionsMarkdown || "(DECISIONS.md 비어 있음)"}

Codex 전달 run 기록:
${formatRunLog(context.runLog)}

review 기준 선택:
${context.runSelectionSummary || "- using task.md\n- run match score: none"}

변경 파일 목록:
${formatChangeFiles(context.changeFiles, context.changedFiles)}

git diff:
${trimToLimit(context.diffText || "(diff 본문 없음)", 45000)}

영향도 힌트:
${formatImpactHints(context.impactHints ?? [])}

untracked 파일 내용 일부:
${formatUntrackedContexts(context.untrackedFileContexts ?? [])}

관련 project memory 요약:
${formatMemorySummaries(context.memorySummaries ?? [], context.projectMapMarkdown)}

리뷰 지침:
- task.md 요구사항과 완료 조건을 기준으로 실제 diff가 충분한지 판단하세요.
- task.md에 "완료 기준" 섹션이 있으면, 그것을 빌드 성공보다 우선하는 완료 정의로 사용하세요.
- task type이 i18n이면 hardcoded user-facing strings, locale mix, missing translation keys, aria/title/placeholder/metadata 누락 가능성을 diff에서 확인하세요.
- i18n에서 기존 컴포넌트의 한국어 문자열이 t("key") 호출로 바뀌고, ko/en locale resource가 함께 추가되며 default locale이 ko로 유지되면 정상 migration으로 보세요. 이 경우 한국어 copy 삭제나 영어 덮어쓰기로 판단하지 마세요.
- task type이 ui_text_cleanup이면 wording consistency, duplicate phrasing, awkward CTA wording을 확인하세요.
- review 기준 선택에서 "run: ignored" 또는 "using diff-inferred task"라고 표시된 경우, run 기록(userRequest/generatedTaskMarkdown/generatedCodexPrompt)은 참고용 reference로만 사용하고 요구사항 판단의 primary basis로 쓰지 마세요. 이 경우 현재 task.md(위에 제공된 목표)를 유일한 primary requirement로 사용하세요.
- run이 제공된 경우에도 run match score가 낮거나 latest run does not match 경고가 있으면, run 기준으로 pass를 쉽게 내지 말고 현재 task.md와 실제 diff를 우선하세요.
- 실제 diff에 나온 파일명, 수정된 문자열, 컴포넌트명, 조건문, import/export 변경을 먼저 근거로 쓰세요.
- 영향도 힌트가 있으면 변경 파일의 reverse dependency를 참고해 필요한 검증 범위를 짚으세요.
- 가능하면 수정된 문구 자체를 짧게 인용하세요. 단, 긴 코드는 인용하지 말고 요약하세요.
- task.md 수정 범위 밖 파일이 바뀌었는지 확인하세요.
- untracked 파일은 새로 생성된 파일입니다. untracked 파일 내용 일부가 제공되면 해당 excerpt를 실제 검토 근거로 사용하세요.
- untracked 파일이 task.md scope 안에 있고 excerpt로 요구사항 위반이 확인되지 않으면, 단순히 "전체 파일 확인 필요"만으로 needs_changes를 선택하지 마세요.
- rules.md와 mistakes.md에 비추어 반복 실수 가능성을 짚으세요.
- diff나 제공된 파일 내용에 근거 없는 추측을 하지 마세요.
- 확인할 수 없으면 "확인 필요"라고 쓰세요.
- status 기준: pass는 요구사항 충족과 위반 없음, info는 참고만 필요한 경우, warning은 minor wording/취향 차이/작은 문구 길이 문제, unknown은 정보 부족이지만 구체 위반 없음, risky는 명확한 위험, needs_changes는 요구사항 불충족/범위 초과/보호 대상 수정/로직 깨짐, critical은 로직 파괴나 데이터/인증/보호 대상 훼손 가능성이 큰 경우에만 선택하세요.
- 문구가 조금 길거나 취향 차이 수준이면 needs_changes가 아니라 warning으로 두세요.
- needs_changes, risky, critical인 경우 "Codex 재수정 프롬프트"에는 문제 파일, 요구사항과 다른 점, 수정해야 할 구체 항목, 건드리면 안 되는 파일/로직을 반드시 포함하세요.
- "검토하세요", "확인하세요"만 있는 모호한 재수정 프롬프트는 금지합니다.
- "RIP처럼", "간결하게 피기", "필요 없는 UI 요소를 없앨 수 있는 방법 고려", "위반이 발견되었습니다", "가능성이 존재합니다" 같은 어색하거나 generic한 표현을 쓰지 마세요.
- 한국어는 짧고 직접적인 개발 협업 문체로 작성하세요.
- context files는 포함된 경우에도 코드 변경과 구분해서 판단하세요.
- 코드 수정은 하지 말고 리뷰 결과만 작성하세요.

반드시 아래 Markdown 형식으로만 답하세요. 코드펜스는 쓰지 마세요.

status: pass | info | warning | needs_changes | risky | critical | unknown

## 결론

## 요구사항 충족 여부

## 범위 초과 수정

## 규칙 위반 가능성

## 반복 실수 가능성

## 확인이 필요한 파일

## Codex 재수정 프롬프트

## 커밋 가능 여부
`;
}

export function buildReviewFixPrompt(input: ReviewFixPromptInput): ReviewFixPrompt {
  if (input.review.status === "pass") {
    return {
      needed: false,
      promptText: "재수정 프롬프트 불필요: review status가 pass입니다."
    };
  }

  const taskGoal = extractSection(input.taskMarkdown, "목표") || extractSection(input.taskMarkdown, "Goal") || firstMeaningfulLine(input.taskMarkdown);
  const taskScope = extractSection(input.taskMarkdown, "수정 범위") || extractSection(input.taskMarkdown, "수정 대상") || "확인 후 판단";
  const taskProtected =
    [extractSection(input.taskMarkdown, "보호 대상"), extractSection(input.taskMarkdown, "건드리면 안 되는 것")].filter(Boolean).join("\n") ||
    "원래 요구사항과 직접 관련 없는 기존 동작과 파일은 되돌리거나 수정하지 마세요.";
  const completion = extractSection(input.taskMarkdown, "완료 조건") || "- 원래 요구사항을 충족한다.\n- 검증 명령어가 성공한다.";
  const verification = extractSection(input.taskMarkdown, "검증 명령어") || "- `pnpm run build`";
  const problemBullets = actionableBullets([extractSection(input.review.markdown, "결론"), extractSection(input.review.markdown, "요구사항 충족 여부")]);
  const reviewResultBullets = actionableBullets([
    extractSection(input.review.markdown, "요구사항 충족 여부"),
    extractSection(input.review.markdown, "범위 초과 수정"),
    extractSection(input.review.markdown, "규칙 위반 가능성"),
    extractSection(input.review.markdown, "반복 실수 가능성")
  ]);
  const scopeDrift = actionableBullets([extractSection(input.review.markdown, "범위 초과 수정")], ["- 확인 후 판단"]);
  const filesToCheck = actionableBullets([extractSection(input.review.markdown, "확인이 필요한 파일"), formatChangeFiles(input.changeFiles, input.changedFiles)]);
  const fixInstructions = actionableBullets([input.review.fixPrompt], ["- 파일을 직접 확인한 뒤 원래 요구사항에 맞게 최소 수정한다."]);
  const protectedItems = actionableBullets([taskProtected], ["- 원래 요구사항과 직접 관련 없는 기존 동작과 파일은 유지한다."]);
  const completionItems = actionableBullets([completion]);
  const verificationItems = actionableBullets([verification]);

  return {
    needed: true,
    promptText: `# Codex 재수정 프롬프트

## 문제 요약
- review status: ${input.review.status}
${problemBullets}

## 원래 요구사항
${sanitizeText(taskGoal || "확인 후 판단")}

## 현재 review 결과
${reviewResultBullets}

## 수정 지시
${fixInstructions}

반드시 아래 원칙을 지키세요.
- 무조건 되돌리지 마세요.
- 원래 요구사항과 직접 관련 없는 변경인 경우에만 되돌리세요.
- 기존 동작 복원이 필요한 경우에도, 원래 요구사항을 충족하기 위한 관련 UI 수정은 유지할 수 있습니다.
- 확실하지 않은 내용은 "확인 후 판단"으로 표시하고, 파일을 직접 확인한 뒤 최소 수정하세요.

## 되돌리지 말아야 할 것
${protectedItems}

## 되돌려야 할 가능성이 있는 것
${scopeDrift}

## 확인 파일
${filesToCheck}

## 수정 대상 파일
${actionableBullets([taskScope])}

## 완료 조건
${completionItems}

## 검증 명령어
${verificationItems}
`
  };
}

function reviewSystemPrompt(): string {
  return [
    "You are a strict AI code-reviewer for dev-guard.",
    "Review only the provided task, rules, mistakes, project memory, changed files, and diff.",
    "Return only Markdown. Do not wrap the answer in code fences.",
    "The first non-empty line must be exactly one of: status: pass, status: info, status: warning, status: needs_changes, status: risky, status: critical, status: unknown.",
    "Always include the required Korean section headings.",
    "Do not invent causes or files that are not supported by the provided context.",
    "If the diff is insufficient to verify a claim, mark it 확인 필요.",
    "Do not choose needs_changes based only on missing full-file context when untracked excerpts are provided and no concrete violation is visible.",
    "Minor wording issues should be warning, not needs_changes.",
    "For needs_changes, risky, or critical, the fix prompt must name files, concrete mismatches, exact edits, and protected files or logic. Do not write a vague prompt.",
    "Use natural concise Korean. Avoid generic or awkward phrases."
  ].join("\n");
}

function formatImpactHints(impactHints: NonNullable<ReviewContext["impactHints"]>): string {
  if (impactHints.length === 0) {
    return "- 영향도 힌트 없음";
  }
  return impactHints
    .slice(0, 5)
    .map((hint) => `- ${hint.file}: imported by ${hint.importedByCount}; affected areas ${hint.affectedAreas.join(", ") || "unknown"}; examples ${hint.importedBy.slice(0, 3).join(", ") || "none"}`)
    .join("\n");
}

function normalizeReviewMarkdown(markdown: string): string {
  return markdown.trim().replace(/^```(?:md|markdown)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function extractStatus(markdown: string): ReviewStatus | undefined {
  const match = markdown.match(/(?:^|\n)\s*status:\s*(pass|info|warning|needs_changes|risky|critical|unknown)\s*(?:\n|$)/i);
  return match?.[1]?.toLowerCase() as ReviewStatus | undefined;
}

function hasSection(markdown: string, section: string): boolean {
  return new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, "m").test(markdown);
}

function extractSection(markdown: string, section: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`).test(line.trim()));
  if (start < 0) {
    return "";
  }

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) {
      break;
    }
    body.push(line);
  }

  return body.join("\n").trim();
}

function formatChangeFiles(changeFiles: ChangeFile[] | undefined, changedFiles: string[]): string {
  const files =
    changeFiles && changeFiles.length > 0
      ? changeFiles.map((file) => {
          const rename = file.oldPath ? ` from ${file.oldPath}` : "";
          const state = file.source === file.status ? file.source : `${file.source}/${file.status}`;
          return `- ${file.path} (${state}${rename})`;
        })
      : changedFiles.map((file) => `- ${file}`);

  return files.length > 0 ? files.join("\n") : "- none";
}

function formatRunLog(runLog: ReviewContext["runLog"]): string {
  if (!runLog) {
    return "(run 기록 없음)";
  }

  return [
    `- run id: ${runLog.id}`,
    `- command: ${runLog.command}`,
    `- createdAt: ${runLog.createdAt}`,
    `- provider/model: ${runLog.provider ?? "unknown"}/${runLog.model ?? "unknown"}`,
    `- git: ${runLog.gitBranch ?? "unknown"} ${runLog.gitHead ?? ""}`.trim(),
    `- userRequest: ${runLog.userRequest || "(비어 있음)"}`,
    `- relatedFiles: ${runLog.relatedFiles.length > 0 ? runLog.relatedFiles.join(", ") : "none"}`,
    "",
    "### generatedTaskMarkdown",
    trimToLimit(runLog.generatedTaskMarkdown || "(비어 있음)", 12000),
    "",
    "### generatedCodexPrompt",
    trimToLimit(runLog.generatedCodexPrompt || "(비어 있음)", 16000)
  ].join("\n");
}

function firstMeaningfulLine(markdown: string): string {
  return (
    markdown
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#")) ?? ""
  );
}

function actionableBullets(sections: string[], fallback = ["- 확인 후 판단"]): string {
  const seen = new Set<string>();
  const lines = sections
    .flatMap((section) => section.split("\n"))
    .map(sanitizeText)
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean)
    .filter((line) => !isGenericReviewLine(line))
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 10);

  if (lines.length === 0) {
    return fallback.join("\n");
  }

  return lines.map((line) => `- ${line}`).join("\n");
}

function sanitizeText(text: string): string {
  return text
    .replace(/설명을 간결하게 피기 위한 것입니다/g, "설명 문구를 줄입니다")
    .replace(/RIP처럼/g, "요구사항과 다르게")
    .replace(/간결하게 피기/g, "문구를 자연스럽게 줄이기")
    .replace(/필요 없는 UI 요소를 없앨 수 있는 방법 고려/g, "불필요한 UI 요소는 요구사항과 관련 있을 때만 정리")
    .replace(/위반이 발견되었습니다/g, "문제가 있습니다")
    .replace(/가능성이 존재합니다/g, "가능성이 있습니다")
    .replace(/할 수 있습니다/g, "할 수 있음")
    .replace(/될 수 있습니다/g, "될 수 있음")
    .replace(/있을 수 있습니다/g, "있을 수 있음")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericReviewLine(line: string): boolean {
  const normalized = line.toLowerCase();
  return (
    normalized === "확인 필요" ||
    normalized === "검토 필요" ||
    normalized === "문제 없음" ||
    normalized === "없음" ||
    normalized === "가능성이 있습니다" ||
    /^(검토하세요|확인하세요|수정하세요)[.]?$/.test(line) ||
    /추가 검토가 필요/.test(line)
  );
}

function formatUntrackedContexts(contexts: ReviewContext["untrackedFileContexts"]): string {
  if (!contexts || contexts.length === 0) {
    return "(없음)";
  }

  return contexts
    .map((context) => {
      const truncated = context.truncated ? "\n... truncated by dev-guard review context limit ..." : "";
      return `### ${context.path}\n- 새로 생성된 untracked 파일입니다. 아래 excerpt를 기준으로 scope/요구사항 충족 여부를 검토하세요.\n\n${context.excerpt}${truncated}`;
    })
    .join("\n\n");
}

function formatMemorySummaries(summaries: ReviewContext["memorySummaries"], projectMapMarkdown?: string): string {
  const summaryText =
    summaries && summaries.length > 0
      ? summaries
          .map((summary) => {
            const keywords = summary.keywords.length > 0 ? summary.keywords.join(", ") : "none";
            const features = summary.features.length > 0 ? summary.features.join(", ") : "none";
            return `- ${summary.path}: ${summary.role}; keywords: ${keywords}; features: ${features}`;
          })
          .join("\n")
      : "- 관련 file summary 없음";
  const projectMap = projectMapMarkdown ? `\n\nproject-map excerpt:\n${trimToLimit(projectMapMarkdown, 8000)}` : "";
  return `${summaryText}${projectMap}`;
}

function trimToLimit(content: string, maxCharacters: number): string {
  if (content.length <= maxCharacters) {
    return content;
  }

  return `${content.slice(0, Math.max(0, maxCharacters - 80)).trimEnd()}\n... truncated by dev-guard review context limit ...`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
