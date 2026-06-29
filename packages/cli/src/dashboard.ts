import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { fromRoot, readTextFile } from "./fs.js";
import { devguardPaths } from "./paths.js";
import { processDoneEvent, readHistoryRecords, readProjectState, readRuntimeState, type HistoryRecord, type RuntimeState } from "./runtime-state.js";
import { readProjectKnowledge } from "./knowledge.js";
import { getAgentStrategyReport } from "./agent-strategies.js";
import { formatWatchDashboard } from "./watch-format.js";
import { dashboardTranslations } from "./dashboard-i18n.js";

const DEFAULT_PORT = 3737;
const HOST = "127.0.0.1";

// Whitelisted file keys for the /api/file endpoint — prevents path traversal.
const FILE_KEYS: Record<string, string> = {
  handoff: devguardPaths.projectHandoff,
  quality: devguardPaths.qualityReport,
  context: devguardPaths.agentContext,
  nextclaude: devguardPaths.nextClaudePrompt,
  nextcodex: devguardPaths.nextCodexPrompt,
  lastrun: devguardPaths.lastRunReport,
  knowledge: devguardPaths.projectKnowledge
};

export interface DashboardServerHandle {
  url: string;
  started: boolean;
  close: () => Promise<void>;
}

interface SessionSummary {
  id: string;
  timestamp: string;
  fileCount: number;
  areas: string[];
  qualityVerdict?: string;
}

interface TimelineEvent {
  time: string;
  type: "session" | "watch_start" | "file_change";
}

interface TodayStats {
  sessions: number;
  filesChanged: number;
  reportsGenerated: number;
  lastUpdate: string;
}

interface FileInfo {
  exists: boolean;
  updatedAt?: string;
}

interface QualitySummary {
  warningCount: number;
  blockedCount: number;
  requiredVerificationCount: number;
}

interface DashboardState {
  status: string;
  watchingSince: string;
  elapsed: string;
  lastActivity: string;
  idleCountdown: string | null;
  changeCount: number;
  recentFiles: string[];
  sessionFiles: string[];
  moreFileCount: number;
  sessionFileCount: number;
  watchRunning: boolean;
  initialized: boolean;
  empty: boolean;
  message?: string;
  qualityVerdict?: string;
  lastProcessedAt?: string;
  sessions: SessionSummary[];
  todayStats: TodayStats;
  qualityTrend: Array<{ verdict: string; timestamp: string }>;
  timeline: TimelineEvent[];
  reports: {
    handoffExists: boolean;
    qualityReportExists: boolean;
    agentContextExists: boolean;
    nextClaudePromptExists: boolean;
    nextCodexPromptExists: boolean;
    handoffUpdatedAt?: string;
    qualityReportUpdatedAt?: string;
    agentContextUpdatedAt?: string;
    nextClaudePromptUpdatedAt?: string;
    nextCodexPromptUpdatedAt?: string;
    handoffPreview?: string;
    qualityReportPreview?: string;
    agentContextPreview?: string;
    qualitySummary: QualitySummary;
  };
  knowledge: {
    exists: boolean;
    updatedAt?: string;
    filesIndexed: number;
    architectureModules: number;
    framework?: string;
  };
  setup?: RuntimeState["setupStatus"];
}

export async function runDashboard(root: string, args: string[]): Promise<void> {
  const port = readPort(args);
  const shouldOpenBrowser = !args.includes("--no-open");
  const dashboard = await startDashboardServer(root, { port });
  console.log(dashboard.started ? "DevGuard dashboard running" : "DevGuard dashboard already running");
  console.log("");
  console.log("URL:");
  console.log(dashboard.url);

  if (shouldOpenBrowser) {
    const opened = await openDashboardBrowser(dashboard.url);
    if (!opened) {
      console.log("");
      console.log("Dashboard");
      console.log(dashboard.url);
    }
  }

  if (!dashboard.started) {
    return;
  }

  console.log("");
  console.log("Press Ctrl+C to stop.");

  process.on("SIGINT", () => {
    void dashboard.close().finally(() => process.exit(0));
  });
}

export async function startDashboardServer(root: string, options: { port?: number } = {}): Promise<DashboardServerHandle> {
  const port = options.port ?? DEFAULT_PORT;
  const server = createServer((request, response) => {
    void handleRequest(root, request, response);
  });
  const url = `http://${HOST}:${port}`;
  const started = await new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen(port, HOST, () => resolve(true));
  });

  return {
    url,
    started,
    close: () =>
      new Promise<void>((resolve) => {
        if (!started) {
          resolve();
          return;
        }
        server.close(() => resolve());
      })
  };
}

async function handleRequest(root: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${HOST}`);
  if (request.method === "POST" && url.pathname === "/api/review-complete") {
    try {
      const result = await processDoneEvent(root);
      sendJson(response, {
        ok: true,
        qualityVerdict: result.qualityVerdict,
        changedFiles: result.changedFiles.length
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
    return;
  }
  if (request.method !== "GET") {
    sendText(response, 405, "Method not allowed");
    return;
  }
  if (url.pathname === "/") {
    sendHtml(response, renderPage());
    return;
  }
  if (url.pathname === "/api/state") {
    try {
      sendJson(response, await getDashboardState(root));
    } catch (error) {
      sendJson(response, { error: errorMessage(error) }, 500);
    }
    return;
  }
  if (url.pathname === "/api/file") {
    const key = url.searchParams.get("path") ?? "";
    const filePath = FILE_KEYS[key.toLowerCase()];
    if (!filePath) {
      sendText(response, 404, "Unknown file key");
      return;
    }
    try {
      const absolute = fromRoot(root, filePath);
      const text = await readTextFile(absolute);
      if (!text.trim()) {
        sendText(response, 404, "File not found or empty");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      });
      response.end(text);
    } catch {
      sendText(response, 404, "File not found");
    }
    return;
  }
  sendText(response, 404, "Not found");
}

async function getDashboardState(root: string): Promise<DashboardState> {
  const initialized = await isDevGuardInitialized(root);
  const [runtime, strategyReport, reports, projectState, history, knowledge] = await Promise.all([
    readRuntimeState(root),
    getAgentStrategyReport(root),
    readReportState(root),
    readProjectState(root),
    readHistoryRecords(root, 20),
    readKnowledgeState(root)
  ]);
  const runtimeVerified = strategyReport.strategies.some((strategy) => strategy.name !== "manual" && strategy.runtimeVerified);
  const autoMode = strategyReport.strategies.some((strategy) => strategy.name !== "manual" && strategy.installed);
  const dashboard = formatWatchDashboard(runtime, {
    autoMode,
    manual: false,
    runtimeVerified
  });
  const watchRunning = isWatchRunning(runtime);
  const sessionFiles = sessionChangedFiles(runtime, projectState);
  const recentFiles = sessionFiles.slice(0, 5);
  const empty = initialized && !watchRunning && !runtime.watchStartedAt && runtime.pendingChangedFiles.length === 0 && history.length === 0;

  const sessions = buildSessionSummaries(history);
  const todayStats = computeTodayStats(history);
  const qualityTrend = buildQualityTrend(history, projectState.lastQualityVerdict, projectState.lastProcessedAt);
  const timeline = buildTimeline(history, runtime);

  return {
    status: normalizeStatus(dashboard.status),
    watchingSince: runtime.watchStartedAt ? formatTime(runtime.watchStartedAt) : "",
    elapsed: runtime.watchStartedAt ? formatDurationSince(runtime.watchStartedAt) : "",
    lastActivity: runtime.lastActivityAt ? formatDurationSince(runtime.lastActivityAt) : "",
    idleCountdown: normalizeStatus(dashboard.status) === "working" && runtime.lastStatus !== "finalizing" ? formatCountdown(runtime.idleDeadlineAt) : null,
    changeCount: runtime.changeCountSinceIdle ?? runtime.pendingChangedFiles.length,
    recentFiles,
    sessionFiles,
    moreFileCount: Math.max(0, sessionFiles.length - recentFiles.length),
    sessionFileCount: sessionFiles.length,
    watchRunning,
    initialized,
    empty,
    message: initialized ? (watchRunning ? undefined : "Watch is not running.") : "DevGuard is not initialized.",
    qualityVerdict: projectState.lastQualityVerdict ?? undefined,
    lastProcessedAt: projectState.lastProcessedAt ?? undefined,
    sessions,
    todayStats,
    qualityTrend,
    timeline,
    reports,
    knowledge,
    setup: runtime.setupStatus
  };
}

async function readKnowledgeState(root: string): Promise<DashboardState["knowledge"]> {
  const [knowledge, file] = await Promise.all([
    readProjectKnowledge(root),
    checkFileInfo(root, devguardPaths.projectKnowledge)
  ]);
  return {
    exists: Boolean(knowledge),
    updatedAt: file.updatedAt,
    filesIndexed: knowledge?.summary.filesIndexed ?? 0,
    architectureModules: knowledge?.architecture.modules.length ?? 0,
    framework: knowledge?.summary.framework
  };
}

function buildSessionSummaries(history: HistoryRecord[]): SessionSummary[] {
  return [...history]
    .reverse()
    .slice(0, 15)
    .map((record) => ({
      id: record.id,
      timestamp: record.timestamp,
      fileCount: record.changedFiles.length,
      areas: record.areas,
      qualityVerdict: record.qualityVerdict
    }));
}

function computeTodayStats(history: HistoryRecord[]): TodayStats {
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const todaySessions = history.filter((r) => r.timestamp.startsWith(todayPrefix));
  const filesToday = new Set<string>();
  for (const session of todaySessions) {
    for (const f of session.changedFiles) filesToday.add(f);
  }
  const lastSession = todaySessions[todaySessions.length - 1];
  return {
    sessions: todaySessions.length,
    filesChanged: filesToday.size,
    reportsGenerated: todaySessions.length,
    lastUpdate: lastSession ? formatTime(lastSession.timestamp) : ""
  };
}

function buildQualityTrend(history: HistoryRecord[], currentVerdict?: string, currentTimestamp?: string): Array<{ verdict: string; timestamp: string }> {
  const trend: Array<{ verdict: string; timestamp: string }> = [];

  for (const record of [...history].reverse()) {
    if (record.qualityVerdict) {
      trend.push({ verdict: record.qualityVerdict, timestamp: record.timestamp });
    }
    if (trend.length >= 5) break;
  }

  if (currentVerdict && currentTimestamp) {
    const alreadyIn = trend.some((t) => t.timestamp === currentTimestamp);
    if (!alreadyIn) {
      trend.unshift({ verdict: currentVerdict, timestamp: currentTimestamp });
      if (trend.length > 5) trend.pop();
    }
  }

  return trend.slice(0, 5);
}

function buildTimeline(history: HistoryRecord[], runtime: RuntimeState): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const record of [...history].reverse().slice(0, 3)) {
    events.push({ time: record.timestamp, type: "session" });
  }

  if (runtime.watchStartedAt) {
    events.push({ time: runtime.watchStartedAt, type: "watch_start" });
  }

  if (runtime.lastChangedAt && runtime.pendingChangedFiles.length > 0) {
    events.push({ time: runtime.lastChangedAt, type: "file_change" });
  }

  return events
    .filter((e) => e.time)
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
    .slice(0, 8);
}

async function readReportState(root: string): Promise<DashboardState["reports"]> {
  const [handoff, quality, context, nextClaude, nextCodex] = await Promise.all([
    readKnownPreview(root, devguardPaths.projectHandoff),
    readKnownPreview(root, devguardPaths.qualityReport),
    readKnownPreview(root, devguardPaths.agentContext),
    checkFileInfo(root, devguardPaths.nextClaudePrompt),
    checkFileInfo(root, devguardPaths.nextCodexPrompt)
  ]);
  return {
    handoffExists: handoff.exists,
    qualityReportExists: quality.exists,
    agentContextExists: context.exists,
    nextClaudePromptExists: nextClaude.exists,
    nextCodexPromptExists: nextCodex.exists,
    handoffUpdatedAt: handoff.updatedAt,
    qualityReportUpdatedAt: quality.updatedAt,
    agentContextUpdatedAt: context.updatedAt,
    nextClaudePromptUpdatedAt: nextClaude.updatedAt,
    nextCodexPromptUpdatedAt: nextCodex.updatedAt,
    handoffPreview: handoff.preview,
    qualityReportPreview: quality.preview,
    agentContextPreview: context.preview,
    qualitySummary: summarizeQualityReport(quality.text ?? quality.preview ?? "")
  };
}

function summarizeQualityReport(markdown: string): QualitySummary {
  return {
    warningCount: countSectionItems(markdown, "Warnings"),
    blockedCount: countSectionItems(markdown, "Blocked Items"),
    requiredVerificationCount: countSectionItems(markdown, "Required Verification")
  };
}

function countSectionItems(markdown: string, heading: string): number {
  const pattern = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, "m");
  const match = pattern.exec(markdown);
  if (!match) return 0;
  const start = match.index + match[0].length;
  const next = markdown.slice(start).search(/\n## /);
  const section = next >= 0 ? markdown.slice(start, start + next) : markdown.slice(start);
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") && !/^- none$/i.test(line))
    .length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readKnownPreview(root: string, path: string): Promise<{ exists: boolean; updatedAt?: string; preview?: string; text?: string }> {
  const absolute = fromRoot(root, path);
  if (!(await fileExists(absolute))) {
    return { exists: false };
  }
  const [text, info] = await Promise.all([readTextFile(absolute), stat(absolute)]);
  return { exists: true, updatedAt: info.mtime.toISOString(), preview: text.slice(0, 1800), text };
}

async function checkFileInfo(root: string, path: string): Promise<FileInfo> {
  const absolute = fromRoot(root, path);
  if (!(await fileExists(absolute))) {
    return { exists: false };
  }
  const info = await stat(absolute);
  return { exists: true, updatedAt: info.mtime.toISOString() };
}

async function isDevGuardInitialized(root: string): Promise<boolean> {
  return (await fileExists(fromRoot(root, devguardPaths.config))) || (await fileExists(fromRoot(root, devguardPaths.task))) || (await fileExists(fromRoot(root, "docs/PROJECT_STATE.md")));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isWatchRunning(runtime: RuntimeState): boolean {
  if (!runtime.watchHeartbeatAt) return false;
  const age = Date.now() - Date.parse(runtime.watchHeartbeatAt);
  return Number.isFinite(age) && age >= 0 && age < 8_000;
}

function sessionChangedFiles(runtime: RuntimeState, projectState: Awaited<ReturnType<typeof readProjectState>>): string[] {
  const files = new Set<string>();
  if (runtime.lastChangedFile) files.add(runtime.lastChangedFile);
  for (const file of runtime.pendingChangedFiles) files.add(file);
  if (files.size === 0 && projectState.lastChangedFiles) {
    for (const file of projectState.lastChangedFiles) files.add(file);
  }
  return [...files];
}

function normalizeStatus(status: string): string {
  if (status === "Working") return "working";
  if (status === "Ready for done") return "ready_for_done";
  if (status === "Finalizing") return "finalizing";
  return status.toLowerCase();
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
}

function formatDurationSince(timestamp: string): string {
  const started = Date.parse(timestamp);
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

function formatCountdown(timestamp?: string): string | null {
  if (!timestamp) return null;
  const target = Date.parse(timestamp);
  if (!Number.isFinite(target)) return null;
  const seconds = Math.max(0, Math.ceil((target - Date.now()) / 1000));
  return seconds < 60 ? `~${seconds}s` : `~${Math.ceil(seconds / 60)}m`;
}

function readPort(args: string[]): number {
  const index = args.indexOf("--port");
  if (index < 0) return DEFAULT_PORT;
  const port = Number(args[index + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port requires a valid port number.");
  }
  return port;
}

export async function openDashboardBrowser(url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn("open", [url], { stdio: "ignore" });
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      resolve(opened);
    };
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
    setTimeout(() => finish(true), 800).unref();
  });
}

function sendJson(response: ServerResponse, data: unknown, statusCode = 200): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(data, null, 2)}\n`);
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(html);
}

function sendText(response: ServerResponse, statusCode: number, text: string): void {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderPage(): string {
  const translationsJson = JSON.stringify(dashboardTranslations);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DevGuard</title>
  <style>
    /* ── Tokens ── */
    :root {
      color-scheme: light;
      --bg: #f5f6f8;
      --surface: #ffffff;
      --surface2: #f8f9fb;
      --ink: #111318;
      --ink2: #424751;
      --muted: #6b7280;
      --line: #e4e7ec;
      --line2: #d1d5db;
      --accent: #2563eb;
      --accent-dk: #1d4ed8;
      --accent-bg: #eff6ff;
      --ok: #16a34a;
      --ok-bg: #f0fdf4;
      --ok-ring: #bbf7d0;
      --warn: #d97706;
      --warn-bg: #fffbeb;
      --warn-ring: #fde68a;
      --bad: #dc2626;
      --bad-bg: #fef2f2;
      --bad-ring: #fecaca;
      --purple: #7c3aed;
      --purple-bg: #f5f3ff;
      --purple-ring: #ddd6fe;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --r: 10px;
      --r-sm: 6px;
    }

    /* ── Reset ── */
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
    h1, h2, h3, p { margin: 0; }
    ul { margin: 0; padding: 0; list-style: none; }
    a { color: inherit; text-decoration: none; }

    /* ── Page ── */
    .page { max-width: 1060px; margin: 0 auto; padding: 24px 20px 56px; }
    .gap { display: grid; gap: 12px; }
    .g2 { grid-template-columns: 1fr 1fr; }
    .g2w { grid-template-columns: 1.5fr 1fr; }

    /* ── Top bar ── */
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
    .brand-name { font-size: 17px; font-weight: 700; letter-spacing: -.3px; }
    .brand-sub { font-size: 12px; color: var(--muted); }
    .topbar-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .lang-toggle { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--line2); border-radius: 8px; background: var(--surface); }
    .lang-toggle button { border: 0; background: transparent; color: var(--muted); border-radius: 6px; padding: 4px 10px; font: 12px/1 var(--sans); font-weight: 600; cursor: pointer; }
    .lang-toggle button.active { background: var(--ink); color: #fff; }
    .lang-toggle button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .btn-refresh { border: 1px solid var(--line2); background: var(--surface); color: var(--muted); border-radius: 6px; padding: 4px 10px; font: 12px/1 var(--sans); font-weight: 600; cursor: pointer; }
    .btn-refresh:hover { background: var(--surface2); color: var(--ink); }
    .timestamp { font: 11px/1 var(--mono); color: var(--muted); }

    /* ── Status banner ── */
    .banner { border-radius: var(--r); padding: 20px 22px; margin-bottom: 12px; border: 1px solid transparent; display: flex; align-items: flex-start; gap: 14px; }
    .banner.idle { background: var(--ok-bg); border-color: var(--ok-ring); }
    .banner.working { background: var(--warn-bg); border-color: var(--warn-ring); }
    .banner.finalizing, .banner.ready_for_done { background: var(--accent-bg); border-color: #bfdbfe; }
    .banner.processed { background: var(--purple-bg); border-color: var(--purple-ring); }
    .banner.setup { background: var(--accent-bg); border-color: #bfdbfe; }
    .banner.offline { background: var(--surface); border-color: var(--line2); }
    .banner-icon { font-size: 24px; line-height: 1; flex-shrink: 0; margin-top: 1px; }
    .banner-text { flex: 1; min-width: 0; }
    .banner-title { font-size: 18px; font-weight: 700; line-height: 1.25; letter-spacing: -.2px; }
    .banner-body { color: var(--ink2); margin-top: 3px; font-size: 14px; }
    .banner-cmd { display: inline-block; margin-top: 8px; font: 13px/1.4 var(--mono); background: rgba(0,0,0,.06); border-radius: 5px; padding: 4px 9px; }
    .setup-list { display: grid; gap: 6px; margin: -2px 0 12px; padding: 12px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); }
    .setup-item { display: flex; align-items: center; gap: 8px; color: var(--ink2); font-size: 13px; }
    .setup-mark { width: 18px; color: var(--accent); font-weight: 800; text-align: center; }
    .setup-item.warning .setup-mark { color: var(--warn); }

    /* ── Action Center ── */
    .ac-section { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 18px; margin-bottom: 12px; }
    .ac-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: 14px; }
    .ac-list { display: grid; gap: 8px; }
    .ac-card { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; padding: 14px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface); transition: border-color .12s, box-shadow .12s; }
    .ac-card:hover { border-color: var(--line2); box-shadow: 0 1px 4px rgba(0,0,0,.06); }
    .ac-card.primary { border-color: #bfdbfe; background: var(--accent-bg); }
    .ac-card.missing { background: var(--surface2); }
    .ac-name { font-size: 14px; font-weight: 740; color: var(--ink); line-height: 1.3; }
    .ac-reason { font-size: 12px; color: var(--muted); line-height: 1.45; margin-top: 3px; }
    .ac-meta { font: 11px/1.4 var(--mono); color: var(--muted); margin-top: 5px; }
    .ac-btns { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .ac-btn { display: inline-flex; align-items: center; justify-content: center; font: 12px/1 var(--sans); font-weight: 650; padding: 6px 13px; border-radius: var(--r-sm); border: none; cursor: pointer; text-decoration: none; transition: background .1s, color .1s; white-space: nowrap; min-height: 30px; }
    .ac-btn-primary { background: var(--accent); color: #fff; }
    .ac-btn-primary:hover { background: var(--accent-dk); }
    .ac-btn-secondary { background: var(--surface2); border: 1px solid var(--line2); color: var(--ink2); }
    .ac-btn-secondary:hover { background: var(--line); color: var(--ink); }
    .ac-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* ── Assistant prompt / summary ── */
    .prompt-list { display: grid; gap: 7px; margin-top: 10px; }
    .prompt-item { display: flex; gap: 8px; align-items: flex-start; color: var(--ink2); font-size: 13px; line-height: 1.45; }
    .prompt-item span { color: var(--accent); font-weight: 800; line-height: 1.4; }
    .summary-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
    .summary-item { border: 1px solid var(--line); background: var(--surface2); border-radius: var(--r-sm); padding: 11px 12px; }
    .summary-value { font-size: 16px; font-weight: 760; color: var(--ink); line-height: 1.2; }
    .summary-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-top: 3px; }
    .summary-evidence { margin-top: 8px; display: grid; gap: 3px; }
    .summary-evidence div { font: 11px/1.35 var(--mono); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── Card ── */
    .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 18px; }
    .card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: 12px; }

    /* ── Activity card ── */
    .activity-what { font-size: 15px; font-weight: 600; color: var(--ink); margin-bottom: 14px; }
    .activity-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 8px 0; border-top: 1px solid var(--line); font-size: 13px; }
    .activity-label { color: var(--muted); }
    .activity-value { font-weight: 600; text-align: right; }

    /* ── Current session (files) card ── */
    .file-list { display: grid; gap: 6px; margin-bottom: 8px; }
    .file-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--surface2); border: 1px solid var(--line); border-radius: var(--r-sm); min-width: 0; }
    .file-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
    .file-text { min-width: 0; flex: 1; }
    .file-name { font: 13px/1.2 var(--mono); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-path { font: 11px/1.2 var(--mono); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-more { font-size: 12px; color: var(--muted); padding: 4px 0; }
    .no-files { padding: 14px; text-align: center; color: var(--muted); font-size: 13px; line-height: 1.5; border: 1px dashed var(--line2); border-radius: var(--r-sm); }
    .no-files strong { display: block; color: var(--ink2); font-size: 13px; margin-bottom: 2px; }

    /* ── Today's progress ── */
    .stat-row { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
    .stat-item { background: var(--surface2); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 12px; }
    .stat-value { font-size: 22px; font-weight: 760; line-height: 1; color: var(--ink); margin-bottom: 3px; }
    .stat-label { font-size: 11px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }

    /* ── Recent sessions ── */
    .sessions-day { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); padding: 10px 0 6px; border-top: 1px solid var(--line); }
    .sessions-day:first-child { border-top: none; padding-top: 0; }
    .session-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--r-sm); transition: background .1s; }
    .session-row:hover { background: var(--surface2); }
    .session-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line2); flex-shrink: 0; }
    .session-dot.pass { background: var(--ok); }
    .session-dot.warn { background: var(--warn); }
    .session-dot.bad { background: var(--bad); }
    .session-time { font: 13px/1 var(--mono); color: var(--muted); flex-shrink: 0; width: 40px; }
    .session-label { flex: 1; font-size: 13px; font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-meta { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .session-files { font-size: 12px; color: var(--muted); }
    .session-verdict { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 99px; }
    .session-verdict.pass { color: var(--ok); background: var(--ok-bg); }
    .session-verdict.warn { color: var(--warn); background: var(--warn-bg); }
    .session-verdict.bad { color: var(--bad); background: var(--bad-bg); }
    .no-sessions { padding: 20px 10px; text-align: center; color: var(--muted); }
    .no-sessions strong { display: block; font-size: 15px; color: var(--ink); margin-bottom: 4px; }
    .no-sessions p { font-size: 13px; }

    /* ── Health card ── */
    .health-list { display: grid; gap: 8px; }
    .health-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 12px; border-radius: var(--r-sm); border: 1px solid var(--line); background: var(--surface2); }
    .health-label { font-size: 13px; color: var(--ink2); font-weight: 500; }
    .health-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 99px; }
    .health-badge.good { color: var(--ok); background: var(--ok-bg); }
    .health-badge.warn { color: var(--warn); background: var(--warn-bg); }
    .health-badge.missing { color: var(--muted); background: var(--surface2); }
    .trend-dots { display: flex; gap: 6px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); align-items: center; }
    .trend-label { font-size: 11px; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: .05em; flex-shrink: 0; }
    .trend-list { display: flex; gap: 4px; align-items: center; }
    .trend-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--line2); }
    .trend-dot.pass { background: var(--ok); }
    .trend-dot.warn { background: var(--warn); }
    .trend-dot.bad { background: var(--bad); }

    /* ── Next action ── */
    .next-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 22px; margin-bottom: 12px; }
    .next-card.pass { border-color: var(--ok-ring); background: var(--ok-bg); }
    .next-card.warn { border-color: var(--warn-ring); background: var(--warn-bg); }
    .next-card.blocked { border-color: var(--bad-ring); background: var(--bad-bg); }
    .next-top { display: flex; align-items: flex-start; gap: 13px; }
    .next-icon { font-size: 24px; line-height: 1; flex-shrink: 0; margin-top: 1px; }
    .next-title { font-size: 19px; line-height: 1.25; font-weight: 760; letter-spacing: -.2px; }
    .next-body { font-size: 14px; color: var(--ink2); line-height: 1.5; font-weight: 500; margin-top: 4px; max-width: 720px; }
    .next-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
    .next-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 34px; border-radius: var(--r-sm); border: 1px solid var(--line2); background: var(--surface); color: var(--ink); padding: 8px 13px; font: 13px/1 var(--sans); font-weight: 700; cursor: pointer; }
    .next-btn.primary { border-color: var(--accent); background: var(--accent); color: #fff; }
    .next-card.blocked .next-btn.primary { min-height: 40px; padding: 10px 16px; font-size: 14px; box-shadow: 0 1px 6px rgba(37,99,235,.18); }
    .next-btn.danger { border-color: var(--bad); background: var(--bad); color: #fff; }
    .next-btn:disabled { opacity: .65; cursor: wait; }
    .review-steps { display: grid; grid-template-columns: 1fr; gap: 8px; margin-top: 14px; max-width: 560px; }
    .review-step { display: flex; align-items: center; background: rgba(255,255,255,.78); border: 1px solid rgba(0,0,0,.08); border-radius: var(--r-sm); padding: 11px 12px; font-size: 13px; font-weight: 680; color: var(--ink2); }
    .review-step span { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; background: var(--surface); border: 1px solid var(--line2); color: var(--muted); font: 11px/1 var(--mono); margin-right: 9px; flex-shrink: 0; }
    .review-step:first-child { border-color: var(--accent); color: var(--ink); }
    .review-step:first-child span { border-color: var(--accent); color: var(--accent); }
    .review-message { margin-top: 10px; color: var(--bad); font-size: 13px; font-weight: 600; }

    /* ── Timeline ── */
    .tl-list { display: grid; gap: 0; }
    .tl-item { display: flex; align-items: flex-start; gap: 10px; position: relative; padding: 8px 0; }
    .tl-item:not(:last-child)::before { content: ''; position: absolute; left: 17px; top: 28px; bottom: 0; width: 1px; background: var(--line); }
    .tl-icon { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 10px; flex-shrink: 0; margin-top: 2px; }
    .tl-icon.session { background: var(--ok-bg); border: 1px solid var(--ok-ring); color: var(--ok); }
    .tl-icon.watch_start { background: var(--accent-bg); border: 1px solid #bfdbfe; color: var(--accent); }
    .tl-icon.file_change { background: var(--surface2); border: 1px solid var(--line); color: var(--muted); }
    .tl-event { font-size: 13px; font-weight: 500; color: var(--ink); }
    .tl-time { font: 11px/1 var(--mono); color: var(--muted); margin-top: 2px; }
    .tl-empty { color: var(--muted); font-size: 13px; padding: 8px 0; }

    /* ── Advanced details ── */
    .adv-wrap { margin-top: 12px; }
    details { border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; }
    summary { display: flex; align-items: center; gap: 8px; padding: 13px 18px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); cursor: pointer; user-select: none; background: var(--surface); }
    summary::-webkit-details-marker { display: none; }
    summary::before { content: '▶'; font-size: 9px; transition: transform .15s; }
    details[open] summary::before { transform: rotate(90deg); }
    summary:hover { background: var(--surface2); }
    .adv-body { padding: 0 18px 18px; background: var(--surface); }
    .adv-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
    .adv-item { padding: 10px 12px; background: var(--surface2); border: 1px solid var(--line); border-radius: var(--r-sm); }
    .adv-label { font-size: 11px; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
    .adv-value { font: 13px/1.3 var(--mono); color: var(--ink); word-break: break-all; }
    .rpt-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .rpt-card { border: 1px solid var(--line); border-radius: var(--r-sm); padding: 12px; }
    .rpt-name { font-size: 13px; font-weight: 700; margin-bottom: 8px; }
    .rpt-meta { font-size: 12px; color: var(--muted); display: grid; gap: 3px; }
    .rpt-prev details { border: none; border-radius: 0; overflow: visible; }
    .rpt-prev { margin-top: 8px; border-top: 1px solid var(--line); padding-top: 8px; }
    .rpt-prev summary { font-size: 11px; padding: 4px 0; background: transparent; text-transform: none; letter-spacing: 0; font-weight: 600; color: var(--muted); }
    .rpt-prev summary:hover { background: transparent; }
    pre { max-height: 200px; overflow: auto; white-space: pre-wrap; background: var(--surface2); border-radius: var(--r-sm); padding: 10px; font: 11px/1.5 var(--mono); color: var(--ink2); margin: 8px 0 0; }

    /* ── Error ── */
    .err { padding: 32px; text-align: center; }
    .err-title { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
    .err-msg { color: var(--muted); font-size: 13px; }

    /* ── Responsive ── */
    @media (max-width: 860px) {
      .ac-card { grid-template-columns: 1fr; }
      .ac-btns { justify-content: flex-start; }
    }
    @media (max-width: 720px) {
      .page { padding: 14px 12px 40px; }
      .g2, .g2w, .adv-grid, .rpt-grid, .stat-row, .review-steps, .summary-grid { grid-template-columns: 1fr; }
      .banner-title { font-size: 16px; }
      .session-meta { flex-direction: column; align-items: flex-end; gap: 3px; }
    }
  </style>
</head>
<body>
<div class="page">
  <div class="topbar">
    <div>
      <div class="brand-name">DevGuard</div>
      <div class="brand-sub" id="brand-sub"></div>
    </div>
    <div class="topbar-right">
      <button class="btn-refresh" onclick="tick()" id="refreshBtn" aria-label="Refresh dashboard"></button>
      <div class="lang-toggle" role="group" id="langToggle">
        <button type="button" data-lang="en">EN</button>
        <button type="button" data-lang="ko">KO</button>
      </div>
      <div class="timestamp" id="ts"></div>
    </div>
  </div>
  <div id="root"></div>
</div>

<script>
const STRINGS = ${translationsJson};
const root = document.getElementById('root');
const ts = document.getElementById('ts');
const brandSub = document.getElementById('brand-sub');
const refreshBtn = document.getElementById('refreshBtn');
const langBtns = [...document.querySelectorAll('[data-lang]')];
let lang = initLang();
let last = null;
let reviewCompleteUntil = 0;

function initLang() {
  const saved = localStorage.getItem('dg.lang');
  if (saved && STRINGS[saved]) return saved;
  const ls = navigator.languages?.length ? navigator.languages : [navigator.language];
  return ls.some(l => String(l).toLowerCase().startsWith('ko')) ? 'ko' : 'en';
}
function t(k) { return STRINGS[lang]?.[k] || STRINGS.en[k] || k; }
function setLang(l) {
  if (!STRINGS[l]) return;
  lang = l;
  localStorage.setItem('dg.lang', l);
  document.documentElement.lang = l;
  langBtns.forEach(b => b.classList.toggle('active', b.dataset.lang === l));
  brandSub.textContent = t('appSubtitle');
  refreshBtn.textContent = t('refresh');
  if (last) render(last); else root.textContent = t('loading');
}
langBtns.forEach(b => b.addEventListener('click', () => setLang(b.dataset.lang)));

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);

function normalizeDashboardState(s) {
  const reports = s?.reports || {};
  const knowledge = s?.knowledge || {};
  const todayStats = s?.todayStats || {};
  return {
    status: s?.status || 'idle',
    watchingSince: s?.watchingSince || '',
    elapsed: s?.elapsed || '',
    lastActivity: s?.lastActivity || '',
    idleCountdown: s?.idleCountdown || null,
    changeCount: Number.isFinite(s?.changeCount) ? s.changeCount : 0,
    recentFiles: Array.isArray(s?.recentFiles) ? s.recentFiles : [],
    sessionFiles: Array.isArray(s?.sessionFiles) ? s.sessionFiles : [],
    moreFileCount: Number.isFinite(s?.moreFileCount) ? s.moreFileCount : 0,
    sessionFileCount: Number.isFinite(s?.sessionFileCount) ? s.sessionFileCount : 0,
    watchRunning: Boolean(s?.watchRunning),
    initialized: Boolean(s?.initialized),
    empty: Boolean(s?.empty),
    message: s?.message,
    qualityVerdict: s?.qualityVerdict,
    lastProcessedAt: s?.lastProcessedAt,
    sessions: Array.isArray(s?.sessions) ? s.sessions : [],
    todayStats: {
      sessions: Number.isFinite(todayStats.sessions) ? todayStats.sessions : 0,
      filesChanged: Number.isFinite(todayStats.filesChanged) ? todayStats.filesChanged : 0,
      reportsGenerated: Number.isFinite(todayStats.reportsGenerated) ? todayStats.reportsGenerated : 0,
      lastUpdate: todayStats.lastUpdate || ''
    },
    qualityTrend: Array.isArray(s?.qualityTrend) ? s.qualityTrend : [],
    timeline: Array.isArray(s?.timeline) ? s.timeline : [],
    reports: {
      handoffExists: Boolean(reports.handoffExists),
      qualityReportExists: Boolean(reports.qualityReportExists),
      agentContextExists: Boolean(reports.agentContextExists),
      nextClaudePromptExists: Boolean(reports.nextClaudePromptExists),
      nextCodexPromptExists: Boolean(reports.nextCodexPromptExists),
      handoffUpdatedAt: reports.handoffUpdatedAt,
      qualityReportUpdatedAt: reports.qualityReportUpdatedAt,
      agentContextUpdatedAt: reports.agentContextUpdatedAt,
      nextClaudePromptUpdatedAt: reports.nextClaudePromptUpdatedAt,
      nextCodexPromptUpdatedAt: reports.nextCodexPromptUpdatedAt,
      handoffPreview: reports.handoffPreview,
      qualityReportPreview: reports.qualityReportPreview,
      agentContextPreview: reports.agentContextPreview,
      qualitySummary: reports.qualitySummary || { warningCount: 0, blockedCount: 0, requiredVerificationCount: 0 }
    },
    knowledge: {
      exists: Boolean(knowledge.exists),
      updatedAt: knowledge.updatedAt,
      filesIndexed: Number.isFinite(knowledge.filesIndexed) ? knowledge.filesIndexed : 0,
      architectureModules: Number.isFinite(knowledge.architectureModules) ? knowledge.architectureModules : 0,
      framework: knowledge.framework
    },
    setup: s?.setup
  };
}

/* ─ Status view ─ */
function statusView(s) {
  if (s.setup?.active) return { icon:'🔵', cls:'setup', title:t('setupTitle'), body:t('setupBody'), activity:t('activityInit'), next:t('nextStartWatch') };
  if (!s.initialized) return { icon:'⚙️', cls:'offline', title:t('notInitializedTitle'), body:t('notInitializedBody'), cmd:'dev-guard watch', activity:t('activityInit'), next:t('nextInit') };
  if (!s.watchRunning)  return { icon:'⏸', cls:'offline', title:t('watchNotRunningTitle'), body:t('watchNotRunningBody'), cmd:'dev-guard watch', activity:t('activityStartWatch'), next:t('nextStartWatch') };
  const m = {
    working:       { icon:'🟡', cls:'working',      title:t('statusWorkingTitle'),    body:t('statusWorkingBody'),    activity:t('activitySettling'),    next:t('nextSettling') },
    ready_for_done:{ icon:'🔵', cls:'ready_for_done',title:t('statusReadyTitle'),     body:t('statusReadyBody'),      activity:t('activityAiCompletion'),next:t('nextAiCompletion') },
    finalizing:    { icon:'🔵', cls:'finalizing',   title:t('statusFinalizingTitle'), body:t('statusFinalizingBody'), activity:t('activityFinalizing'),  next:t('nextFinalizing') },
    processed:     { icon:'🟣', cls:'processed',    title:t('statusProcessedTitle'),  body:t('statusProcessedBody'),  activity:t('activityProcessed'),   next:t('nextProcessed') }
  };
  return m[s.status] ?? { icon:'🟢', cls:'idle', title:t('statusMonitoringTitle'), body:t('statusMonitoringBody'), activity:t('activityMonitoring'), next:t('nextMonitoring') };
}

/* ─ Time helpers ─ */
function ago(v) { return v ? (lang === 'ko' ? v + ' ' + t('timeAgoSuffix') : v + ' ago') : t('never'); }
function dash(v) { return v || t('unknown'); }
function basename(p) { return p.split('/').pop() || p; }
function dirname(p) { const ps = p.split('/'); return ps.length > 1 ? ps.slice(0,-1).join('/') + '/' : ''; }
function shortTime(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(lang==='ko'?'ko-KR':'en-US', { hour:'2-digit', minute:'2-digit', hour12: false });
}
function relativeTime(ts) {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - Date.parse(ts)) / 1000);
  if (sec < 60) return lang==='ko' ? sec+'초 '+t('timeAgoSuffix') : sec+'s ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return lang==='ko' ? min+'분 '+t('timeAgoSuffix') : min+'m ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return lang==='ko' ? hr+'시간 '+t('timeAgoSuffix') : hr+'h ago';
  return lang==='ko' ? Math.floor(hr/24)+'일 '+t('timeAgoSuffix') : Math.floor(hr/24)+'d ago';
}
function dayLabel(ts) {
  const d = new Date(ts), now = new Date(), yest = new Date(now - 86400000);
  if (d.toDateString() === now.toDateString()) return t('today');
  if (d.toDateString() === yest.toDateString()) return t('yesterday');
  return d.toLocaleDateString(lang==='ko'?'ko-KR':'en-US', { month:'short', day:'numeric' });
}

/* ─ Session label ─ */
function sessionLabel(areas) {
  if (!areas?.length) return t('sessionLabelGeneric');
  if (areas.includes('docs')) return t('sessionLabelDocs');
  if (areas.includes('test')) return t('sessionLabelTests');
  if (areas.includes('cli') && areas.includes('config')) return t('sessionLabelCliConfig');
  if (areas.includes('cli')) return t('sessionLabelCli');
  if (areas.includes('config')) return t('sessionLabelConfig');
  if (areas.includes('api')) return t('sessionLabelApi');
  const first = areas[0];
  const label = first.charAt(0).toUpperCase() + first.slice(1);
  return areas.length > 1 ? label + ' +' + (areas.length - 1) : label;
}
function verdictInfo(v) {
  if (!v) return { cls:'', text:t('verdictUnknown') };
  if (v === 'PASS') return { cls:'pass', text:t('verdictHealthy') };
  if (v === 'BLOCKED') return { cls:'bad', text:t('verdictBlocked') };
  return { cls:'warn', text:t('verdictReview') };
}

/* ─ Health ─ */
function qualityHealth(v) {
  if (!v) return { cls:'missing', icon:'○', label:t('healthUnknown') };
  if (v === 'PASS') return { cls:'good', icon:'✓', label:t('healthGood') };
  return { cls:'warn', icon:'!', label:t('healthWarning') };
}
function boolHealth(exists) {
  return exists ? { cls:'good', icon:'✓', label:t('healthGood') } : { cls:'missing', icon:'○', label:t('healthMissing') };
}
function reportsHealth(s) {
  if (!s.reports.handoffExists && !s.reports.qualityReportExists) return { cls:'missing', icon:'○', label:t('reportsNeverUpdated') };
  const stamp = s.reports.qualityReportUpdatedAt || s.reports.handoffUpdatedAt;
  return { cls:'good', icon:'✓', label: t('reportsUpdated') + (stamp ? ' ' + shortTime(stamp) : '') };
}
function healthBadge(h) { return '<span class="health-badge ' + h.cls + '">' + esc(h.icon) + ' ' + esc(h.label) + '</span>'; }

/* ─ Copy file ─ */
async function copyFile(key, btn) {
  const orig = btn.textContent;
  try {
    const res = await fetch('/api/file?path=' + encodeURIComponent(key));
    if (!res.ok) throw new Error('not found');
    const text = await res.text();
    await navigator.clipboard.writeText(text);
    btn.textContent = t('actionCopied');
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
  } catch {
    btn.textContent = t('actionCopyFailed');
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
  }
}

async function completeReview(btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('reviewCompleteRunning');
  try {
    const res = await fetch('/api/review-complete', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || 'review failed');
    btn.textContent = t('reviewCompleteDone');
    reviewCompleteUntil = Date.now() + 4500;
    setTimeout(() => tick(), 300);
  } catch (e) {
    btn.textContent = orig;
    btn.disabled = false;
    const msg = document.getElementById('reviewMessage');
    if (msg) msg.textContent = t('reviewCompleteFailed');
  }
}

/* ─ Recommended action builder ─ */
function recommendedActionCard(opts, index) {
  const { name, reason, meta, avail, openKey, copyKey, onClick, primary } = opts;
  const cls = (avail ? '' : 'missing') + (primary ? ' primary' : '');
  let btns = '';
  if (avail) {
    if (openKey) btns += '<a class="ac-btn ac-btn-primary" href="/api/file?path=' + esc(openKey) + '" target="_blank" rel="noopener">' + esc(t('actionOpen')) + '</a>';
    if (copyKey) btns += '<button class="ac-btn ac-btn-secondary" onclick="copyFile(' + JSON.stringify(copyKey) + ', this)">' + esc(t('actionCopy')) + '</button>';
    if (onClick) btns += '<button class="ac-btn ac-btn-secondary" onclick="' + esc(onClick) + '">' + esc(t('reviewComplete')) + '</button>';
  }
  return '<div class="ac-card ' + cls + '">' +
    '<div><div class="ac-name">' + esc(index + 1) + '. ' + esc(name) + '</div>' +
    '<div class="ac-reason">' + esc(reason) + '</div>' +
    (meta ? '<div class="ac-meta">' + esc(meta) + '</div>' : '') + '</div>' +
    (btns ? '<div class="ac-btns">' + btns + '</div>' : '') +
    '</div>';
}

function fmt(key, vars) {
  return t(key).replace(/\\{(\\w+)\\}/g, (_, name) => vars[name] ?? '');
}

function shortFileList(files, max = 3) {
  const names = (files || []).slice(0, max).map(f => basename(f));
  const extra = Math.max(0, (files || []).length - max);
  return extra > 0 ? names.concat('+' + extra).join(', ') : names.join(', ');
}

function sessionImpact(s) {
  const files = s.sessionFiles || s.recentFiles || [];
  const docsFiles = files.filter(f => /(^|\\/)(README[^\\/]*|docs\\/)|\\.(md|mdx)$/i.test(f));
  const apiFiles = files.filter(f => /(^|\\/)(app|src\\/app|pages|src\\/pages)\\/api\\/|(^|\\/)api\\/.*\\.[tj]s$|(^|\\/)routes\\/.*\\.[tj]s$|\\/route\\.[tj]s$/i.test(f));
  const dashboardFiles = files.filter(f => /(^|\\/)packages\\/cli\\/src\\/dashboard(?:-[^\\/]*)?\\.[tj]s$|(^|\\/)packages\\/cli\\/src\\/dashboard\\//i.test(f));
  const configFiles = files.filter(f => /(^|\\/)(package\\.json|pnpm-lock\\.yaml|package-lock\\.json|yarn\\.lock|tsconfig[^\\/]*\\.json|vite\\.config\\.[tj]s|next\\.config\\.[tj]s|eslint\\.config\\.[tj]s|\\.env[^\\/]*)$/i.test(f) || /(^|\\/)config\\//i.test(f));
  const cliFiles = files.filter(f => /^packages\\/cli\\/src\\/.+\\.[tj]s$/i.test(f) && !dashboardFiles.includes(f));
  const primary =
    apiFiles.length > 0 ? { key: 'api', label: t('architectureApiChanged'), files: apiFiles } :
    cliFiles.length > 0 ? { key: 'cli', label: t('architectureCliChanged'), files: cliFiles } :
    dashboardFiles.length > 0 ? { key: 'dashboard', label: t('architectureDashboardChanged'), files: dashboardFiles } :
    configFiles.length > 0 ? { key: 'config', label: t('architectureConfigChanged'), files: configFiles } :
    docsFiles.length > 0 ? { key: 'docs', label: t('architectureDocsChanged'), files: docsFiles } :
    { key: 'none', label: t('architectureNoMajorChanges'), files: [] };
  return {
    files,
    docsFiles,
    apiFiles,
    configFiles,
    dashboardFiles,
    cliFiles,
    architecture: apiFiles.length + cliFiles.length + dashboardFiles.length + configFiles.length,
    architectureText: primary.label,
    primaryImpact: primary.key,
    evidenceFiles: primary.files
  };
}

function qualityReason(s, blocked) {
  const q = s.reports.qualitySummary || {};
  if (blocked) {
    if (q.blockedCount > 0) return fmt('reasonBlockedCount', { count: q.blockedCount });
    if (q.warningCount > 0) return fmt('reasonWarningsDetected', { count: q.warningCount });
    return t('actionReasonBlocked');
  }
  if (q.warningCount > 0) return fmt('reasonWarningsDetected', { count: q.warningCount });
  if (q.requiredVerificationCount > 0) return fmt('reasonVerificationCount', { count: q.requiredVerificationCount });
  return t('actionReasonNeedsReview');
}

function knowledgeReason(s, impact) {
  if (!s.knowledge.exists) return t('actionReasonKnowledgeMissing');
  if (impact.evidenceFiles.length > 0) {
    return fmt('reasonChangedFiles', { files: shortFileList(impact.evidenceFiles, 2) });
  }
  return t('actionReasonKnowledgeReady');
}

function handoffReason(s, impact) {
  const count = s.sessionFileCount || impact.files.length || 0;
  return count > 0 ? fmt('reasonFilesChanged', { count }) : t('actionReasonHandoff');
}

function impactEvidence(impact) {
  if (!impact.evidenceFiles.length) return [t('summaryNoImpactEvidence')];
  return impact.evidenceFiles.slice(0, 3).map(file => fmt('summaryFileChanged', { file: basename(file) }));
}

function recommendedActions(s) {
  const impact = sessionImpact(s);
  const promptExists = s.reports.nextClaudePromptExists || s.reports.nextCodexPromptExists;
  const promptKey = s.reports.nextClaudePromptExists ? 'nextclaude' : s.reports.nextCodexPromptExists ? 'nextcodex' : null;
  const knowledgeActionReason = knowledgeReason(s, impact);
  const handoffActionReason = handoffReason(s, impact);
  const actions = [];
  if (s.qualityVerdict === 'BLOCKED') {
    actions.push({ name: t('actionReviewQuality'), reason: qualityReason(s, true), avail: s.reports.qualityReportExists, openKey: 'quality', primary: true });
    actions.push({ name: t('reviewComplete'), reason: t('actionReasonReviewComplete'), avail: true, onClick: 'completeReview(this)' });
    actions.push({ name: t('knowledgeTitle'), reason: knowledgeActionReason, avail: s.knowledge.exists, openKey: 'knowledge', copyKey: 'knowledge', meta: impact.architectureText });
    actions.push({ name: t('actionPromptTitle'), reason: t('actionReasonPromptFix'), avail: promptExists, openKey: promptKey, copyKey: promptKey });
    return actions;
  }
  if (s.qualityVerdict === 'NEEDS_REVIEW') {
    actions.push({ name: t('actionReviewQuality'), reason: qualityReason(s, false), avail: s.reports.qualityReportExists, openKey: 'quality', primary: true });
    actions.push({ name: t('actionContinueWorking'), reason: t('actionReasonContinue'), avail: promptExists, openKey: promptKey, copyKey: promptKey });
    actions.push({ name: t('knowledgeTitle'), reason: knowledgeActionReason, avail: s.knowledge.exists, openKey: 'knowledge', copyKey: 'knowledge', meta: impact.architectureText });
    actions.push({ name: t('actionHandoffTitle'), reason: handoffActionReason, avail: s.reports.handoffExists, openKey: 'handoff', copyKey: 'handoff' });
    return actions;
  }
  actions.push({ name: t('actionContinueFeature'), reason: t('actionReasonPass'), avail: promptExists, openKey: promptKey, copyKey: promptKey, primary: true });
  actions.push({ name: t('knowledgeTitle'), reason: knowledgeActionReason, avail: s.knowledge.exists, openKey: 'knowledge', copyKey: 'knowledge', meta: impact.architectureText });
  actions.push({ name: t('actionHandoffTitle'), reason: handoffActionReason, avail: s.reports.handoffExists, openKey: 'handoff', copyKey: 'handoff' });
  return actions;
}

function assistantPromptLines(s) {
  if (s.qualityVerdict === 'BLOCKED') {
    return [t('promptBlockedQuality'), t('promptBlockedValidate'), t('promptBlockedComplete')];
  }
  if (s.qualityVerdict === 'NEEDS_REVIEW') {
    return [t('promptNeedsReviewReport'), t('promptNeedsReviewContinue')];
  }
  return [t('promptPassContinue')];
}

function sessionSummaryItems(s) {
  const impact = sessionImpact(s);
  const quality = s.qualityVerdict === 'PASS' ? t('verdictHealthy') : s.qualityVerdict === 'BLOCKED' ? t('verdictBlocked') : s.qualityVerdict === 'NEEDS_REVIEW' ? t('verdictReview') : t('verdictUnknown');
  const q = s.reports.qualitySummary || {};
  const fileEvidence = impact.files.length ? impact.files.slice(0, 3).map(f => basename(f)) : [t('summaryNoFiles')];
  const qualityEvidence = q.blockedCount > 0
    ? [fmt('reasonBlockedCount', { count: q.blockedCount })]
    : q.warningCount > 0
      ? [fmt('reasonWarningsDetected', { count: q.warningCount })]
      : q.requiredVerificationCount > 0
        ? [fmt('reasonVerificationCount', { count: q.requiredVerificationCount })]
        : [t('summaryNoQualityIssues')];
  return [
    { label: t('summaryFiles'), value: String(s.sessionFileCount || impact.files.length || 0), evidence: fileEvidence },
    { label: t('summaryDocs'), value: String(impact.docsFiles.length), evidence: impact.docsFiles.length ? impact.docsFiles.slice(0, 2).map(f => basename(f)) : [t('summaryNoDocs')] },
    { label: t('summaryQuality'), value: quality, evidence: qualityEvidence },
    { label: t('summaryArchitecture'), value: impact.architectureText, evidence: impactEvidence(impact) }
  ];
}

function nextActionView(s, v) {
  if (Date.now() < reviewCompleteUntil) {
    return {
      cls: 'pass',
      icon: '✓',
      title: t('reviewCompletedTitle'),
      body: t('reviewCompletedBody')
    };
  }
  if (s.qualityVerdict === 'BLOCKED') {
    return {
      cls: 'blocked',
      icon: '⛔',
      title: t('reviewRequiredTitle'),
      body: t('reviewRequiredBody'),
      primary: t('openQualityReport'),
      primaryHref: '/api/file?path=quality',
      complete: true,
      steps: [t('reviewStepReport'), t('reviewStepRunApp'), t('reviewStepComplete')]
    };
  }
  if (s.qualityVerdict === 'NEEDS_REVIEW') {
    return {
      cls: 'warn',
      icon: '!',
      title: t('reviewRecommendedTitle'),
      body: t('reviewRecommendedBody'),
      primary: s.reports.qualityReportExists ? t('openQualityReport') : null,
      primaryHref: '/api/file?path=quality'
    };
  }
  if (s.qualityVerdict === 'PASS' && (s.status === 'idle' || s.status === 'processed')) {
    return {
      cls: 'pass',
      icon: '✓',
      title: t('monitoringReadyTitle'),
      body: t('monitoringReadyBody')
    };
  }
  return {
    cls: s.status === 'working' || s.status === 'ready_for_done' || s.status === 'finalizing' ? 'warn' : '',
    icon: s.status === 'working' || s.status === 'ready_for_done' || s.status === 'finalizing' ? '…' : '✓',
    title: t('nextActionTitle'),
    body: v.next
  };
}

/* ─ Advanced report block ─ */
function rptBlock(name, exists, updatedAt, preview) {
  const ds = updatedAt ? new Date(updatedAt).toLocaleString(lang==='ko'?'ko-KR':'en-US', { dateStyle:'short', timeStyle:'short' }) : t('notCreated');
  return '<div class="rpt-card">' +
    '<div class="rpt-name">' + esc(name) + '</div>' +
    '<div class="rpt-meta"><div>' + esc(t('availability')) + ': ' + esc(exists ? t('ready') : t('notCreated')) + '</div>' +
    '<div>' + esc(t('lastUpdated')) + ': ' + esc(ds) + '</div></div>' +
    (exists && preview ? '<details class="rpt-prev"><summary>' + esc(t('preview')) + '</summary><pre>' + esc(preview) + '</pre></details>' : '') +
    '</div>';
}

/* ─ Timeline icon/label ─ */
function tlIcon(type) { return type==='session' ? '✓' : type==='watch_start' ? '◉' : '·'; }
function tlLabel(type) { return type==='session' ? t('timelineSession') : type==='watch_start' ? t('timelineWatchStart') : t('timelineFileChange'); }

/* ─ Main render ─ */
function render(s) {
  s = normalizeDashboardState(s);
  last = s;
  const v = statusView(s);

  /* Status banner */
  const banner = '<div class="banner ' + esc(v.cls) + '">' +
    '<div class="banner-icon" aria-hidden="true">' + v.icon + '</div>' +
    '<div class="banner-text"><div class="banner-title">' + esc(v.title) + '</div>' +
    '<div class="banner-body">' + esc(v.body) + '</div>' +
    (v.cmd ? '<code class="banner-cmd">' + esc(v.cmd) + '</code>' : '') +
    '</div></div>';

  const setupList = s.setup?.active
    ? '<div class="setup-list">' + (s.setup.steps || []).map(step => {
        const mark = step.status === 'done' ? '✓' : step.status === 'warning' ? '!' : step.status === 'running' ? '…' : '○';
        const cls = step.status === 'warning' ? ' warning' : '';
        return '<div class="setup-item' + cls + '"><span class="setup-mark">' + esc(mark) + '</span><span>' + esc(step.label) + '</span></div>';
      }).join('') + '</div>'
    : '';

  /* Action Center — always shown, cards disabled when file missing */
  const handoffSub = s.reports.handoffExists
    ? (s.reports.handoffUpdatedAt ? t('actionUpdatedPrefix') + ' ' + relativeTime(s.reports.handoffUpdatedAt) : t('actionHandoffSubAvail'))
    : t('actionHandoffSubMissing');
  const qualitySub = s.reports.qualityReportExists
    ? (s.reports.qualityReportUpdatedAt ? t('actionUpdatedPrefix') + ' ' + relativeTime(s.reports.qualityReportUpdatedAt) : t('actionQualitySubAvail'))
    : t('actionQualitySubMissing');
  const contextSub = s.reports.agentContextExists
    ? (s.reports.agentContextUpdatedAt ? t('actionUpdatedPrefix') + ' ' + relativeTime(s.reports.agentContextUpdatedAt) : t('actionContextSubAvail'))
    : t('actionContextSubMissing');
  const promptExists = s.reports.nextClaudePromptExists || s.reports.nextCodexPromptExists;
  const promptUpdatedAt = s.reports.nextClaudePromptUpdatedAt || s.reports.nextCodexPromptUpdatedAt;
  const promptSub = promptExists
    ? (promptUpdatedAt ? t('actionUpdatedPrefix') + ' ' + relativeTime(promptUpdatedAt) : t('actionPromptSubAvail'))
    : t('actionPromptSubMissing');
  const promptOpenKey = s.reports.nextClaudePromptExists ? 'nextclaude' : s.reports.nextCodexPromptExists ? 'nextcodex' : null;
  const promptCopyKey = promptOpenKey;
  const knowledgeSub = s.knowledge.exists
    ? t('knowledgeReady') + ' · ' + s.knowledge.filesIndexed + ' ' + t('knowledgeFiles') + ' · ' + s.knowledge.architectureModules + ' ' + t('knowledgeModules')
    : t('knowledgeMissing');
  const knowledgeHint = s.knowledge.exists
    ? (s.knowledge.updatedAt ? t('actionUpdatedPrefix') + ' ' + relativeTime(s.knowledge.updatedAt) : s.knowledge.framework || null)
    : t('knowledgeHint');
  const actions = recommendedActions(s);

  const actionCenter = '<div class="ac-section">' +
    '<div class="ac-title">' + esc(t('recommendedTitle')) + '</div>' +
    '<div class="ac-list">' +
    actions.map((action, index) => recommendedActionCard(action, index)).join('') +
    '</div></div>';

  /* Activity card */
  const actRows = [
    s.watchingSince ? '<div class="activity-row"><span class="activity-label">' + esc(t('sessionStarted')) + '</span><span class="activity-value">' + esc(s.watchingSince) + '</span></div>' : '',
    s.lastActivity  ? '<div class="activity-row"><span class="activity-label">' + esc(t('lastChange')) + '</span><span class="activity-value">' + esc(ago(s.lastActivity)) + '</span></div>' : '',
    s.changeCount > 0 ? '<div class="activity-row"><span class="activity-label">' + esc(t('changesCount')) + '</span><span class="activity-value">' + esc(s.changeCount) + '</span></div>' : ''
  ].filter(Boolean).join('');
  const actCard = '<div class="card"><div class="card-title">' + esc(t('currentActivityTitle')) + '</div>' +
    '<div class="activity-what">' + esc(v.activity) + '</div>' + actRows + '</div>';

  /* Files card */
  let filesHtml = !s.recentFiles.length
    ? '<div class="no-files"><strong>' + esc(t('noRecentFilesTitle')) + '</strong>' + esc(t('noRecentFilesBody')) + '</div>'
    : '<div class="file-list">' + s.recentFiles.map(f =>
        '<div class="file-item"><div class="file-dot"></div><div class="file-text"><div class="file-name">' + esc(basename(f)) + '</div>' +
        (dirname(f) ? '<div class="file-path">' + esc(dirname(f)) + '</div>' : '') + '</div></div>'
      ).join('') + '</div>' + (s.moreFileCount > 0 ? '<div class="file-more">+' + esc(s.moreFileCount) + ' ' + esc(t('moreFiles')) + '</div>' : '');
  const filesCard = '<div class="card"><div class="card-title">' + esc(t('recentChangesTitle')) + '</div>' + filesHtml + '</div>';

  /* Today's progress card */
  const todayHas = s.todayStats.sessions > 0;
  const statItems = [
    { label: t('todaySessionsLabel'),   value: todayHas ? s.todayStats.sessions         : t('todayNone') },
    { label: t('todayFilesLabel'),      value: todayHas ? s.todayStats.filesChanged      : t('todayNone') },
    { label: t('todayReportsLabel'),    value: todayHas ? s.todayStats.reportsGenerated  : t('todayNone') },
    { label: t('todayLastUpdateLabel'), value: todayHas ? s.todayStats.lastUpdate        : t('todayNone') }
  ];
  const progressCard = '<div class="card"><div class="card-title">' + esc(t('todayProgressTitle')) + '</div>' +
    '<div class="stat-row">' + statItems.map(i => '<div class="stat-item"><div class="stat-value">' + esc(i.value) + '</div><div class="stat-label">' + esc(i.label) + '</div></div>').join('') + '</div></div>';

  /* Recent sessions card */
  let sessionsHtml;
  if (!s.sessions.length) {
    sessionsHtml = '<div class="no-sessions"><strong>' + esc(t('noSessionsTitle')) + '</strong><p>' + esc(t('noSessionsBody')) + '</p></div>';
  } else {
    const groups = {};
    for (const sess of s.sessions) { const d = dayLabel(sess.timestamp); if (!groups[d]) groups[d] = []; groups[d].push(sess); }
    sessionsHtml = Object.entries(groups).map(([day, items]) =>
      '<div class="sessions-day">' + esc(day) + '</div>' +
      items.map(sess => {
        const vi = verdictInfo(sess.qualityVerdict);
        return '<div class="session-row">' +
          '<div class="session-dot ' + vi.cls + '"></div>' +
          '<div class="session-time">' + esc(shortTime(sess.timestamp)) + '</div>' +
          '<div class="session-label">' + esc(sessionLabel(sess.areas)) + '</div>' +
          '<div class="session-meta"><span class="session-files">' + esc(sess.fileCount) + ' ' + esc(t('sessionFiles')) + '</span>' +
          (sess.qualityVerdict ? '<span class="session-verdict ' + vi.cls + '">' + esc(vi.text) + '</span>' : '') +
          '</div></div>';
      }).join('')
    ).join('');
  }
  const sessionsCard = '<div class="card"><div class="card-title">' + esc(t('recentSessionsTitle')) + '</div>' + sessionsHtml + '</div>';

  /* Health card */
  const qh = qualityHealth(s.qualityVerdict);
  const ch = boolHealth(s.reports.agentContextExists);
  const rh = reportsHealth(s);
  const trendDots = s.qualityTrend.length
    ? '<div class="trend-dots"><span class="trend-label">' + esc(t('qualityTrendTitle')) + '</span><div class="trend-list">' +
      s.qualityTrend.map(item => {
        const cls = item.verdict==='PASS' ? 'pass' : item.verdict==='BLOCKED' ? 'bad' : 'warn';
        return '<div class="trend-dot ' + cls + '" title="' + esc(shortTime(item.timestamp)) + '"></div>';
      }).join('') + '</div></div>' : '';
  const healthCard = '<div class="card"><div class="card-title">' + esc(t('healthTitle')) + '</div>' +
    '<div class="health-list">' +
    '<div class="health-row"><span class="health-label">' + esc(t('healthQuality')) + '</span>' + healthBadge(qh) + '</div>' +
    '<div class="health-row"><span class="health-label">' + esc(t('healthContext')) + '</span>' + healthBadge(ch) + '</div>' +
    '<div class="health-row"><span class="health-label">' + esc(t('healthReports')) + '</span>' + healthBadge(rh) + '</div>' +
    '</div>' + trendDots + '</div>';

  const summaryCard = '<div class="card"><div class="card-title">' + esc(t('sessionSummaryTitle')) + '</div>' +
    '<div class="summary-grid">' + sessionSummaryItems(s).map(item =>
      '<div class="summary-item"><div class="summary-value">' + esc(item.value) + '</div><div class="summary-label">' + esc(item.label) + '</div>' +
      '<div class="summary-evidence">' + (item.evidence || []).map(line => '<div>' + esc(line) + '</div>').join('') + '</div></div>'
    ).join('') + '</div></div>';

  /* Next action card */
  const na = nextActionView(s, v);
  const reviewSteps = na.steps?.length
    ? '<div class="review-steps">' + na.steps.map((step, i) => '<div class="review-step"><span>' + (i + 1) + '</span>' + esc(step) + '</div>').join('') + '</div>'
    : '';
  const nextButtons = (na.primary || na.complete)
    ? '<div class="next-actions">' +
      (na.primary ? '<a class="next-btn primary" href="' + esc(na.primaryHref) + '" target="_blank" rel="noopener">' + esc(na.primary) + '</a>' : '') +
      (na.complete ? '<button class="next-btn danger" onclick="completeReview(this)">' + esc(t('reviewComplete')) + '</button>' : '') +
      '</div><div id="reviewMessage" class="review-message" aria-live="polite"></div>'
    : '';
  const nextCard = '<div class="next-card ' + esc(na.cls) + '">' +
    '<div class="next-top"><div class="next-icon" aria-hidden="true">' + esc(na.icon) + '</div><div>' +
    '<div class="next-title">' + esc(na.title) + '</div>' +
    '<div class="next-body">' + esc(na.body) + '</div>' +
    '<div class="prompt-list">' + assistantPromptLines(s).map(line => '<div class="prompt-item"><span>•</span><div>' + esc(line) + '</div></div>').join('') + '</div>' +
    reviewSteps + nextButtons +
    '</div></div></div>';

  /* Timeline */
  const tlHtml = !s.timeline.length
    ? '<div class="tl-empty">' + esc(t('timelineEmpty')) + '</div>'
    : '<div class="tl-list">' + s.timeline.map(ev =>
        '<div class="tl-item"><div class="tl-icon ' + esc(ev.type) + '">' + esc(tlIcon(ev.type)) + '</div>' +
        '<div><div class="tl-event">' + esc(tlLabel(ev.type)) + '</div><div class="tl-time">' + esc(shortTime(ev.time)) + '</div></div></div>'
      ).join('') + '</div>';
  const timelineCard = '<div class="card"><div class="card-title">' + esc(t('timelineTitle')) + '</div>' + tlHtml + '</div>';

  /* Advanced details */
  const advItems = [
    { label: t('sessionDuration'), value: dash(s.elapsed) },
    { label: t('internalStatus'), value: s.status || '—' },
    { label: t('idleCountdown'), value: s.idleCountdown || t('noCountdown') }
  ];
  const advanced = '<div class="adv-wrap"><details>' +
    '<summary>' + esc(t('advancedTitle')) + '</summary>' +
    '<div class="adv-body">' +
    '<div class="adv-grid">' + advItems.map(i => '<div class="adv-item"><div class="adv-label">' + esc(i.label) + '</div><div class="adv-value">' + esc(i.value) + '</div></div>').join('') + '</div>' +
    '<div class="rpt-grid">' +
    rptBlock(t('reportHandoff'), s.reports.handoffExists, s.reports.handoffUpdatedAt, s.reports.handoffPreview) +
    rptBlock(t('reportQuality'), s.reports.qualityReportExists, s.reports.qualityReportUpdatedAt, s.reports.qualityReportPreview) +
    rptBlock(t('reportContext'), s.reports.agentContextExists, s.reports.agentContextUpdatedAt, s.reports.agentContextPreview) +
    '</div></div></details></div>';

  root.innerHTML =
    nextCard + banner + setupList + actionCenter +
    '<div class="gap g2w" style="margin-top:12px">' + actCard + filesCard + '</div>' +
    '<div class="gap g2w" style="margin-top:12px">' + summaryCard + sessionsCard + '</div>' +
    '<div class="gap g2" style="margin-top:12px">' + healthCard + timelineCard + '</div>' +
    advanced;
}

async function tick() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    render(await res.json());
    ts.textContent = t('dashboardUpdated') + ' ' + new Date().toLocaleTimeString(lang==='ko'?'ko-KR':'en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false });
  } catch (e) {
    root.innerHTML = '<div class="err"><div class="err-title">' + esc(t('dashboardUnavailableTitle')) + '</div><div class="err-msg">' + esc(e.message) + '</div></div>';
  }
}

setLang(lang);
tick();
setInterval(tick, 1000);
</script>
</body>
</html>`;
}
