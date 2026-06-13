import { existsSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import {
  hashRuntimeFiles,
  isIgnoredWatchPath,
  markRuntimeStable,
  readRuntimeState,
  recordRuntimeChange
} from "./runtime-state.js";

type WatchStatus = "idle" | "active" | "ready_for_done";

interface WatchOptions {
  stableAfterMs: number;
  compact: boolean;
}

const watchRoots = ["app", "components", "lib", "hooks", "utils", "constants", "styles", "supabase", "src", "packages", "docs", "devguard"];
const excludedSummary = "node_modules, .git, dist, build, .next, coverage, devguard/runtime.json, devguard/reports/*";

export async function runWatch(root: string, args: string[]): Promise<void> {
  const options = parseWatchOptions(args);
  console.log("dev-guard watch");
  console.log(`watching: ${watchRoots.filter((path) => existsSync(join(root, path))).join(", ") || "."}`);
  console.log(`excluded: ${excludedSummary}`);
  console.log("mode: event-driven; no periodic refresh; no auto write");
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
      console.log("NEXT: dev-guard done");
    } else {
      console.log("NEXT: keep editing; run dev-guard done when the AI task is finished");
    }
  };

  const handleChange = async (path: string) => {
    if (!path || isIgnoredWatchPath(path)) {
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

  const watcher = await createWatcher(root, handleChange);
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
  if (stableAfterSec <= 0) {
    throw new Error("dev-guard watch --stable-after must be positive.");
  }
  return {
    stableAfterMs: stableAfterSec * 1000,
    compact: args.includes("--compact") || args.includes("--ultra")
  };
}

async function createWatcher(root: string, onChange: (path: string) => Promise<void>): Promise<unknown> {
  const existingRoots = watchRoots.map((path) => join(root, path)).filter((path) => existsSync(path));
  const paths = existingRoots.length > 0 ? existingRoots : [root];
  const chokidar = await loadChokidar();
  if (chokidar?.watch) {
    const watcher = chokidar.watch(paths, {
      ignoreInitial: true,
      ignored: (path: string) => isIgnoredWatchPath(path.replace(`${root}/`, "")),
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    });
    watcher.on("all", (_event: string, path: string) => {
      void onChange(path.replace(`${root}/`, ""));
    });
    watcher.on("error", (error: Error) => {
      console.error(`watch warning: ${error.message}`);
      console.error("watch backend unavailable in this shell; run dev-guard done manually or reduce watched paths");
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
    console.error("watch backend unavailable in this shell; install dependencies for chokidar support or run dev-guard done manually");
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
