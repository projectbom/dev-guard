import { existsSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import {
  ensureDevguardWorkspace,
  hashRuntimeFiles,
  isIgnoredWatchPath,
  markRuntimeStable,
  readRuntimeState,
  recordRuntimeChange
} from "./runtime-state.js";
import { getHookStatus } from "./hooks.js";
import { DEVGUARD_DIR, devguardPaths } from "./paths.js";
import { getAgentStrategyReport } from "./agent-strategies.js";

type WatchStatus = "idle" | "active" | "ready_for_done";

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

  let status: WatchStatus = "idle";
  let stableTimer: NodeJS.Timeout | undefined;
  let lastPrintedKey = "";

  const printState = async (nextStatus: WatchStatus) => {
    const runtime = await readRuntimeState(root);
    const key = `${nextStatus}:${runtime.pendingChangedFiles.join("|")}`;
    if (key === lastPrintedKey) {
      return;
    }
    lastPrintedKey = key;
    status = nextStatus;
    console.log("");
    console.log(`STATUS: ${status}`);
    if (runtime.pendingChangedFiles.length > 0) {
      console.log(`changed: ${runtime.pendingChangedFiles.slice(0, 8).join(", ")}${runtime.pendingChangedFiles.length > 8 ? `, +${runtime.pendingChangedFiles.length - 8}` : ""}`);
    }
    if (status === "ready_for_done") {
      if (autoMode && runtimeVerified) {
        console.log("NEXT: wait for verified agent completion strategy; fallback: dev-guard done");
      } else if (autoMode) {
        console.log("NEXT: automatic completion is not runtime verified yet. Run dev-guard doctor --agents or fallback: dev-guard done");
      } else {
        console.log("NEXT: dev-guard done");
      }
    } else {
      console.log(autoMode ? (runtimeVerified ? "NEXT: keep editing; verified agent strategy will run done when the AI task finishes" : "NEXT: keep editing; verify agent strategy with dev-guard doctor --agents or use dev-guard done") : "NEXT: keep editing; run dev-guard done when the AI task is finished");
    }
  };

  const handleChange = async (path: string) => {
    if (!path || isIgnoredWatchPath(path) || isLockfilePath(path, options)) {
      return;
    }
    try {
      clearTimeout(stableTimer);
      const runtime = await recordRuntimeChange(root, path);
      await printState("active");
      stableTimer = setTimeout(async () => {
        const latest = await readRuntimeState(root);
        await markRuntimeStable(root, hashRuntimeFiles(latest.pendingChangedFiles));
        await printState(latest.pendingChangedFiles.length > 0 ? "ready_for_done" : "idle");
      }, options.stableAfterMs);
      if (!options.compact) {
        console.log(`event: ${path}; pending=${runtime.pendingChangedFiles.length}`);
      }
    } catch (error) {
      console.error(`watch warning: ${errorMessage(error)}`);
      console.error("recovery: fix the file issue or run dev-guard reset");
    }
  };

  const watcher = await createWatcher(root, handleChange, options);
  await printState(status);

  process.on("SIGINT", async () => {
    await closeWatcher(watcher);
    clearTimeout(stableTimer);
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

async function createWatcher(root: string, onChange: (path: string) => Promise<void>, options: WatchOptions): Promise<unknown> {
  const existingRoots = watchRoots.map((path) => join(root, path)).filter((path) => existsSync(path));
  const paths = existingRoots.length > 0 ? existingRoots : [root];
  const chokidar = await loadChokidar();
  if (chokidar?.watch) {
    const watcher = chokidar.watch(paths, {
      ignoreInitial: true,
      ignored: (path: string) => {
        const normalized = path.replace(`${root}/`, "");
        return isIgnoredWatchPath(normalized) || isLockfilePath(normalized, options);
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
