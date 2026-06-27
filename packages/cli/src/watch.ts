import { existsSync, watch as fsWatch } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureDevguardWorkspace,
  hashRuntimeFiles,
  isIgnoredWatchPath,
  markRuntimeStable,
  readProjectState,
  readRuntimeState,
  recordRuntimeChange,
  resetRuntimeState,
  writeRuntimeState
} from "./runtime-state.js";
import { getHookStatus } from "./hooks.js";
import { DEVGUARD_DIR, devguardPaths } from "./paths.js";
import { getAgentStrategyReport } from "./agent-strategies.js";
import { formatWatchDashboard, formatWatchDashboardKey } from "./watch-format.js";

type WatchStatus = "idle" | "active" | "ready_for_done" | "processed";

interface WatchOptions {
  stableAfterMs: number;
  compact: boolean;
  depth: number;
  poll: boolean;
  includeLockfiles: boolean;
  manual: boolean;
}

const watchRoots = ["app", "components", "lib", "hooks", "utils", "constants", "styles", "supabase", "src", "packages", "docs", DEVGUARD_DIR];
const excludedSummary = `node_modules/**, .git/**, dist/**, build/**, .next/**, coverage/**, ${devguardPaths.runtime}, ${devguardPaths.state}, ${devguardPaths.history}, ${devguardPaths.reportsDir}/**, ${devguardPaths.promptsDir}/**, ${devguardPaths.logsDir}/**, ${devguardPaths.hooksDir}/**`;

export async function runWatch(root: string, args: string[]): Promise<void> {
  await ensureDevguardWorkspace(root);
  const options = parseWatchOptions(args);
  const hookStatus = await getHookStatus(root);
  const strategyReport = await getAgentStrategyReport(root);
  const claudeHookInstalled = hookStatus.claudeInstalled && hookStatus.claudeHookFile;
  const codexHookInstalled = hookStatus.codexInstalled && hookStatus.codexHookFile;
  const runtimeVerified = strategyReport.strategies.some((strategy) => strategy.name !== "manual" && strategy.runtimeVerified);
  const autoStrategyInstalled = strategyReport.strategies.some((strategy) => strategy.name !== "manual" && strategy.installed);
  const autoMode = !options.manual && autoStrategyInstalled;
  console.log("dev-guard watch");
  console.log(`Mode: ${autoMode ? "Auto Mode" : "Manual Mode"}`);
  console.log("Auto completion strategy:");
  console.log(`Claude: Stop Hook ${strategyReport.claude.installed ? "installed" : "not installed"}; runtime verified: ${strategyReport.claude.runtimeVerified ? "yes" : "no"}`);
  console.log(`Codex: Notify recommended (${strategyReport.codexNotify.installed ? "installed" : "not installed"}); Stop Hook ${codexHookInstalled ? "installed" : "not installed"}${strategyReport.codexStopHook.requiresUserTrust ? " but requires /hooks trust" : ""}`);
  console.log(`Runtime verified: ${runtimeVerified ? "yes" : "no"}`);
  console.log(`Fallback: dev-guard done`);
  console.log(`Done trigger: ${autoMode ? "verified agent strategy when runtime calls it" : "manual dev-guard done"}`);
  if (autoMode) {
    console.log("");
    console.log("Watching for file changes...");
    console.log(runtimeVerified ? "When the verified agent completion strategy fires, dev-guard done will run automatically." : "Automatic completion is installed but runtime verification is still required.");
  } else {
    console.log("");
    console.log("Watching for file changes...");
    console.log("Tip:");
    console.log(options.manual ? "Manual Mode enabled; run dev-guard done when the AI task is finished." : "Run dev-guard install-hooks to enable Auto Mode.");
  }
  console.log("");
  console.log(`watching: ${watchRoots.filter((path) => existsSync(join(root, path))).join(", ") || "."}`);
  console.log(`excluded: ${excludedSummary}`);
  console.log(`depth: ${options.depth}; poll: ${options.poll ? "on" : "off"}; lockfiles: ${options.includeLockfiles ? "included" : "excluded"}; manual: ${options.manual ? "on" : "off"}`);
  console.log("mode: event-driven; no periodic refresh; no idle-time completion");
  console.log("stop: Ctrl+C");

  await startWatchSession(root);

  let status: WatchStatus = "idle";
  let stableTimer: NodeJS.Timeout | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let lastPrintedKey = "";
  let lastTransitionKey = "";
  let lastSeenProcessedAt = (await readProjectState(root)).lastProcessedAt;

  const printState = async (nextStatus: WatchStatus) => {
    const runtime = await readRuntimeState(root);
    const projectState = await readProjectState(root);
    const dashboard = formatWatchDashboard(runtime, {
      autoMode,
      manual: options.manual,
      runtimeVerified
    });
    const key = `${nextStatus}:${formatWatchDashboardKey(runtime, {
      autoMode,
      manual: options.manual,
      runtimeVerified
    })}:${projectState.lastProcessedAt ?? "none"}:${projectState.lastQualityVerdict ?? "unknown"}`;
    if (key === lastPrintedKey) {
      return;
    }
    lastPrintedKey = key;
    status = nextStatus;
    console.log("");
    const transitionKey = `${dashboard.transition}:${runtime.changeCountSinceIdle ?? 0}:${runtime.pendingChangedFiles.length}`;
    if (transitionKey !== lastTransitionKey) {
      console.log(dashboard.transition);
      console.log("");
      lastTransitionKey = transitionKey;
    }
    console.log(dashboard.lines.join("\n"));
  };

  const refreshExternalDoneState = async () => {
    const [runtime, projectState] = await Promise.all([readRuntimeState(root), readProjectState(root)]);
    const processedAt = projectState.lastProcessedAt;
    if (!processedAt || processedAt === lastSeenProcessedAt) {
      return;
    }
    const pendingIsStale = runtime.pendingChangedFiles.length === 0 || (await allPendingFilesAtOrBefore(root, runtime.pendingChangedFiles, processedAt));
    if (pendingIsStale) {
      lastSeenProcessedAt = processedAt;
      clearTimeout(stableTimer);
      if (runtime.pendingChangedFiles.length > 0 || (runtime.lastStatus ?? "idle") !== "idle") {
        await resetRuntimeState(root);
      }
      await startWatchSession(root);
      lastPrintedKey = "";
      status = "processed";
      console.log("");
      console.log("Completion processed");
      console.log("DONE: agent completion processed changes");
      console.log(`Last processed: ${processedAt}`);
      console.log(`Quality: ${projectState.lastQualityVerdict ?? "unknown"}`);
      console.log(`NEXT: ${projectState.lastQualityVerdict && projectState.lastQualityVerdict !== "PASS" ? `review ${devguardPaths.qualityReport}` : "keep editing"}`);
      await printState("idle");
    }
  };

  const handleChange = async (path: string) => {
    if (!path) {
      return;
    }
    if (isWatchUiRefreshPath(path)) {
      await refreshExternalDoneState();
      return;
    }
    if (isIgnoredWatchPath(path) || isLockfilePath(path, options)) {
      return;
    }
    try {
      const projectState = await readProjectState(root);
      if (projectState.lastProcessedAt && (await pathMtimeAtOrBefore(root, path, projectState.lastProcessedAt))) {
        await refreshExternalDoneState();
        return;
      }
      clearTimeout(stableTimer);
      const runtime = await recordRuntimeChange(root, path, { idleAfterMs: options.stableAfterMs });
      await printState("active");
      stableTimer = setTimeout(async () => {
        try {
          const latest = await readRuntimeState(root);
          const projectState = await readProjectState(root);
          if (projectState.lastProcessedAt && latest.lastChangedAt && Date.parse(latest.lastChangedAt) <= Date.parse(projectState.lastProcessedAt)) {
            console.warn("watch warning: stale stable write skipped after external done");
            await resetRuntimeState(root);
            await refreshExternalDoneState();
            return;
          }
          await markRuntimeStable(root, hashRuntimeFiles(latest.pendingChangedFiles));
          await printState(latest.pendingChangedFiles.length > 0 ? "ready_for_done" : "idle");
        } catch (error) {
          console.error(`watch warning: ${errorMessage(error)}`);
        }
      }, options.stableAfterMs);
      if (!options.compact) {
        console.log(`event: ${path}; pending=${runtime.pendingChangedFiles.length}; idle_timer=reset`);
      }
    } catch (error) {
      console.error(`watch warning: ${errorMessage(error)}`);
      console.error("recovery: fix the file issue or run dev-guard reset");
    }
  };

  let eventQueue = Promise.resolve();
  const enqueueChange = (path: string) => {
    eventQueue = eventQueue
      .then(() => handleChange(path))
      .catch((error) => {
        console.error(`watch warning: ${errorMessage(error)}`);
      });
  };

  const watcher = await createWatcher(root, enqueueChange, options);
  await printState(status);
  refreshTimer = setInterval(() => {
    void (async () => {
      await refreshExternalDoneState();
      const runtime = await readRuntimeState(root);
      if ((runtime.lastStatus ?? "idle") === "active") {
        await printState("active");
      }
    })().catch((error) => {
      console.error(`watch warning: ${errorMessage(error)}`);
    });
  }, 1000);

  process.on("SIGINT", async () => {
    await closeWatcher(watcher);
    clearTimeout(stableTimer);
    clearInterval(refreshTimer);
    console.log("\ndev-guard watch stopped");
    process.exit(0);
  });

  await new Promise<void>(() => {
    // Keep process alive until SIGINT.
  });
}

function parseWatchOptions(args: string[]): WatchOptions {
  const stableAfterSec = readNumberOption(args, "--stable-after", 20);
  const depth = readNumberOption(args, "--depth", 8);
  if (stableAfterSec <= 0) {
    throw new Error("dev-guard watch --stable-after must be positive.");
  }
  if (depth < 1) {
    throw new Error("dev-guard watch --depth must be 1 or greater.");
  }
  return {
    stableAfterMs: stableAfterSec * 1000,
    compact: args.includes("--compact") || args.includes("--ultra"),
    depth,
    poll: args.includes("--poll"),
    includeLockfiles: args.includes("--include-lockfiles"),
    manual: args.includes("--manual") || args.includes("--no-auto")
  };
}

async function createWatcher(root: string, onChange: (path: string) => Promise<void> | void, options: WatchOptions): Promise<unknown> {
  const existingRoots = watchRoots.map((path) => join(root, path)).filter((path) => existsSync(path));
  const paths = existingRoots.length > 0 ? existingRoots : [root];
  const chokidar = await loadChokidar();
  if (chokidar?.watch) {
    const watcher = chokidar.watch(paths, {
      ignoreInitial: true,
      ignored: (path: string) => {
        const normalized = path.replace(`${root}/`, "");
        return (!isWatchUiRefreshPath(normalized) && isIgnoredWatchPath(normalized)) || isLockfilePath(normalized, options);
      },
      depth: options.depth,
      usePolling: options.poll,
      interval: options.poll ? 500 : undefined,
      binaryInterval: options.poll ? 1000 : undefined,
      awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 }
    });
    watcher.on("all", (_event: string, path: string) => {
      void onChange(path.replace(`${root}/`, ""));
    });
    watcher.on("error", (error: Error) => {
      console.error(`watch warning: ${error.message}`);
      console.error("recovery:");
      console.error("- run from a narrower project path");
      console.error("- retry with dev-guard watch --poll");
      console.error("- lower watched depth with dev-guard watch --depth 4");
      console.error("- increase the OS file descriptor limit");
      console.error("- run dev-guard done manually when the task is finished");
      void watcher.close?.();
    });
    return watcher;
  }

  console.log("watch backend: node fs.watch fallback (top-level only; install dependencies for chokidar recursive watching)");
  const watcher = fsWatch(root, { recursive: false }, (_event, filename) => {
    if (filename) {
      void onChange(filename.toString());
    }
  });
  let fallbackErrored = false;
  watcher.on("error", (error) => {
    if (fallbackErrored) {
      return;
    }
    fallbackErrored = true;
    console.error(`watch warning: ${error.message}`);
    console.error("recovery: retry with --poll, reduce --depth, increase OS file limit, or run dev-guard done manually");
    watcher.close();
  });
  return [watcher];
}

function isWatchUiRefreshPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized === devguardPaths.runtime || normalized === devguardPaths.state || normalized === devguardPaths.history;
}

async function startWatchSession(root: string): Promise<void> {
  const current = await readRuntimeState(root);
  await writeRuntimeState(root, {
    ...current,
    watchStartedAt: new Date().toISOString()
  });
}

async function allPendingFilesAtOrBefore(root: string, paths: string[], timestamp: string): Promise<boolean> {
  for (const path of paths) {
    if (!(await pathMtimeAtOrBefore(root, path, timestamp))) {
      return false;
    }
  }
  return true;
}

async function pathMtimeAtOrBefore(root: string, path: string, timestamp: string): Promise<boolean> {
  const processedMs = Date.parse(timestamp);
  if (!Number.isFinite(processedMs)) {
    return false;
  }
  try {
    const metadata = await stat(join(root, path));
    return metadata.mtimeMs <= processedMs;
  } catch {
    return true;
  }
}

async function closeWatcher(watcher: unknown): Promise<void> {
  if (Array.isArray(watcher)) {
    for (const item of watcher) {
      item.close();
    }
    return;
  }
  const maybe = watcher as { close?: () => Promise<void> | void };
  await maybe.close?.();
}

async function loadChokidar(): Promise<{ watch?: (...args: unknown[]) => { on: (...args: unknown[]) => unknown; close?: () => Promise<void> | void } } | undefined> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    return (await dynamicImport("chokidar")) as { watch?: (...args: unknown[]) => { on: (...args: unknown[]) => unknown; close?: () => Promise<void> | void } };
  } catch {
    return undefined;
  }
}

function readNumberOption(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} requires a number.`);
  }
  return value;
}

function isLockfilePath(path: string, options: WatchOptions): boolean {
  if (options.includeLockfiles) {
    return false;
  }
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/.test(normalized);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
