import { analyzeDiff, analyzeGeneratedDiffDrift, type CodeGraphEntry } from "@dev-guard/core";
import { recordDriftTelemetry } from "./drift-telemetry.js";
import { fromRoot, readJsonFile, readTextFile } from "./fs.js";
import { getGitChanges, hasGitBaseline } from "./git.js";
import { loadConfig } from "./config.js";

interface CheckOptions {
  includeContextFiles: boolean;
  local?: boolean;
}

export async function runCheck(root: string, options: CheckOptions): Promise<void> {
  const [gitChanges, taskText, rulesText, resolvedConfig, baseline, codeGraph] = await Promise.all([
    getGitChanges(root),
    readTextFile(fromRoot(root, ".devguard/task.md")),
    readTextFile(fromRoot(root, ".devguard/rules.md")),
    loadConfig(root),
    hasGitBaseline(root),
    readJsonFile<CodeGraphEntry[]>(fromRoot(root, ".devguard/code-graph.json"), [])
  ]);

  const report = analyzeDiff({
    changedFiles: gitChanges.changedFiles,
    changeFiles: gitChanges.changeFiles,
    diffText: gitChanges.diffText,
    taskText,
    rulesText,
    config: resolvedConfig.config,
    includeContextFiles: options.includeContextFiles,
    codeGraph
  });
  await recordDriftTelemetry(root, {
    result: analyzeGeneratedDiffDrift({
      requirementText: taskText,
      taskMarkdown: taskText,
      diffText: gitChanges.diffText,
      changedFiles: report.changedFiles,
      changeFiles: report.changeFiles
    }),
    source: "check:local",
    subtype: taskText.match(/subtype:\s*([a-z_.]+)/i)?.[1]
  }).catch((error) => console.error(`dev-guard check: telemetry warning: ${errorMessage(error)}`));

  printReport(report, { mode: options.local ? "local heuristic" : "local heuristic", configSource: resolvedConfig.source, baseline });
}

function printReport(report: ReturnType<typeof analyzeDiff>, meta: { mode: string; configSource: string; baseline: boolean }): void {
  console.log("dev-guard check");
  console.log(`Mode: ${meta.mode}`);
  console.log(`Config Source: ${meta.configSource}`);
  if (!meta.baseline) {
    console.log("Git baseline: none");
    console.log("No git baseline found. Initial/untracked files can make check output noisy.");
    console.log('Run: git add . && git commit -m "initial commit"');
  }
  console.log("");
  console.log("Changed files:");

  if (report.changeFiles.length === 0) {
    console.log("- none");
  } else {
    printChangeSection("Working tree", report.changeFiles.filter((file) => file.source === "workingTree"));
    printChangeSection("Staged", report.changeFiles.filter((file) => file.source === "staged"));
    printChangeSection("Untracked", report.changeFiles.filter((file) => file.source === "untracked"));
  }

  console.log("");
  console.log("Findings:");

  if (report.findings.length === 0) {
    console.log("- no warnings");
  } else {
    for (const finding of report.findings) {
      const prefix = finding.severity === "warning" ? "warning" : "info";
      console.log(`- [${prefix}] ${finding.title}`);
      console.log(`  ${finding.message}`);
      if (finding.files && finding.files.length > 0) {
        console.log(`  files: ${finding.files.join(", ")}`);
      }
    }
  }

  console.log("");
  console.log(`Docs update needed: ${report.docsUpdateNeeded ? "yes" : "no"}`);
}

function printChangeSection(title: string, files: ReturnType<typeof analyzeDiff>["changeFiles"]): void {
  console.log(`${title}:`);

  if (files.length === 0) {
    console.log("- none");
    return;
  }

  for (const file of files) {
    const rename = file.oldPath ? ` from ${file.oldPath}` : "";
    console.log(`- ${file.path} (${file.status}${rename})`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
