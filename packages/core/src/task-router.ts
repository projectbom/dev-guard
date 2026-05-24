import type { TaskRiskLevel, TaskType, TaskTypeConfidence, TaskTypeResult } from "./types.js";

interface TypeRule {
  type: TaskType;
  strategy: string;
  riskLevel: TaskRiskLevel;
  requiresPhasing: boolean;
  patterns: RegExp[];
}

const rules: TypeRule[] = [
  {
    type: "i18n",
    strategy: "structure-first",
    riskLevel: "high",
    requiresPhasing: true,
    patterns: [/영어\s*변환|영문\s*변환|영어\s*버전|영문\s*버전|영어.*지원|영문.*지원|전체\s*영어|전체.*영문|영문.*추가|다국어|i18n|locali[sz]ation|locale|translation|언어\s*(전환|설정|지원)|language\s*(setting|switch|support)/i]
  },
  {
    type: "infra_config",
    strategy: "config-first",
    riskLevel: "high",
    requiresPhasing: false,
    patterns: [/환경\s*변수|env|deploy|배포|config|설정\s*파일|build\s*설정|ci|workflow|docker|vercel|netlify|supabase.*배포|배포.*supabase/i]
  },
  {
    type: "migration",
    strategy: "phased-migration",
    riskLevel: "high",
    requiresPhasing: true,
    patterns: [/migration|마이그레이션|전환|업그레이드|버전\s*업|교체|이관|backward compatibility|호환/i]
  },
  {
    type: "architecture",
    strategy: "design-first-phased",
    riskLevel: "high",
    requiresPhasing: true,
    patterns: [/아키텍처|architecture|구조\s*설계|구조\s*도입|전체\s*구조|전역\s*구조|기반\s*구조|provider\s*구조|시스템\s*도입/i]
  },
  {
    type: "performance",
    strategy: "measure-first",
    riskLevel: "medium",
    requiresPhasing: false,
    patterns: [/느림|느려|로딩|성능|performance|최적화|지연|버벅|렌더링.*오래|속도/i]
  },
  {
    type: "bugfix",
    strategy: "reproduce-and-fix",
    riskLevel: "medium",
    requiresPhasing: false,
    patterns: [/오류|에러|버그|bug|fix|깨짐|동작하지|실패|안\s*됨|문제\s*해결|잘못|문제.*바뀌|다른.*바뀌|원래.*아니|유지.*안|바뀜/i]
  },
  {
    type: "docs",
    strategy: "docs-only",
    riskLevel: "low",
    requiresPhasing: false,
    patterns: [/readme|문서|docs?|가이드|사용법|설명서|changelog|릴리즈\s*노트/i]
  },
  {
    type: "refactor",
    strategy: "behavior-preserving",
    riskLevel: "medium",
    requiresPhasing: false,
    patterns: [/refactor|리팩터|리팩토|정리|중복\s*제거|구조\s*개선|cleanup|clean\s*up/i]
  },
  {
    type: "ui_text_cleanup",
    strategy: "copy-only",
    riskLevel: "low",
    requiresPhasing: false,
    patterns: [/문구|텍스트|단어|표현|copy|wording|마이크로카피|어색한\s*단어|의미가\s*불분명/i]
  },
  {
    type: "ui_polish",
    strategy: "minimal-ui-polish",
    riskLevel: "low",
    requiresPhasing: false,
    patterns: [
      /자연스럽|부자연|어색|뜬금|위화감|시각적\s*위계|배치|더\s*매끄럽|다듬|polish|ux|ui/i,
      /(명령|command).*(출력|output|요약|summary)|출력.*(명확|요약|정리)|요약.*(명확|보여)|더\s*명확|명확하게|help|status|done|preview/i
    ]
  },
  {
    type: "styling",
    strategy: "style-token-first",
    riskLevel: "low",
    requiresPhasing: false,
    patterns: [/스타일|css|색상|다크모드|dark\s*mode|라이트|theme|테마|spacing|margin|padding|font|폰트/i]
  },
  {
    type: "feature_add",
    strategy: "scope-first",
    riskLevel: "medium",
    requiresPhasing: false,
    patterns: [/추가|구현|만들|생성|지원|기능|버튼|페이지|flow|플로우/i]
  }
];

export function classifyTaskType(requirement: string): TaskTypeResult {
  const normalized = requirement.trim();
  const scored = rules
    .map((rule) => {
      const matched = rule.patterns.filter((pattern) => pattern.test(normalized));
      return {
        rule,
        score: matched.length,
        reasons: matched.map((pattern) => `matched ${pattern.source}`)
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || rulePriority(a.rule.type) - rulePriority(b.rule.type));
  const selected = scored[0];

  if (!selected) {
    return {
      type: "feature_add",
      confidence: "low",
      reasons: ["no specific task type matched; defaulted to feature_add"],
      strategy: "scope-first",
      riskLevel: "medium",
      requiresPhasing: false,
      domainKeywords: extractDomainKeywords(normalized)
    };
  }
  const subtype = inferSubtype(selected.rule.type, normalized);

  return {
    type: selected.rule.type,
    subtype,
    confidence: selected.rule.type === "i18n" ? "high" : confidenceFromScore(selected.score),
    reasons: [...selected.reasons.slice(0, 4), ...(subtype ? [`subtype ${subtype}`] : [])],
    strategy: selected.rule.strategy,
    riskLevel: selected.rule.riskLevel,
    requiresPhasing: selected.rule.requiresPhasing,
    domainKeywords: extractDomainKeywords(normalized)
  };
}

export function taskTypeStrategyNotes(result: TaskTypeResult): string[] {
  const notes: Record<TaskType, string[]> = {
    ui_text_cleanup: [
      "텍스트/문구 수정 중심으로 제한한다.",
      "로직, 상태, 데이터 변경은 금지한다.",
      "수정 대상은 화면/컴포넌트의 copy surface 중심으로 고른다."
    ],
    ui_polish: [
      "기존 UI 흐름 안에서 최소 수정한다.",
      "새 섹션, 새 카드, 새 기능 추가를 피한다.",
      "상태/동작 로직은 보호한다."
    ],
    bugfix: [
      "재현 조건, 원인 후보, 검증 방법을 포함한다.",
      "관련 로직 파일을 우선한다.",
      "기존 정상 동작을 보호한다."
    ],
    feature_add: [
      "새 기능 범위를 명확히 한다.",
      "UI, 상태, 데이터 영향을 구분한다.",
      "보호 대상을 명시한다."
    ],
    architecture: [
      "바로 전체 수정하지 않고 단계 분해한다.",
      "영향 범위와 마이그레이션 위험을 명시한다.",
      "이번 단계에서 제외할 것을 명확히 한다."
    ],
    i18n: [
      "기존 언어를 유지한다.",
      "언어 리소스, 설정, provider 구조를 우선한다.",
      "전체 페이지 직접 번역을 금지하고 샘플 적용만 1차 범위로 제한한다."
    ],
    refactor: [
      "동작 변경을 금지한다.",
      "public API와 컴포넌트 props를 보호한다.",
      "테스트와 빌드를 필수 검증으로 둔다."
    ],
    migration: [
      "단계별 전환으로 나눈다.",
      "backward compatibility를 보호한다.",
      "rollback point를 명시한다."
    ],
    performance: [
      "측정 기준과 대상을 명시한다.",
      "기능 변경을 금지한다.",
      "과한 리팩토링을 피한다."
    ],
    styling: [
      "스타일/UI 표현 중심으로 제한한다.",
      "로직을 보호한다.",
      "디자인 시스템 토큰을 우선한다."
    ],
    docs: [
      "문서만 수정한다.",
      "코드 변경을 금지한다.",
      "README/docs 변경으로 범위를 제한한다."
    ],
    infra_config: [
      "config/env/build/deploy 영향을 명시한다.",
      "secrets 저장을 금지한다.",
      "공식 문서 확인 필요를 표시한다."
    ]
  };

  return notes[result.type];
}

function confidenceFromScore(score: number): TaskTypeConfidence {
  if (score >= 2) {
    return "high";
  }
  return "medium";
}

function rulePriority(type: TaskType): number {
  const order: TaskType[] = [
    "i18n",
    "infra_config",
    "migration",
    "architecture",
    "performance",
    "bugfix",
    "docs",
    "ui_text_cleanup",
    "ui_polish",
    "styling",
    "refactor",
    "feature_add"
  ];
  return order.indexOf(type);
}

function inferSubtype(type: TaskType, requirement: string): string | undefined {
  if (type === "bugfix") {
    if (/(이전|뒤로|돌아가|previous|prev|back|navigation|navigate|router|history|질문|문제|question|state|상태|유지|바뀌|변경됨)/i.test(requirement)) {
      return "bugfix.navigation_state";
    }
    if (/(저장|복원|localstorage|sessionstorage|persist|persistence|cache|캐시)/i.test(requirement)) {
      return "bugfix.data_persistence";
    }
    if (/(렌더|표시|보이지|깨짐|화면|ui|layout|레이아웃)/i.test(requirement)) {
      return "bugfix.ui_rendering";
    }
    if (/(문구|텍스트|단어|표현|copy|wording)/i.test(requirement)) {
      return "bugfix.text_content";
    }
    if (/(api|fetch|request|response|서버|요청|응답|네트워크|network)/i.test(requirement)) {
      return "bugfix.api_error";
    }
    if (/(build|빌드|compile|컴파일|type error|타입 에러|lint)/i.test(requirement)) {
      return "bugfix.build_error";
    }
  }

  if (type === "ui_text_cleanup") {
    return "ui_text_cleanup.wording";
  }
  if (type === "ui_polish") {
    if (/(명령|command|출력|output|요약|summary|help|status|done|preview|watch|review|check|task-ai|prompt|doctor|update)/i.test(requirement)) {
      return "cli_output_polish";
    }
    return "ui_polish.integration";
  }
  return undefined;
}

function extractDomainKeywords(requirement: string): string[] {
  const mappings: Array<[RegExp, string[]]> = [
    [/(이전|뒤로|돌아가|previous|prev|back)/i, ["previous", "back", "navigation"]],
    [/(질문|문제|question)/i, ["question"]],
    [/(상태|state|유지|바뀌|변경됨)/i, ["state"]],
    [/(결과|result)/i, ["result"]],
    [/(문구|텍스트|단어|표현|copy|wording)/i, ["text", "wording"]],
    [/(영어|영문|다국어|i18n|locale|translation|언어)/i, ["i18n", "locale"]],
    [/(auth|login|로그인|인증)/i, ["auth"]],
    [/(api|fetch|서버|요청|응답)/i, ["api"]]
  ];
  const keywords = new Set<string>();
  for (const [pattern, values] of mappings) {
    if (pattern.test(requirement)) {
      values.forEach((value) => keywords.add(value));
    }
  }
  return [...keywords];
}
