import {
  analyzeDiff,
  defaultConfig,
  filterDevGuardContextFiles,
  generateCompactReport,
  type DevGuardConfig,
  type CodeGraphEntry
} from "@dev-guard/core";
import { copyTextToClipboard } from "./clipboard.js";
import { fromRoot, readJsonFile, readTextFile } from "./fs.js";
import { getCommitGitChanges, getGitChanges } from "./git.js";
import { loadCurrentProjectIdentity } from "./project-identity.js";
import { formatEffectiveTaskContext, resolveEffectiveTaskContext } from "./effective-task.js";

interface ReportOptions {
  compact: boolean;
  copy: boolean;
  json: boolean;
  since?: string;
}

export async function runReport(root: string, args: string[]): Promise<void> {
  const options = parseReportOptions(args);
  const [gitChanges, taskText, rulesText, config, codeGraph, currentIdentity] = await Promise.all([
    options.since ? getCommitGitChanges(root, options.since) : getGitChanges(root),
    readTextFile(fromRoot(root, ".devguard/task.md")),
    readTextFile(fromRoot(root, ".devguard/rules.md")),
    readJsonFile<DevGuardConfig>(fromRoot(root, ".devguard/config.json"), defaultConfig),
    readJsonFile<CodeGraphEntry[]>(fromRoot(root, ".devguard/code-graph.json"), []),
    loadCurrentProjectIdentity(root).catch(() => undefined)
  ]);
  const reportChangeFiles = filterDevGuardContextFiles(gitChanges.changeFiles, false);
  const changedFiles = [...new Set(reportChangeFiles.map((file) => file.path))].sort();
  const effective = await resolveEffectiveTaskContext({
    root,
    taskMarkdown: taskText,
    gitChanges: { diffText: gitChanges.diffText, changedFiles, changeFiles: reportChangeFiles },
    changedFiles,
    reviewChangeFiles: reportChangeFiles,
    codeGraph,
    currentIdentity
  });
  const effectiveTaskText = effective.effectiveTaskMarkdown;
  const anchorMode = effective.useTaskMarkdown ? "task-first" : "diff-first";

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
    runLog: effective.effectiveRunLog,
    scanStale: false,
    anchorMode
  });

  if (changedFiles.length > 0) {
    for (const line of formatEffectiveTaskContext("dev-guard report", effective)) {
      console.error(line);
    }
    if (effective.runSelection.warning) {
      console.error(`dev-guard report: warning: ${effective.runSelection.warning}`);
    }
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
