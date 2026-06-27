import type { RuntimeState } from "./runtime-state.js";

export interface WatchDashboardOptions {
  autoMode: boolean;
  manual: boolean;
  runtimeVerified: boolean;
  now?: number;
}

export interface WatchDashboard {
  status: string;
  stage: string;
  waitingFor: string;
  next: string;
  transition: string;
  lines: string[];
}

export function formatWatchDashboard(runtime: RuntimeState, options: WatchDashboardOptions): WatchDashboard {
  const now = options.now ?? Date.now();
  const status = runtime.lastStatus ?? "idle";
  const stage = currentStage(runtime, options);
  const waitingFor = waitingReason(runtime, options);
  const next = nextTransition(runtime, options, now);
  const transition = transitionLine(runtime, stage);
  const recentFiles = recentChangedFiles(runtime);
  const lines = [
    "DevGuard",
    "",
    "Status",
    displayStatus(status),
    "",
    "Current Stage",
    stage,
    "",
    "Watching Since",
    runtime.watchStartedAt ? formatTime(runtime.watchStartedAt) : "unknown",
    "",
    "Elapsed",
    runtime.watchStartedAt ? formatDurationSince(runtime.watchStartedAt, now) : "unknown",
    "",
    "Last Activity",
    runtime.lastActivityAt ? `${formatDurationSince(runtime.lastActivityAt, now)} ago` : "none",
    "",
    "Changes",
    String(runtime.changeCountSinceIdle ?? runtime.pendingChangedFiles.length),
    "",
    "Recent Files",
    ...formatRecentFiles(recentFiles, runtime.pendingChangedFiles.length)
  ];

  if (status === "idle" && runtime.idleSinceAt) {
    lines.push("", "Idle Since", `${formatDurationSince(runtime.idleSinceAt, now)} ago`);
  }

  lines.push("", "Waiting For", waitingFor, "", "Next", next);

  return {
    status: displayStatus(status),
    stage,
    waitingFor,
    next,
    transition,
    lines
  };
}

export function formatWatchDashboardKey(runtime: RuntimeState, options: WatchDashboardOptions): string {
  const status = runtime.lastStatus ?? "idle";
  const countdownBucket = status === "active" ? remainingSeconds(runtime.idleDeadlineAt, options.now ?? Date.now()) : "";
  return [
    status,
    runtime.pendingChangedFiles.join("|"),
    runtime.lastChangedFile ?? "",
    runtime.lastActivityAt ?? "",
    runtime.changeCountSinceIdle ?? 0,
    runtime.idleSinceAt ?? "",
    runtime.watchStartedAt ?? "",
    countdownBucket,
    options.autoMode ? "auto" : "manual",
    options.runtimeVerified ? "verified" : "unverified"
  ].join(":");
}

function currentStage(runtime: RuntimeState, options: WatchDashboardOptions): string {
  if (runtime.buildActive) {
    return "Build Running";
  }
  if (runtime.hookActive) {
    return "Hook Running";
  }
  const status = runtime.lastStatus ?? "idle";
  if (status === "active") {
    return "Filesystem Settling";
  }
  if (status === "ready_for_done") {
    return options.manual ? "Ready for dev-guard done" : "Waiting for completion";
  }
  if (status === "processed") {
    return "Completion Processed";
  }
  return runtime.pendingChangedFiles.length > 0 ? "Changes Detected" : "Watching";
}

function waitingReason(runtime: RuntimeState, options: WatchDashboardOptions): string {
  if (runtime.buildActive) {
    return "Build completion";
  }
  if (runtime.hookActive) {
    return "Hook completion";
  }
  const status = runtime.lastStatus ?? "idle";
  if (status === "active") {
    return "Filesystem inactivity";
  }
  if (status === "ready_for_done") {
    if (options.manual) {
      return "Manual dev-guard done";
    }
    if (options.runtimeVerified) {
      return "Agent completion strategy or manual dev-guard done";
    }
    return "Runtime verification or manual dev-guard done";
  }
  if (status === "processed") {
    return "Idle state refresh";
  }
  return "New file changes";
}

function nextTransition(runtime: RuntimeState, options: WatchDashboardOptions, now: number): string {
  const status = runtime.lastStatus ?? "idle";
  if (runtime.buildActive) {
    return "Idle countdown starts after build activity clears";
  }
  if (runtime.hookActive) {
    return "Waiting for hook completion";
  }
  if (status === "active") {
    return `Idle in ${formatRemaining(runtime.idleDeadlineAt, now)}`;
  }
  if (status === "ready_for_done") {
    if (options.manual) {
      return "Waiting for dev-guard done";
    }
    if (options.runtimeVerified) {
      return "Waiting for verified agent completion; fallback: dev-guard done";
    }
    return "Run dev-guard doctor --agents or fallback: dev-guard done";
  }
  if (status === "processed") {
    return "Returning to idle";
  }
  return options.autoMode && options.runtimeVerified
    ? "Watching; verified agent strategy will run done when the AI task finishes"
    : options.manual
      ? "Watching; run dev-guard done when the AI task is finished"
      : "Watching; verify agent strategy or use dev-guard done";
}

function transitionLine(runtime: RuntimeState, stage: string): string {
  const status = runtime.lastStatus ?? "idle";
  if (status === "active") {
    return `Changes detected (${runtime.changeCountSinceIdle ?? runtime.pendingChangedFiles.length})`;
  }
  if (status === "ready_for_done") {
    return "Ready for completion";
  }
  if (status === "processed") {
    return "Completion processed";
  }
  if (status === "idle") {
    return "Idle";
  }
  return stage;
}

function displayStatus(status: string): string {
  if (status === "active") return "Working";
  if (status === "ready_for_done") return "Ready for done";
  if (status === "processed") return "Processed";
  return "Idle";
}

function recentChangedFiles(runtime: RuntimeState): string[] {
  const files = new Set<string>();
  if (runtime.lastChangedFile) {
    files.add(runtime.lastChangedFile);
  }
  for (const file of runtime.pendingChangedFiles) {
    files.add(file);
  }
  return [...files].slice(0, 3);
}

function formatRecentFiles(files: string[], total: number): string[] {
  if (files.length === 0) {
    return ["none"];
  }
  const lines = files.map((file) => `- ${file}`);
  const hidden = Math.max(0, total - files.length);
  if (hidden > 0) {
    lines.push(`(+${hidden} more)`);
  }
  return lines;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return "unknown";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatDurationSince(timestamp: string, now: number): string {
  const started = Date.parse(timestamp);
  if (!Number.isFinite(started)) {
    return "unknown";
  }
  return formatDuration(Math.max(0, now - started));
}

function formatRemaining(timestamp: string | undefined, now: number): string {
  if (!timestamp) {
    return "unknown";
  }
  const seconds = remainingSeconds(timestamp, now);
  if (seconds <= 0) {
    return "now";
  }
  return `~${seconds}s`;
}

function remainingSeconds(timestamp: string | undefined, now: number): number {
  if (!timestamp) {
    return -1;
  }
  const target = Date.parse(timestamp);
  if (!Number.isFinite(target)) {
    return -1;
  }
  return Math.max(0, Math.ceil((target - now) / 1000));
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) {
    return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}
