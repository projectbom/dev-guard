import type { ProjectIdentity } from "@dev-guard/core";

export interface MarkdownFilterResult {
  filteredMarkdown: string;
  loaded: number;
  relevant: number;
  suppressed: string[];
}

const genericRuleTokens = new Set([
  "scope",
  "diff",
  "build",
  "test",
  "검증",
  "빌드",
  "테스트",
  "범위",
  "요구사항",
  "수정",
  "관련",
  "파일",
  "보호",
  "최소",
  "비밀",
  "api",
  "key",
  "secret"
]);

export function filterRelevantMarkdown(
  markdown: string,
  relevanceText: string,
  identity?: ProjectIdentity,
  extraKeywords: string[] = []
): MarkdownFilterResult {
  const items = splitMarkdownItems(markdown);
  const relevanceTokens = new Set([
    ...extractTokens(relevanceText),
    ...extractTokens(identity?.packageName ?? ""),
    ...(identity?.frameworkKeywords ?? []).flatMap(extractTokens),
    ...extraKeywords.flatMap(extractTokens)
  ]);
  const kept: string[] = [];
  const suppressed: string[] = [];

  for (const item of items) {
    const tokens = extractTokens(item);
    const hasGenericRuleToken = tokens.some((token) => genericRuleTokens.has(token));
    const hasOverlap = tokens.some((token) => relevanceTokens.has(token));

    if (hasOverlap || hasGenericRuleToken || tokens.length === 0) {
      kept.push(item);
    } else {
      suppressed.push(compactLine(item));
    }
  }

  return {
    filteredMarkdown: kept.join("\n").trim(),
    loaded: items.length,
    relevant: kept.length,
    suppressed
  };
}

function splitMarkdownItems(markdown: string): string[] {
  const lines = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#{1,6}\s*$/.test(line));

  const items: string[] = [];
  let current = "";

  for (const line of lines) {
    if (/^[-*]\s+/.test(line) || /^#{1,6}\s+/.test(line) || !current) {
      if (current) {
        items.push(current);
      }
      current = line;
    } else {
      current = `${current} ${line}`;
    }
  }

  if (current) {
    items.push(current);
  }

  return items;
}

function extractTokens(value: string): string[] {
  return [...new Set((value.toLowerCase().match(/[a-z0-9가-힣]{2,}/g) ?? []).filter((token) => token.length >= 2))];
}

function compactLine(value: string): string {
  return value.replace(/^[-*]\s+/, "").replace(/\s+/g, " ").slice(0, 100);
}
