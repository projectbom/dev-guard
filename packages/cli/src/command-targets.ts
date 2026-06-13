import type { TaskAIFileCandidate } from "@dev-guard/core";

interface CommandTarget {
  command: string;
  edit: string[];
  reference: string[];
}

const knownCommands = ["task-ai", "fix-prompt", "self-check", "done", "handoff", "status", "update", "watch", "review", "check", "prompt", "doctor", "report", "scan", "refresh", "telemetry", "self"];

export function inferCommandTargetFiles(requirement: string, projectFiles: string[]): CommandTarget | undefined {
  const command = detectCommand(requirement);
  if (!command) {
    return undefined;
  }

  const fileSet = new Set(projectFiles);
  const indexFile = existing(fileSet, "packages/cli/src/index.ts");
  const commandFile = commandFileFor(command, fileSet);
  const updateFile = existing(fileSet, "packages/cli/src/update.ts");
  const references: string[] = [];
  const edits: string[] = [];

  if (command === "done" || command === "handoff" || command === "status") {
    if (indexFile) {
      edits.push(indexFile);
    }
    if (/update\s*preview|preview|업데이트\s*미리|문서\s*후보/i.test(requirement) && updateFile) {
      references.push(updateFile);
    }
  } else if (commandFile) {
    edits.push(commandFile);
    if (indexFile && commandFile !== indexFile) {
      references.push(indexFile);
    }
  } else if (indexFile) {
    edits.push(indexFile);
  }

  if ((command === "update" || /update\s*preview|preview/i.test(requirement)) && updateFile && !edits.includes(updateFile) && !references.includes(updateFile)) {
    references.push(updateFile);
  }

  return {
    command,
    edit: unique(edits),
    reference: unique(references)
  };
}

export function mergeCommandTargetCandidates(
  candidates: TaskAIFileCandidate[],
  target: CommandTarget | undefined
): TaskAIFileCandidate[] {
  if (!target) {
    return candidates;
  }

  const byPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  for (const path of target.edit) {
    byPath.set(path, bumpCandidate(byPath.get(path), path, 120, "edit", `command target:${target.command}`));
  }
  for (const path of target.reference) {
    byPath.set(path, bumpCandidate(byPath.get(path), path, 80, "reference", relatedReason(target.command, path), true));
  }

  return [...byPath.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 30);
}

export function filterCommandTargetCandidates(
  candidates: TaskAIFileCandidate[],
  target: CommandTarget | undefined
): TaskAIFileCandidate[] {
  if (!target) {
    return candidates;
  }

  const allowedCommandFiles = new Set([...target.edit, ...target.reference]);
  return candidates.filter((candidate) => {
    if (allowedCommandFiles.has(candidate.path)) {
      return true;
    }

    if ((target.command === "done" || target.command === "handoff" || target.command === "status") && /(^|\/)update\.ts$/i.test(candidate.path)) {
      return false;
    }

    return true;
  });
}

function bumpCandidate(
  candidate: TaskAIFileCandidate | undefined,
  path: string,
  score: number,
  role: TaskAIFileCandidate["role"],
  reason: string,
  forceRole = false
): TaskAIFileCandidate {
  const next =
    candidate ??
    ({
      path,
      score: 0,
      reasons: [],
      negativeReasons: [],
      role
    } satisfies TaskAIFileCandidate);
  return {
    ...next,
    score: Math.max(next.score, score),
    role: forceRole ? role : role === "edit" ? "edit" : next.role === "edit" ? "edit" : role,
    reasons: [...new Set([reason, ...next.reasons])].slice(0, 8)
  };
}

function detectCommand(requirement: string): string | undefined {
  const normalized = requirement.toLowerCase();
  return knownCommands.find((command) => new RegExp(`(^|[^a-z0-9-])${escapeRegExp(command)}([^a-z0-9-]|$)`, "i").test(normalized));
}

function commandFileFor(command: string, fileSet: Set<string>): string | undefined {
  const normalized = command.replace(/-/g, "");
  const candidates = [
    `packages/cli/src/${command}.ts`,
    `packages/cli/src/${normalized}.ts`,
    command === "handoff" ? "packages/cli/src/runtime-state.ts" : "",
    command === "task-ai" ? "packages/cli/src/task-ai.ts" : "",
    command === "fix-prompt" ? "packages/cli/src/review.ts" : "",
    command === "review" ? "packages/cli/src/review.ts" : "",
    command === "check" ? "packages/cli/src/check.ts" : "",
    command === "prompt" ? "packages/cli/src/prompt.ts" : "",
    command === "doctor" ? "packages/cli/src/doctor.ts" : "",
    command === "watch" ? "packages/cli/src/watch.ts" : "",
    command === "update" ? "packages/cli/src/update.ts" : "",
    command === "self" || command === "self-check" ? "packages/cli/src/self.ts" : "",
    command === "scan" ? "packages/cli/src/scan.ts" : "",
    command === "refresh" ? "packages/cli/src/refresh.ts" : "",
    command === "telemetry" ? "packages/cli/src/telemetry.ts" : "",
    command === "report" ? "packages/cli/src/report.ts" : ""
  ].filter(Boolean);
  return candidates.find((file) => fileSet.has(file));
}

function existing(fileSet: Set<string>, path: string): string | undefined {
  return fileSet.has(path) ? path : undefined;
}

function relatedReason(command: string, path: string): string {
  if (command === "done" && path.endsWith("/update.ts")) {
    return "related update preview output";
  }
  return `command router/reference for ${command}`;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
