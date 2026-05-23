import type { CompactReport, CompactReportInput, GuardFinding } from "./types.js";

export function generateCompactReport(input: CompactReportInput): CompactReport {
  const task = extractSection(input.taskMarkdown, "목표") || firstMeaningfulLine(input.taskMarkdown) || "현재 task 없음";
  const userRequest = input.runLog?.userRequest || input.runLog?.title || "저장된 userRequest 없음";
  const changedFiles = input.changedFiles;
  const check = summarizeCheck(input.checkReport.findings);
  const review = summarizeReview(input.runLog?.reviewResult);
  const nextAction = suggestNextAction({
    changedFiles,
    findings: input.checkReport.findings,
    review,
    scanStale: input.scanStale
  });

  return {
    task: compactLine(task),
    userRequest: compactLine(userRequest),
    changedFiles,
    check,
    review,
    runId: input.runLog?.id ?? "none",
    nextAction
  };
}

function summarizeCheck(findings: GuardFinding[]): string {
  const warnings = findings.filter((finding) => finding.severity === "warning");
  if (warnings.length === 0) {
    return "pass";
  }

  return `warning - ${warnings.map((finding) => finding.title).slice(0, 2).join(", ")}`;
}

function summarizeReview(markdown: string | undefined): string {
  if (!markdown?.trim()) {
    return "none";
  }

  const status = markdown.match(/(?:^|\n)\s*status:\s*([a-z_]+)/i)?.[1] ?? "unknown";
  const conclusion = extractSection(markdown, "결론") || extractSection(markdown, "요구사항 충족 여부");
  const summary = compactLine(conclusion).replace(/^[-*\s]+/, "");
  return summary ? `${status} - ${summary}` : status;
}

function suggestNextAction(input: {
  changedFiles: string[];
  findings: GuardFinding[];
  review: string;
  scanStale?: boolean;
}): string {
  if (input.scanStale) {
    return "run dev-guard refresh";
  }
  if (input.changedFiles.length === 0) {
    return "run task-ai or start implementation";
  }
  if (/needs_changes|risky|critical/.test(input.review)) {
    return "run dev-guard fix-prompt";
  }
  if (input.findings.some((finding) => finding.severity === "warning")) {
    return "review check warnings";
  }
  if (/pass/.test(input.review)) {
    return "build and commit";
  }
  return "run dev-guard check/review before commit";
}

function extractSection(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
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

function firstMeaningfulLine(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#")) ?? "";
}

function compactLine(value: string): string {
  return value
    .split("\n")
    .map((line) => line.replace(/^[-*\s]+/, "").trim())
    .filter(Boolean)
    .join(" / ")
    .replace(/\s+/g, " ")
    .slice(0, 160);
}
