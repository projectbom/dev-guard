import { existsSync, watch as fsWatch } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureDevguardWorkspace,
  hashRuntimeFiles,
  isIgnoredWatchPath,
  markRuntimeStable,
  processDoneEvent,
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
import { openDashboardBrowser, startDashboardServer, type DashboardServerHandle } from "./dashboard.js";
import { defaultWatchConfig, loadWatchConfig, type WatchConfig } from "./config.js";

type WatchStatus = "idle" | "active" | "ready_for_done" | "finalizing" | "processed";

interface WatchOptions {
  stableAfterMs: number;
  compact: boolean;
  depth: number;
  poll: boolean;
  includeLockfiles: boolean;
  manual: boolean;
  dashboard: boolean;
  autoCompleteDelayMs: number;
}

const watchRoots = ["app", "components", "lib", "hooks", "utils", "constants", "styles", "supabase", "src", "packages", "docs", DEVGUARD_DIR];
const excludedSummary = `node_modules/**, .git/**, dist/**, build/**, .next/**, coverage/**, ${devguardPaths.runtime}, ${devguardPaths.state}, ${devguardPaths.history}, ${devguardPaths.reportsDir}/**, ${devguardPaths.promptsDir}/**, ${devguardPaths.logsDir}/**, ${devguardPaths.hooksDir}/**`;

export async function runWatch(root: string, args: string[]): Promise<void> {
  await ensureDevguardWorkspace(root);
  const watchConfig = await loadWatchConfig(root);
  const options = parseWatchOptions(args, watchConfig);
  const hookStatus = await getHookStatus(root);
  const strategyReport = await getAgentStrategyReport(root);
  const runtimeVerified = strategyReport.strategies.some((strategy) => strategy.name !== "manual" && strategy.runtimeVerified);
  const autoStrategyInstalled = strategyReport.strategies.some((strategy) => strategy.name !== "manual" && strategy.installed);
  const autoMode = !options.manual && autoStrategyInstalled;
  await startWatchSession(root);
  let dashboard: DashboardServerHandle | undefined;
  if (options.dashboard) {
    try {
      dashboard = await startDashboardServer(root);
    } catch (error) {
      console.error(`dashboard warning: ${errorMessage(error)}`);
    }
  }

  const autoCompleteEnabled = options.autoCompleteDelayMs > 0;

  if (dashboard) {
    console.log("DevGuard");
    console.log("");
    console.log("✓ Watching project");
    console.log("");
    console.log("Dashboard");
    console.log(dashboard.url);
    console.log("");
    console.log("Monitoring AI coding session...");
    console.log("");
    console.log("Press Ctrl+C to stop.");
    const opened = await openDashboardBrowser(dashboard.url);
    if (!opened) {
      console.log("");
      console.log("Open this URL in your browser:");
      console.log(dashboard.url);
    }
  } else {
    console.log("dev-guard watch");
    if (options.manual) {
      console.log("Mode: Manual — run dev-guard done when the AI task is finished.");
    } else {
      console.log(`Mode: Auto — finalizes ${autoCompleteEnabled ? `${options.autoCompleteDelayMs / 1000}s after changes settle` : "via hooks only"}.`);
    }
    console.log(`watching: ${watchRoots.filter((path) => existsSync(join(root, path))).join(", ") || "."}`);
    console.log("stop: Ctrl+C");
  }

  let status: WatchStatus = "idle";
  let stableTimer: NodeJS.Timeout | undefined;
  let autoCompleteTimer: NodeJS.Timeout | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let isAutoFinalizing = false;
  let pendingDuringFinalize: string[] = [];
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
    if (options.dashboard) {
      const transitionKey = `${dashboard.transition}:${runtime.changeCountSinceIdle ?? 0}:${runtime.pendingChangedFiles.length}`;
      if (transitionKey !== lastTransitionKey) {
        console.log(`\n${dashboard.transition}`);
        lastTransitionKey = transitionKey;
      }
      return;
    }
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
      clearTimeout(autoCompleteTimer);
      autoCompleteTimer = undefined;
      if (runtime.pendingChangedFiles.length > 0 || (runtime.lastStatus ?? "idle") !== "idle") {
        await resetRuntimeState(root);
      }
      await startWatchSession(root);
      lastPrintedKey = "";
      status = "processed";
      if (options.dashboard) {
        console.log("");
        console.log(`Completion processed. Quality: ${projectState.lastQualityVerdict ?? "unknown"}`);
      } else {
        console.log("");
        console.log(`done: quality=${projectState.lastQualityVerdict ?? "unknown"}; ${projectState.lastQualityVerdict && projectState.lastQualityVerdict !== "PASS" ? `review ${devguardPaths.qualityReport}` : "keep editing"}`);
      }
      await printState("idle");
    }
  };

  const runAutoComplete = async () => {
    if (isAutoFinalizing) {
      return;
    }
    isAutoFinalizing = true;
    pendingDuringFinalize = [];

    try {
      const current = await readRuntimeState(root);
      await writeRuntimeState(root, { ...current, lastStatus: "finalizing" });
    } catch {
      // Non-fatal: dashboard may briefly show wrong state
    }
    await printState("finalizing");

    if (!options.compact) {
      console.log("auto: finalizing session...");
    }

    let finalizeError: unknown;
    try {
      const result = await processDoneEvent(root);
      if (!options.compact) {
        console.log(`auto: done — ${result.changedFiles.length} file(s); quality=${result.qualityVerdict}`);
        if (result.qualityVerdict !== "PASS") {
          console.log(`review: ${devguardPaths.qualityReport}`);
        }
      }
    } catch (error) {
      finalizeError = error;
      console.error(`auto: finalization failed — ${errorMessage(error)}`);
      console.error("recovery: run dev-guard done");
    }

    isAutoFinalizing = false;

    if (finalizeError) {
      lastPrintedKey = "";
      await printState("idle");
      return;
    }

    if (pendingDuringFinalize.length > 0) {
      const deferred = pendingDuringFinalize;
      pendingDuringFinalize = [];
      lastSeenProcessedAt = (await readProjectState(root)).lastProcessedAt;
      lastPrintedKey = "";
      await startWatchSession(root);
      for (const p of deferred) {
        await handleChange(p);
      }
    } else {
      lastSeenProcessedAt = (await readProjectState(root)).lastProcessedAt;
      lastPrintedKey = "";
      await startWatchSession(root);
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

    // If auto-finalization is actively running, buffer the change for replay afterwards
    if (isAutoFinalizing) {
      pendingDuringFinalize.push(path);
      return;
    }

    // Cancel any pending auto-complete grace timer if new changes arrive
    if (autoCompleteTimer !== undefined) {
      clearTimeout(autoCompleteTimer);
      autoCompleteTimer = undefined;
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
          const afterStable = await readRuntimeState(root);
          if (afterStable.pendingChangedFiles.length > 0 && autoCompleteEnabled) {
            await printState("ready_for_done");
            if (!options.compact) {
              console.log(`auto: settling done; finalizing in ${options.autoCompleteDelayMs / 1000}s...`);
            }
            autoCompleteTimer = setTimeout(() => {
              void runAutoComplete();
            }, options.autoCompleteDelayMs);
          } else {
            await printState(afterStable.pendingChangedFiles.length > 0 ? "ready_for_done" : "idle");
          }
        } catch (error) {
          console.error(`watch warning: ${errorMessage(error)}`);
        }
      }, options.stableAfterMs);
      if (!options.compact) {
        console.log(`change: ${path}`);
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
  if (!options.dashboard) {
    await printState(status);
  }
  refreshTimer = setInterval(() => {
    void (async () => {
      if (!isAutoFinalizing) {
        await refreshExternalDoneState();
      }
      const runtime = await readRuntimeState(root);
      const now = Date.now();
      if (!runtime.watchHeartbeatAt || now - Date.parse(runtime.watchHeartbeatAt) > 4_000) {
        await writeRuntimeState(root, {
          ...runtime,
          watchHeartbeatAt: new Date(now).toISOString()
        });
      }
      if ((runtime.lastStatus ?? "idle") === "active") {
        await printState("active");
      }
    })().catch((error) => {
      console.error(`watch warning: ${errorMessage(error)}`);
    });
  }, 1000);

  process.on("SIGINT", async () => {
    await closeWatcher(watcher);
    await dashboard?.close();
    clearTimeout(stableTimer);
    clearTimeout(autoCompleteTimer);
    clearInterval(refreshTimer);
    console.log("\ndev-guard watch stopped");
    process.exit(0);
  });

  await new Promise<void>(() => {
    // Keep process alive until SIGINT.
  });
}

/**
 * Resolve WatchOptions by merging config file defaults with explicit CLI flag overrides.
 * A CLI flag only overrides config when it is explicitly present in args.
 */
function parseWatchOptions(args: string[], config: WatchConfig): WatchOptions {
  // Number options: CLI overrides config only when flag is explicitly present
  const stableAfterSec = args.includes("--stable-after")
    ? readNumberOption(args, "--stable-after", defaultWatchConfig.stableAfter)
    : (config.stableAfter ?? defaultWatchConfig.stableAfter);

  const autoCompleteDelaySec = args.includes("--auto-complete-delay")
    ? readNumberOption(args, "--auto-complete-delay", defaultWatchConfig.autoCompleteDelay)
    : (config.autoCompleteDelay ?? defaultWatchConfig.autoCompleteDelay);

  const depth = args.includes("--depth")
    ? readNumberOption(args, "--depth", defaultWatchConfig.depth)
    : (config.depth ?? defaultWatchConfig.depth);

  if (stableAfterSec <= 0) {
    throw new Error("watch.stableAfter / --stable-after must be positive.");
  }
  if (autoCompleteDelaySec <= 0) {
    throw new Error("watch.autoCompleteDelay / --auto-complete-delay must be positive.");
  }
  if (depth < 1) {
    throw new Error("watch.depth / --depth must be 1 or greater.");
  }

  // Boolean options: CLI flag takes explicit precedence over config
  const manual = args.includes("--manual") || args.includes("--no-auto");

  const poll = args.includes("--poll") ? true : (config.poll ?? defaultWatchConfig.poll);
  const compact = (args.includes("--compact") || args.includes("--ultra")) ? true : (config.compact ?? defaultWatchConfig.compact);
  const includeLockfiles = args.includes("--include-lockfiles") ? true : (config.includeLockfiles ?? defaultWatchConfig.includeLockfiles);
  const dashboard = args.includes("--no-dashboard") ? false : (config.dashboard ?? defaultWatchConfig.dashboard);

  // Auto-complete: disabled by --manual, --no-auto-complete, or config.autoComplete=false
  const autoCompleteEnabled = !manual && !args.includes("--no-auto-complete") && (config.autoComplete ?? defaultWatchConfig.autoComplete);

  return {
    stableAfterMs: stableAfterSec * 1000,
    compact,
    depth,
    poll,
    includeLockfiles,
    manual,
    dashboard,
    autoCompleteDelayMs: autoCompleteEnabled ? autoCompleteDelaySec * 1000 : 0
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
      console.error("- retry with dev-guard watch --poll");
      console.error("- lower depth: dev-guard watch --depth 4  (or set watch.depth in .devguard/config.json)");
      console.error("- increase the OS file descriptor limit");
      console.error("- run dev-guard done manually");
      void watcher.close?.();
    });
    return watcher;
  }

  console.log("watch backend: node fs.watch fallback (top-level only; install dependencies for recursive watching)");
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
    console.error("recovery: retry with --poll, reduce --depth, or run dev-guard done manually");
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
    watchStartedAt: new Date().toISOString(),
    watchHeartbeatAt: new Date().toISOString()
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
