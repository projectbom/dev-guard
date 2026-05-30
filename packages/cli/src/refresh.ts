import {
  buildProjectScan,
  refreshProjectScan,
  type CodeGraphEntry,
  type DevGuardConfig,
  type FileSummary,
  type ProjectIndexEntry
} from "@dev-guard/core";
import { writeAIContext } from "./ai-context.js";
import { loadConfig } from "./config.js";
import { fileMetadata, fromRoot, readJsonFile, writeTextFile } from "./fs.js";
import { getGitChanges, getProjectFiles } from "./git.js";
import { fileExists, readFileHash, readScanInputFile } from "./project-memory.js";
import { loadCurrentProjectIdentity, writeProjectIdentity } from "./project-identity.js";

export interface RefreshOptions {
  full: boolean;
  ai: boolean;
  dryRun: boolean;
}

export interface RefreshResult {
  mode: "incremental" | "full";
  ai: boolean;
  dryRun: boolean;
  updatedPaths: string[];
  removedPaths: string[];
  unchangedCount: number;
}

export async function runRefresh(root: string, args: string[]): Promise<void> {
  const options = parseRefreshOptions(args);
  const result = await refreshProjectMemory(root, options);
  printRefreshPlan(result);
}

export async function refreshProjectMemory(root: string, options: RefreshOptions): Promise<RefreshResult> {
  const resolvedConfig = await loadConfig(root);
  const config = resolvedConfig.config;
  for (const warning of resolvedConfig.warnings) {
    console.error(`dev-guard refresh: warning: ${warning}`);
  }
  const [existingIndex, existingSummaries, existingCodeGraph] = await Promise.all([
    readJsonFile<ProjectIndexEntry[]>(fromRoot(root, ".devguard/project-index.json"), []),
    readJsonFile<FileSummary[]>(fromRoot(root, ".devguard/file-summaries.json"), []),
    readJsonFile<CodeGraphEntry[]>(fromRoot(root, ".devguard/code-graph.json"), [])
  ]);

  if (options.full || existingIndex.length === 0 || existingCodeGraph.length === 0) {
    return runFullRefresh(root, options, config);
  }

  const [gitChanges, projectFiles] = await Promise.all([getGitChanges(root), getProjectFiles(root)]);
  const projectFileSet = new Set(projectFiles);
  const changedPaths = new Set<string>();
  const removedPaths = new Set<string>();

  for (const change of gitChanges.changeFiles) {
    if (change.oldPath) {
      removedPaths.add(change.oldPath);
    }

    if (change.status === "deleted") {
      removedPaths.add(change.path);
      continue;
    }

    if (projectFileSet.has(change.path)) {
      changedPaths.add(change.path);
    }
  }

  let unchangedCount = 0;
  for (const entry of existingIndex) {
    if (removedPaths.has(entry.path)) {
      continue;
    }

    if (!(await fileExists(root, entry.path))) {
      removedPaths.add(entry.path);
      continue;
    }

    if (changedPaths.has(entry.path)) {
      continue;
    }

    const metadata = await fileMetadata(fromRoot(root, entry.path));
    const hash = await readFileHash(root, entry.path);
    if (entry.lastModified !== metadata.lastModified || entry.hash !== hash) {
      changedPaths.add(entry.path);
    } else {
      unchangedCount += 1;
    }
  }

  const updatedPaths = [...changedPaths].filter((path) => projectFileSet.has(path)).sort();
  const removed = [...removedPaths].sort();

  const result: RefreshResult = {
    mode: "incremental",
    ai: options.ai && config.ai?.provider !== "none",
    dryRun: options.dryRun,
    updatedPaths,
    removedPaths: removed,
    unchangedCount
  };

  if (options.dryRun) {
    return result;
  }

  const updatedFiles = await Promise.all(updatedPaths.map((path) => readScanInputFile(root, path)));
  const refreshed = refreshProjectScan({
    existingIndex,
    existingSummaries,
    existingCodeGraph,
    updatedFiles,
    removedPaths: removed
  });

  await writeMemoryFiles(root, refreshed.index, refreshed.summaries, refreshed.projectMapMarkdown, refreshed.codeGraph);
  await writeAIContext(root).catch(() => undefined);
  return result;
}

function parseRefreshOptions(args: string[]): RefreshOptions {
  return {
    full: args.includes("--full"),
    ai: args.includes("--ai"),
    dryRun: args.includes("--dry-run")
  };
}

async function runFullRefresh(root: string, options: RefreshOptions, config: DevGuardConfig): Promise<RefreshResult> {
  const projectFiles = await getProjectFiles(root);
  const inputFiles = await Promise.all(projectFiles.map((path) => readScanInputFile(root, path)));
  const scan = buildProjectScan(inputFiles);

  const result: RefreshResult = {
    mode: "full",
    ai: options.ai && config.ai?.provider !== "none",
    dryRun: options.dryRun,
    updatedPaths: scan.index.map((entry) => entry.path),
    removedPaths: [],
    unchangedCount: 0
  };

  if (options.dryRun) {
    return result;
  }

  await writeMemoryFiles(root, scan.index, scan.summaries, scan.projectMapMarkdown, scan.codeGraph);
  await writeAIContext(root).catch(() => undefined);
  return result;
}

async function writeMemoryFiles(
  root: string,
  index: ProjectIndexEntry[],
  summaries: FileSummary[],
  projectMapMarkdown: string,
  codeGraph: CodeGraphEntry[]
): Promise<void> {
  const identity = await loadCurrentProjectIdentity(root, index.map((entry) => entry.path));
  await Promise.all([
    writeTextFile(fromRoot(root, ".devguard/project-index.json"), `${JSON.stringify(index, null, 2)}\n`),
    writeTextFile(fromRoot(root, ".devguard/file-summaries.json"), `${JSON.stringify(summaries, null, 2)}\n`),
    writeTextFile(fromRoot(root, ".devguard/code-graph.json"), `${JSON.stringify(codeGraph, null, 2)}\n`),
    writeTextFile(fromRoot(root, ".devguard/project-map.md"), projectMapMarkdown),
    writeProjectIdentity(root, identity)
  ]);
}

function printRefreshPlan(plan: {
  mode: "incremental" | "full";
  ai: boolean;
  dryRun: boolean;
  updatedPaths: string[];
  removedPaths: string[];
  unchangedCount: number;
}): void {
  console.log("dev-guard refresh");
  console.log(`- mode: ${plan.mode}`);
  console.log(`- dry-run: ${plan.dryRun ? "yes" : "no"}`);
  console.log(`- summaries: ${plan.ai ? "rule-based (AI summary hook reserved)" : "rule-based"}`);
  console.log(`- updated summaries: ${plan.updatedPaths.length}`);
  console.log(`- removed summaries: ${plan.removedPaths.length}`);
  console.log(`- unchanged files skipped: ${plan.unchangedCount}`);
  console.log("- writes: .devguard/project-index.json, .devguard/file-summaries.json, .devguard/code-graph.json, .devguard/project-map.md, .devguard/project-identity.json, .devguard/AI_CONTEXT.md");
  console.log("- reason: keep project memory current for task-ai/review/report");

  if (plan.updatedPaths.length > 0) {
    console.log(`- updated files: ${plan.updatedPaths.join(", ")}`);
  }

  if (plan.removedPaths.length > 0) {
    console.log(`- removed files: ${plan.removedPaths.join(", ")}`);
  }

  if (plan.updatedPaths.length === 0 && plan.removedPaths.length === 0) {
    console.log("- skipped: no changed project files detected");
  }

  console.log("- next: run dev-guard check or dev-guard report");
}
