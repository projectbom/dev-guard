import { analyzeGeneratedDiffDrift, scoreWorkflowQuality } from "@dev-guard/core";
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { runCheck } from "./check.js";
import { loadConfig } from "./config.js";
import { fromRoot, readTextFile } from "./fs.js";
import { getGitChanges } from "./git.js";
import { refreshProjectMemory } from "./refresh.js";
import { runReview } from "./review.js";

interface WatchOptions {
  check: boolean;
  review: boolean;
  once: boolean;
  debounceMs: number;
}

const defaultDebounceMs = 800;
const pollIntervalMs = 500;
const watchRoots = ["app", "components", "lib", "hooks", "utils", "constants", "styles", "supabase", "src", "packages"];
const watchRootFiles = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  ".devguard/task.md",
  ".devguard/rules.md",
  ".devguard/mistakes.md",
  ".devguard/config.json",
  ".devguardrc",
  "devguard.config.json",
  "docs/PROJECT_STATE.md",
  "docs/CURRENT_TASK.md",
  "docs/DECISIONS.md",
  "docs/DO_NOT_REPEAT.md"
];
const ignoredDirectoryNames = new Set(["node_modules", ".next", "dist", "build", "coverage", ".git"]);
const ignoredExactFiles = new Set([
  ".devguard/project-index.json",
  ".devguard/file-summaries.json",
  ".devguard/code-graph.json",
  ".devguard/project-map.md",
  ".devguard/project-identity.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock"
]);
const ignoredBinaryExtensions = /\.(png|jpe?g|gif|webp|avif|ico|svg|ttf|otf|woff2?|mp4|mov|mp3|wav|pdf|zip|gz|tar|br|wasm)$/i;
const ignoredCacheExtensions = /\.(tsbuildinfo|tmp|temp)$/i;

export async function runWatch(root: string, args: string[]): Promise<void> {
  const options = parseWatchOptions(args);

  if (options.once) {
    console.log("dev-guard watch --once");
    printWatchStartup(options);
    await runWatchCycle(root, options, []);
    return;
  }

  console.log("dev-guard watch started");
  printWatchStartup(options);

  const state = {
    snapshot: await scanWatchedFiles(root),
    pendingChanges: new Set<string>(),
    timer: undefined as NodeJS.Timeout | undefined,
    running: false,
    rerunRequested: false,
    configSignature: await loadConfigSignature(root)
  };

  const scheduleCycle = () => {
    if (state.timer) {
      clearTimeout(state.timer);
    }

    state.timer = setTimeout(async () => {
      if (state.running) {
        state.rerunRequested = true;
        console.log("refresh already running -> merge pending changes");
        return;
      }

      const changed = [...state.pendingChanges].sort();
      state.pendingChanges.clear();
      state.running = true;
      try {
        state.configSignature = await maybeReloadConfig(root, changed, state.configSignature);
        await runWatchCycle(root, options, changed);
        state.snapshot = await scanWatchedFiles(root);
      } catch (error) {
        console.error(`dev-guard watch: warning: ${errorMessage(error)}`);
      } finally {
        state.running = false;
        if (state.rerunRequested || state.pendingChanges.size > 0) {
          state.rerunRequested = false;
          scheduleCycle();
        }
      }
    }, options.debounceMs);
  };

  const interval = setInterval(async () => {
    try {
      const nextSnapshot = await scanWatchedFiles(root);
      const changed = diffSnapshots(state.snapshot, nextSnapshot);
      state.snapshot = nextSnapshot;

      if (changed.length === 0) {
        return;
      }

      for (const path of changed) {
        state.pendingChanges.add(path);
      }
      scheduleCycle();
    } catch (error) {
      console.error(`dev-guard watch: warning: ${errorMessage(error)}`);
    }
  }, pollIntervalMs);

  process.on("SIGINT", () => {
    clearInterval(interval);
    console.log("\ndev-guard watch stopped");
    process.exit(0);
  });

  await new Promise<void>(() => {
    // Keep the process alive until SIGINT.
  });
}

function printWatchStartup(options: WatchOptions): void {
  console.log(`watching directories: ${watchRoots.join(", ")}`);
  console.log(`watching root/context files: ${watchRootFiles.join(", ")}`);
  console.log("excluded: node_modules, .git, .next, dist, build, coverage, lockfiles, binary assets, .devguard cache files");
  console.log("action: auto-refresh project memory only; user docs/source files are not overwritten");
  console.log(`debounce: ${options.debounceMs}ms`);
  console.log("stop: press Ctrl+C");
  if (options.check) {
    console.log("after refresh: dev-guard check");
  }
  if (options.review) {
    console.log("after refresh: dev-guard review (AI provider may incur API cost; falls back to heuristic when provider=none)");
  }
}

function parseWatchOptions(args: string[]): WatchOptions {
  const debounceIndex = args.indexOf("--debounce");
  const debounceValue = debounceIndex >= 0 ? Number(args[debounceIndex + 1]) : defaultDebounceMs;
  if (!Number.isFinite(debounceValue) || debounceValue <= 0) {
    throw new Error("dev-guard watch --debounce requires a positive millisecond value.");
  }

  return {
    check: args.includes("--check"),
    review: args.includes("--review"),
    once: args.includes("--once"),
    debounceMs: debounceValue
  };
}

async function runWatchCycle(root: string, options: WatchOptions, changedPaths: string[]): Promise<void> {
  if (changedPaths.length > 0) {
    console.log(`changed: ${changedPaths.join(", ")}`);
  } else {
    console.log("changed: none (single-run refresh)");
  }

  console.log("running: dev-guard refresh");
  const result = await refreshProjectMemory(root, {
    full: false,
    ai: false,
    dryRun: false
  });

  console.log(`refresh complete: updated ${result.updatedPaths.length}, removed ${result.removedPaths.length}, skipped ${result.unchangedCount}`);
  console.log("writes: .devguard project memory cache only");

  if (options.check) {
    console.log("running: dev-guard check");
    await runCheck(root, { includeContextFiles: false });
  } else {
    await printWatchDriftSummary(root);
  }

  if (options.review) {
    try {
      console.log("running: dev-guard review");
      await runReview(root, ["--heuristic"]);
    } catch (error) {
      console.error(`dev-guard watch: review skipped: ${errorMessage(error)}`);
    }
  }

  if (!options.check && !options.review) {
    console.log("next: run dev-guard check before commit");
  }
}

async function printWatchDriftSummary(root: string): Promise<void> {
  try {
    const [changes, taskMarkdown] = await Promise.all([
      getGitChanges(root),
      readTextFile(fromRoot(root, ".devguard/task.md"))
    ]);
    const drift = analyzeGeneratedDiffDrift({
      requirementText: taskMarkdown,
      taskMarkdown,
      diffText: changes.diffText,
      changedFiles: changes.changedFiles,
      changeFiles: changes.changeFiles
    });
    if (drift.severity === "low") {
      console.log("drift: no suspicious drift detected by local heuristic");
      return;
    }
    const quality = scoreWorkflowQuality({
      drift,
      changedFiles: changes.changedFiles,
      diffText: changes.diffText,
      changeFiles: changes.changeFiles
    });
    console.log("possible drift detected:");
    console.log(`- severity: ${drift.severity}`);
    console.log(`- requirement alignment: ${quality.requirementAlignment}`);
    console.log(`- drift risk: ${quality.driftRisk}`);
    console.log(`- reasons: ${drift.reasons.slice(0, 3).join("; ") || "domain/zone mismatch"}`);
    console.log("next: run dev-guard check --local or dev-guard review --heuristic");
  } catch (error) {
    console.error(`dev-guard watch: drift summary skipped: ${errorMessage(error)}`);
  }
}

async function maybeReloadConfig(root: string, changedPaths: string[], previousSignature: string): Promise<string> {
  if (!changedPaths.some(isConfigPath)) {
    return previousSignature;
  }
  const nextSignature = await loadConfigSignature(root);
  if (nextSignature === previousSignature) {
    return previousSignature;
  }
  try {
    const resolved = await loadConfig(root);
    if (resolved.warnings.length > 0) {
      console.error(`dev-guard watch: invalid config; keeping previous settings (${resolved.warnings.join("; ")})`);
      return previousSignature;
    }
    console.log("config changed -> reloading provider settings");
    console.log(`provider: ${resolved.config.ai?.provider ?? "none"}`);
    console.log(`model: ${resolved.config.ai?.model ?? "gpt-4o-mini"}`);
    console.log(`config source: ${resolved.source}`);
    return nextSignature;
  } catch (error) {
    console.error(`dev-guard watch: invalid config; keeping previous settings (${errorMessage(error)})`);
    return previousSignature;
  }
}

async function loadConfigSignature(root: string): Promise<string> {
  const parts = await Promise.all(
    [".devguard/config.json", ".devguardrc", "devguard.config.json", "package.json"].map(async (path) => {
      try {
        const metadata = await stat(resolve(root, path));
        return `${path}:${metadata.mtimeMs}:${metadata.size}`;
      } catch {
        return `${path}:missing`;
      }
    })
  );
  return parts.join("|");
}

async function scanWatchedFiles(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();

  for (const watchRoot of watchRoots) {
    const absoluteRoot = resolve(root, watchRoot);
    if (await isDirectory(absoluteRoot)) {
      await collectFileSnapshot(root, absoluteRoot, snapshot);
    }
  }

  await collectRootFileSnapshot(root, snapshot);

  return snapshot;
}

async function collectRootFileSnapshot(root: string, snapshot: Map<string, string>): Promise<void> {
  await Promise.all(
    watchRootFiles.map(async (path) => {
      if (!isWatchableRootFile(path)) {
        return;
      }
      try {
        const metadata = await stat(resolve(root, path));
        if (metadata.isFile()) {
          snapshot.set(path, `${metadata.mtimeMs}:${metadata.size}`);
        }
      } catch {
        // Missing optional context files are ignored until they appear.
      }
    })
  );
}

async function collectFileSnapshot(root: string, directory: string, snapshot: Map<string, string>): Promise<void> {
  const relativeDirectory = normalizePath(relative(root, directory));
  if (relativeDirectory && isIgnoredDirectoryPath(relativeDirectory)) {
    return;
  }

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = join(directory, entry.name);
      const relativePath = normalizePath(relative(root, absolutePath));

      if (entry.isDirectory()) {
        await collectFileSnapshot(root, absolutePath, snapshot);
        return;
      }

      if (!entry.isFile() || !isWatchablePath(relativePath)) {
        return;
      }

      try {
        const metadata = await stat(absolutePath);
        snapshot.set(relativePath, `${metadata.mtimeMs}:${metadata.size}`);
      } catch {
        // File may have changed between readdir and stat; the next poll will see it.
      }
    })
  );
}

function diffSnapshots(previous: Map<string, string>, next: Map<string, string>): string[] {
  const changed = new Set<string>();

  for (const [path, signature] of next.entries()) {
    if (previous.get(path) !== signature) {
      changed.add(path);
    }
  }

  for (const path of previous.keys()) {
    if (!next.has(path)) {
      changed.add(path);
    }
  }

  return [...changed].sort();
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isWatchablePath(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized || !watchRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`))) {
    return false;
  }

  if (
    isIgnoredDirectoryPath(normalized) ||
    ignoredExactFiles.has(normalized) ||
    isLockfilePath(normalized) ||
    ignoredBinaryExtensions.test(normalized) ||
    ignoredCacheExtensions.test(normalized)
  ) {
    return false;
  }

  return true;
}

function isWatchableRootFile(path: string): boolean {
  const normalized = normalizePath(path);
  return (
    watchRootFiles.includes(normalized) &&
    !ignoredExactFiles.has(normalized) &&
    !isLockfilePath(normalized) &&
    !ignoredBinaryExtensions.test(normalized)
  );
}

function isIgnoredDirectoryPath(path: string): boolean {
  const parts = normalizePath(path).split("/");
  if (parts.some((part) => ignoredDirectoryNames.has(part))) {
    return true;
  }

  return path.startsWith(".devguard/runs/");
}

function normalizePath(path: string): string {
  return path.split("\\").join("/").replace(/^\.\//, "");
}

function isLockfilePath(path: string): boolean {
  const fileName = path.split("/").at(-1);
  return fileName === "pnpm-lock.yaml" || fileName === "package-lock.json" || fileName === "yarn.lock";
}

function isConfigPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === ".devguard/config.json" || normalized === ".devguardrc" || normalized === "devguard.config.json" || normalized === "package.json";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
