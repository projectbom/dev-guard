import {
  formatInferredDiffIntentClusters,
  inferDiffIntentClusters,
  type CodeGraphEntry,
  type InferredDiffIntentClusters
} from "@dev-guard/core";
import { createHash } from "node:crypto";
import { fromRoot, readJsonFile, readTextFile } from "./fs.js";
import { getGitChanges } from "./git.js";
import { runCheck } from "./check.js";
import { runReview } from "./review.js";

type WatchStatus = "idle" | "active" | "stable" | "ready_for_done" | "mixed_warning";

interface WatchOptions {
  check: boolean;
  review: boolean;
  once: boolean;
  intervalMs: number;
  stableAfterMs: number;
  density: "compact" | "ultra";
}

interface WatchRenderState {
  status: WatchStatus;
  lastDiffHash: string;
  stableDurationMs: number;
  primaryIntent?: InferredDiffIntentClusters["primaryIntent"];
  secondaryIntents?: InferredDiffIntentClusters["secondaryIntents"];
}

const defaultIntervalMs = 1000;
const defaultStableAfterMs = 30_000;

export async function runWatch(root: string, args: string[]): Promise<void> {
  const options = parseWatchOptions(args);
  console.log("watching changes...");
  console.log(`interval=${options.intervalMs}ms; stable_after=${Math.round(options.stableAfterMs / 1000)}s; density=${options.density}`);
  console.log("policy: suggestion only; done/update/write/commit are never run automatically");
  console.log("stop: Ctrl+C");

  let lastSignature = "";
  let lastRenderKey = "";
  let lastOptionalKey = "";
  let lastHashChangeAt = Date.now();
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      const next = await buildWatchState(root, options, lastSignature, lastHashChangeAt);
      if (next.diffHash !== lastSignature) {
        lastSignature = next.diffHash;
        lastHashChangeAt = Date.now();
      }
      const stableDurationMs = next.diffHash ? Date.now() - lastHashChangeAt : 0;
      const state = toRenderState(next.clusters, next.diffHash, stableDurationMs, options);
      if (lastRenderKey !== next.renderKey) {
        printWatchState(state, next.clusters, options);
        lastRenderKey = next.renderKey;
      }

      const optionalKey = `${next.diffHash}:${state.status}`;
      if ((state.status === "stable" || state.status === "ready_for_done" || state.status === "mixed_warning") && lastOptionalKey !== optionalKey) {
        await runOptionalChecks(root, options, state);
        lastOptionalKey = optionalKey;
      }
    } catch (error) {
      console.error(`watch warning: ${errorMessage(error)}`);
    } finally {
      running = false;
    }
  };

  await tick();
  if (options.once) {
    return;
  }

  const interval = setInterval(tick, options.intervalMs);
  process.on("SIGINT", () => {
    clearInterval(interval);
    console.log("\ndev-guard watch stopped");
    process.exit(0);
  });
  await new Promise<void>(() => {
    // Keep process alive until SIGINT.
  });
}

async function buildWatchState(root: string, options: WatchOptions, previousHash: string, lastHashChangeAt: number): Promise<{
  diffHash: string;
  clusters: InferredDiffIntentClusters;
  renderKey: string;
}> {
  const [gitChanges, taskMarkdown, codeGraph] = await Promise.all([
    getGitChanges(root),
    readTextFile(fromRoot(root, ".devguard/task.md")),
    readJsonFile<CodeGraphEntry[]>(fromRoot(root, ".devguard/code-graph.json"), [])
  ]);
  const diffHash = hashDiff([gitChanges.changedFiles.join("\n"), gitChanges.diffText].join("\n"));
  const clusters = inferDiffIntentClusters({
    changedFiles: gitChanges.changedFiles,
    changeFiles: gitChanges.changeFiles,
    diffText: gitChanges.diffText,
    codeGraph,
    taskText: hasTaskContext(taskMarkdown) ? taskMarkdown : undefined
  });
  const stableDurationMs = diffHash === previousHash ? Date.now() - lastHashChangeAt : 0;
  const status = toWatchStatus(clusters, diffHash, stableDurationMs, options);
  const renderKey = [diffHash, status, formatInferredDiffIntentClusters(clusters)].join("|");
  return { diffHash, clusters, renderKey };
}

function toRenderState(
  clusters: InferredDiffIntentClusters,
  diffHash: string,
  stableDurationMs: number,
  options: WatchOptions
): WatchRenderState {
  return {
    status: toWatchStatus(clusters, diffHash, stableDurationMs, options),
    lastDiffHash: diffHash,
    stableDurationMs,
    primaryIntent: clusters.primaryIntent,
    secondaryIntents: clusters.secondaryIntents
  };
}

function toWatchStatus(clusters: InferredDiffIntentClusters, diffHash: string, stableDurationMs: number, options: WatchOptions): WatchStatus {
  if (!diffHash || clusters.primaryIntent.changedFiles.length === 0) {
    return "idle";
  }
  if (stableDurationMs < options.stableAfterMs) {
    return "active";
  }
  if (clusters.mixedRisk !== "low") {
    return "mixed_warning";
  }
  if (clusters.primaryIntent.confidence === "high") {
    return "ready_for_done";
  }
  return "stable";
}

function printWatchState(state: WatchRenderState, clusters: InferredDiffIntentClusters, options: WatchOptions): void {
  if (state.status === "idle") {
    console.log("STATUS: idle");
    console.log("NEXT: edit files or run dev-guard \"requirement\"");
    return;
  }

  const primary = clusters.primaryIntent;
  console.log("");
  console.log(`INTENT: ${primary.subtype ?? primary.type}${primary.targetCommand ? `(${primary.targetCommand})` : ""}`);
  console.log(`SCOPE: ${primary.scope.join(", ") || "changed files"}`);
  if (clusters.secondaryDetails.length > 0) {
    const mixed = clusters.secondaryDetails
      .slice(0, 2)
      .map((detail) => {
        const target = detail.intent.targetCommand ? `(${detail.intent.targetCommand})` : "";
        return `${detail.intent.subtype ?? detail.intent.type}${target}(${detail.intent.changedFiles.length}) ${shortSeverity(detail.severity)}`;
      })
      .join(", ");
    const remaining = clusters.secondaryDetails.length - Math.min(2, clusters.secondaryDetails.length);
    console.log(`MIXED: ${mixed}${remaining > 0 ? `, +${remaining} clusters` : ""}`);
  }
  console.log(`DRIFT: ${clusters.mixedRisk}`);
  console.log(`STATUS: ${state.status}`);
  if (state.status === "stable" || state.status === "ready_for_done" || state.status === "mixed_warning") {
    console.log(`stable for ${Math.round(state.stableDurationMs / 1000)}s`);
  }
  if (state.status === "ready_for_done") {
    console.log("NEXT: dev-guard done");
  } else if (state.status === "mixed_warning") {
    console.log("NEXT: inspect mixed files, then run dev-guard done");
  } else if (primary.confidence === "low") {
    console.log('NEXT: dev-guard "<requirement>" for stronger context');
  }
  if (options.density === "compact" && primary.evidence.length > 0) {
    console.log(`EVIDENCE: ${primary.evidence.slice(0, 2).join("; ")}`);
  }
}

async function runOptionalChecks(root: string, options: WatchOptions, state: WatchRenderState): Promise<void> {
  if (state.status === "active" || state.status === "idle") {
    return;
  }
  if (options.check) {
    console.log("running: dev-guard check --local");
    await runCheck(root, { includeContextFiles: false, local: true });
  }
  if (options.review) {
    console.log("running: dev-guard review --heuristic");
    await runReview(root, ["--heuristic"]);
  }
}

function parseWatchOptions(args: string[]): WatchOptions {
  const intervalMs = readNumberOption(args, "--interval", defaultIntervalMs);
  const debounceMs = readNumberOption(args, "--debounce", intervalMs);
  const stableAfterSec = readNumberOption(args, "--stable-after", defaultStableAfterMs / 1000);
  if (intervalMs <= 0 || debounceMs <= 0 || stableAfterSec <= 0) {
    throw new Error("dev-guard watch interval/debounce/stable-after options must be positive numbers.");
  }
  return {
    check: args.includes("--check"),
    review: args.includes("--review"),
    once: args.includes("--once"),
    intervalMs: debounceMs,
    stableAfterMs: stableAfterSec * 1000,
    density: args.includes("--ultra") ? "ultra" : "compact"
  };
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

function hashDiff(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return "";
  }
  return createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

function shortSeverity(severity: InferredDiffIntentClusters["secondaryDetails"][number]["severity"]): string {
  if (severity === "info") return "i";
  if (severity === "caution") return "!";
  if (severity === "warning") return "warning";
  return "high";
}

function hasTaskContext(taskMarkdown: string): boolean {
  const text = taskMarkdown.trim();
  return text.length > 0 && !/^#?\s*Current task/i.test(text) && !/Describe the requested change/i.test(text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
