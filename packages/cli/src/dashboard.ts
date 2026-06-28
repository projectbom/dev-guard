import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { fromRoot, readTextFile } from "./fs.js";
import { devguardPaths } from "./paths.js";
import { readProjectState, readRuntimeState, type RuntimeState } from "./runtime-state.js";
import { getAgentStrategyReport } from "./agent-strategies.js";
import { formatWatchDashboard } from "./watch-format.js";
import { dashboardTranslations } from "./dashboard-i18n.js";

const DEFAULT_PORT = 3737;
const HOST = "127.0.0.1";

export interface DashboardServerHandle {
  url: string;
  started: boolean;
  close: () => Promise<void>;
}

interface DashboardState {
  status: string;
  watchingSince: string;
  elapsed: string;
  lastActivity: string;
  idleCountdown: string | null;
  changeCount: number;
  recentFiles: string[];
  moreFileCount: number;
  watchRunning: boolean;
  initialized: boolean;
  empty: boolean;
  message?: string;
  qualityVerdict?: string;
  lastProcessedAt?: string;
  reports: {
    handoffExists: boolean;
    qualityReportExists: boolean;
    agentContextExists: boolean;
    handoffUpdatedAt?: string;
    qualityReportUpdatedAt?: string;
    agentContextUpdatedAt?: string;
    handoffPreview?: string;
    qualityReportPreview?: string;
    agentContextPreview?: string;
  };
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
  sendText(response, 404, "Not found");
}

async function getDashboardState(root: string): Promise<DashboardState> {
  const initialized = await isDevGuardInitialized(root);
  const [runtime, strategyReport, reports, projectState] = await Promise.all([
    readRuntimeState(root),
    getAgentStrategyReport(root),
    readReportState(root),
    readProjectState(root)
  ]);
  const runtimeVerified = strategyReport.strategies.some((strategy) => strategy.name !== "manual" && strategy.runtimeVerified);
  const autoMode = strategyReport.strategies.some((strategy) => strategy.name !== "manual" && strategy.installed);
  const dashboard = formatWatchDashboard(runtime, {
    autoMode,
    manual: false,
    runtimeVerified
  });
  const watchRunning = isWatchRunning(runtime);
  const recentFiles = recentChangedFiles(runtime);
  const empty = initialized && !watchRunning && !runtime.watchStartedAt && runtime.pendingChangedFiles.length === 0;

  return {
    status: normalizeStatus(dashboard.status),
    watchingSince: runtime.watchStartedAt ? formatTime(runtime.watchStartedAt) : "",
    elapsed: runtime.watchStartedAt ? formatDurationSince(runtime.watchStartedAt) : "",
    lastActivity: runtime.lastActivityAt ? formatDurationSince(runtime.lastActivityAt) : "",
    idleCountdown: normalizeStatus(dashboard.status) === "working" && runtime.lastStatus !== "finalizing" ? formatCountdown(runtime.idleDeadlineAt) : null,
    changeCount: runtime.changeCountSinceIdle ?? runtime.pendingChangedFiles.length,
    recentFiles,
    moreFileCount: Math.max(0, runtime.pendingChangedFiles.length - recentFiles.length),
    watchRunning,
    initialized,
    empty,
    message: initialized ? (watchRunning ? undefined : "Watch is not running.") : "DevGuard is not initialized.",
    qualityVerdict: projectState.lastQualityVerdict ?? undefined,
    lastProcessedAt: projectState.lastProcessedAt ?? undefined,
    reports
  };
}

async function readReportState(root: string): Promise<DashboardState["reports"]> {
  const [handoff, quality, context] = await Promise.all([
    readKnownPreview(root, devguardPaths.projectHandoff),
    readKnownPreview(root, devguardPaths.qualityReport),
    readKnownPreview(root, devguardPaths.agentContext)
  ]);
  return {
    handoffExists: handoff.exists,
    qualityReportExists: quality.exists,
    agentContextExists: context.exists,
    handoffUpdatedAt: handoff.updatedAt,
    qualityReportUpdatedAt: quality.updatedAt,
    agentContextUpdatedAt: context.updatedAt,
    handoffPreview: handoff.preview,
    qualityReportPreview: quality.preview,
    agentContextPreview: context.preview
  };
}

async function readKnownPreview(root: string, path: string): Promise<{ exists: boolean; updatedAt?: string; preview?: string }> {
  const absolute = fromRoot(root, path);
  if (!(await fileExists(absolute))) {
    return { exists: false };
  }
  const [text, info] = await Promise.all([readTextFile(absolute), stat(absolute)]);
  return { exists: true, updatedAt: info.mtime.toISOString(), preview: text.slice(0, 1800) };
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

function recentChangedFiles(runtime: RuntimeState): string[] {
  const files = new Set<string>();
  if (runtime.lastChangedFile) files.add(runtime.lastChangedFile);
  for (const file of runtime.pendingChangedFiles) files.add(file);
  return [...files].slice(0, 5);
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
      --radius: 10px;
      --radius-sm: 6px;
    }

    /* ── Reset ── */
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
    h1, h2, h3, p { margin: 0; }
    ul { margin: 0; padding: 0; list-style: none; }

    /* ── Layout ── */
    .page { max-width: 1040px; margin: 0 auto; padding: 24px 20px 48px; }

    /* ── Top bar ── */
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
    .brand { display: flex; align-items: center; gap: 10px; }
    .brand-name { font-size: 17px; font-weight: 700; letter-spacing: -.3px; }
    .brand-sub { font-size: 12px; color: var(--muted); }
    .topbar-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .lang-toggle { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--line2); border-radius: 8px; background: var(--surface); }
    .lang-toggle button { border: 0; background: transparent; color: var(--muted); border-radius: 6px; padding: 4px 10px; font: 12px/1 var(--sans); font-weight: 600; cursor: pointer; transition: background .12s, color .12s; }
    .lang-toggle button.active { background: var(--ink); color: #fff; }
    .lang-toggle button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .timestamp { font: 11px/1 var(--mono); color: var(--muted); }

    /* ── Status banner ── */
    .status-banner { border-radius: var(--radius); padding: 20px 22px; margin-bottom: 16px; border: 1px solid transparent; display: flex; align-items: flex-start; gap: 14px; }
    .status-banner.idle { background: var(--ok-bg); border-color: var(--ok-ring); }
    .status-banner.working { background: var(--warn-bg); border-color: var(--warn-ring); }
    .status-banner.finalizing,
    .status-banner.ready_for_done { background: var(--accent-bg); border-color: #bfdbfe; }
    .status-banner.processed { background: var(--purple-bg); border-color: var(--purple-ring); }
    .status-banner.offline { background: var(--surface); border-color: var(--line2); }
    .status-icon { font-size: 24px; line-height: 1; flex-shrink: 0; margin-top: 1px; }
    .status-text { flex: 1; min-width: 0; }
    .status-title { font-size: 18px; font-weight: 700; line-height: 1.25; letter-spacing: -.2px; }
    .status-body { color: var(--ink2); margin-top: 3px; font-size: 14px; }
    .status-cmd { display: inline-block; margin-top: 8px; font: 13px/1.4 var(--mono); background: rgba(0,0,0,.06); border-radius: 5px; padding: 4px 9px; color: var(--ink); }

    /* ── Card grid ── */
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .grid.wide { grid-template-columns: 1.5fr 1fr; }

    /* ── Card ── */
    .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; }
    .card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: 12px; }

    /* ── Activity card ── */
    .activity-what { font-size: 15px; font-weight: 600; color: var(--ink); margin-bottom: 14px; }
    .activity-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 8px 0; border-top: 1px solid var(--line); font-size: 13px; }
    .activity-label { color: var(--muted); }
    .activity-value { font-weight: 600; text-align: right; }

    /* ── Recent changes card ── */
    .file-list { display: grid; gap: 6px; margin-bottom: 8px; }
    .file-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--surface2); border: 1px solid var(--line); border-radius: var(--radius-sm); min-width: 0; }
    .file-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
    .file-text { min-width: 0; flex: 1; }
    .file-name { font: 13px/1.2 var(--mono); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-path { font: 11px/1.2 var(--mono); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-more { font-size: 12px; color: var(--muted); padding: 4px 0; }
    .no-files { padding: 16px; text-align: center; color: var(--muted); font-size: 13px; line-height: 1.5; border: 1px dashed var(--line2); border-radius: var(--radius-sm); }
    .no-files strong { display: block; color: var(--ink2); font-size: 13px; margin-bottom: 2px; }

    /* ── Health card ── */
    .health-list { display: grid; gap: 8px; }
    .health-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 12px; border-radius: var(--radius-sm); border: 1px solid var(--line); background: var(--surface2); }
    .health-label { font-size: 13px; color: var(--ink2); font-weight: 500; }
    .health-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 99px; }
    .health-badge.good { color: var(--ok); background: var(--ok-bg); }
    .health-badge.warn { color: var(--warn); background: var(--warn-bg); }
    .health-badge.missing { color: var(--muted); background: var(--surface2); }

    /* ── Next action card ── */
    .next-body { font-size: 15px; color: var(--ink); line-height: 1.5; font-weight: 500; }

    /* ── Advanced details ── */
    .advanced-wrap { margin-top: 12px; }
    details { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
    summary { display: flex; align-items: center; gap: 8px; padding: 13px 18px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); cursor: pointer; user-select: none; background: var(--surface); }
    summary::-webkit-details-marker { display: none; }
    summary::before { content: '▶'; font-size: 9px; transition: transform .15s; }
    details[open] summary::before { transform: rotate(90deg); }
    summary:hover { background: var(--surface2); }
    .details-body { padding: 0 18px 18px; background: var(--surface); }
    .details-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
    .detail-item { padding: 10px 12px; background: var(--surface2); border: 1px solid var(--line); border-radius: var(--radius-sm); }
    .detail-label { font-size: 11px; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
    .detail-value { font: 13px/1.3 var(--mono); color: var(--ink); word-break: break-all; }
    .report-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .report-card { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 12px; }
    .report-name { font-size: 13px; font-weight: 700; margin-bottom: 8px; }
    .report-meta { font-size: 12px; color: var(--muted); display: grid; gap: 3px; }
    .report-preview { margin-top: 8px; border-top: 1px solid var(--line); padding-top: 8px; }
    .report-preview summary { font-size: 11px; padding: 4px 0; background: transparent; text-transform: none; letter-spacing: 0; font-weight: 600; color: var(--muted); }
    .report-preview summary:hover { background: transparent; }
    .report-preview details { border: none; border-radius: 0; overflow: visible; }
    pre { max-height: 200px; overflow: auto; white-space: pre-wrap; background: var(--surface2); border-radius: var(--radius-sm); padding: 10px; font: 11px/1.5 var(--mono); color: var(--ink2); margin: 8px 0 0; }

    /* ── Error state ── */
    .error-state { padding: 32px; text-align: center; }
    .error-title { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
    .error-msg { color: var(--muted); font-size: 13px; }

    /* ── Responsive ── */
    @media (max-width: 700px) {
      .page { padding: 16px 14px 40px; }
      .grid, .grid.wide, .details-grid, .report-grid { grid-template-columns: 1fr; }
      .status-title { font-size: 16px; }
    }
  </style>
</head>
<body>
<div class="page">
  <div class="topbar">
    <div class="brand">
      <div>
        <div class="brand-name">DevGuard</div>
        <div class="brand-sub" id="brand-sub"></div>
      </div>
    </div>
    <div class="topbar-right">
      <div class="lang-toggle" role="group" id="langToggle" aria-label="Language">
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
const langToggle = document.getElementById('langToggle');
const langBtns = [...document.querySelectorAll('[data-lang]')];
let lang = initLang();
let last = null;

function initLang() {
  const saved = localStorage.getItem('dg.lang');
  if (saved && STRINGS[saved]) return saved;
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some(l => String(l).toLowerCase().startsWith('ko')) ? 'ko' : 'en';
}

function t(k) { return STRINGS[lang][k] || STRINGS.en[k] || k; }

function setLang(l) {
  if (!STRINGS[l]) return;
  lang = l;
  localStorage.setItem('dg.lang', l);
  document.documentElement.lang = l;
  langBtns.forEach(b => b.classList.toggle('active', b.dataset.lang === l));
  brandSub.textContent = t('appSubtitle');
  if (last) render(last); else root.textContent = t('loading');
}
langBtns.forEach(b => b.addEventListener('click', () => setLang(b.dataset.lang)));

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);

/* ── Status view ── */
function statusView(s) {
  if (!s.initialized) return {
    icon: '⚙️', cls: 'offline',
    title: t('notInitializedTitle'), body: t('notInitializedBody'),
    cmd: 'dev-guard init',
    activity: t('activityInit'), next: t('nextInit')
  };
  if (!s.watchRunning) return {
    icon: '⏸', cls: 'offline',
    title: t('watchNotRunningTitle'), body: t('watchNotRunningBody'),
    cmd: 'dev-guard watch',
    activity: t('activityStartWatch'), next: t('nextStartWatch')
  };
  const m = {
    working:       { icon: '🟡', cls: 'working',     title: t('statusWorkingTitle'),    body: t('statusWorkingBody'),    activity: t('activitySettling'),    next: t('nextSettling') },
    ready_for_done:{ icon: '🔵', cls: 'ready_for_done',title: t('statusReadyTitle'),    body: t('statusReadyBody'),      activity: t('activityAiCompletion'),next: t('nextAiCompletion') },
    finalizing:    { icon: '🔵', cls: 'finalizing',  title: t('statusFinalizingTitle'), body: t('statusFinalizingBody'), activity: t('activityFinalizing'),  next: t('nextFinalizing') },
    processed:     { icon: '🟣', cls: 'processed',   title: t('statusProcessedTitle'),  body: t('statusProcessedBody'),  activity: t('activityProcessed'),   next: t('nextProcessed') }
  };
  return m[s.status] ?? { icon: '🟢', cls: 'idle', title: t('statusMonitoringTitle'), body: t('statusMonitoringBody'), activity: t('activityMonitoring'), next: t('nextMonitoring') };
}

/* ── Time helpers ── */
function ago(v) {
  if (!v) return t('never');
  return lang === 'ko' ? v + ' 전' : v + ' ago';
}
function dash(v) { return v || t('unknown'); }

/* ── File helpers ── */
function basename(p) { return p.split('/').pop() || p; }
function dirname(p) {
  const parts = p.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';
}

/* ── Health helpers ── */
function qualityHealth(verdict) {
  if (!verdict) return { cls: 'missing', icon: '○', label: t('healthUnknown') };
  if (verdict === 'PASS') return { cls: 'good', icon: '✓', label: t('healthGood') };
  return { cls: 'warn', icon: '!', label: t('healthWarning') };
}
function boolHealth(exists) {
  return exists
    ? { cls: 'good', icon: '✓', label: t('healthGood') }
    : { cls: 'missing', icon: '○', label: t('healthMissing') };
}
function reportsHealth(s) {
  if (!s.reports.handoffExists && !s.reports.qualityReportExists) return { cls: 'missing', icon: '○', label: t('reportsNeverUpdated') };
  const ts = s.reports.qualityReportUpdatedAt || s.reports.handoffUpdatedAt;
  if (!ts) return { cls: 'good', icon: '✓', label: t('healthGood') };
  const date = new Date(ts);
  const label = t('reportsUpdated') + ' ' + (Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(lang === 'ko' ? 'ko-KR' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: false }));
  return { cls: 'good', icon: '✓', label };
}
function healthBadge(h) {
  return '<span class="health-badge ' + h.cls + '">' + esc(h.icon) + ' ' + esc(h.label) + '</span>';
}

/* ── Report block (advanced) ── */
function reportBlock(name, exists, updatedAt, preview) {
  const dateStr = updatedAt ? new Date(updatedAt).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US', { dateStyle: 'short', timeStyle: 'short' }) : t('notCreated');
  return '<div class="report-card">' +
    '<div class="report-name">' + esc(name) + '</div>' +
    '<div class="report-meta">' +
    '<div>' + esc(t('availability')) + ': ' + esc(exists ? t('ready') : t('notCreated')) + '</div>' +
    '<div>' + esc(t('lastUpdated')) + ': ' + esc(dateStr) + '</div>' +
    '</div>' +
    (exists && preview
      ? '<details class="report-preview"><summary>' + esc(t('preview')) + '</summary><pre>' + esc(preview) + '</pre></details>'
      : '') +
    '</div>';
}

/* ── Main render ── */
function render(s) {
  last = s;
  const v = statusView(s);

  /* Status banner */
  const banner = '<div class="status-banner ' + esc(v.cls) + '">' +
    '<div class="status-icon" aria-hidden="true">' + v.icon + '</div>' +
    '<div class="status-text">' +
    '<div class="status-title">' + esc(v.title) + '</div>' +
    '<div class="status-body">' + esc(v.body) + '</div>' +
    (v.cmd ? '<code class="status-cmd">' + esc(v.cmd) + '</code>' : '') +
    '</div></div>';

  /* Activity card */
  const activityRows = [
    s.watchingSince ? '<div class="activity-row"><span class="activity-label">' + esc(t('sessionStarted')) + '</span><span class="activity-value">' + esc(s.watchingSince) + '</span></div>' : '',
    s.lastActivity  ? '<div class="activity-row"><span class="activity-label">' + esc(t('lastChange')) + '</span><span class="activity-value">' + esc(ago(s.lastActivity)) + '</span></div>' : '',
    s.changeCount > 0 ? '<div class="activity-row"><span class="activity-label">' + esc(t('changesCount')) + '</span><span class="activity-value">' + esc(s.changeCount) + '</span></div>' : ''
  ].filter(Boolean).join('');
  const activityCard = '<div class="card">' +
    '<div class="card-title">' + esc(t('currentActivityTitle')) + '</div>' +
    '<div class="activity-what">' + esc(v.activity) + '</div>' +
    activityRows +
    '</div>';

  /* Recent changes card */
  let filesHtml;
  if (!s.recentFiles.length) {
    filesHtml = '<div class="no-files"><strong>' + esc(t('noRecentFilesTitle')) + '</strong>' + esc(t('noRecentFilesBody')) + '</div>';
  } else {
    filesHtml = '<div class="file-list">' +
      s.recentFiles.map(f => {
        const name = basename(f);
        const dir = dirname(f);
        return '<div class="file-item">' +
          '<div class="file-dot"></div>' +
          '<div class="file-text">' +
          '<div class="file-name">' + esc(name) + '</div>' +
          (dir ? '<div class="file-path">' + esc(dir) + '</div>' : '') +
          '</div></div>';
      }).join('') +
      '</div>' +
      (s.moreFileCount > 0 ? '<div class="file-more">+' + esc(s.moreFileCount) + ' ' + esc(t('moreFiles')) + '</div>' : '');
  }
  const filesCard = '<div class="card">' +
    '<div class="card-title">' + esc(t('recentChangesTitle')) + '</div>' +
    filesHtml +
    '</div>';

  /* Health card */
  const qh = qualityHealth(s.qualityVerdict);
  const ch = boolHealth(s.reports.agentContextExists);
  const rh = reportsHealth(s);
  const healthCard = '<div class="card">' +
    '<div class="card-title">' + esc(t('healthTitle')) + '</div>' +
    '<div class="health-list">' +
    '<div class="health-row"><span class="health-label">' + esc(t('healthQuality')) + '</span>' + healthBadge(qh) + '</div>' +
    '<div class="health-row"><span class="health-label">' + esc(t('healthContext')) + '</span>' + healthBadge(ch) + '</div>' +
    '<div class="health-row"><span class="health-label">' + esc(t('healthReports')) + '</span>' + healthBadge(rh) + '</div>' +
    '</div></div>';

  /* Next action card */
  const nextCard = '<div class="card">' +
    '<div class="card-title">' + esc(t('nextActionTitle')) + '</div>' +
    '<div class="next-body">' + esc(v.next) + '</div>' +
    '</div>';

  /* Advanced details */
  const detailItems = [
    { label: t('sessionDuration'), value: dash(s.elapsed) },
    { label: t('internalStatus'), value: s.status || '—' },
    { label: t('idleCountdown'), value: s.idleCountdown || t('noCountdown') }
  ].map(d => '<div class="detail-item"><div class="detail-label">' + esc(d.label) + '</div><div class="detail-value">' + esc(d.value) + '</div></div>').join('');

  const advanced = '<div class="advanced-wrap"><details>' +
    '<summary>' + esc(t('advancedTitle')) + '</summary>' +
    '<div class="details-body">' +
    '<div class="details-grid">' + detailItems + '</div>' +
    '<div class="report-grid">' +
    reportBlock(t('reportHandoff'), s.reports.handoffExists, s.reports.handoffUpdatedAt, s.reports.handoffPreview) +
    reportBlock(t('reportQuality'), s.reports.qualityReportExists, s.reports.qualityReportUpdatedAt, s.reports.qualityReportPreview) +
    reportBlock(t('reportContext'), s.reports.agentContextExists, s.reports.agentContextUpdatedAt, s.reports.agentContextPreview) +
    '</div></div></details></div>';

  root.innerHTML = banner +
    '<div class="grid wide" style="margin-top:12px">' + activityCard + filesCard + '</div>' +
    '<div class="grid" style="margin-top:12px">' + healthCard + nextCard + '</div>' +
    advanced;
}

async function tick() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    render(await res.json());
    ts.textContent = t('dashboardUpdated') + ' ' + new Date().toLocaleTimeString(lang === 'ko' ? 'ko-KR' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch (e) {
    root.innerHTML = '<div class="error-state"><div class="error-title">' + esc(t('dashboardUnavailableTitle')) + '</div><div class="error-msg">' + esc(e.message) + '</div></div>';
  }
}

setLang(lang);
tick();
setInterval(tick, 1000);
</script>
</body>
</html>`;
}
