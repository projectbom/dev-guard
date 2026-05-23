import { filterDevGuardContextFiles, generateCodexPrompt } from "@dev-guard/core";
import { copyTextToClipboard } from "./clipboard.js";
import { fromRoot, readTextFile, writeTextFile } from "./fs.js";
import { getGitChanges } from "./git.js";
import { loadCurrentProjectIdentity } from "./project-identity.js";
import { filterRelevantMarkdown } from "./rule-filter.js";
import { createRunLog, logRunSaved, upsertLatestRun } from "./runs.js";

interface PromptOptions {
  copy: boolean;
  compact: boolean;
  ultraCompact: boolean;
  density?: "ultra" | "compact" | "verbose";
  includeContextFiles: boolean;
  saveRun: boolean;
  maxPromptTokens?: number;
  output?: string;
}

interface MarkdownReadResult {
  path: string;
  content: string;
  missing: boolean;
}

export async function runPrompt(root: string, options: PromptOptions): Promise<void> {
  const [gitChanges, task, rules, mistakes, projectState, decisions, identity] = await Promise.all([
    getGitChanges(root),
    readMarkdown(root, ".devguard/task.md"),
    readMarkdown(root, ".devguard/rules.md"),
    readMarkdown(root, ".devguard/mistakes.md"),
    readMarkdown(root, "docs/PROJECT_STATE.md"),
    readMarkdown(root, "docs/DECISIONS.md"),
    loadCurrentProjectIdentity(root).catch(() => undefined)
  ]);

  const missingFiles = [task, rules, mistakes, projectState, decisions].filter((result) => result.missing);
  for (const file of missingFiles) {
    console.error(`dev-guard warning: ${file.path} not found; using empty content.`);
  }

  const relevanceText = [task.content, gitChanges.changedFiles.join("\n"), projectState.content, decisions.content].join("\n");
  const filteredRules = filterRelevantMarkdown(rules.content, relevanceText, identity);
  const filteredMistakes = filterRelevantMarkdown(mistakes.content, relevanceText, identity);
  const prompt = generateCodexPrompt({
    taskMarkdown: task.content,
    rulesMarkdown: filteredRules.filteredMarkdown,
    mistakesMarkdown: filteredMistakes.filteredMarkdown,
    projectStateMarkdown: projectState.content,
    decisionsMarkdown: decisions.content,
    changedFiles: gitChanges.changedFiles,
    changeFiles: gitChanges.changeFiles,
    diffText: gitChanges.diffText,
    compact: options.compact,
    ultraCompact: options.ultraCompact,
    density: options.density,
    maxPromptTokens: options.maxPromptTokens,
    includeContextFiles: options.includeContextFiles
  });

  if (options.output) {
    await writeTextFile(fromRoot(root, options.output), prompt.promptText);
    console.error(`dev-guard prompt: wrote ${options.output}`);
  }

  if (options.copy) {
    const result = await copyTextToClipboard(prompt.promptText);
    if (result.ok) {
      console.error("dev-guard prompt: copied to clipboard.");
    } else {
      console.error(`dev-guard prompt: clipboard copy failed (${result.reason}). Printing prompt to stdout instead.`);
    }
  }

  if (options.saveRun || options.copy || options.output) {
    const save = options.saveRun ? createRunLog : upsertLatestRun;
    const relatedChangeFiles = filterDevGuardContextFiles(gitChanges.changeFiles, options.includeContextFiles);
    const relatedFiles = [...new Set(relatedChangeFiles.map((file) => file.path))].sort();
    const run = await save(root, {
      command: "prompt",
      userRequest: options.saveRun ? "Generated Codex prompt from current dev-guard context." : undefined,
      generatedTaskMarkdown: task.content,
      generatedCodexPrompt: prompt.promptText,
      relatedFiles,
      changedFilesAtCreation: relatedFiles,
      projectIdentity: identity,
      status: "created"
    });
    logRunSaved(run);
  }

  console.log(prompt.promptText);
}

export function parsePromptOptions(args: string[]): PromptOptions {
  const options: PromptOptions = {
    copy: args.includes("--copy"),
    compact: true,
    ultraCompact: args.includes("--ultra-compact"),
    density: parseDensityOption(args),
    includeContextFiles: args.includes("--include-context-files"),
    saveRun: args.includes("--save-run"),
    maxPromptTokens: parseNumberOption(args, "--max-prompt-tokens")
  };
  const outputIndex = args.indexOf("--output");

  if (outputIndex >= 0) {
    const output = args[outputIndex + 1];
    if (!output || output.startsWith("--")) {
      throw new Error("dev-guard prompt --output 옵션에는 파일 경로가 필요합니다.");
    }

    options.output = output;
  }

  return options;
}

function parseDensityOption(args: string[]): PromptOptions["density"] {
  const index = args.indexOf("--density");
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (value !== "ultra" && value !== "compact" && value !== "verbose") {
    throw new Error("dev-guard prompt --density 옵션은 ultra, compact, verbose 중 하나여야 합니다.");
  }
  return value;
}

function parseNumberOption(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`dev-guard prompt ${flag} 옵션에는 양수 값이 필요합니다.`);
  }
  return value;
}

async function readMarkdown(root: string, path: string): Promise<MarkdownReadResult> {
  const sentinel = "\0__DEV_GUARD_MISSING__\0";
  const content = await readTextFile(fromRoot(root, path), sentinel);
  return {
    path,
    content: content === sentinel ? "" : content,
    missing: content === sentinel
  };
}
