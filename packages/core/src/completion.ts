import type { GuardFinding, TaskCompletionCriteria, TaskType, TaskTypeResult } from "./types.js";

export function buildTaskCompletionCriteria(taskType: TaskTypeResult): TaskCompletionCriteria {
  const criteria = criteriaByType[taskType.type];
  if (taskType.subtype === "cli_output_polish") {
    return {
      requiredChecks: [
        "대상 CLI 명령의 출력에서 핵심 요약이 먼저 보인다.",
        "preview/write 정책이 출력에서 명확히 구분된다.",
        "기존 명령 동작과 자동 write 정책은 유지된다."
      ],
      forbiddenPatterns: ["새 기능 추가로 범위 확대", "update --write 자동 실행", "긴 로그를 기본 출력에 추가"],
      reviewHints: ["대상 command handler와 관련 preview 출력만 확인한다.", "기본 출력이 compact한지 확인한다."],
      blockingFailures: ["대상 명령 출력 개선 누락", "preview 명령이 파일을 수정함", "기존 command flow 훼손"]
    };
  }
  return {
    requiredChecks: criteria.requiredChecks,
    forbiddenPatterns: criteria.forbiddenPatterns,
    reviewHints: criteria.reviewHints,
    blockingFailures: criteria.blockingFailures
  };
}

export function formatCompletionCriteria(criteria: TaskCompletionCriteria): string {
  return [
    "required checks:",
    ...criteria.requiredChecks.map((item) => `- ${item}`),
    criteria.forbiddenPatterns?.length ? "\nforbidden patterns:" : "",
    ...(criteria.forbiddenPatterns ?? []).map((item) => `- ${item}`),
    criteria.reviewHints?.length ? "\nreview hints:" : "",
    ...(criteria.reviewHints ?? []).map((item) => `- ${item}`),
    criteria.blockingFailures?.length ? "\nblocking failures:" : "",
    ...(criteria.blockingFailures ?? []).map((item) => `- ${item}`)
  ]
    .filter(Boolean)
    .join("\n");
}

export function analyzeCompletionPostChecks(input: {
  taskMarkdown: string;
  changedFiles: string[];
  diffText: string;
}): GuardFinding[] {
  if (!isI18nTaskMarkdown(input.taskMarkdown)) {
    return [];
  }

  return analyzeI18nPostChecks(input.changedFiles, input.diffText);
}

const criteriaByType: Record<TaskType, TaskCompletionCriteria> = {
  ui_text_cleanup: {
    requiredChecks: [
      "사용자 노출 문구가 요청 의도에 맞게 쉬운 표현으로 정리된다.",
      "같은 의미의 중복 문구가 남지 않는다.",
      "CTA, 제목, 빈 상태, 에러 문구의 톤이 한 화면 안에서 일관된다."
    ],
    forbiddenPatterns: ["로직/상태/데이터 변경", "문구 작업을 기능 추가로 확대"],
    reviewHints: ["변경된 문자열을 직접 비교한다.", "문구 길이와 의미 중복을 확인한다."],
    blockingFailures: ["요청한 화면의 핵심 문구가 그대로 남음", "문구 수정 중 기능 로직 변경"]
  },
  ui_polish: {
    requiredChecks: [
      "기존 UI 흐름 안에서 자연스럽게 통합된다.",
      "새 섹션/카드/버튼이 불필요하게 추가되지 않는다.",
      "기존 동작은 유지된다."
    ],
    forbiddenPatterns: ["새 기능 추가", "상태/데이터 로직 변경", "레이아웃 전면 재구성"],
    reviewHints: ["변경된 UI surface와 기존 흐름의 연결만 확인한다."],
    blockingFailures: ["기존 기능 동작 훼손", "요청과 무관한 UI 구조 추가"]
  },
  bugfix: {
    requiredChecks: ["재현 조건이 설명된다.", "원인 후보와 수정 근거가 연결된다.", "회귀 검증 방법이 포함된다."],
    forbiddenPatterns: ["원인 불명 상태의 광범위 수정", "정상 동작하던 경로 훼손"],
    reviewHints: ["실제 diff가 재현 조건을 해결하는지 확인한다."],
    blockingFailures: ["버그 재현 조건 미해결", "관련 없는 기능 변경"]
  },
  feature_add: {
    requiredChecks: ["새 기능 범위가 명확하다.", "UI/상태/데이터 영향이 구분된다.", "기존 동작 보호 대상이 명시된다."],
    forbiddenPatterns: ["요청 범위 밖 기능 추가", "검증 없는 데이터 구조 변경"],
    reviewHints: ["새 기능 진입점과 기존 흐름 영향을 확인한다."],
    blockingFailures: ["핵심 기능 미구현", "보호 대상 변경"]
  },
  product_strategy: {
    requiredChecks: [
      "사용자가 이 서비스를 굳이 써야 하는 한 문장 이유가 정의된다.",
      "공유하고 싶거나 다시 써보고 싶은 이유가 코드 수정 전에 설명된다.",
      "구현이 필요하면 최소 변경 범위와 검증 기준을 먼저 제안한다."
    ],
    forbiddenPatterns: ["바로 코드 수정 착수", "검증 없는 새 UI 섹션 추가", "결과 계산/저장/인증 로직 변경"],
    reviewHints: ["product brief와 implementation proposal이 먼저 있는지 확인한다.", "reference 파일을 primary edit target으로 오해하지 않았는지 확인한다."],
    blockingFailures: ["핵심 가치/후킹 정의 없이 UI만 추가", "승인 없는 코드 수정 범위 확정", "보호 로직 변경"]
  },
  architecture: {
    requiredChecks: ["영향 범위가 단계별로 분해된다.", "dependency direction이 유지된다.", "마이그레이션 위험이 명시된다."],
    forbiddenPatterns: ["전체 구조 일괄 교체", "layer violation", "unrelated file modification"],
    reviewHints: ["변경 파일이 이번 단계 경계 안에 있는지 확인한다."],
    blockingFailures: ["layer violation", "rollback 어려운 전역 구조 변경"]
  },
  i18n: {
    requiredChecks: [
      "사용자 노출 문자열 inventory가 먼저 정리된다.",
      "대상 화면에서 locale=en일 때 한국어 UI가 섞이지 않는다.",
      "사용자 노출 문자열은 locale resource로 이동한다.",
      "aria-label/title/placeholder/metadata 문자열도 locale resource 기준으로 처리한다.",
      "locale resource key가 ko/en 사이에서 대응된다."
    ],
    forbiddenPatterns: [
      "한국어 원본 덮어쓰기",
      "전체 페이지 텍스트 직접 치환",
      "hardcoded user-facing strings remain",
      "locale mixed rendering",
      "missing translation keys",
      "metadata locale mismatch"
    ],
    reviewHints: [
      "JSX/text hardcoded string detection",
      "locale resource parity",
      "untranslated key detection",
      "metadata/json-ld locale consistency",
      "aria-label/title/placeholder untranslated check",
      "mixed locale rendering detection"
    ],
    blockingFailures: [
      "고유명사 외 하드코딩 사용자 노출 문자열 잔존",
      "locale=en 화면에 한국어 문구 혼입",
      "ko/en resource key 불일치",
      "metadata/aria-label/title/placeholder 미처리"
    ]
  },
  refactor: {
    requiredChecks: ["동작 변경이 없다.", "public API/props가 유지된다.", "빌드와 관련 테스트가 통과한다."],
    forbiddenPatterns: ["기능 변경", "public API breaking change"],
    reviewHints: ["삭제/이동된 export와 props 변경을 확인한다."],
    blockingFailures: ["동작 변경", "호환성 깨짐"]
  },
  migration: {
    requiredChecks: ["단계별 전환 계획이 있다.", "backward compatibility가 유지된다.", "rollback point가 명시된다."],
    forbiddenPatterns: ["일괄 전환", "호환성 없는 삭제"],
    reviewHints: ["old/new 경로가 공존 가능한지 확인한다."],
    blockingFailures: ["rollback 불가", "호환성 깨짐"]
  },
  performance: {
    requiredChecks: ["측정 기준과 대상이 명시된다.", "기능 동작은 유지된다.", "과한 리팩터링 없이 병목만 다룬다."],
    forbiddenPatterns: ["측정 없는 최적화", "기능 변경", "광범위 리팩터링"],
    reviewHints: ["성능 관련 변경이 병목 지점에 연결되는지 확인한다."],
    blockingFailures: ["기능 회귀", "측정/검증 기준 없음"]
  },
  styling: {
    requiredChecks: ["스타일/UI 표현만 바뀐다.", "디자인 시스템 토큰을 우선한다.", "로직은 유지된다."],
    forbiddenPatterns: ["로직 변경", "토큰 우회 하드코딩 남발"],
    reviewHints: ["class/style 변경 범위를 확인한다."],
    blockingFailures: ["스타일 작업 중 동작 로직 변경"]
  },
  docs: {
    requiredChecks: ["문서만 수정된다.", "명령/예시가 현재 동작과 맞다.", "코드 변경이 없다."],
    forbiddenPatterns: ["코드 변경", "검증되지 않은 사용법 추가"],
    reviewHints: ["README/docs diff만 확인한다."],
    blockingFailures: ["문서 작업 중 코드 변경"]
  },
  infra_config: {
    requiredChecks: ["config/env/build/deploy 영향이 명시된다.", "secret이 저장되지 않는다.", "검증 명령 또는 공식 문서 확인 필요가 남는다."],
    forbiddenPatterns: ["API key/secret 저장", "환경별 영향 누락"],
    reviewHints: ["env/config 파일 diff와 secret 포함 여부를 확인한다."],
    blockingFailures: ["secret commit 위험", "배포/빌드 설정 회귀"]
  }
};

function extractTaskType(taskMarkdown: string): TaskType | undefined {
  const section = extractSection(taskMarkdown, "작업 유형") || taskMarkdown;
  const match = section.match(/type:\s*([a-z_]+)/i);
  return match?.[1] as TaskType | undefined;
}

function isI18nTaskMarkdown(taskMarkdown: string): boolean {
  return extractTaskType(taskMarkdown) === "i18n" || /type:\s*i18n/i.test(taskMarkdown) || /##\s*완료 기준[\s\S]*locale=en/i.test(taskMarkdown);
}

function analyzeI18nPostChecks(changedFiles: string[], diffText: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  const hasEnglishResource = changedFiles.some((file) => /(^|\/)(en|en-US)\.(json|ts|tsx|js|yaml|yml)$/i.test(file) || /(^|\/)(messages|locales|translations|dictionaries)\/.*en/i.test(file));
  const hasKoreanResource = changedFiles.some((file) => /(^|\/)(ko|ko-KR)\.(json|ts|tsx|js|yaml|yml)$/i.test(file) || /(^|\/)(messages|locales|translations|dictionaries)\/.*ko/i.test(file));
  const migration = analyzeI18nMigration(diffText, hasKoreanResource, hasEnglishResource);
  const hardcodedKoreanAdditions = extractAddedLines(diffText).filter((line) => containsKorean(line) && !looksLikeLocaleResourceLine(line));
  const ariaMetadataAdditions = hardcodedKoreanAdditions.filter((line) => /aria-label|title=|placeholder=|metadata|json-ld|description|openGraph/i.test(line));

  if (!hasEnglishResource || !hasKoreanResource) {
    findings.push({
      severity: "warning",
      code: "i18n_resource_parity_missing",
      title: "i18n resource parity needs review",
      message: "i18n task changed files do not clearly include both Korean and English locale resources."
    });
  }

  if (hardcodedKoreanAdditions.length > 0) {
    findings.push({
      severity: "warning",
      code: "i18n_possible_hardcoded_strings",
      title: "Possible hardcoded user-facing strings",
      message: "Korean user-facing additions remain outside obvious locale resource files. Confirm they are not hardcoded UI strings."
    });
  }

  if (ariaMetadataAdditions.length > 0) {
    findings.push({
      severity: "warning",
      code: "i18n_metadata_accessibility_strings",
      title: "Metadata or accessibility strings may be untranslated",
      message: "Added aria/title/placeholder/metadata strings include Korean text. Confirm they are locale-resource driven."
    });
  }

  if (migration.normal) {
    findings.push({
      severity: "info",
      code: "i18n_locale_resource_migration",
      title: "i18n locale resource migration detected",
      message: "Korean copy moved to locale resource; default locale preserved."
    });
  }

  return findings;
}

function analyzeI18nMigration(diffText: string, hasKoreanResource: boolean, hasEnglishResource: boolean): { normal: boolean } {
  const addedLines = extractAddedLines(diffText);
  const removedLines = extractRemovedLines(diffText);
  const removedKoreanCopy = removedLines.some((line) => containsKorean(line) && looksLikeUserFacingStringLine(line));
  const koResourceCopy = addedLines.some((line) => containsKorean(line) && looksLikeLocaleResourceLine(line));
  const tCallAdded = addedLines.some((line) => /\bt\(\s*["'][\w.-]+["']\s*\)|useTranslations|useI18n|getMessage|translate\(/i.test(line));
  const defaultKo = /defaultLocale\s*[:=]\s*["']ko(?:-KR)?["']|fallbackLocale\s*[:=]\s*["']ko(?:-KR)?["']|locale\s*\?\?\s*["']ko(?:-KR)?["']/i.test(diffText);
  const defaultEnAdded = addedLines.some((line) => /defaultLocale\s*[:=]\s*["']en(?:-US)?["']|fallbackLocale\s*[:=]\s*["']en(?:-US)?["']|locale\s*\?\?\s*["']en(?:-US)?["']/i.test(line));
  return {
    normal: hasKoreanResource && hasEnglishResource && removedKoreanCopy && koResourceCopy && tCallAdded && (defaultKo || !defaultEnAdded)
  };
}

function extractAddedLines(diffText: string): string[] {
  return diffText
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1).trim())
    .filter(Boolean);
}

function extractRemovedLines(diffText: string): string[] {
  return diffText
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---"))
    .map((line) => line.slice(1).trim())
    .filter(Boolean);
}

function containsKorean(value: string): boolean {
  return /[가-힣]/.test(value);
}

function looksLikeLocaleResourceLine(value: string): boolean {
  return /messages|locales|translation|dictionary|ko\.|ko:|["']ko["']|한국어\s*원본|existing Korean copy|["'][\w.-]+["']\s*:\s*["'][^"']*[가-힣]/i.test(value);
}

function looksLikeUserFacingStringLine(value: string): boolean {
  return /["'`][^"'`]*[가-힣][^"'`]*["'`]/.test(value);
}

function extractSection(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(title)}\\s*$`).test(line.trim()));
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
