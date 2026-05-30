import {
  analyzeDiff,
  defaultConfig,
  filterDevGuardContextFiles,
  generateCompactReport,
  scoreTaskAnchorFreshness,
  formatInferredDiffIntentClusters,
  inferDiffIntentClusters,
  inferredIntentToRequirement,
  type DevGuardConfig,
  type CodeGraphEntry
} from "@dev-guard/core";
import { copyTextToClipboard } from "./clipboard.js";
import { fromRoot, readJsonFile, readTextFile } from "./fs.js";
import { getCommitGitChanges, getGitChanges } from "./git.js";
import { readLatestRun } from "./runs.js";

interface ReportOptions {
  compact: boolean;
  copy: boolean;
  json: boolean;
  since?: string;
}

export async function runReport(root: string, args: string[]): Promise<void> {
  const options = parseReportOptions(args);
  const [gitChanges, taskText, rulesText, config, runLog, codeGraph] = await Promise.all([
    options.since ? getCommitGitChanges(root, options.since) : getGitChanges(root),
    readTextFile(fromRoot(root, ".devguard/task.md")),
    readTextFile(fromRoot(root, ".devguard/rules.md")),
    readJsonFile<DevGuardConfig>(fromRoot(root, ".devguard/config.json"), defaultConfig),
    readLatestRun(root),
    readJsonFile<CodeGraphEntry[]>(fromRoot(root, ".devguard/code-graph.json"), [])
  ]);
  const reportChangeFiles = filterDevGuardContextFiles(gitChanges.changeFiles, false);
  const changedFiles = [...new Set(reportChangeFiles.map((file) => file.path))].sort();

  // Task anchor freshness check — scoreTaskAnchorFreshness handles absent/placeholder/stale/fresh
  const anchor = changedFiles.length > 0
    ? scoreTaskAnchorFreshness({ taskMarkdown: taskText, diffText: gitChanges.diffText, changedFiles, changeFiles: reportChangeFiles })
    : null;

  const needsDiffTask = anchor?.mode === "stale" || anchor?.mode === "anchor_absent";
  const effectiveTaskText = needsDiffTask
    ? buildInferredTaskSummary(changedFiles, reportChangeFiles, gitChanges.diffText, codeGraph)
    : taskText;

  const checkReport = analyzeDiff({
    changedFiles: gitChanges.changedFiles,
    changeFiles: gitChanges.changeFiles,
    diffText: gitChanges.diffText,
    taskText: effectiveTaskText,
    rulesText,
    config,
    includeContextFiles: false
  });
  const report = generateCompactReport({
    taskMarkdown: effectiveTaskText,
    changedFiles,
    checkReport,
    runLog,
    scanStale: false
  });

  if (anchor?.mode === "anchor_absent") {
    console.error("dev-guard report: task anchor: absent; using diff-inferred task");
  } else if (anchor?.mode === "stale") {
    console.error(`dev-guard report: task.md stale (match score ${anchor.matchScore}); using diff-inferred task`);
  } else if (anchor?.mode === "uncertain") {
    console.error(`dev-guard report: task.md uncertain (match score ${anchor.matchScore})`);
  }

  const output = options.json ? `${JSON.stringify(report, null, 2)}\n` : options.compact ? formatCompactReport(report) : formatReport(report);

  if (options.copy) {
    const result = await copyTextToClipboard(output);
    if (result.ok) {
      console.error("dev-guard report: copied to clipboard.");
    } else {
      console.error(`dev-guard report: clipboard copy failed (${result.reason}).`);
    }
  }

  console.log(output.trimEnd());
}

function parseReportOptions(args: string[]): ReportOptions {
  const sinceIndex = args.indexOf("--since");
  const since = sinceIndex >= 0 ? args[sinceIndex + 1] : undefined;
  if (sinceIndex >= 0 && (!since || since.startsWith("--"))) {
    throw new Error("dev-guard report --since 옵션에는 기준 ref가 필요합니다.");
  }

  return {
    compact: args.includes("--compact"),
    copy: args.includes("--copy"),
    json: args.includes("--json"),
    since
  };
}

function formatCompactReport(report: ReturnType<typeof generateCompactReport>): string {
  const changed = report.changedFiles.length > 0 ? report.changedFiles.slice(0, 5).join(", ") : "none";
  const more = report.changedFiles.length > 5 ? ` (+${report.changedFiles.length - 5})` : "";
  return [
    `Task: ${report.task}`,
    `Request: ${report.userRequest}`,
    `Changed: ${changed}${more}`,
    `Check: ${report.check}`,
    `Review: ${report.review}`,
    `Run: ${report.runId}`,
    `Next: ${report.nextAction}`
  ].join("\n");
}

function formatReport(report: ReturnType<typeof generateCompactReport>): string {
  return [
    "dev-guard report",
    "",
    `Current task: ${report.task}`,
    `User request: ${report.userRequest}`,
    `Run id: ${report.runId}`,
    "",
    "Changed files:",
    ...(report.changedFiles.length > 0 ? report.changedFiles.map((file) => `- ${file}`) : ["- none"]),
    "",
    `Check: ${report.check}`,
    `Latest review: ${report.review}`,
    `Suggested next action: ${report.nextAction}`
  ].join("\n");
}

function buildInferredTaskSummary(
  changedFiles: string[],
  changeFiles: ReturnType<typeof filterDevGuardContextFiles>,
  diffText: string,
  codeGraph: CodeGraphEntry[]
): string {
  const clusters = inferDiffIntentClusters({ changedFiles, changeFiles, diffText, codeGraph });
  const intent = clusters.primaryIntent;
  return [
    "# Inferred Current Task (task.md stale)",
    "",
    `- type: ${intent.type}`,
    intent.subtype ? `- subtype: ${intent.subtype}` : "",
    `- confidence: ${intent.confidence}`,
    `- scope: ${intent.scope.join(", ") || changedFiles.slice(0, 3).join(", ")}`,
    "",
    `## Goal`,
    `- ${inferredIntentToRequirement(intent)}`,
    "",
    `## Inferred from diff`,
    `- ${formatInferredDiffIntentClusters(clusters)}`
  ]
    .filter((line) => line !== "")
    .join("\n");
}
