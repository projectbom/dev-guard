import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { fromRoot, readTextFile } from "./fs.js";
import { devguardPaths } from "./paths.js";
import { readRuntimeState, type RuntimeState } from "./runtime-state.js";
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
  stage: string;
  waitingFor: string;
  next: string;
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
  const [runtime, strategyReport, reports] = await Promise.all([
    readRuntimeState(root),
    getAgentStrategyReport(root),
    readReportState(root)
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
    stage: dashboard.stage,
    waitingFor: initialized ? (watchRunning ? dashboard.waitingFor : "dev-guard watch") : "dev-guard init",
    next: initialized ? (watchRunning ? dashboard.next : "Run dev-guard watch") : "Run dev-guard init",
    watchingSince: runtime.watchStartedAt ? formatTime(runtime.watchStartedAt) : "unknown",
    elapsed: runtime.watchStartedAt ? formatDurationSince(runtime.watchStartedAt) : "unknown",
    lastActivity: runtime.lastActivityAt ? formatDurationSince(runtime.lastActivityAt) : "none",
    idleCountdown: normalizeStatus(dashboard.status) === "working" ? formatCountdown(runtime.idleDeadlineAt) : null,
    changeCount: runtime.changeCountSinceIdle ?? runtime.pendingChangedFiles.length,
    recentFiles,
    moreFileCount: Math.max(0, runtime.pendingChangedFiles.length - recentFiles.length),
    watchRunning,
    initialized,
    empty,
    message: initialized ? (watchRunning ? undefined : "Watch is not running.") : "DevGuard is not initialized.",
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
  return [...files].slice(0, 3);
}

function normalizeStatus(status: string): string {
  if (status === "Working") return "working";
  if (status === "Ready for done") return "ready_for_done";
  return status.toLowerCase();
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "unknown";
}

function formatDurationSince(timestamp: string): string {
  const started = Date.parse(timestamp);
  if (!Number.isFinite(started)) return "unknown";
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
  <title>DevGuard Dashboard</title>
  <style>
    :root { color-scheme: light; --bg:#f7f8fa; --panel:#ffffff; --ink:#17191f; --muted:#636a75; --soft:#f1f3f5; --line:#dfe3e8; --accent:#2563eb; --ok:#11843b; --warn:#a05a00; --done:#6842c2; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width:1060px; margin:0 auto; padding:24px; }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:16px; }
    h1 { margin:0; font-size:25px; line-height:1.1; letter-spacing:0; }
    h2 { margin:0 0 10px; font-size:15px; line-height:1.2; }
    h3 { margin:0 0 5px; font-size:12px; color:var(--muted); font-weight:700; }
    p { margin:0; }
    .subtle { color:var(--muted); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; }
    .topbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:flex-end; }
    .toggle { display:inline-flex; gap:2px; padding:2px; border:1px solid var(--line); border-radius:8px; background:var(--panel); }
    .toggle button { border:0; background:transparent; color:var(--muted); border-radius:6px; padding:5px 8px; font:inherit; cursor:pointer; }
    .toggle button.active { background:var(--ink); color:#fff; }
    .layout { display:grid; grid-template-columns:minmax(0, 1.35fr) minmax(280px, .65fr); gap:14px; align-items:start; }
    .stack { display:grid; gap:14px; }
    section { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    .summary { padding:20px; }
    .summaryHead { display:flex; align-items:center; gap:11px; margin-bottom:10px; }
    .icon { width:34px; height:34px; display:grid; place-items:center; border-radius:999px; background:var(--soft); font-size:18px; }
    .summaryTitle { font-size:22px; font-weight:760; line-height:1.2; }
    .summaryBody { color:var(--muted); max-width:720px; font-size:15px; }
    .summary.idle .icon { background:#dcfce7; }
    .summary.working .icon { background:#fff1d6; }
    .summary.ready_for_done .icon { background:#dbeafe; }
    .summary.processed .icon { background:#ede9fe; }
    .facts { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px; margin-top:16px; }
    .fact { background:var(--soft); border:1px solid #e8ebef; border-radius:7px; padding:12px; min-height:82px; }
    .fact strong { display:block; font-size:13px; margin-bottom:4px; }
    .fact div { color:var(--muted); }
    .timeline { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px; }
    .metric { border-top:1px solid var(--line); padding-top:10px; }
    .metricValue { font-weight:720; font-size:16px; overflow-wrap:anywhere; }
    .fileList { list-style:none; padding:0; margin:10px 0 0; display:grid; gap:7px; }
    .fileList li { background:var(--soft); border:1px solid #e8ebef; border-radius:7px; padding:8px 10px; overflow-wrap:anywhere; }
    .emptyState { border:1px dashed var(--line); background:#fbfcfd; border-radius:7px; padding:14px; color:var(--muted); }
    .reportGrid { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px; }
    .report { border:1px solid var(--line); border-radius:7px; padding:12px; min-height:150px; }
    .reportTitle { font-size:15px; font-weight:740; margin-bottom:8px; }
    .meta { display:grid; gap:5px; color:var(--muted); font-size:13px; }
    .badge { display:inline-flex; align-items:center; width:max-content; max-width:100%; border:1px solid var(--line); border-radius:999px; padding:2px 8px; color:var(--ink); background:#fff; font-size:12px; }
    details { border-top:1px solid var(--line); padding-top:10px; margin-top:10px; }
    summary { cursor:pointer; font-weight:700; }
    pre { max-height:220px; overflow:auto; white-space:pre-wrap; background:var(--soft); border-radius:6px; padding:10px; font-size:12px; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    @media (max-width: 860px) { main { padding:16px; } header { display:block; } .topbar { justify-content:flex-start; margin-top:12px; } .layout, .facts, .timeline, .reportGrid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div><h1>DevGuard</h1><div class="subtle" id="subtitle"></div></div>
      <div class="topbar">
        <div class="toggle" role="group" id="languageToggle">
          <button type="button" data-lang="en">EN</button>
          <button type="button" data-lang="ko">KO</button>
        </div>
        <div class="subtle mono" id="updated"></div>
      </div>
    </header>
    <div id="app" class="emptyState"></div>
  </main>
  <script>
    const STRINGS = ${translationsJson};
    const app = document.getElementById('app');
    const updated = document.getElementById('updated');
    const subtitle = document.getElementById('subtitle');
    const languageToggle = document.getElementById('languageToggle');
    const langButtons = [...document.querySelectorAll('[data-lang]')];
    let currentLanguage = initialLanguage();
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

    function initialLanguage() {
      const saved = localStorage.getItem('devguard.dashboard.language');
      if (saved && STRINGS[saved]) return saved;
      const browserLanguages = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
      return browserLanguages.some(lang => String(lang).toLowerCase().startsWith('ko')) ? 'ko' : 'en';
    }

    function t(key) {
      return STRINGS[currentLanguage][key] || STRINGS.en[key] || key;
    }

    function setLanguage(lang) {
      if (!STRINGS[lang]) return;
      currentLanguage = lang;
      localStorage.setItem('devguard.dashboard.language', lang);
      document.documentElement.lang = lang;
      languageToggle.setAttribute('aria-label', t('language'));
      langButtons.forEach(button => button.classList.toggle('active', button.dataset.lang === lang));
      subtitle.textContent = t('appSubtitle');
      if (!lastState) app.textContent = t('loading');
      if (lastState) render(lastState);
    }

    langButtons.forEach(button => button.addEventListener('click', () => setLanguage(button.dataset.lang)));

    function statusView(s) {
      if (!s.initialized) return { icon:'⚙️', className:'idle', title:t('notInitializedTitle'), body:t('notInitializedBody'), activity:t('activityInit'), next:t('nextInit'), action:'dev-guard init' };
      if (!s.watchRunning) return { icon:'⏸', className:'idle', title:t('watchNotRunningTitle'), body:t('watchNotRunningBody'), activity:t('activityStartWatch'), next:t('nextStartWatch'), action:'dev-guard watch' };
      if (s.status === 'working') return { icon:'🟡', className:'working', title:t('statusWorkingTitle'), body:t('statusWorkingBody'), activity:t('activitySettling'), next:t('nextSettling') };
      if (s.status === 'ready_for_done') return { icon:'🔵', className:'ready_for_done', title:t('statusReadyTitle'), body:t('statusReadyBody'), activity:t('activityAiCompletion'), next:t('nextAiCompletion') };
      if (s.status === 'processed') return { icon:'🟣', className:'processed', title:t('statusProcessedTitle'), body:t('statusProcessedBody'), activity:t('activityProcessed'), next:t('nextProcessed') };
      return { icon:'🟢', className:'idle', title:t('statusMonitoringTitle'), body:t('statusMonitoringBody'), activity:t('activityMonitoring'), next:t('nextMonitoring') };
    }

    function activityTime(value) {
      if (!value || value === 'none') return t('never');
      return currentLanguage === 'ko' ? value + ' 전' : value + ' ago';
    }

    function plainValue(value) {
      if (!value || value === 'unknown') return t('unknown');
      return value;
    }

    function formatUpdatedAt(value) {
      if (!value) return t('notCreated');
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return t('unknown');
      return date.toLocaleString(currentLanguage === 'ko' ? 'ko-KR' : 'en-US', { dateStyle:'medium', timeStyle:'short' });
    }

    function reportBlock(title, exists, updatedAt, preview) {
      return '<div class="report"><div class="reportTitle">' + esc(title) + '</div>' +
        '<div class="meta">' +
        '<div><strong>' + esc(t('availability')) + ':</strong> <span class="badge">' + esc(exists ? t('ready') : t('notCreated')) + '</span></div>' +
        '<div><strong>' + esc(t('lastUpdated')) + ':</strong> ' + esc(formatUpdatedAt(updatedAt)) + '</div>' +
        '</div>' +
        (exists && preview ? '<details><summary>' + esc(t('preview')) + '</summary><pre>' + esc(preview) + '</pre></details>' : '') +
        '</div>';
    }

    function recentFiles(s) {
      if (!s.recentFiles.length) {
        return '<div class="emptyState"><strong>' + esc(t('noRecentFilesTitle')) + '</strong><p>' + esc(t('noRecentFilesBody')) + '</p></div>';
      }
      return '<ul class="fileList">' + s.recentFiles.map(f => '<li class="mono">' + esc(f) + '</li>').join('') + '</ul>' +
        (s.moreFileCount > 0 ? '<p class="subtle">+' + esc(s.moreFileCount) + ' ' + esc(t('moreFiles')) + '</p>' : '');
    }

    let lastState;
    function render(s) {
      lastState = s;
      const view = statusView(s);
      app.className = '';
      app.innerHTML = \`
        <div class="layout">
          <div class="stack">
            <section class="summary \${esc(view.className)}">
              <h2>\${esc(t('currentStatus'))}</h2>
              <div class="summaryHead"><span class="icon" aria-hidden="true">\${view.icon}</span><div class="summaryTitle">\${esc(view.title)}</div></div>
              <p class="summaryBody">\${esc(view.body)}</p>
              \${view.action ? '<pre>' + esc(view.action) + '</pre>' : ''}
              <div class="facts">
                <div class="fact"><strong>\${esc(t('currentActivity'))}</strong><div>\${esc(view.activity)}</div></div>
                <div class="fact"><strong>\${esc(t('whatHappensNext'))}</strong><div>\${esc(view.next)}</div></div>
                <div class="fact"><strong>\${esc(t('idleCountdown'))}</strong><div>\${esc(s.idleCountdown || t('noCountdown'))}</div></div>
              </div>
            </section>
            <section>
              <h2>\${esc(t('recentFiles'))}</h2>
              <p class="subtle">\${esc(t('changesTracked'))}: \${esc(s.changeCount)}</p>
              \${recentFiles(s)}
            </section>
            <section>
              <h2>\${esc(t('projectInformation'))}</h2>
              <div class="reportGrid">
                \${reportBlock(t('nextSession'), s.reports.handoffExists, s.reports.handoffUpdatedAt, s.reports.handoffPreview)}
                \${reportBlock(t('projectHealth'), s.reports.qualityReportExists, s.reports.qualityReportUpdatedAt, s.reports.qualityReportPreview)}
                \${reportBlock(t('projectContext'), s.reports.agentContextExists, s.reports.agentContextUpdatedAt, s.reports.agentContextPreview)}
              </div>
            </section>
          </div>
          <section>
            <h2>\${esc(t('timeline'))}</h2>
            <div class="timeline">
              <div class="metric"><h3>\${esc(t('monitoringStarted'))}</h3><div class="metricValue">\${esc(plainValue(s.watchingSince))}</div></div>
              <div class="metric"><h3>\${esc(t('sessionDuration'))}</h3><div class="metricValue">\${esc(plainValue(s.elapsed))}</div></div>
              <div class="metric"><h3>\${esc(t('lastFileChange'))}</h3><div class="metricValue">\${esc(activityTime(s.lastActivity))}</div></div>
            </div>
          </section>
        </div>\`;
    }
    async function tick() {
      try {
        const res = await fetch('/api/state', { cache: 'no-store' });
        render(await res.json());
        updated.textContent = t('dashboardUpdated') + ' ' + new Date().toLocaleTimeString();
      } catch (error) {
        app.className = 'emptyState';
        app.innerHTML = '<h2>' + esc(t('dashboardUnavailableTitle')) + '</h2><p>' + esc(error.message) + '</p>';
      }
    }
    setLanguage(currentLanguage);
    tick();
    setInterval(tick, 1000);
  </script>
</body>
</html>`;
}
