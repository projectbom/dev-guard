import {
  formatInferredDiffIntentClusters,
  inferDiffIntentClusters,
  inferredIntentToRequirement,
  type CodeGraphEntry
} from "@dev-guard/core";
import { writeAIContext } from "./ai-context.js";
import { fromRoot, readJsonFile, readTextFile, writeTextFile } from "./fs.js";
import { getGitChanges } from "./git.js";
import { loadCurrentProjectIdentity } from "./project-identity.js";
import { formatEffectiveTaskContext, resolveEffectiveTaskContext } from "./effective-task.js";

interface InferTaskOptions {
  write: boolean;
}

export async function runInferTask(root: string, args: string[]): Promise<void> {
  const options = parseInferTaskOptions(args);
  const [gitChanges, taskMarkdown, codeGraph, currentIdentity] = await Promise.all([
    getGitChanges(root),
    readTextFile(fromRoot(root, ".devguard/task.md")),
    readJsonFile<CodeGraphEntry[]>(fromRoot(root, ".devguard/code-graph.json"), []),
    loadCurrentProjectIdentity(root).catch(() => undefined)
  ]);

  if (gitChanges.changedFiles.length === 0) {
    console.log("dev-guard infer-task");
    console.log("");
    console.log("no diff to infer task from: 변경 사항이 없습니다.");
    return;
  }

  const effective = await resolveEffectiveTaskContext({
    root,
    taskMarkdown,
    gitChanges,
    codeGraph,
    currentIdentity
  });
  const clusters = effective.inferredTask;
  const intent = clusters.primaryIntent;

  console.log("dev-guard infer-task");
  console.log("");
  for (const line of formatEffectiveTaskContext("dev-guard infer-task", effective)) {
    console.log(line);
  }
  if (effective.runSelection.warning) {
    console.log(`dev-guard infer-task: warning: ${effective.runSelection.warning}`);
  }
  console.log("");

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
    await writeAIContext(root).catch(() => undefined);
    console.log("");
    console.log("[written] .devguard/task.md updated with inferred task.");
    console.log("[written] .devguard/AI_CONTEXT.md updated.");
  } else {
    console.log("");
    if (effective.anchorStatus === "absent") {
      console.log("task.md absent. Use --write to create from current diff:");
    } else if (!effective.useTaskMarkdown) {
      console.log("task.md is not the active anchor. Use --write to replace with current diff:");
    } else {
      console.log("Preview only. Use --write to replace .devguard/task.md:");
    }
    console.log("  dev-guard infer-task --write");
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
