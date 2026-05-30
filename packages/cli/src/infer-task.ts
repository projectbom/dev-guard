import {
  formatInferredDiffIntentClusters,
  inferDiffIntentClusters,
  inferredIntentToRequirement,
  scoreTaskAnchorFreshness,
  type CodeGraphEntry
} from "@dev-guard/core";
import { fromRoot, readJsonFile, readTextFile, writeTextFile } from "./fs.js";
import { getGitChanges } from "./git.js";

interface InferTaskOptions {
  write: boolean;
}

export async function runInferTask(root: string, args: string[]): Promise<void> {
  const options = parseInferTaskOptions(args);
  const [gitChanges, taskMarkdown, codeGraph] = await Promise.all([
    getGitChanges(root),
    readTextFile(fromRoot(root, ".devguard/task.md")),
    readJsonFile<CodeGraphEntry[]>(fromRoot(root, ".devguard/code-graph.json"), [])
  ]);

  if (gitChanges.changedFiles.length === 0) {
    console.log("dev-guard infer-task");
    console.log("");
    console.log("변경 사항 없음: infer할 diff가 없습니다.");
    return;
  }

  const clusters = inferDiffIntentClusters({
    changedFiles: gitChanges.changedFiles,
    changeFiles: gitChanges.changeFiles,
    diffText: gitChanges.diffText,
    codeGraph
  });
  const intent = clusters.primaryIntent;

  // Check if existing task.md is stale
  const hasTask = taskMarkdown.trim().length > 0 && !/^#?\s*Current task/i.test(taskMarkdown.trim());
  const anchor = hasTask
    ? scoreTaskAnchorFreshness({
        taskMarkdown,
        diffText: gitChanges.diffText,
        changedFiles: gitChanges.changedFiles,
        changeFiles: gitChanges.changeFiles
      })
    : null;

  console.log("dev-guard infer-task");
  console.log("");

  if (anchor) {
    const scoreLabel = `match score ${anchor.matchScore}`;
    if (anchor.mode === "stale") {
      console.log(`task.md: stale (${scoreLabel})`);
      if (anchor.taskType) console.log(`task.md task: ${anchor.taskType}`);
    } else if (anchor.mode === "uncertain") {
      console.log(`task.md: uncertain (${scoreLabel})`);
    } else {
      console.log(`task.md: fresh (${scoreLabel})`);
    }
    console.log("");
  }

  const inferredMarkdown = buildInferredTaskMarkdown(intent, clusters, gitChanges.changedFiles);

  console.log("Inferred Current Task:");
  console.log(`- type: ${intent.type}`);
  if (intent.subtype) console.log(`- subtype: ${intent.subtype}`);
  if (intent.targetCommand) console.log(`- target: ${intent.targetCommand}`);
  console.log(`- scope: ${intent.scope.join(", ") || gitChanges.changedFiles.slice(0, 3).join(", ")}`);
  console.log(`- confidence: ${intent.confidence}`);
  if (intent.evidence.length > 0) {
    console.log(`- evidence: ${intent.evidence.slice(0, 3).join("; ")}`);
  }
  if (clusters.secondaryIntents.length > 0) {
    console.log(`- clusters: ${formatInferredDiffIntentClusters(clusters)}`);
  }

  console.log("");
  console.log("Changed files:");
  for (const file of gitChanges.changedFiles.slice(0, 10)) {
    console.log(`  - ${file}`);
  }
  if (gitChanges.changedFiles.length > 10) {
    console.log(`  ... +${gitChanges.changedFiles.length - 10} more`);
  }

  if (options.write) {
    const taskPath = fromRoot(root, ".devguard/task.md");
    await writeTextFile(taskPath, inferredMarkdown);
    console.log("");
    console.log("[written] .devguard/task.md updated with inferred task.");
  } else {
    console.log("");
    console.log("Preview only. Use --write to replace .devguard/task.md:");
    console.log("  dev-guard infer-task --write");
    if (anchor?.mode === "stale") {
      console.log("  (recommended: task.md is stale)");
    }
  }
}

function parseInferTaskOptions(args: string[]): InferTaskOptions {
  return { write: args.includes("--write") };
}

function buildInferredTaskMarkdown(
  intent: ReturnType<typeof inferDiffIntentClusters>["primaryIntent"],
  clusters: ReturnType<typeof inferDiffIntentClusters>,
  changedFiles: string[]
): string {
  const scope = intent.scope.join(", ") || changedFiles.slice(0, 5).join(", ");
  const requirement = inferredIntentToRequirement(intent);
  const lines = [
    "# Current Task",
    "",
    `> Auto-inferred from git diff by dev-guard infer-task`,
    "",
    "## Goal",
    `- ${requirement}`,
    "",
    "## Task type",
    `- type: ${intent.type}`,
    intent.subtype ? `- subtype: ${intent.subtype}` : null,
    intent.targetCommand ? `- target: ${intent.targetCommand}` : null,
    `- confidence: ${intent.confidence}`,
    `- scope: ${scope}`,
    "",
    "## Changed files",
    ...changedFiles.slice(0, 15).map((file) => `- ${file}`),
    changedFiles.length > 15 ? `- ... +${changedFiles.length - 15} more` : null,
    "",
    "## Allowed Paths",
    ...changedFiles.slice(0, 8).map((file) => `- ${file}`),
    "",
    "## Out of Scope",
    "- (inferred task — define scope manually if needed)",
    "",
    "## Diff clusters",
    `- ${formatInferredDiffIntentClusters(clusters)}`
  ];
  return lines.filter((line) => line !== null).join("\n") + "\n";
}
