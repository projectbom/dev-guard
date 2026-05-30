import type { ChangeFile, ContextPriority, DriftResult, TaskTypeResult, WorkflowQualityScore } from "./types.js";

const domainPatterns: Record<string, RegExp> = {
  navigation_state: /(이전|뒤로|돌아가|previous|prev|back|navigation|navigate|router|history|질문|문제|question|state|상태|유지|바뀌|변경)/i,
  text_wording: /(문구|텍스트|단어|표현|copy|wording|카피|어색|모호|불분명|cta|제목)/i,
  ui_interaction: /(클릭|누르면|눌렀을 때|열기|열리|펼치|전체 보기|목록 보기|상세 보기|modal|모달|sheet|바텀시트|expand|더보기|local state|ui state)/i,
  auth: /(login|로그인|auth|인증|session|token|cookie|oauth|callback)/i,
  i18n: /(영어|영문|다국어|i18n|locale|localization|translation|messages|번역|언어)/i,
  api: /(api|fetch|request|response|요청|응답|서버|network|네트워크)/i,
  build: /(build|빌드|compile|컴파일|type error|타입|lint|ci)/i,
  ui_redesign: /(redesign|리디자인|재설계|재구성|새\s*레이아웃|전체\s*레이아웃)/i,
  ui_rendering: /(ui|화면|렌더|render|layout|레이아웃|스타일|css|배치|디자인)/i,
  performance: /(느림|느려|성능|performance|최적화|지연|버벅|속도)/i
};

const allowedExpansionsByDomain: Record<string, string[]> = {
  navigation_state: ["router", "history", "state", "navigation", "question", "selection", "storage"],
  text_wording: ["copy", "wording", "cta", "title", "label", "placeholder", "aria"],
  ui_interaction: ["click", "handler", "modal", "sheet", "expand", "local state", "list", "scroll", "responsive"],
  auth: ["session", "token", "cookie", "oauth", "callback", "provider"],
  i18n: ["locale", "messages", "translation", "dictionary", "language", "metadata", "aria"],
  api: ["fetch", "request", "response", "network", "server", "error"],
  build: ["typescript", "lint", "config", "dependency", "package"],
  ui_rendering: ["layout", "style", "component", "render", "responsive"],
  performance: ["measure", "render", "cache", "query", "bundle"]
};

const hardConflicts: Record<string, string[]> = {
  navigation_state: ["text_wording", "i18n"],
  text_wording: ["navigation_state", "api", "build", "ui_redesign"],
  build: ["ui_redesign", "ui_rendering", "text_wording"],
  i18n: ["navigation_state", "api"],
  auth: ["text_wording", "i18n"],
  api: ["text_wording", "ui_rendering"]
};

const zonePatterns: Record<string, RegExp> = {
  state_logic: /(state|상태|유지|restore|persist|localStorage|sessionStorage|store|reducer|history|sequence|순서)/i,
  routing: /(router|route|routing|navigate|navigation|redirect|pathname|href|뒤로|이전|돌아가|경로)/i,
  ui_copy: /(문구|텍스트|단어|표현|copy|wording|label|placeholder|aria-label|title|cta)/i,
  ui_interaction: /(onClick|handler|modal|sheet|bottomSheet|drawer|dialog|popover|expand|selected|open|isOpen|펼치|열기|목록|상세)/i,
  styling: /(className|style|css|tailwind|layout|레이아웃|스타일|색상|spacing|margin|padding)/i,
  architecture: /(provider|wrapper|layout|architecture|구조|migration|refactor|dependency|interface)/i,
  config: /(config|환경\s*변수|env|package\.json|tsconfig|vite|next\.config|eslint|설정)/i,
  auth: /(auth|login|로그인|session|token|cookie|oauth|callback|인증)/i,
  data_flow: /(fetch|query|mutation|api|database|supabase|저장|계산|result|결과|score|scoring|data)/i
};

const pathZonePatterns: Array<[string, RegExp]> = [
  ["routing", /(^|\/)(app|pages|routes?|router|navigation)(\/|$)|middleware\.|route\./i],
  ["state_logic", /(^|\/)(store|state|hooks|reducers?|context)(\/|$)|use[A-Z].*\.(ts|tsx)$/],
  ["ui_copy", /(copy|content|messages|locales?|i18n|translations?|labels?)/i],
  ["ui_interaction", /(modal|sheet|drawer|dialog|popover|expand|interaction|card|components?)/i],
  ["styling", /\.(css|scss|sass|less)$|(^|\/)(styles?|theme)(\/|$)/i],
  ["architecture", /(^|\/)(providers?|layouts?|wrappers?|core|infra)(\/|$)/i],
  ["config", /(^|\/)(package\.json|tsconfig|vite\.config|next\.config|eslint|prettier|\.env)/i],
  ["auth", /(^|\/)(auth|login|session|oauth)(\/|$)/i],
  ["data_flow", /(^|\/)(api|db|data|services?|supabase|models?)(\/|$)|(result|score|query|mutation)/i]
];

export function defaultContextPriority(): ContextPriority {
  return {
    requirement: 100,
    relatedCode: 80,
    taskSubtypeContext: 70,
    recentRun: 35,
    projectMemory: 25,
    staleDocs: 10
  };
}

export function analyzeSemanticDrift(requirement: string, generatedText: string, taskType?: TaskTypeResult): DriftResult {
  if (!generatedText.trim()) {
    return emptyResult(requirement, taskType);
  }

  const requirementDomains = inferDomains(requirement, taskType);
  const generatedDomains = inferDomains(generatedText);
  const requirementZones = inferSemanticZones(requirement, [], taskType);
  const generatedZones = inferSemanticZones(generatedText);
  const allowedExpansions = [...new Set(requirementDomains.flatMap((domain) => allowedExpansionsByDomain[domain] ?? []))];
  const shared = generatedDomains.filter((domain) => requirementDomains.includes(domain));
  const sharedZones = generatedZones.filter((zone) => requirementZones.includes(zone));
  const conflicts = requirementDomains.flatMap((domain) => (hardConflicts[domain] ?? []).filter((conflict) => generatedDomains.includes(conflict)));
  const missingPrimary = requirementDomains.length > 0 && shared.length === 0;
  const missingPrimaryZone = requirementZones.length > 0 && generatedZones.length > 0 && sharedZones.length === 0;
  const expansionHits = allowedExpansions.filter((token) => new RegExp(escapeRegExp(token), "i").test(generatedText));
  const similarity = requirementDomains.length === 0 ? 0.5 : Math.min(1, (shared.length + expansionHits.length * 0.25) / requirementDomains.length);
  let driftScore = conflicts.length * 35 + (missingPrimary ? 45 : 0);

  if (generatedDomains.length > 0 && requirementDomains.length > 0 && shared.length === 0) {
    driftScore += 20;
  }
  if (similarity < 0.35) {
    driftScore += 15;
  }
  if (missingPrimaryZone) {
    driftScore += 20;
  }
  driftScore = Math.min(100, driftScore);

  const reasons = [
    ...conflicts.map((domain) => `conflicting domain:${domain}`),
    ...(missingPrimary ? ["missing primary requirement domain"] : []),
    ...(missingPrimaryZone ? [`semantic zone mismatch:${requirementZones.join(",")} -> ${generatedZones.join(",")}`] : []),
    ...(similarity < 0.35 ? [`low requirement similarity:${similarity.toFixed(2)}`] : [])
  ];

  return {
    driftScore,
    severity: driftScore >= 65 ? "high" : driftScore >= 30 ? "medium" : "low",
    reasons: [...new Set(reasons)],
    requirementDomains,
    generatedDomains,
    requirementZones,
    generatedZones,
    allowedExpansions,
    similarity
  };
}

export function analyzeGeneratedDiffDrift(input: {
  requirementText: string;
  taskMarkdown?: string;
  diffText: string;
  changedFiles: string[];
  changeFiles?: ChangeFile[];
  taskType?: TaskTypeResult;
}): DriftResult {
  const requirementText = [
    input.requirementText,
    extractRequirementAnchor(input.taskMarkdown ?? ""),
    extractTaskGoal(input.taskMarkdown ?? "")
  ]
    .filter(Boolean)
    .join("\n");
  const diffSignal = summarizeDiffSignal(input.diffText, input.changedFiles, input.changeFiles);
  const result = analyzeSemanticDrift(requirementText, diffSignal, input.taskType);
  const requirementZones = inferSemanticZones(requirementText, [], input.taskType);
  const generatedZones = inferSemanticZones(diffSignal, input.changedFiles);
  const zoneMismatchPenalty =
    requirementZones.length > 0 && generatedZones.length > 0 && !generatedZones.some((zone) => requirementZones.includes(zone)) ? 20 : 0;
  const broadDiffPenalty = input.changedFiles.length >= 12 ? 20 : 0;
  const unrelatedWordingPenalty =
    result.requirementDomains.includes("navigation_state") && result.generatedDomains.includes("text_wording") ? 25 : 0;
  const architecturePenalty =
    !result.requirementDomains.includes("build") && !result.requirementDomains.includes("i18n") && result.generatedDomains.includes("ui_redesign")
      ? 15
      : 0;
  const driftScore = Math.min(100, result.driftScore + zoneMismatchPenalty + broadDiffPenalty + unrelatedWordingPenalty + architecturePenalty);
  const reasons = [
    ...result.reasons,
    ...(zoneMismatchPenalty ? [`diff semantic zone mismatch:${requirementZones.join(",")} -> ${generatedZones.join(",")}`] : []),
    ...(broadDiffPenalty ? ["large unrelated diff risk"] : []),
    ...(unrelatedWordingPenalty ? ["generated diff appears to change wording for a navigation/state task"] : []),
    ...(architecturePenalty ? ["unexpected architecture/ui redesign signal"] : [])
  ];

  return {
    ...result,
    driftScore,
    severity: driftScore >= 65 ? "high" : driftScore >= 30 ? "medium" : "low",
    reasons: [...new Set(reasons)],
    requirementZones,
    generatedZones
  };
}

export function inferDomains(text: string, taskType?: TaskTypeResult): string[] {
  const domains = new Set<string>();
  if (taskType?.subtype === "bugfix.navigation_state") {
    domains.add("navigation_state");
  } else if (taskType?.subtype === "bugfix.text_content" || taskType?.type === "ui_text_cleanup") {
    domains.add("text_wording");
  } else if (taskType?.type === "ui_feature_polish") {
    domains.add("text_wording");
    domains.add("ui_interaction");
  } else if (taskType?.type === "i18n") {
    domains.add("i18n");
  } else if (taskType?.subtype === "bugfix.api_error") {
    domains.add("api");
  } else if (taskType?.subtype === "bugfix.build_error" || taskType?.type === "infra_config") {
    domains.add("build");
  }

  for (const [domain, pattern] of Object.entries(domainPatterns)) {
    if (pattern.test(text)) {
      domains.add(domain);
    }
  }

  return [...domains];
}

export function inferSemanticZones(text: string, paths: string[] = [], taskType?: TaskTypeResult): string[] {
  const zones = new Set<string>();
  if (taskType?.subtype === "bugfix.navigation_state") {
    zones.add("routing");
    zones.add("state_logic");
  } else if (taskType?.subtype === "bugfix.text_content" || taskType?.type === "ui_text_cleanup") {
    zones.add("ui_copy");
  } else if (taskType?.type === "ui_feature_polish") {
    zones.add("ui_copy");
    zones.add("ui_interaction");
  } else if (taskType?.type === "i18n") {
    zones.add("ui_copy");
    zones.add("config");
  } else if (taskType?.type === "infra_config") {
    zones.add("config");
  }

  for (const [zone, pattern] of Object.entries(zonePatterns)) {
    if (pattern.test(text)) {
      zones.add(zone);
    }
  }
  for (const path of paths) {
    for (const [zone, pattern] of pathZonePatterns) {
      if (pattern.test(path)) {
        zones.add(zone);
      }
    }
  }

  return [...zones];
}

export function scoreWorkflowQuality(input: {
  drift: DriftResult;
  changedFiles: string[];
  diffText: string;
  changeFiles?: ChangeFile[];
}): WorkflowQualityScore {
  const broadDiffPenalty = input.changedFiles.length >= 12 ? 25 : input.changedFiles.length >= 6 ? 10 : 0;
  const destructivePenalty = (input.changeFiles ?? []).filter((file) => file.status === "deleted" || file.status === "renamed").length * 5;
  const sizePenalty = input.diffText.length > 30000 ? 20 : input.diffText.length > 10000 ? 10 : 0;
  const zoneMismatchPenalty =
    input.drift.requirementZones.length > 0 &&
    input.drift.generatedZones.length > 0 &&
    !input.drift.generatedZones.some((zone) => input.drift.requirementZones.includes(zone))
      ? 15
      : 0;

  const driftRisk = clamp(input.drift.driftScore + broadDiffPenalty + sizePenalty, 0, 100);
  const requirementAlignment = clamp(Math.round(100 - input.drift.driftScore + input.drift.similarity * 10 - zoneMismatchPenalty), 0, 100);
  const scopeSafety = clamp(100 - broadDiffPenalty - destructivePenalty - sizePenalty, 0, 100);
  const confidence = clamp(
    Math.round((requirementAlignment + scopeSafety + (input.drift.generatedZones.length > 0 ? 80 : 55)) / 3),
    0,
    100
  );

  return {
    requirementAlignment,
    driftRisk,
    scopeSafety,
    confidence
  };
}

function emptyResult(requirement: string, taskType?: TaskTypeResult): DriftResult {
  return {
    driftScore: 0,
    severity: "low",
    reasons: [],
    requirementDomains: inferDomains(requirement, taskType),
    generatedDomains: [],
    requirementZones: inferSemanticZones(requirement, [], taskType),
    generatedZones: [],
    allowedExpansions: [],
    similarity: 0
  };
}

function extractRequirementAnchor(markdown: string): string {
  return markdown.match(/-\s*원문:\s*(.+)/)?.[1]?.trim() ?? "";
}

function extractTaskGoal(markdown: string): string {
  const match = markdown.match(/^##\s+목표\s*\n([\s\S]*?)(?=\n##\s+|$)/m);
  return match?.[1]?.trim() ?? "";
}

function summarizeDiffSignal(diffText: string, changedFiles: string[], changeFiles: ChangeFile[] = []): string {
  const pathText = changedFiles.join("\n");
  const fileStatusText = changeFiles.map((file) => `${file.path} ${file.status} ${file.source}`).join("\n");
  const addedLines = diffText
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .filter((line) => /[a-zA-Z가-힣]/.test(line))
    .slice(0, 80)
    .join("\n");
  return [pathText, fileStatusText, addedLines].filter(Boolean).join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
