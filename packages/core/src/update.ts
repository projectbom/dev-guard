import { filterDevGuardContextFiles } from "./context-files.js";
import type { ChangeFile, UpdateSuggestionInput, UpdateSuggestions } from "./types.js";

interface DiffStats {
  addedLines: number;
  removedLines: number;
}

export function generateUpdateSuggestions(input: UpdateSuggestionInput): UpdateSuggestions {
  const allChangeFiles = normalizeChangeFiles(input.changeFiles, input.changedFiles);
  const changeFiles = filterDevGuardContextFiles(allChangeFiles, input.includeContextFiles);
  const changedFiles = normalizeFiles(changeFiles.map((file) => file.path));
  const generatedAt = new Date().toISOString();
  const stats = getDiffStats(input.diffText);
  const summary = buildSummary(changeFiles, stats, allChangeFiles.length > 0);
  const taskSummary = firstMeaningfulLine(input.taskMarkdown, "No task summary found in .devguard/task.md.");
  const rulesSummary = firstMeaningfulLine(input.rulesMarkdown, "No rule summary found in .devguard/rules.md.");
  const mistakesSummary = firstMeaningfulLine(input.mistakesMarkdown, "No mistake notes found in .devguard/mistakes.md.");
  const runSummary = input.runLog ? formatRunSummary(input.runLog) : "No saved run context found.";
  const changedFileList = formatList(changeFiles.length > 0 ? changeFiles.map(formatChangeFile) : ["none"]);
  const decisions = inferDecisionNotes(changedFiles);
  const cautions = inferCautionNotes(changeFiles, stats, rulesSummary);
  const repeatRules = inferRepeatPreventionRules(changedFiles, mistakesSummary);
  const ruleHygiene = inferRuleHygiene(input.rulesMarkdown, input.mistakesMarkdown);

  return {
    projectStateSuggestion: section("Project State Update Candidate", generatedAt, [
      ["Change summary", summary],
      ["Changed files", changedFileList],
      ["State notes", formatList(inferProjectStateNotes(changedFiles))]
    ]),
    currentTaskSuggestion: section("Current Task Update Candidate", generatedAt, [
      ["Change summary", summary],
      ["Task reference", taskSummary],
      ["Run reference", runSummary],
      ["Changed files", changedFileList],
      ["Remaining review", formatList(cautions)]
    ]),
    decisionsSuggestion: section("Decision Update Candidate", generatedAt, [
      ["Change summary", summary],
      ["Decision candidates", formatList(decisions)],
      ["Run context", runSummary],
      ["Cautions", formatList(cautions)]
    ]),
    doNotRepeatSuggestion: section("Do Not Repeat Candidate", generatedAt, [
      ["Change summary", summary],
      ["Repeat prevention candidates", formatList(repeatRules)],
      ["Rule hygiene candidates", formatList(ruleHygiene)],
      ["Run context", runSummary],
      ["Changed files", changedFileList]
    ]),
    summary
  };
}

function formatRunSummary(runLog: NonNullable<UpdateSuggestionInput["runLog"]>): string {
  return [
    `- run id: ${runLog.id}`,
    `- command: ${runLog.command}`,
    `- user request: ${runLog.userRequest || "none"}`,
    `- related files: ${runLog.relatedFiles.length > 0 ? runLog.relatedFiles.join(", ") : "none"}`,
    `- status: ${runLog.status}`
  ].join("\n");
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

function getDiffStats(diffText: string): DiffStats {
  return diffText.split("\n").reduce<DiffStats>(
    (stats, line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        stats.addedLines += 1;
      }

      if (line.startsWith("-") && !line.startsWith("---")) {
        stats.removedLines += 1;
      }

      return stats;
    },
    { addedLines: 0, removedLines: 0 }
  );
}

function buildSummary(changeFiles: ChangeFile[], stats: DiffStats, hasAnyChangeFiles: boolean): string {
  if (changeFiles.length === 0) {
    if (hasAnyChangeFiles) {
      return "No code changes detected. Context files changed only.";
    }

    return "No tracked, staged, or untracked changes detected.";
  }

  const changedFiles = normalizeFiles(changeFiles.map((file) => file.path));
  const areas = inferAreas(changedFiles).join(", ");
  const untrackedCount = changeFiles.filter((file) => file.source === "untracked").length;
  const stagedCount = changeFiles.filter((file) => file.source === "staged").length;
  const workingTreeCount = changeFiles.filter((file) => file.source === "workingTree").length;
  const sourceSummary = [`working tree ${workingTreeCount}`, `staged ${stagedCount}`, `untracked ${untrackedCount}`].join(", ");

  return `${changedFiles.length} file(s) changed in ${areas}; ${sourceSummary}; +${stats.addedLines}/-${stats.removedLines} diff lines.`;
}

function inferAreas(changedFiles: string[]): string[] {
  const areas = new Set<string>();

  for (const file of changedFiles) {
    if (file.startsWith("packages/core/")) {
      areas.add("core");
    } else if (file.startsWith("packages/cli/")) {
      areas.add("cli");
    } else if (file.startsWith("docs/") || file === "README.md") {
      areas.add("docs");
    } else if (file === "package.json" || file.endsWith("package.json") || file.includes("tsconfig") || file === "pnpm-workspace.yaml") {
      areas.add("workspace config");
    } else {
      areas.add("other");
    }
  }

  return areas.size > 0 ? [...areas] : ["none"];
}

function firstMeaningfulLine(markdown: string, fallback: string): string {
  const line = markdown
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !item.startsWith("#") && item !== "-");

  return line ?? fallback;
}

function inferProjectStateNotes(changedFiles: string[]): string[] {
  const notes: string[] = [];

  if (changedFiles.some((file) => file.startsWith("packages/core/"))) {
    notes.push("Core analysis behavior or reusable rule-based logic changed.");
  }

  if (changedFiles.some((file) => file.startsWith("packages/cli/"))) {
    notes.push("CLI command behavior changed.");
  }

  if (changedFiles.includes("packages/cli/src/self.ts")) {
    notes.push("Dogfooding workflow command behavior changed.");
  }

  if (changedFiles.includes("packages/core/src/prompt.ts") || changedFiles.includes("packages/cli/src/prompt.ts")) {
    notes.push("Codex prompt density, compression, or token-budget behavior changed.");
  }

  if (changedFiles.includes("packages/core/src/completion.ts")) {
    notes.push("Task completion criteria behavior changed.");
  }

  if (changedFiles.some((file) => file === "package.json" || file.endsWith("package.json") || file.includes("tsconfig"))) {
    notes.push("Workspace build, package, or TypeScript setup changed.");
  }

  return notes.length > 0 ? notes : ["No durable project-state update inferred by rules."];
}

function inferDecisionNotes(changedFiles: string[]): string[] {
  const notes: string[] = [];

  if (changedFiles.some((file) => file.startsWith("packages/core/"))) {
    notes.push("Keep analysis logic in packages/core so future analyzers can be added behind the CLI.");
  }

  if (changedFiles.some((file) => file.startsWith("packages/cli/"))) {
    notes.push("Keep file writes opt-in from the CLI and default to preview output.");
  }

  if (changedFiles.includes("packages/cli/src/self.ts")) {
    notes.push("Keep dogfooding shortcuts as wrappers around existing task/check/review logic rather than duplicating analyzers.");
  }

  if (changedFiles.includes("packages/core/src/prompt.ts") || changedFiles.includes("packages/cli/src/prompt.ts")) {
    notes.push("Preserve guardrail-critical prompt sections when reducing token usage.");
  }

  if (changedFiles.some((file) => file === "README.md")) {
    notes.push("Document new CLI behavior when commands or flags change.");
  }

  return notes.length > 0 ? notes : ["No decision candidate inferred by rules."];
}

function inferCautionNotes(changeFiles: ChangeFile[], stats: DiffStats, rulesSummary: string): string[] {
  const changedFiles = normalizeFiles(changeFiles.map((file) => file.path));
  const notes = [`Review against rule context: ${rulesSummary}`];

  if (changedFiles.length >= 8 || stats.addedLines + stats.removedLines >= 400) {
    notes.push("Diff is broad enough to require extra scope review before documenting it as intended state.");
  }

  if (changedFiles.some((file) => file.includes("package.json") || file.includes("pnpm-lock.yaml"))) {
    notes.push("Dependency or package metadata changed; verify install/build commands still work.");
  }

  if (changeFiles.some((file) => file.source === "untracked")) {
    notes.push("Untracked files have no git diff body yet; treat them as newly created files and review contents before commit.");
  }

  return notes;
}

function inferRepeatPreventionRules(changedFiles: string[], mistakesSummary: string): string[] {
  const rules = [`Compare this change against existing mistake context: ${mistakesSummary}`];

  if (changedFiles.some((file) => file.startsWith("packages/cli/"))) {
    rules.push("Do not make write-mode behavior the default; keep preview-only behavior unless explicitly requested.");
  }

  if (changedFiles.some((file) => file.startsWith("packages/core/"))) {
    rules.push("Do not mix rule-based core logic with CLI formatting or filesystem side effects.");
  }

  if (changedFiles.some((file) => file === "README.md")) {
    rules.push("Do not ship command changes without updating README usage examples.");
  }

  if (changedFiles.includes("packages/core/src/prompt.ts")) {
    rules.push("Do not remove PROTECT/SUCCESS/VERIFY when compressing Codex prompts.");
  }

  return dedupeLines(rules);
}

function inferRuleHygiene(rulesMarkdown: string, mistakesMarkdown: string): string[] {
  const lines = [...extractRuleLines(rulesMarkdown), ...extractRuleLines(mistakesMarkdown)];
  const normalized = lines.map(normalizeRuleLine).filter(Boolean);
  const duplicateCount = normalized.length - new Set(normalized).size;
  const notes: string[] = [];

  if (duplicateCount > 0) {
    notes.push(`Deduplicate ${duplicateCount} repeated rule candidate(s).`);
  }
  if (hasRuleConflict(normalized, "preview", "write") || hasRuleConflict(normalized, "compact", "verbose")) {
    notes.push("Review possible contradictory rules before promoting them into project policy.");
  }
  if (lines.some((line) => /packages\/|\.devguard|pnpm|typescript|cli/i.test(line))) {
    notes.push("Classify tool/repository-specific rules separately from generic AI coding rules.");
  }
  if (lines.length > 20) {
    notes.push("Consider pruning stale or low-relevance rules to keep prompts compact.");
  }

  return notes.length > 0 ? dedupeLines(notes) : ["No duplicate or contradictory rule candidates inferred by rules."];
}

function extractRuleLines(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim());
}

function normalizeRuleLine(line: string): string {
  return line.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasRuleConflict(lines: string[], first: string, second: string): boolean {
  return lines.some((line) => line.includes(first)) && lines.some((line) => line.includes(second));
}

function dedupeLines(lines: string[]): string[] {
  return [...new Map(lines.map((line) => [normalizeRuleLine(line), line])).values()];
}

function section(title: string, generatedAt: string, entries: Array<[string, string]>): string {
  const body = entries.map(([heading, value]) => `### ${heading}\n${value}`).join("\n\n");
  return `## ${title}\n\n- Date/time: ${generatedAt}\n\n${body}\n`;
}

function formatList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function formatChangeFile(file: ChangeFile): string {
  const rename = file.oldPath ? ` from ${file.oldPath}` : "";
  const state = file.source === file.status ? file.source : `${file.source}/${file.status}`;
  const newFileNote = file.source === "untracked" ? " - 새 파일 생성됨" : "";
  return `${file.path} (${state}${rename})${newFileNote}`;
}
