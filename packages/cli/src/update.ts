import { generateUpdateSuggestions } from "@dev-guard/core";
import { fromRoot, readTextFile, writeTextFile } from "./fs.js";
import { getGitChanges } from "./git.js";
import { loadCurrentProjectIdentity, sameProjectIdentity } from "./project-identity.js";
import { readLatestRun } from "./runs.js";

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
  const [gitChanges, taskMarkdown, rulesMarkdown, mistakesMarkdown, runLog, identity] = await Promise.all([
    getGitChanges(root),
    readTextFile(fromRoot(root, ".devguard/task.md")),
    readTextFile(fromRoot(root, ".devguard/rules.md")),
    readTextFile(fromRoot(root, ".devguard/mistakes.md")),
    readLatestRun(root),
    loadCurrentProjectIdentity(root).catch(() => undefined)
  ]);
  const matchedRunLog = runLog && identity && runLog.projectIdentity && sameProjectIdentity(identity, runLog.projectIdentity) ? runLog : undefined;
  if (runLog && !matchedRunLog) {
    console.error("dev-guard update: warning: latest run project identity mismatch; ignoring run context.");
  }

  if (gitChanges.changeFiles.length === 0 && !gitChanges.diffText.trim()) {
    console.log("dev-guard update");
    console.log("");
    console.log("변경 사항 없음");
    return;
  }

  const suggestions = generateUpdateSuggestions({
    changedFiles: gitChanges.changedFiles,
    changeFiles: gitChanges.changeFiles,
    diffText: gitChanges.diffText,
    taskMarkdown,
    rulesMarkdown,
    mistakesMarkdown,
    includeContextFiles: options.includeContextFiles,
    runLog: matchedRunLog
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

  console.log(`# ${targetDocs.projectStateSuggestion}`);
  console.log(suggestions.projectStateSuggestion);
  console.log(`# ${targetDocs.currentTaskSuggestion}`);
  console.log(suggestions.currentTaskSuggestion);
  console.log(`# ${targetDocs.decisionsSuggestion}`);
  console.log(suggestions.decisionsSuggestion);
  console.log(`# ${targetDocs.doNotRepeatSuggestion}`);
  console.log(suggestions.doNotRepeatSuggestion);

  if (!options.write) {
    console.log("No files were modified. Re-run with --write to append these suggestions.");
  } else {
    console.log("Updated managed dev-guard blocks. User-written content outside the markers was preserved.");
  }
}
