import {
  filterDevGuardContextFiles,
  formatInferredDiffIntentClusters,
  inferDiffIntentClusters,
  inferredIntentToRequirement,
  scoreTaskAnchorFreshness,
  type CodeGraphEntry,
  type InferredDiffIntentClusters,
  type TaskAnchorFreshnessResult
} from "@dev-guard/core";
import { fromRoot, readJsonFile, readTextFile, writeTextFile } from "./fs.js";
import { getGitChanges } from "./git.js";

/**
 * Generates and writes .devguard/AI_CONTEXT.md.
 * Called after refresh, infer-task --write, and task-ai --write.
 * Silent on error to avoid breaking the main workflow.
 */
export async function writeAIContext(root: string): Promise<void> {
  const [gitChanges, taskMarkdown, codeGraph] = await Promise.all([
    getGitChanges(root),
    readTextFile(fromRoot(root, ".devguard/task.md")),
    readJsonFile<CodeGraphEntry[]>(fromRoot(root, ".devguard/code-graph.json"), [])
  ]);

  const changeFiles = filterDevGuardContextFiles(gitChanges.changeFiles, false);
  const changedFiles = [...new Set(changeFiles.map((f) => f.path))].sort();

  const anchor = scoreTaskAnchorFreshness({
    taskMarkdown,
    diffText: gitChanges.diffText,
    changedFiles,
    changeFiles
  });

  const clusters =
    changedFiles.length > 0
      ? inferDiffIntentClusters({ changedFiles, changeFiles, diffText: gitChanges.diffText, codeGraph })
      : null;

  const content = generateAIContextMarkdown({ anchor, clusters, changedFiles, taskMarkdown });
  await writeTextFile(fromRoot(root, ".devguard/AI_CONTEXT.md"), content);
}

/**
 * Short preamble prepended to Codex/Claude prompts so they know to read AI_CONTEXT.md first.
 */
export function buildAIContextPreamble(): string {
  return "Start by reading `.devguard/AI_CONTEXT.md` for task anchor and project context.\n\n---\n\n";
}

function generateAIContextMarkdown(input: {
  anchor: TaskAnchorFreshnessResult;
  clusters: InferredDiffIntentClusters | null;
  changedFiles: string[];
  taskMarkdown: string;
}): string {
  const { anchor, clusters, changedFiles } = input;
  const now = new Date().toISOString();

  const anchorStatus =
    anchor.mode === "anchor_absent"
      ? "absent"
      : anchor.mode === "stale"
        ? `stale (match score: ${anchor.matchScore})`
        : anchor.mode === "uncertain"
          ? `uncertain (match score: ${anchor.matchScore})`
          : `fresh (match score: ${anchor.matchScore})`;
  const anchorMode = anchor.mode === "anchor_absent" || anchor.mode === "stale" ? "diff-first" : "task-first";

  const taskSection = buildTaskSection(anchor, clusters, input.taskMarkdown);

  const changedSection =
    changedFiles.length > 0
      ? [
          ...changedFiles.slice(0, 12).map((f) => `- ${f}`),
          ...(changedFiles.length > 12 ? [`- ... +${changedFiles.length - 12} more`] : [])
        ].join("\n")
      : "- (no current changes)";

  const readFirst = [
    "- `.devguard/project-map.md` — project structure overview",
    "- `.devguard/file-summaries.json` — per-file roles and keywords",
    ...(anchorMode === "task-first"
      ? ["- `.devguard/task.md` — current task specification", "- `docs/CURRENT_TASK.md` — task history (if relevant)"]
      : [])
  ].join("\n");

  return [
    "# dev-guard AI Context",
    `Generated: ${now}`,
    "",
    "Start here before scanning the full project.",
    "",
    "## Task Anchor",
    `- status: ${anchorStatus}`,
    `- mode: ${anchorMode}`,
    "",
    "## Current Task",
    taskSection,
    "",
    "## Changed Files",
    changedSection,
    "",
    "## Read First",
    readFirst,
    "",
    "## Use If Needed",
    "- `.devguard/code-graph.json` — import/export graph",
    "- `docs/PROJECT_STATE.md` — project state",
    "- `docs/DECISIONS.md` — past decisions",
    "- `docs/DO_NOT_REPEAT.md` — mistakes to avoid",
    "",
    "## AI Rules",
    "- Do not scan the whole project directory first.",
    "- Use current git diff as source of truth when task anchor is absent or stale.",
    "- Open targeted files only — use project-map + file-summaries for discovery.",
    "- Verify stale context before trusting it.",
    "- When task.md is fresh, treat it as the authoritative task specification.",
    ""
  ].join("\n");
}

function buildTaskSection(
  anchor: TaskAnchorFreshnessResult,
  clusters: InferredDiffIntentClusters | null,
  taskMarkdown: string
): string {
  if (anchor.mode === "anchor_absent") {
    if (!clusters) return "- (no diff to infer from)";
    const intent = clusters.primaryIntent;
    return [
      `- type: ${intent.type}`,
      intent.subtype ? `- subtype: ${intent.subtype}` : "",
      intent.targetCommand ? `- target: ${intent.targetCommand}` : "",
      `- scope: ${intent.scope.join(", ") || "changed files"}`,
      `- confidence: ${intent.confidence}`,
      "- source: inferred from diff (task anchor absent)"
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (anchor.mode === "stale") {
    if (!clusters) return "- (task.md stale, no diff)";
    const intent = clusters.primaryIntent;
    return [
      `- type: ${intent.type}`,
      intent.subtype ? `- subtype: ${intent.subtype}` : "",
      `- scope: ${intent.scope.join(", ") || "changed files"}`,
      `- confidence: ${intent.confidence}`,
      anchor.taskType ? `- task.md type (stale): ${anchor.taskType}` : "",
      "- source: inferred from diff (task.md stale)"
    ]
      .filter(Boolean)
      .join("\n");
  }

  // uncertain or use_task
  const goalLine = extractTaskGoalLine(taskMarkdown);
  return [
    anchor.taskType ? `- type: ${anchor.taskType}` : "",
    goalLine ? `- goal: ${goalLine}` : "",
    anchor.mode === "uncertain"
      ? `- note: task.md uncertain (match score ${anchor.matchScore}), verify before trusting`
      : "",
    "- source: task.md"
  ]
    .filter(Boolean)
    .join("\n");
}

function extractTaskGoalLine(markdown: string): string | undefined {
  const match =
    markdown.match(/^##\s+목표\s*\n[-•]\s+(.+)/m) ??
    markdown.match(/^##\s+Goal\s*\n[-•]\s+(.+)/im);
  return match?.[1]?.trim().slice(0, 120);
}
