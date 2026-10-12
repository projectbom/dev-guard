import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { fromRoot, readTextFile, readTextFileCapped, readTextFilePrefix } from "./fs.js";
import { logMemSnapshot, memDebugEnabled } from "./mem-debug.js";
import { devguardPaths } from "./paths.js";
import { processDoneEvent, readHistoryRecords, readProjectState, readRuntimeState, refreshRuntimeLocale, type HistoryRecord, type RuntimeState } from "./runtime-state.js";
import { readProjectKnowledge, type ProjectKnowledge } from "./knowledge.js";
import { buildDashboardOverview } from "./dashboard-view.js";
import { getAgentStrategyReport } from "./agent-strategies.js";
import { formatWatchDashboard } from "./watch-format.js";
import { dashboardTranslations } from "./dashboard-i18n.js";
import { resolveOpenAIApiKey, writeConfigValue, writeOpenAIApiKey, type OpenAIKeySource } from "./config.js";
import { getContextEfficiencyReport } from "./context-efficiency.js";

const DEFAULT_PORT = 3737;
const HOST = "127.0.0.1";

// Whitelisted file keys for the /api/file endpoint — prevents path traversal.
const FILE_KEYS: Record<string, string> = {
  handoff: devguardPaths.projectHandoff,
  quality: devguardPaths.qualityReport,
  working: devguardPaths.workingContext,
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
  locale?: string;
  sessions: SessionSummary[];
  todayStats: TodayStats;
  qualityTrend: Array<{ verdict: string; timestamp: string }>;
  timeline: TimelineEvent[];
  reports: {
    handoffExists: boolean;
    qualityReportExists: boolean;
    agentContextExists: boolean;
    workingContextExists: boolean;
    nextClaudePromptExists: boolean;
    nextCodexPromptExists: boolean;
    handoffUpdatedAt?: string;
    qualityReportUpdatedAt?: string;
    agentContextUpdatedAt?: string;
    workingContextUpdatedAt?: string;
    nextClaudePromptUpdatedAt?: string;
    nextCodexPromptUpdatedAt?: string;
    handoffPreview?: string;
    qualityReportPreview?: string;
    agentContextPreview?: string;
    workingContextPreview?: string;
    qualitySummary: QualitySummary;
  };
  knowledge: {
    exists: boolean;
    updatedAt?: string;
    filesIndexed: number;
    architectureModules: number;
    framework?: string;
    sourceRoots: number;
    coverage?: ProjectKnowledge["coverage"];
  };
  setup?: RuntimeState["setupStatus"];
  openAI: {
    configured: boolean;
    source: OpenAIKeySource;
  };
}

export async function runDashboard(root: string, args: string[]): Promise<void> {
  const port = readPort(args);
  const shouldOpenBrowser = !args.includes("--no-open");
  const locale = await refreshRuntimeLocale(root);
  const dashboard = await startDashboardServer(root, { port });
  console.log(dashboard.started ? "DevGuard dashboard running" : "DevGuard dashboard already running");
  console.log("");
  console.log(`Locale: ${locale}`);
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

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceExit = setTimeout(() => process.exit(1), 3000);
    forceExit.unref();
    void dashboard
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export async function startDashboardServer(root: string, options: { port?: number } = {}): Promise<DashboardServerHandle> {
  const port = options.port ?? DEFAULT_PORT;
  const server = createServer((request, response) => {
    void handleRequest(root, request, response);
  });
  // `server.close()`'s callback only fires once every connection has ended —
  // and Node keeps HTTP/1.1 keep-alive sockets open (including idle ones)
  // until the client closes them or they time out. A browser tab left open
  // on the dashboard (which `dev-guard watch` opens automatically) holds
  // exactly such an idle keep-alive connection, so `close()` alone can hang
  // indefinitely. Tracking sockets ourselves and destroying them on close
  // guarantees the callback fires promptly regardless of client behavior.
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
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
        for (const socket of sockets) socket.destroy();
      })
  };
}

async function handleRequest(root: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${HOST}`);
  if (request.method === "POST" && url.pathname === "/api/review-complete") {
    try {
      const result = await processDoneEvent(root, { completionSource: "dashboard-review-complete" });
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
  if (request.method === "POST" && url.pathname === "/api/locale") {
    try {
      const body = await readJsonBody<{ locale?: string }>(request);
      const locale = body.locale === "ko" ? "ko-KR" : body.locale === "en" ? "en-US" : body.locale;
      if (locale !== "ko-KR" && locale !== "en-US") {
        sendJson(response, { ok: false, error: "Unsupported locale" }, 400);
        return;
      }
      await writeConfigValue(root, "locale", locale);
      const resolved = await refreshRuntimeLocale(root);
      sendJson(response, { ok: true, locale: resolved });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/openai-key") {
    try {
      const body = await readJsonBody<{ apiKey?: string; action?: string }>(request);
      if (body.action === "remove") {
        await writeOpenAIApiKey(root, undefined);
        sendJson(response, { ok: true, configured: false, source: "none" });
        return;
      }
      const apiKey = body.apiKey?.trim();
      if (!apiKey) {
        sendJson(response, { ok: false, error: "Missing API key" }, 400);
        return;
      }
      await writeOpenAIApiKey(root, apiKey);
      sendJson(response, { ok: true, configured: true, source: "config" });
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
  // The dashboard's single poll: watch/setup state, the context-efficiency
  // report (cached ~10s server-side) and the five-second overview built from
  // both. /api/state and /api/efficiency stay available on their own.
  if (url.pathname === "/api/overview") {
    try {
      const [state, efficiency] = await Promise.all([getDashboardState(root), getContextEfficiencyReport(root).catch(() => undefined)]);
      const overview = buildDashboardOverview(
        { initialized: state.initialized, watchRunning: state.watchRunning, setupActive: Boolean(state.setup?.active), qualityVerdict: state.qualityVerdict, sessionFileCount: state.sessionFileCount },
        efficiency,
        efficiency?.taskCard?.readPlan
      );
      sendJson(response, { state, efficiency: efficiency ?? null, overview });
    } catch (error) {
      sendJson(response, { error: errorMessage(error) }, 500);
    }
    return;
  }
  // Context Efficiency on its own (cached ~10s server-side).
  if (url.pathname === "/api/efficiency") {
    try {
      sendJson(response, await getContextEfficiencyReport(root));
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

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

async function getDashboardState(root: string): Promise<DashboardState> {
  const initialized = await isDevGuardInitialized(root);
  const [runtime, strategyReport, reports, projectState, history, knowledge, openAI] = await Promise.all([
    readRuntimeState(root),
    getAgentStrategyReport(root),
    readReportState(root),
    readProjectState(root),
    readHistoryRecords(root, 20),
    readKnowledgeState(root),
    resolveOpenAIApiKey(root)
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
    locale: runtime.locale,
    sessions,
    todayStats,
    qualityTrend,
    timeline,
    reports,
    knowledge,
    setup: runtime.setupStatus,
    openAI: {
      configured: openAI.configured,
      source: openAI.source
    }
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
    framework: knowledge?.summary.framework,
    sourceRoots: knowledge?.summary.sourceRoots?.length ?? 0,
    ...(knowledge?.coverage ? { coverage: knowledge.coverage } : {})
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
  // Polled every second by the dashboard's own tick() — only quality
  // actually needs full content (summarizeQualityReport scans for ##
  // headings that can appear anywhere in the document); the other three
  // only ever display a short preview, so reading their full content on
  // every poll just to immediately slice(0, 1800) it was pure waste that
  // scales with report size for no benefit. See readKnownPreview /
  // readPreviewOnly below.
  const [handoff, quality, working, context, nextClaude, nextCodex] = await Promise.all([
    readPreviewOnly(root, devguardPaths.projectHandoff),
    readKnownPreview(root, devguardPaths.qualityReport),
    readPreviewOnly(root, devguardPaths.workingContext),
    readPreviewOnly(root, devguardPaths.agentContext),
    checkFileInfo(root, devguardPaths.nextClaudePrompt),
    checkFileInfo(root, devguardPaths.nextCodexPrompt)
  ]);
  return {
    handoffExists: handoff.exists,
    qualityReportExists: quality.exists,
    workingContextExists: working.exists,
    agentContextExists: context.exists,
    nextClaudePromptExists: nextClaude.exists,
    nextCodexPromptExists: nextCodex.exists,
    handoffUpdatedAt: handoff.updatedAt,
    qualityReportUpdatedAt: quality.updatedAt,
    workingContextUpdatedAt: working.updatedAt,
    agentContextUpdatedAt: context.updatedAt,
    nextClaudePromptUpdatedAt: nextClaude.updatedAt,
    nextCodexPromptUpdatedAt: nextCodex.updatedAt,
    handoffPreview: handoff.preview,
    qualityReportPreview: quality.preview,
    workingContextPreview: working.preview,
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
  // Capped, not plain readTextFile: this file is re-read on every 1s
  // dashboard poll for the lifetime of the `watch` session, so a future
  // generator bug producing a runaway quality-report.md must not turn
  // "every second, forever" into "every second, forever, at unbounded
  // size" — see readTextFileCapped.
  const [text, info] = await Promise.all([readTextFileCapped(absolute), stat(absolute)]);
  return { exists: true, updatedAt: info.mtime.toISOString(), preview: text.slice(0, 1800), text };
}

/**
 * Same exists/updatedAt/preview shape as readKnownPreview, for the three
 * callers that only ever show the preview and never read `.text` — reads
 * only the first ~4KB (comfortably more than the 1800-char preview, so a
 * heading or marker landing just past byte 1800 isn't cut mid-preview)
 * regardless of how large the underlying file actually is.
 */
async function readPreviewOnly(root: string, path: string): Promise<{ exists: boolean; updatedAt?: string; preview?: string }> {
  const absolute = fromRoot(root, path);
  if (!(await fileExists(absolute))) {
    return { exists: false };
  }
  const [prefix, info] = await Promise.all([readTextFilePrefix(absolute, 4096), stat(absolute)]);
  return { exists: true, updatedAt: info.mtime.toISOString(), preview: prefix?.slice(0, 1800) };
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

let dashboardRequestCount = 0;
let dashboardResponseBytes = 0;

function sendJson(response: ServerResponse, data: unknown, statusCode = 200): void {
  const body = `${JSON.stringify(data, null, 2)}\n`;
  if (memDebugEnabled()) {
    dashboardRequestCount += 1;
    dashboardResponseBytes += Buffer.byteLength(body, "utf8");
    if (dashboardRequestCount % 5 === 0) {
      logMemSnapshot("dashboard:sendJson", {
        dashboardRequestCount,
        dashboardResponseBytes,
        lastResponseBytes: Buffer.byteLength(body, "utf8")
      });
    }
  }
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
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

    /* ── Compact overview: NOW → this task → context flow → details ── */
    #root { display: grid; gap: 12px; }
    .ov-now { background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--ok); border-radius: var(--r); padding: 14px 16px; display: grid; gap: 10px; }
    .ov-now.health-SETTING_UP { border-left-color: var(--accent); }
    .ov-now.health-ATTENTION { border-left-color: var(--bad); }
    .ov-pills { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .ov-pill { display: flex; flex-direction: column; gap: 3px; padding: 8px 12px; border-radius: var(--r-sm); background: var(--ok-bg); border: 1px solid var(--ok-ring); min-width: 0; }
    .ov-pill b { font-size: 16px; line-height: 1.25; }
    .ov-pill.health-SETTING_UP { background: var(--accent-bg); border-color: #bfdbfe; }
    .ov-pill.health-ATTENTION, .ov-pill.thread-NEW_THREAD { background: var(--bad-bg); border-color: var(--bad-ring); }
    .ov-pill.thread-SOON { background: var(--warn-bg); border-color: var(--warn-ring); }
    .ov-k { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
    .ov-line { display: grid; grid-template-columns: 116px minmax(0, 1fr); gap: 10px; align-items: baseline; }
    .ov-task { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ov-issue { font-size: 14px; color: var(--ink2); }
    .ov-issue.has-issue { color: var(--ink); font-weight: 700; }
    .ov-action { padding-top: 8px; border-top: 1px solid var(--line); font-size: 14px; }
    .ov-cmd { font: 12px var(--mono); background: var(--surface2); border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; }
    .ov-btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .ov-block { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 12px 14px; display: grid; gap: 8px; }
    .ov-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; }
    .ov-metric { background: var(--surface2); border-radius: var(--r-sm); padding: 8px 10px; min-width: 0; }
    .ov-v { font-size: 15px; font-weight: 700; overflow-wrap: anywhere; }
    .ov-note { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .ov-ev { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); border-bottom: 1px dotted var(--line2); cursor: help; }
    .ov-details > summary, .ov-sub > summary { cursor: pointer; font-size: 13px; font-weight: 600; color: var(--ink2); }
    .ov-details { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 10px 14px; }
    .ov-details-body { display: grid; gap: 6px; margin-top: 10px; }
    .ov-sub { border-top: 1px solid var(--line); padding-top: 6px; }
    .ov-sub > summary { font-weight: 500; font-size: 12.5px; }
    .ov-sub-body { padding: 8px 0 4px; }
    .muted { color: var(--muted); }
    @media (max-width: 640px) {
      .ov-line { grid-template-columns: 1fr; gap: 2px; }
      .ov-pills { grid-template-columns: 1fr; }
    }

    /* ── Context Efficiency (detail rows, bars, legends) ── */
    .eff:empty { display: none; }
    .eff { margin-bottom: 12px; display: grid; gap: 10px; }
    .eff-note { font-size: 11.5px; color: var(--ink2); margin-top: 2px; }
    .stack { display: flex; height: 14px; border-radius: 4px; overflow: hidden; background: var(--line); }
    .stack span { height: 100%; min-width: 0; }
    .eff-row { display: grid; grid-template-columns: minmax(90px, 30%) 1fr auto; gap: 8px; align-items: center; font-size: 12px; margin: 5px 0; }
    .eff-row .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink2); }
    .eff-row .num { font: 11px/1 var(--mono); color: var(--muted); white-space: nowrap; }
    .legend { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; color: var(--ink2); margin-top: 8px; }
    .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
    .ev { display: inline-block; font: 9.5px/1 var(--mono); padding: 2px 4px; border-radius: 3px; border: 1px solid var(--line2); color: var(--muted); margin-left: 4px; vertical-align: 1px; cursor: help; }
    .eff-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 12px; }
    .eff-kv dt { color: var(--muted); }
    .eff-kv dd { margin: 0; overflow-wrap: anywhere; }
    .eff-recs li { padding: 7px 0; border-top: 1px solid var(--line); font-size: 12.5px; }
    .eff-recs li:first-child { border-top: 0; }
    .eff-recs .why { color: var(--muted); font-size: 11.5px; }
    .roll-CONTINUE { color: var(--ok); } .roll-NEW_THREAD_SOON { color: var(--warn); } .roll-NEW_THREAD_RECOMMENDED { color: var(--bad); }
    .tl svg { width: 100%; height: 130px; display: block; }
    .eff-legend-line { font-size: 10.5px; color: var(--muted); }
    @media (max-width: 640px) { .eff-tile.wide { grid-column: auto; } .eff-row { grid-template-columns: 1fr auto; } .eff-row .bar, .eff-row .stack { grid-column: 1 / -1; } }

    /* ── Reset ── */
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
    h1, h2, h3, p { margin: 0; }
    ul { margin: 0; padding: 0; list-style: none; }
    a { color: inherit; text-decoration: none; }

    /* ── Page ── */
    .page { max-width: 1060px; margin: 0 auto; padding: 18px 18px 42px; }

    /* ── Top bar ── */
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
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
    .banner.idle { background: var(--ok-bg); border-color: var(--ok-ring); }
    .banner.working { background: var(--warn-bg); border-color: var(--warn-ring); }
    .banner.finalizing, .banner.ready_for_done { background: var(--accent-bg); border-color: #bfdbfe; }
    .banner.processed { background: var(--purple-bg); border-color: var(--purple-ring); }
    .banner.setup { background: var(--accent-bg); border-color: #bfdbfe; }
    .banner.offline { background: var(--surface); border-color: var(--line2); }
    .section-label { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin-bottom: 6px; }
    .setup-list { display: grid; gap: 6px; margin: -2px 0 12px; padding: 12px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); }
    .setup-item { display: flex; align-items: center; gap: 8px; color: var(--ink2); font-size: 13px; }
    .setup-mark { width: 18px; color: var(--accent); font-weight: 800; text-align: center; }
    .setup-item.warning .setup-mark { color: var(--warn); }

    /* ── Action Center ── */
    .ac-card.primary { border-color: #bfdbfe; background: var(--accent-bg); }
    .mini-btn { border: 1px solid var(--line2); background: var(--ink); color: #fff; border-radius: var(--r-sm); padding: 7px 11px; font: 12px/1 var(--sans); font-weight: 700; cursor: pointer; }
    .mini-btn.ghost { background: var(--surface); color: var(--ink2); }
    .mini-btn:hover { filter: brightness(.96); }
    .quick-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }

    /* ── Assistant prompt / summary ── */

    /* ── Card ── */
    .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 14px; }

    /* ── Activity card ── */

    /* ── Current session (files) card ── */

    /* ── Today's progress ── */

    /* ── Recent sessions ── */
    .session-dot.pass { background: var(--ok); }
    .session-verdict.pass { color: var(--ok); background: var(--ok-bg); }

    /* ── Health card ── */
    .trend-dot.pass { background: var(--ok); }

    /* ── Next action ── */
    .next-card.pass { border-color: var(--ok-ring); background: var(--ok-bg); }
    .next-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 34px; border-radius: var(--r-sm); border: 1px solid var(--line2); background: var(--surface); color: var(--ink); padding: 8px 13px; font: 13px/1 var(--sans); font-weight: 700; cursor: pointer; }
    .next-btn.primary { border-color: var(--accent); background: var(--accent); color: #fff; }
    .next-card.blocked .next-btn.primary { min-height: 40px; padding: 10px 16px; font-size: 14px; box-shadow: 0 1px 6px rgba(37,99,235,.18); }
    .next-btn.danger { border-color: var(--bad); background: var(--bad); color: #fff; }
    .next-btn:disabled { opacity: .65; cursor: wait; }
    .review-message { margin-top: 10px; color: var(--bad); font-size: 13px; font-weight: 600; }

    /* ── Timeline ── */
    .tl-icon.session { background: var(--ok-bg); border: 1px solid var(--ok-ring); color: var(--ok); }
    .tl-icon.watch_start { background: var(--accent-bg); border: 1px solid #bfdbfe; color: var(--accent); }
    .tl-icon.file_change { background: var(--surface2); border: 1px solid var(--line); color: var(--muted); }

    /* ── Advanced details ── */
    details { border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; }
    summary { display: flex; align-items: center; gap: 8px; padding: 13px 18px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); cursor: pointer; user-select: none; background: var(--surface); }
    summary::-webkit-details-marker { display: none; }
    summary::before { content: '▶'; font-size: 9px; transition: transform .15s; }
    details[open] summary::before { transform: rotate(90deg); }
    summary:hover { background: var(--surface2); }
    .rpt-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .rpt-card { border: 1px solid var(--line); border-radius: var(--r-sm); padding: 12px; }
    .rpt-name { font-size: 13px; font-weight: 760; margin-bottom: 3px; }
    .rpt-desc { font-size: 12px; line-height: 1.35; color: var(--muted); margin-bottom: 8px; }
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
    }
    @media (max-width: 720px) {
      .page { padding: 14px 12px 40px; }
      .g2, .g2w, .adv-grid, .rpt-grid, .stat-row, .review-steps, .summary-grid, .settings-body { grid-template-columns: 1fr; }
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
let applyingServerLang = false;
const previewOpen = {};

function initLang() {
  const saved = localStorage.getItem('dg.lang');
  if (saved && STRINGS[saved]) return saved;
  const ls = navigator.languages?.length ? navigator.languages : [navigator.language];
  return ls.some(l => String(l).toLowerCase().startsWith('ko')) ? 'ko' : 'en';
}
function t(k) { return STRINGS[lang]?.[k] || STRINGS.en[k] || k; }
function localeToLang(locale) {
  return String(locale || '').toLowerCase().startsWith('ko') ? 'ko' : String(locale || '').toLowerCase().startsWith('en') ? 'en' : null;
}
function setLang(l, opts = {}) {
  if (!STRINGS[l]) return;
  lang = l;
  localStorage.setItem('dg.lang', l);
  document.documentElement.lang = l;
  langBtns.forEach(b => b.classList.toggle('active', b.dataset.lang === l));
  brandSub.textContent = t('appSubtitle');
  refreshBtn.textContent = t('refresh');
  if (last) renderOverview(last); else root.textContent = t('loading');
  if (!opts.skipPersist) persistLocale(l);
}
async function persistLocale(l) {
  if (applyingServerLang) return;
  try {
    await fetch('/api/locale', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale: l === 'ko' ? 'ko-KR' : 'en-US' })
    });
  } catch {
    // The dashboard language still changes locally; config sync will retry on the next user change.
  }
}
async function setOpenAIKey(btn) {
  const key = window.prompt(t('openAIKeyPrompt'));
  if (!key) return;
  await saveOpenAIKey({ apiKey: key }, btn);
}
async function removeOpenAIKey(btn) {
  if (!window.confirm(t('openAIKeyRemoveConfirm'))) return;
  await saveOpenAIKey({ action: 'remove' }, btn);
}
async function saveOpenAIKey(body, btn) {
  const original = btn ? btn.textContent : '';
  if (btn) btn.textContent = t('saving');
  try {
    const res = await fetch('/api/openai-key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await tick();
  } catch {
    window.alert(t('openAIKeySaveFailed'));
  } finally {
    if (btn) btn.textContent = original;
  }
}
function applyServerLocale(locale) {
  const next = localeToLang(locale);
  if (!next || next === lang) return;
  applyingServerLang = true;
  try {
    setLang(next, { skipPersist: true });
  } finally {
    applyingServerLang = false;
  }
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
    locale: s?.locale,
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
      workingContextExists: Boolean(reports.workingContextExists),
      agentContextExists: Boolean(reports.agentContextExists),
      nextClaudePromptExists: Boolean(reports.nextClaudePromptExists),
      nextCodexPromptExists: Boolean(reports.nextCodexPromptExists),
      handoffUpdatedAt: reports.handoffUpdatedAt,
      qualityReportUpdatedAt: reports.qualityReportUpdatedAt,
      workingContextUpdatedAt: reports.workingContextUpdatedAt,
      agentContextUpdatedAt: reports.agentContextUpdatedAt,
      nextClaudePromptUpdatedAt: reports.nextClaudePromptUpdatedAt,
      nextCodexPromptUpdatedAt: reports.nextCodexPromptUpdatedAt,
      handoffPreview: reports.handoffPreview,
      qualityReportPreview: reports.qualityReportPreview,
      workingContextPreview: reports.workingContextPreview,
      agentContextPreview: reports.agentContextPreview,
      qualitySummary: reports.qualitySummary || { warningCount: 0, blockedCount: 0, requiredVerificationCount: 0 }
    },
    knowledge: {
      exists: Boolean(knowledge.exists),
      updatedAt: knowledge.updatedAt,
      filesIndexed: Number.isFinite(knowledge.filesIndexed) ? knowledge.filesIndexed : 0,
      architectureModules: Number.isFinite(knowledge.architectureModules) ? knowledge.architectureModules : 0,
      framework: knowledge.framework,
      sourceRoots: Number.isFinite(knowledge.sourceRoots) ? knowledge.sourceRoots : 0,
      coverage: knowledge.coverage
    },
    setup: s?.setup,
    openAI: {
      configured: Boolean(s?.openAI?.configured),
      source: s?.openAI?.source || 'none'
    }
  };
}

/* ─ Status view ─ */
function statusView(s) {
  if (s.setup?.active) return { icon:'🔵', cls:'setup', title:t('setupTitle'), body:t('setupBody'), activity:t('activityInit'), next:t('nextStartWatch') };
  if (!s.initialized) return { icon:'⚙️', cls:'offline', title:t('notInitializedTitle'), body:t('notInitializedBody'), cmd:'dev-guard watch', activity:t('activityInit'), next:t('nextInit') };
  if (!s.watchRunning)  return { icon:'⏸', cls:'offline', title:t('watchNotRunningTitle'), body:t('watchNotRunningBody'), cmd:'dev-guard watch', activity:t('activityStartWatch'), next:t('nextStartWatch') };
  if ((s.status === 'idle' || s.status === 'processed') && s.qualityVerdict === 'PASS') return { icon:'✓', cls:'idle', title:t('statusQualityPassTitle'), body:t('statusQualityPassBody'), activity:t('activityMonitoring'), next:t('nextMonitoring') };
  if ((s.status === 'idle' || s.status === 'processed') && s.qualityVerdict === 'NEEDS_REVIEW') return { icon:'!', cls:'working', title:t('statusQualityReviewTitle'), body:t('statusQualityReviewBody'), activity:t('activityProcessed'), next:t('nextReviewQuality') };
  if ((s.status === 'idle' || s.status === 'processed') && s.qualityVerdict === 'BLOCKED') return { icon:'⛔', cls:'offline', title:t('statusQualityBlockedTitle'), body:t('statusQualityBlockedBody'), activity:t('activityProcessed'), next:t('nextReviewQuality') };
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


function fmt(key, vars) {
  return t(key).replace(/\\{(\\w+)\\}/g, (_, name) => vars[name] ?? '');
}










function rememberDetails(name, open) {
  if (name.startsWith('preview:')) previewOpen[name.slice(8)] = open;
}




/* ─ Advanced report block ─ */
function rptBlock(key, name, description, exists, updatedAt, preview) {
  const ds = updatedAt ? new Date(updatedAt).toLocaleString(lang==='ko'?'ko-KR':'en-US', { dateStyle:'short', timeStyle:'short' }) : t('notCreated');
  const openAttr = previewOpen[key] ? ' open' : '';
  return '<div class="rpt-card">' +
    '<div class="rpt-name">' + esc(name) + '</div>' +
    '<div class="rpt-desc">' + esc(description) + '</div>' +
    '<div class="rpt-meta"><div>' + esc(t('availability')) + ': ' + esc(exists ? t('ready') : t('notCreated')) + '</div>' +
    '<div>' + esc(t('lastUpdated')) + ': ' + esc(ds) + '</div></div>' +
    (exists && preview ? '<details class="rpt-prev"' + openAttr + ' ontoggle="rememberDetails(\\'preview:' + esc(key) + '\\', this.open)"><summary>' + esc(t('preview')) + '</summary><pre>' + esc(preview) + '</pre></details>' : '') +
    '</div>';
}


/* ─ Main render: NOW → THIS TASK → CONTEXT FLOW → DETAILS ─ */
// One poll (/api/overview) answers the five-second questions (health,
// task, thread, biggest problem, next action) from the server-side
// overview; everything else is in collapsed details with bounded lists.
const CAT_ORDER = ['MCP','FALLBACK_DOCS','SEARCH','CODE_READS','CODE_EDITS','VALIDATION','ADMIN','OTHER'];
const CAT_COLOR = { MCP:'#2563eb', FALLBACK_DOCS:'#d97706', SEARCH:'#dc2626', CODE_READS:'#0891b2', CODE_EDITS:'#16a34a', VALIDATION:'#7c3aed', ADMIN:'#64748b', OTHER:'#cbd5e1' };
const GROUP_ORDER = ['CODE','SEARCH','DEVGUARD','VALIDATION','CONTEXT_MANAGEMENT','OTHER'];
const GROUP_COLOR = { DEVGUARD:'#2563eb', CODE:'#16a34a', SEARCH:'#dc2626', VALIDATION:'#7c3aed', CONTEXT_MANAGEMENT:'#d97706', OTHER:'#cbd5e1' };
const MODE_ORDER = ['IMPLEMENTATION','EXPLORATION','VALIDATION','CONTEXT_ADMIN','RESUME_RECOVERY','OTHER'];
const TL_COLOR = { TASK_PREPARED:'#2563eb', TASK_DONE:'#16a34a', VALIDATION:'#7c3aed', ROLLOVER_SOON:'#d97706', ROLLOVER_RECOMMENDED:'#dc2626', NEW_THREAD:'#0891b2', COMPACTION:'#111318' };
const LIST_LIMIT = 12;
const detailsOpen = {};
// Estimates never show more precision than they have: ~18K, ~900.
function fmtApprox(n) { n = n || 0; return '~' + (n >= 1000 ? Math.round(n / 1000) + 'K' : String(Math.round(n / 100) * 100)); }
function pct(part, total) { return total > 0 ? Math.round(part / total * 100) : 0; }
function issueText(i) { if (!i) return ''; const k = 'iss_' + i.id + (i.id === 'CONTEXT_PRESSURE' ? '_' + i.severity : ''); return STRINGS[lang]?.[k] && lang !== 'en' ? t(k) : i.issue; }
function actionText(i) { if (!i) return ''; const k = ['act_' + i.id + (i.cause ? '_' + i.cause : ''), 'act_' + i.id].find((key) => STRINGS[lang]?.[key]); return k && lang !== 'en' ? t(k) : i.action; }
function stackBar(costs, total, widthPct, order, colors, prefix) {
  const segs = order.filter(c => (costs[c] || 0) > 0).map(c => '<span title="' + esc(t(prefix + c) + ': ' + fmtApprox(costs[c]) + ' (' + pct(costs[c], total) + '%)') + '" style="width:' + (costs[c] / total * 100).toFixed(2) + '%;background:' + colors[c] + '"></span>').join('');
  return '<div class="stack" style="width:' + (widthPct || 100) + '%">' + segs + '</div>';
}
function legendFor(costs, total, order, colors, prefix) {
  return '<div class="legend">' + order.filter(c => (costs[c] || 0) > 0).map(c => '<span><i style="background:' + colors[c] + '"></i>' + esc(t(prefix + c)) + ' ' + pct(costs[c], total) + '%</span>').join('') + '</div>';
}
function timelineSvg(tl) {
  const pts = tl.cumulative || [];
  const evs = tl.events || [];
  const all = pts.map(p => Date.parse(p.ts)).concat(evs.map(e => Date.parse(e.ts)));
  if (all.length < 2) return '<div class="eff-note">' + esc(t('effNoActivity')) + '</div>';
  const t0 = Math.min(...all), t1 = Math.max(...all), span = Math.max(1, t1 - t0);
  const maxY = Math.max(1, ...pts.map(p => p.estTokens));
  const x = ts => (Date.parse(ts) - t0) / span * 590 + 5;
  const y = v => 118 - v / maxY * 100;
  const line = pts.map(p => x(p.ts).toFixed(1) + ',' + y(p.estTokens).toFixed(1)).join(' ');
  const marks = evs.map(e => '<line x1="' + x(e.ts).toFixed(1) + '" x2="' + x(e.ts).toFixed(1) + '" y1="8" y2="120" stroke="' + (TL_COLOR[e.type] || '#999') + '" stroke-width="' + (e.type === 'COMPACTION' ? 2 : 1) + '"><title>' + esc(t('tl' + e.type) + (e.detail ? ' — ' + e.detail : '') + ' · ' + new Date(e.ts).toLocaleString()) + '</title></line>').join('');
  const types = [...new Set(evs.map(e => e.type))];
  return '<svg viewBox="0 0 600 130" preserveAspectRatio="none" role="img" aria-label="' + esc(t('effTimelineTitle')) + '">' + marks +
    '<polyline points="' + line + '" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>' +
    '<div class="legend">' + types.map(k => '<span><i style="background:' + TL_COLOR[k] + '"></i>' + esc(t('tl' + k)) + '</span>').join('') + '</div>';
}
function kv(label, value) { return '<dt>' + esc(label) + '</dt><dd>' + value + '</dd>'; }
function boundedList(items) {
  if (!items || !items.length) return esc(t('effNone'));
  const shown = items.slice(0, LIST_LIMIT).map(x => esc(x)).join('<br>');
  return items.length > LIST_LIMIT ? shown + '<br><span class="muted">' + esc(fmt('dMore', { n: items.length - LIST_LIMIT })) + '</span>' : shown;
}
function evidenceTag(kind) { return '<span class="ov-ev ev-' + esc(kind) + '" title="' + esc(t('evHelp_' + kind)) + '">' + esc(t('ev_' + kind)) + '</span>'; }
function toggleDetails(el) { detailsOpen[el.dataset.key] = el.open; }
function section(key, title, body) {
  return '<details class="ov-sub" data-key="' + esc(key) + '"' + (detailsOpen[key] ? ' open' : '') + ' ontoggle="toggleDetails(this)"><summary>' + esc(title) + '</summary><div class="ov-sub-body">' + body + '</div></details>';
}
function fmt(key, vars) {
  return t(key).replace(/[{](\\w+)[}]/g, (_, name) => vars[name] ?? '');
}
function metricValue(m) {
  const v = m.value;
  if (!v) return { main: '—', note: m.key === 'context' ? t('ovNotObservable') : t('ovNotRecorded') };
  if (m.key === 'context') return { main: v.percent + '%' };
  if (m.key === 'readPlan') return { main: v.required + ' ' + t('ovRequired') + ' / ' + v.optional + ' ' + t('ovOptional') };
  if (m.key === 'suggestions') return { main: v.used + ' / ' + v.of };
  if (m.key === 'validation') {
    const parts = [];
    if (v.pass) parts.push(v.pass + ' PASS');
    if (v.fail) parts.push(v.fail + ' FAIL');
    if (v.unknown) parts.push(v.unknown + ' UNKNOWN');
    return parts.length ? { main: parts.join(' / ') } : { main: '—', note: t('ovNotRecorded') };
  }
  return { main: String(v.count) };
}
function metricTile(m) {
  const v = metricValue(m);
  return '<div class="ov-metric" data-metric="' + esc(m.key) + '"><div class="ov-k">' + esc(t('m_' + m.key)) + '</div>' +
    '<div class="ov-v">' + esc(v.main) + '</div>' +
    '<div class="ov-note">' + (v.note ? esc(v.note) + ' · ' : '') + evidenceTag(m.evidence) + '</div></div>';
}
function actionBlock(o, s) {
  const a = o.action;
  const text = a.id === 'FIX_ISSUE' ? actionText(o.issue) : t('ovAct_' + a.id);
  let extra = '';
  if (a.command) extra += ' <code class="ov-cmd">' + esc(a.command) + '</code>';
  if (a.id === 'REVIEW_QUALITY' && Date.now() >= reviewCompleteUntil) {
    extra += '<div class="ov-btns">' +
      (s.reports.qualityReportExists ? '<a class="next-btn primary" href="/api/file?path=quality" target="_blank" rel="noopener">' + esc(t('openQualityReport')) + '</a>' : '') +
      (s.qualityVerdict === 'BLOCKED' ? '<button class="next-btn danger" onclick="completeReview(this)">' + esc(t('reviewComplete')) + '</button>' : '') +
      '</div><div id="reviewMessage" class="review-message" aria-live="polite"></div>';
  }
  return '<span data-testid="ov-action-text">' + esc(text) + '</span>' + extra;
}

function renderOverview(data) {
  const s = normalizeDashboardState(data.state);
  const o = data.overview;
  const d = data.efficiency && !data.efficiency.error ? data.efficiency : null;
  applyServerLocale(s.locale);
  last = data;
  if (!o) { root.innerHTML = ''; return; }

  /* NOW — health, thread, task, primary issue, one action */
  const now = '<section class="ov-now health-' + esc(o.health.level) + '" data-testid="ov-now">' +
    '<div class="section-label">' + esc(t('ovNow')) + '</div>' +
    '<div class="ov-pills">' +
      '<div class="ov-pill health-' + esc(o.health.level) + '" data-testid="ov-health" title="' + esc(t('ovHealthReason_' + o.health.reason)) + '"><span class="ov-k">' + esc(t('ovHealth')) + '</span><b>' + esc(t('ovHealth_' + o.health.level)) + '</b></div>' +
      '<div class="ov-pill thread-' + esc(o.thread.level) + '" data-testid="ov-thread" title="' + esc(o.thread.reason) + '"><span class="ov-k">' + esc(t('ovThread')) + '</span><b>' + esc(t('ovThread_' + o.thread.level)) + '</b></div>' +
    '</div>' +
    '<div class="ov-line"><span class="ov-k">' + esc(t('ovTask')) + '</span><div class="ov-task" data-testid="ov-task" title="' + esc(o.task || '') + '">' + esc(o.task || t('ovNoTask')) + '</div></div>' +
    '<div class="ov-line"><span class="ov-k">' + esc(t('ovIssue')) + '</span><div class="ov-issue' + (o.issue ? ' has-issue' : '') + '" data-testid="ov-issue"' + (o.issue ? ' title="' + esc(o.issue.why) + '"' : '') + '>' + esc(o.issue ? issueText(o.issue) : t('ovNoIssue')) + '</div></div>' +
    '<div class="ov-line ov-action"><span class="ov-k">' + esc(t('ovAction')) + '</span><div data-testid="ov-action">' + actionBlock(o, s) + '</div></div>' +
    '</section>';

  /* THIS TASK — at most five numbers */
  const metrics = o.metrics.length
    ? '<section class="ov-block" data-testid="ov-metrics"><div class="section-label">' + esc(t('ovTaskSection')) + '</div><div class="ov-metrics">' + o.metrics.map(metricTile).join('') + '</div></section>'
    : '';

  /* CONTEXT FLOW — the one chart */
  let flow = '';
  if (o.flow) {
    const total = Object.values(o.flow.groups).reduce((a, b) => a + b, 0);
    flow = '<section class="ov-block" data-testid="ov-flow"><div class="section-label">' + esc(t('ovFlow')) + ' · ' + esc(fmtApprox(o.flow.approxTokens)) + ' ' + evidenceTag('ESTIMATED') + '</div>' +
      (total > 0 ? stackBar(o.flow.groups, total, 100, GROUP_ORDER, GROUP_COLOR, 'grp') + legendFor(o.flow.groups, total, GROUP_ORDER, GROUP_COLOR, 'grp') : '<div class="eff-note">' + esc(t('effNoActivity')) + '</div>') +
      '<div class="eff-legend-line">' + esc(t('ovFlowNote')) + '</div></section>';
  }

  /* DETAILS — collapsed, each section bounded */
  const cur = d?.current;
  const card = d?.taskCard;
  const sections = [];
  if (card) {
    sections.push(section('readplan', t('dReadPlan'), '<dl class="eff-kv">' +
      kv(t('effGoal'), esc(card.goal)) + kv(t('effNext'), esc(card.nextAction || '—')) +
      kv(t('effTargets'), boundedList(card.edit)) + kv(t('effCandidatesList'), boundedList(card.candidates)) +
      kv(t('effReference'), boundedList(card.reference)) + kv(t('effProtected'), boundedList(card.protected)) +
      kv(t('effCarried'), card.carriedOver != null ? esc(card.carriedOver) : '—') + '</dl>'));
  }
  if (cur) {
    sections.push(section('lineage', t('dLineage'), '<dl class="eff-kv">' +
      kv(t('dPlanOutside'), esc(cur.nonProvidedReads.files + ' · ' + fmtApprox(cur.nonProvidedReads.estTokens))) +
      kv(t('dMissingScripts'), boundedList(cur.missingScripts || [])) +
      kv(t('dGapCause'), esc(cur.executionGapCause || '—')) + '</dl>'));
    sections.push(section('search', t('dSearch'), '<dl class="eff-kv">' +
      kv(t('mSearches'), esc(cur.searchCalls)) + kv(t('effBroad'), esc(cur.broadSearchCalls + ' / ' + cur.searchCalls)) +
      kv(t('effSearchFirst'), esc(cur.searchBeforeProvidedRead ? t('effYes') : t('effNo'))) +
      kv(t('effFallbackReads'), esc(cur.fallbackDocReads)) + '</dl>'));
  }
  sections.push(section('validation', t('dValidation'), '<dl class="eff-kv">' +
    (cur ? kv(t('m_validation'), esc(cur.validation.pass + ' PASS · ' + cur.validation.fail + ' FAIL · ' + cur.validation.unknown + ' UNKNOWN')) : '') +
    (card ? kv(t('effFresh'), boundedList(card.freshValidation)) + kv(t('effOpen'), boundedList(card.openValidation)) : '') +
    kv(t('dQuality'), esc(s.qualityVerdict || '—')) + '</dl>'));
  if (d) {
    const recent = (d.recent || []).slice(-8);
    const maxTask = Math.max(1, ...recent.map(r => r.estTokens || 0));
    sections.push(section('timeline', t('dTimeline'), timelineSvg(d.timeline || {}) +
      recent.map(r => '<div class="eff-row"><span class="lbl" title="' + esc(r.label) + '">' + esc(r.label) + '</span>' + (r.estTokens > 0 ? stackBar(r.costByCategory, r.estTokens, Math.max(2, r.estTokens / maxTask * 100), CAT_ORDER, CAT_COLOR, 'cat') : '<div></div>') + '<span class="num">' + fmtApprox(r.estTokens) + (r.sameThreadAsPrevious ? ' ↺' : '') + (r.compactions ? ' ⧉' + r.compactions : '') + '</span></div>').join('') +
      '<div class="eff-legend-line">↺ ' + esc(t('effSameThread')) + ' · ⧉ ' + esc(t('tlCOMPACTION')) + ' · ' + esc(t('effTimelineNote')) + '</div>'));
  }
  if (o.secondaryIssues.length) {
    sections.push(section('issues', t('dIssues') + ' (' + o.secondaryIssues.length + ')', '<ul class="eff-recs">' +
      o.secondaryIssues.map(i => '<li>' + esc(issueText(i)) + '<div class="why">' + esc(actionText(i)) + ' · ' + esc(i.why) + '</div></li>').join('') + '</ul>'));
  }
  const promptKey = s.reports.nextClaudePromptExists ? 'nextclaude' : s.reports.nextCodexPromptExists ? 'nextcodex' : null;
  sections.push(section('artifacts', t('dArtifacts'), '<div class="rpt-grid">' +
    rptBlock('quality', t('reportQuality'), t('reportQualityDesc'), s.reports.qualityReportExists, s.reports.qualityReportUpdatedAt, s.reports.qualityReportPreview) +
    rptBlock('handoff', t('reportHandoff'), t('reportHandoffDesc'), s.reports.handoffExists, s.reports.handoffUpdatedAt, s.reports.handoffPreview) +
    rptBlock('working', t('reportWorking'), t('reportWorkingDesc'), s.reports.workingContextExists, s.reports.workingContextUpdatedAt, s.reports.workingContextPreview) +
    rptBlock('context', t('reportContext'), t('reportContextDesc'), s.reports.agentContextExists, s.reports.agentContextUpdatedAt, s.reports.agentContextPreview) +
    '</div>' + (promptKey ? '<div class="ov-btns"><button class="mini-btn" onclick="copyFile(\\'' + promptKey + '\\', this)">' + esc(t('actionPromptTitle')) + ' — ' + esc(t('actionCopy')) + '</button></div>' : '')));
  const v = statusView(s);
  const steps = s.setup?.steps?.length ? '<div class="setup-list">' + s.setup.steps.map(step => '<div class="setup-item' + (step.status === 'warning' ? ' warning' : '') + '"><span class="setup-mark">' + esc(step.status === 'done' ? '✓' : step.status === 'warning' ? '!' : step.status === 'running' ? '…' : '○') + '</span><span>' + esc(step.label) + '</span></div>').join('') + '</div>' : '';
  sections.push(section('setup', t('dSetup'), '<dl class="eff-kv">' +
    kv(t('dWatch'), esc(v.title)) + kv(t('sessionDuration'), esc(dash(s.elapsed))) + kv(t('lastChange'), esc(ago(s.lastActivity))) +
    kv(t('language'), esc(s.locale || t('unknown'))) +
    (d ? (d.sources || []).map(x => kv(x.provider, esc(x.available ? x.userThreads + ' ' + t('effUserThreads') + (x.subagentThreads ? ', ' + x.subagentThreads + ' ' + t('effSubagents') : '') : (x.note || '—')))).join('') : '') +
    kv(t('openAIKeyTitle'), esc(s.openAI.configured ? t('openAIKeyConfigured') : t('openAIKeyNotConfigured')) +
      ' <button class="mini-btn" onclick="setOpenAIKey(this)">' + esc(s.openAI.configured ? t('openAIKeyUpdate') : t('openAIKeySet')) + '</button>' +
      (s.openAI.configured && s.openAI.source === 'config' ? ' <button class="mini-btn ghost" onclick="removeOpenAIKey(this)">' + esc(t('openAIKeyRemove')) + '</button>' : '')) +
    '</dl>' + steps));
  const k = s.knowledge;
  sections.push(section('project', t('dProject'), '<dl class="eff-kv">' +
    kv(t('dFramework'), esc(k.framework || t('unknown'))) + kv(t('dWorkspaces'), esc(k.sourceRoots)) +
    kv(t('dIndexed'), esc(k.filesIndexed)) + kv(t('dFreshness'), esc(k.updatedAt ? relativeTime(k.updatedAt) : t('knowledgeMissing'))) +
    (k.coverage ? kv(t('dCoverage'), esc(Object.entries(k.coverage).map(([name, c]) => t('cov_' + name) + ' ' + c.kept + '/' + c.detected).join(' · '))) : '') +
    '</dl>' + (k.exists ? '<div class="ov-btns"><a class="mini-btn" href="/api/file?path=knowledge" target="_blank" rel="noopener">' + esc(t('actionOpen')) + '</a></div>' : '')));
  if (d) {
    const u = cur?.candidateUtilization;
    sections.push(section('raw', t('dRaw'), '<dl class="eff-kv">' +
      kv('health', esc(d.now.health)) + kv('thread', esc(o.thread.raw + ' (' + o.thread.evidence + ') — ' + o.thread.reason)) +
      kv('status', esc(s.status)) +
      (cur ? kv(t('effProvidedFiles'), esc(cur.provided.files + (cur.provided.ranges != null ? ' · ' + cur.provided.ranges + ' ranges' : ''))) +
        kv(t('effUsedFiles'), esc(cur.usedFiles)) + kv(t('effUsedFromDevGuard'), esc(cur.providedUsed)) + kv(t('effDiscovered'), esc(cur.nonProvidedUsed)) +
        kv(t('effUtil'), esc(u ? u.used + ' / ' + u.of : '—')) + kv(t('effUnusedReads'), esc(cur.unusedSuggestionReads.files + ' · ' + fmtApprox(cur.unusedSuggestionReads.estTokens))) +
        kv(t('effPeakUse'), esc(cur.peakContextUse != null ? Math.round(cur.peakContextUse * 100) + '%' : '—')) +
        kv(t('effModeTitle'), esc(MODE_ORDER.filter(m => (cur.modeTokens[m] || 0) > 0).map(m => t('mode' + m) + ' ' + pct(cur.modeTokens[m], cur.estTokens) + '%').join(' · ') || '—')) : '') +
      '</dl><div class="eff-legend-line">' + esc(t('effLegend')) + '</div>'));
  }
  const details = '<details class="ov-details" data-testid="ov-details" data-key="details"' + (detailsOpen.details ? ' open' : '') + ' ontoggle="toggleDetails(this)"><summary>' + esc(t('ovDetails')) + '</summary><div class="ov-details-body">' + sections.join('') + '</div></details>';

  root.innerHTML = now + metrics + flow + details;
}

async function tick() {
  try {
    const res = await fetch('/api/overview', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    renderOverview(await res.json());
    ts.textContent = t('dashboardUpdated') + ' ' + new Date().toLocaleTimeString(lang==='ko'?'ko-KR':'en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false });
  } catch (e) {
    root.innerHTML = '<div class="err"><div class="err-title">' + esc(t('dashboardUnavailableTitle')) + '</div><div class="err-msg">' + esc(e.message) + '</div></div>';
  }
}
setLang(lang);
tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;
}
