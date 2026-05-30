import type { ChangeFile, DriftResult, TaskAnchorFreshnessResult } from "./types.js";
import { analyzeGeneratedDiffDrift } from "./drift.js";

/**
 * Scores how well the current task.md matches the current git diff.
 * Returns a matchScore 0-100 (higher = better match) and a mode:
 *   - "use_task" (score >= 60): task.md is fresh, use it normally
 *   - "uncertain" (30-59): task.md may be stale, use with caution
 *   - "stale" (< 30): task.md is stale, switch to diff-first review
 */
export function scoreTaskAnchorFreshness(input: {
  taskMarkdown: string;
  diffText: string;
  changedFiles: string[];
  changeFiles?: ChangeFile[];
}): TaskAnchorFreshnessResult {
  const taskMarkdown = input.taskMarkdown.trim();

  if (!taskMarkdown) {
    return {
      matchScore: 0,
      mode: "stale",
      reasons: ["task.md is empty"],
      drift: emptyDrift()
    };
  }

  const drift = analyzeGeneratedDiffDrift({
    requirementText: taskMarkdown,
    taskMarkdown,
    diffText: input.diffText,
    changedFiles: input.changedFiles,
    changeFiles: input.changeFiles
  });

  // Invert drift score: drift 0 = perfect match → matchScore 100
  const baseScore = 100 - drift.driftScore;

  // File hint bonus: +15 if task.md references specific files that appear in the diff
  const fileBonus = computeFileHintBonus(taskMarkdown, input.changedFiles);

  const matchScore = Math.min(100, Math.max(0, Math.round(baseScore + fileBonus)));
  const taskType = extractTaskTypeToken(taskMarkdown);
  const mode: TaskAnchorFreshnessResult["mode"] = matchScore >= 60 ? "use_task" : matchScore >= 30 ? "uncertain" : "stale";

  return {
    matchScore,
    mode,
    taskType,
    diffType: undefined,
    reasons: drift.reasons,
    drift
  };
}

export function formatTaskAnchorStatus(result: TaskAnchorFreshnessResult, taskLabel?: string, diffLabel?: string): string {
  const score = `match score ${result.matchScore}`;
  if (result.mode === "use_task") {
    return `task.md: fresh (${score})`;
  }
  if (result.mode === "uncertain") {
    const taskPart = taskLabel ? `task.md task: ${taskLabel}` : "";
    return [`task.md: uncertain (${score})`, taskPart].filter(Boolean).join(" — ");
  }
  const taskPart = taskLabel ? `task.md task: ${taskLabel}` : "";
  const diffPart = diffLabel ? `current diff intent: ${diffLabel}` : "";
  return [
    `task.md: stale (${score})`,
    taskPart,
    diffPart,
    "mode: diff-first inferred review"
  ].filter(Boolean).join("\n");
}

function computeFileHintBonus(taskMarkdown: string, changedFiles: string[]): number {
  if (changedFiles.length === 0) return 0;
  const roots = "(?:app|apps|pages|packages|src|lib|components|hooks|utils|supabase|styles|constants|public|docs)";
  const hints = [...taskMarkdown.matchAll(new RegExp(`(?:^|[\\s\`'"/])((?:\\./)?${roots}/[^\\s,)\\]\`'"]+)`, "g"))]
    .map((m) => (m[1] ?? "").replace(/^\.\//, "").replace(/[),.\]'"]+$/, "").trim())
    .filter(Boolean);
  if (hints.length === 0) return 0;
  const hitCount = changedFiles.filter((file) =>
    hints.some((hint) => file === hint || file.startsWith(`${hint}/`) || hint.startsWith(file))
  ).length;
  return hitCount > 0 ? Math.min(15, hitCount * 5) : 0;
}

function extractTaskTypeToken(markdown: string): string | undefined {
  return markdown.match(/^-\s*type:\s*([a-z_]+)/im)?.[1] ?? markdown.match(/\btype:\s*([a-z_]+)/i)?.[1];
}

function emptyDrift(): DriftResult {
  return {
    driftScore: 100,
    severity: "high",
    reasons: ["no task content"],
    requirementDomains: [],
    generatedDomains: [],
    requirementZones: [],
    generatedZones: [],
    allowedExpansions: [],
    similarity: 0
  };
}
