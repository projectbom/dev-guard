import {
  generateUpdateSuggestions,
  type CodeGraphEntry
} from "@dev-guard/core";
import { fromRoot, readJsonFile, readTextFile, writeTextFile } from "./fs.js";
import { getGitChanges } from "./git.js";
import { loadCurrentProjectIdentity } from "./project-identity.js";
import { formatEffectiveTaskContext, resolveEffectiveTaskContext } from "./effective-task.js";

interface UpdateOptions {
  write: boolean;
  includeContextFiles: boolean;
}

const targetDocs = {
  projectStateSuggestion: "docs/PROJECT_STATE.md",
  currentTaskSuggestion: "docs/CURRENT_TASK.md",
  decisionsSuggestion: "docs/DECISIONS.md",
  doNotRepeatSuggestion: "docs/DO_NOT_REPEAT.md"
} as const;

export async function runUpdate(root: string, options: UpdateOptions): Promise<void> {
  const [gitChanges, taskMarkdown, rulesMarkdown, mistakesMarkdown, identity, codeGraph] = await Promise.all([
    getGitChanges(root),
    readTextFile(fromRoot(root, ".devguard/task.md")),
    readTextFile(fromRoot(root, ".devguard/rules.md")),
    readTextFile(fromRoot(root, ".devguard/mistakes.md")),
    loadCurrentProjectIdentity(root).catch(() => undefined),
    readJsonFile<CodeGraphEntry[]>(fromRoot(root, ".devguard/code-graph.json"), [])
  ]);

  if (gitChanges.changeFiles.length === 0 && !gitChanges.diffText.trim()) {
    console.log("dev-guard update");
    console.log("");
    console.log("변경 사항 없음");
    return;
  }

  const effective = await resolveEffectiveTaskContext({
    root,
    taskMarkdown,
    gitChanges,
    codeGraph,
    currentIdentity: identity
  });
  for (const line of formatEffectiveTaskContext("dev-guard update", effective)) {
    console.error(line);
  }
  if (effective.runSelection.warning) {
    console.error(`dev-guard update: warning: ${effective.runSelection.warning}`);
  }

  const suggestions = generateUpdateSuggestions({
    changedFiles: gitChanges.changedFiles,
    changeFiles: gitChanges.changeFiles,
    diffText: gitChanges.diffText,
    taskMarkdown: effective.effectiveTaskMarkdown,
    rulesMarkdown,
    mistakesMarkdown,
    includeContextFiles: options.includeContextFiles,
    runLog: effective.effectiveRunLog
  });

  if (options.write) {
    const writes = await Promise.all([
      appendSuggestion(root, targetDocs.projectStateSuggestion, suggestions.projectStateSuggestion),
      appendSuggestion(root, targetDocs.currentTaskSuggestion, suggestions.currentTaskSuggestion),
      appendSuggestion(root, targetDocs.decisionsSuggestion, suggestions.decisionsSuggestion),
      appendSuggestion(root, targetDocs.doNotRepeatSuggestion, suggestions.doNotRepeatSuggestion)
    ]);
    for (const write of writes) {
      console.error(`dev-guard update: ${write.action} ${write.path} (${write.reason})`);
    }
  }

  printUpdatePreview(suggestions, options);
}

async function appendSuggestion(root: string, path: string, suggestion: string): Promise<{ path: string; action: "created" | "updated"; reason: string }> {
  const absolutePath = fromRoot(root, path);
  const existing = await readTextFile(absolutePath);
  const hasStart = existing.includes("<!-- dev-guard:update:start -->");
  const hasEnd = existing.includes("<!-- dev-guard:update:end -->");
  if (hasStart !== hasEnd) {
    throw new Error(`${path} has a broken dev-guard update marker. Fix the marker pair before running --write.`);
  }
  const block = [
    "<!-- dev-guard:update:start -->",
    suggestion.trim(),
    "<!-- dev-guard:update:end -->",
    ""
  ].join("\n");
  const pattern = /<!-- dev-guard:update:start -->[\s\S]*?<!-- dev-guard:update:end -->\n?/;
  const action = pattern.test(existing) ? "updated" : "created";
  const next = pattern.test(existing)
    ? existing.replace(pattern, block)
    : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}`;
  await writeTextFile(absolutePath, next);
  return {
    path,
    action,
    reason: action === "updated" ? "replaced existing managed block" : "created managed block and preserved existing content"
  };
}

function printUpdatePreview(suggestions: ReturnType<typeof generateUpdateSuggestions>, options: UpdateOptions): void {
  console.log("dev-guard update");
  console.log("");
  console.log(`Mode: ${options.write ? "write" : "preview"}`);
  console.log(`Summary: ${suggestions.summary}`);
  console.log("");

  console.log("Docs Update Preview:");
  printDocSummary(targetDocs.projectStateSuggestion, suggestions.projectStateSuggestion);
  printDocSummary(targetDocs.currentTaskSuggestion, suggestions.currentTaskSuggestion);
  printDocSummary(targetDocs.decisionsSuggestion, suggestions.decisionsSuggestion);
  printDocSummary(targetDocs.doNotRepeatSuggestion, suggestions.doNotRepeatSuggestion);
  console.log("");

  if (!options.write) {
    console.log("No files were modified.");
    console.log("Apply:");
    console.log("  dev-guard update --write");
  } else {
    console.log("Updated managed dev-guard blocks. User-written content outside the markers was preserved.");
  }
}

function printDocSummary(path: string, suggestion: string): void {
  const items = extractActionItems(suggestion);
  console.log(`- ${path}`);
  for (const item of items.slice(0, 4)) {
    console.log(`  - ${item}`);
  }
  if (items.length > 4) {
    console.log(`  - ... ${items.length - 4} more`);
  }
  if (items.length === 0) {
    console.log("  - No notable candidate inferred.");
  }
}

function extractActionItems(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const headings = new Set([
    "### State notes",
    "### Remaining review",
    "### Decision candidates",
    "### Cautions",
    "### Repeat prevention candidates",
    "### Rule hygiene candidates",
    "### Task reference",
    "### Run reference"
  ]);
  const ignoredPrefixes = ["- Date/time:", "- .gitignore", "- package.json", "- README.md"];
  const items: string[] = [];
  let inRelevantSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("### ")) {
      inRelevantSection = headings.has(line);
      continue;
    }
    if (!inRelevantSection || !line.startsWith("- ")) {
      continue;
    }
    if (ignoredPrefixes.some((prefix) => line.startsWith(prefix))) {
      continue;
    }
    items.push(line.slice(2));
  }

  return [...new Set(items)];
}
