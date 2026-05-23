import { mergeConfig } from "./defaults.js";
import { filterDevGuardContextFiles } from "./context-files.js";
import { analyzeCompletionPostChecks } from "./completion.js";
import { analyzeGeneratedDiffDrift, scoreWorkflowQuality } from "./drift.js";
import type { ChangeFile, DiffInput, GuardFinding, GuardReport } from "./types.js";

export function analyzeDiff(input: DiffInput): GuardReport {
  const config = mergeConfig(input.config);
  const findings: GuardFinding[] = [];
  const allChangeFiles = normalizeChangeFiles(input.changeFiles, input.changedFiles);
  const changeFiles = filterDevGuardContextFiles(allChangeFiles, input.includeContextFiles);
  const changedFiles = normalizeFiles(changeFiles.map((file) => file.path));
  const riskFiles = changedFiles.filter((file) => !matchesAny(file, config.riskIgnoredPaths));
  const docFiles = riskFiles.filter((file) => matchesAny(file, config.docPaths));
  const sourceFiles = riskFiles.filter((file) => matchesAny(file, config.sourcePaths));
  const allowedPaths = collectAllowedPaths(input.taskText, input.rulesText, config.allowedPaths);
  const unrelatedFiles = findUnrelatedFiles(riskFiles, allowedPaths, config.docPaths);
  const protectedFiles = riskFiles.filter((file) => matchesAny(file, config.protectedPaths));
  const docsUpdateNeeded = sourceFiles.length > 0 && docFiles.length === 0;

  if (allChangeFiles.length > 0 && changeFiles.length === 0) {
    findings.push({
      severity: "info",
      code: "context_files_changed_only",
      title: "Context files changed only",
      message: "No code changes detected after excluding dev-guard context files."
    });
  } else if (changedFiles.length === 0) {
    findings.push({
      severity: "info",
      code: "no_changes",
      title: "No changes detected",
      message: "There are no tracked, staged, or untracked changes detected."
    });
  }

  if (changeFiles.some((file) => file.source === "untracked")) {
    findings.push({
      severity: "info",
      code: "untracked_files_detected",
      title: "Untracked files detected",
      message: "Untracked files are included in this check. Review whether they should be committed or ignored.",
      files: changeFiles.filter((file) => file.source === "untracked").map((file) => file.path)
    });
  }

  if (unrelatedFiles.length > 0) {
    findings.push({
      severity: "warning",
      code: "possibly_unrelated_files",
      title: "Possible unrelated file changes",
      message:
        "Some changed files do not appear in task/rules path hints. Review whether they are inside the requested scope.",
      files: unrelatedFiles
    });
  } else if (changedFiles.length > 0 && allowedPaths.length > 0) {
    findings.push({
      severity: "info",
      code: "no_scope_drift",
      title: "No scope drift detected",
      message: "Changed code files match task/rules path hints."
    });
  }

  if (protectedFiles.length > 0) {
    findings.push({
      severity: "warning",
      code: "protected_paths_changed",
      title: "Protected or high-impact paths changed",
      message: "High-impact paths changed. Confirm this was explicitly required by the task.",
      files: protectedFiles
    });
  }

  if (hasLargeDiff(input.diffText, riskFiles)) {
    findings.push({
      severity: "warning",
      code: "large_scope_change",
      title: "Possible requirement scope expansion",
      message: "The diff touches many files or has a large patch size. Confirm this was necessary for the task."
    });
  }

  if (docsUpdateNeeded) {
    findings.push({
      severity: "warning",
      code: "docs_update_needed",
      title: "Project docs may need updates",
      message:
        "Source files changed without docs changes. Consider updating PROJECT_STATE, CURRENT_TASK, DECISIONS, or DO_NOT_REPEAT."
    });
  }

  findings.push(
    ...analyzeCompletionPostChecks({
      taskMarkdown: input.taskText,
      changedFiles,
      diffText: input.diffText
    })
  );

  const drift = analyzeGeneratedDiffDrift({
    requirementText: input.taskText,
    taskMarkdown: input.taskText,
    diffText: input.diffText,
    changedFiles,
    changeFiles
  });
  const quality = scoreWorkflowQuality({
    drift,
    changedFiles,
    diffText: input.diffText,
    changeFiles
  });
  if (drift.severity !== "low") {
    findings.push({
      severity: "warning",
      code: "potential_semantic_drift",
      title: "Potential semantic drift detected",
      message: `Generated diff may have drifted from the task. severity=${drift.severity}, score=${drift.driftScore}, alignment=${quality.requirementAlignment}, driftRisk=${quality.driftRisk}, reasons=${drift.reasons.join("; ") || "domain mismatch"}`,
      files: changedFiles.slice(0, 12)
    });
  }

  return {
    changedFiles,
    changeFiles,
    findings,
    docsUpdateNeeded
  };
}

function normalizeChangeFiles(changeFiles: ChangeFile[] | undefined, changedFiles: string[]): ChangeFile[] {
  const source: ChangeFile[] =
    changeFiles ?? changedFiles.map((path) => ({ path, status: "modified" as const, source: "workingTree" as const }));
  const seen = new Set<string>();
  const normalized: ChangeFile[] = [];

  for (const file of source) {
    const path = file.path.trim();
    if (!path) {
      continue;
    }

    const key = `${file.source}:${file.status}:${file.oldPath ?? ""}:${path}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push({ ...file, path });
  }

  return normalized.sort((a, b) => a.path.localeCompare(b.path) || a.source.localeCompare(b.source));
}

function normalizeFiles(files: string[]): string[] {
  return [...new Set(files.map((file) => file.trim()).filter(Boolean))].sort();
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = cleanPathHint(pattern);
    if (matchesGlobPath(file, normalized)) {
      return true;
    }

    if (normalized.endsWith("/")) {
      return file.startsWith(normalized);
    }

    return file === normalized || file.startsWith(normalized);
  });
}

function matchesGlobPath(file: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) {
    const directory = pattern.slice(0, -3);
    return file === directory || file.startsWith(`${directory}/`);
  }

  if (pattern.endsWith("/*")) {
    const directory = pattern.slice(0, -2);
    if (!file.startsWith(`${directory}/`)) {
      return false;
    }

    return !file.slice(directory.length + 1).includes("/");
  }

  if (!pattern.includes("*")) {
    return false;
  }

  const regex = new RegExp(`^${escapeRegExp(pattern).replace(/\\\*\\\*/g, ".*").replace(/\\\*/g, "[^/]*")}$`);
  return regex.test(file);
}

function collectAllowedPaths(taskText: string, rulesText: string, configAllowedPaths: string[]): string[] {
  const text = `${taskText}\n${rulesText}`;
  const markdownPaths = [...text.matchAll(/`([^`\n]+\.[a-zA-Z0-9]+|[^`\n]+\/)`/g)].map((match) => match[1]);
  const plainPaths = [...text.matchAll(pathHintPattern("global"))].map((match) => match[1]);
  const scopePaths = [...extractSectionPaths(taskText, "수정 범위"), ...extractSectionPaths(taskText, "수정 대상")];

  return [...configAllowedPaths, ...markdownPaths, ...plainPaths, ...scopePaths]
    .map(cleanPathHint)
    .filter(Boolean);
}

function pathHintPattern(mode: "global" | "single" = "global"): RegExp {
  const roots = [
    "app",
    "apps",
    "pages",
    "packages",
    "src",
    "lib",
    "components",
    "hooks",
    "utils",
    "supabase",
    "styles",
    "constants",
    "public",
    "docs",
    "\\.devguard"
  ].join("|");

  return new RegExp(`(?:^|\\s)((?:\\.\\/)?(?:${roots})\\/[^\\s,)\\]]+)`, mode === "global" ? "g" : "");
}

function extractSectionPaths(taskText: string, section: string): string[] {
  const scope = extractMarkdownSection(taskText, section);
  if (!scope) {
    return [];
  }

  return scope
    .split("\n")
    .map((line) => extractPathFromScopeLine(line))
    .filter((path): path is string => Boolean(path));
}

function extractMarkdownSection(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const headingIndex = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(title)}\\s*$`).test(line.trim()));

  if (headingIndex < 0) {
    return "";
  }

  const sectionLines: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^##\s+/.test(line.trim())) {
      break;
    }

    sectionLines.push(line);
  }

  return sectionLines.join("\n").trim();
}

function extractPathFromScopeLine(line: string): string | undefined {
  const withoutBullet = line.trim().replace(/^[-*]\s*/, "");
  const backtickMatch = withoutBullet.match(/`([^`]+)`/);
  if (backtickMatch) {
    return cleanPathHint(backtickMatch[1]);
  }

  const plainMatch = withoutBullet.match(pathHintPattern("single"));
  return plainMatch?.[1] ? cleanPathHint(plainMatch[1]) : undefined;
}

function cleanPathHint(path: string): string {
  return path
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/^\.\//, "")
    .replace(/\s+-\s+.*$/, "")
    .replace(/\s+\([^)]*\)$/, "")
    .replace(/[),.\]]+$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findUnrelatedFiles(changedFiles: string[], allowedPaths: string[], docPaths: string[]): string[] {
  if (allowedPaths.length === 0) {
    return [];
  }

  return changedFiles.filter((file) => !matchesAny(file, allowedPaths) && !matchesAny(file, docPaths));
}

function hasLargeDiff(diffText: string, changedFiles: string[]): boolean {
  const changedLineCount = diffText
    .split("\n")
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")))
    .length;

  return changedFiles.length >= 12 || changedLineCount >= 600;
}
