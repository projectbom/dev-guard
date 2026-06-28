import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fromRoot, readTextFile } from "./fs.js";
import { devguardPaths } from "./paths.js";
import { readRuntimeState, type RuntimeState } from "./runtime-state.js";
import { getAgentStrategyReport } from "./agent-strategies.js";
import { formatWatchDashboard } from "./watch-format.js";

const DEFAULT_PORT = 3737;
const HOST = "127.0.0.1";

interface DashboardState {
  status: string;
  stage: string;
  waitingFor: string;
  next: string;
  watchingSince: string;
  elapsed: string;
  lastActivity: string;
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
    handoffPreview?: string;
    qualityReportPreview?: string;
    agentContextPreview?: string;
  };
}

export async function runDashboard(root: string, args: string[]): Promise<void> {
  const port = readPort(args);
  const openBrowser = args.includes("--open");
  const server = createServer((request, response) => {
    void handleRequest(root, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });

  const url = `http://${HOST}:${port}`;
  console.log("DevGuard dashboard running");
  console.log("");
  console.log("URL:");
  console.log(url);
  console.log("");
  console.log("Press Ctrl+C to stop.");

  if (openBrowser) {
    tryOpenBrowser(url);
  }

  process.on("SIGINT", () => {
    server.close(() => process.exit(0));
  });
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
    lastActivity: runtime.lastActivityAt ? `${formatDurationSince(runtime.lastActivityAt)} ago` : "none",
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
    handoffPreview: handoff.preview,
    qualityReportPreview: quality.preview,
    agentContextPreview: context.preview
  };
}

async function readKnownPreview(root: string, path: string): Promise<{ exists: boolean; preview?: string }> {
  const absolute = fromRoot(root, path);
  if (!(await fileExists(absolute))) {
    return { exists: false };
  }
  const text = await readTextFile(absolute);
  return { exists: true, preview: text.slice(0, 1800) };
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

function readPort(args: string[]): number {
  const index = args.indexOf("--port");
  if (index < 0) return DEFAULT_PORT;
  const port = Number(args[index + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port requires a valid port number.");
  }
  return port;
}

function tryOpenBrowser(url: string): void {
  const child = spawn("open", [url], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DevGuard Dashboard</title>
  <style>
    :root { color-scheme: light; --bg:#f6f7f9; --panel:#ffffff; --ink:#16181d; --muted:#626975; --line:#dfe3e8; --accent:#1f6feb; --ok:#147d43; --warn:#9a6700; --bad:#b42318; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width:1100px; margin:0 auto; padding:28px; }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:22px; }
    h1 { margin:0; font-size:28px; letter-spacing:0; }
    .subtle { color:var(--muted); }
    .grid { display:grid; grid-template-columns: 1.2fr .8fr; gap:16px; }
    .cards { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:12px; margin-top:16px; }
    section, .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:18px; }
    .statusRow { display:flex; align-items:center; gap:12px; margin-bottom:12px; }
    .pill { display:inline-flex; align-items:center; height:32px; padding:0 12px; border-radius:999px; border:1px solid var(--line); font-weight:700; text-transform:capitalize; }
    .pill.working { background:#fff4ce; color:var(--warn); border-color:#f2d675; }
    .pill.idle { background:#dafbe1; color:var(--ok); border-color:#aceebb; }
    .pill.ready_for_done { background:#ddf4ff; color:var(--accent); border-color:#b6e3ff; }
    .pill.processed { background:#eee7ff; color:#6639ba; border-color:#d8c9ff; }
    h2 { margin:0 0 10px; font-size:16px; }
    h3 { margin:0 0 6px; font-size:13px; color:var(--muted); font-weight:650; }
    .big { font-size:24px; font-weight:750; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; }
    ul { margin:8px 0 0; padding-left:18px; }
    li { margin:4px 0; overflow-wrap:anywhere; }
    details { border-top:1px solid var(--line); padding-top:12px; margin-top:12px; }
    summary { cursor:pointer; font-weight:700; }
    pre { max-height:260px; overflow:auto; white-space:pre-wrap; background:#f0f2f5; border-radius:6px; padding:12px; }
    .empty { border:1px dashed var(--line); background:#fbfcfd; }
    @media (max-width: 860px) { main { padding:18px; } .grid, .cards { grid-template-columns:1fr; } header { display:block; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div><h1>DevGuard</h1><div class="subtle">Local AI coding session control panel</div></div>
      <div class="subtle mono" id="updated">Updating...</div>
    </header>
    <div id="app" class="empty card">Loading dashboard state...</div>
  </main>
  <script>
    const app = document.getElementById('app');
    const updated = document.getElementById('updated');
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    function reportBlock(title, exists, preview) {
      return '<div class="card"><h3>' + esc(title) + '</h3><div class="big">' + (exists ? 'Available' : 'Missing') + '</div>' +
        (exists && preview ? '<details><summary>Preview</summary><pre>' + esc(preview) + '</pre></details>' : '') + '</div>';
    }
    function render(s) {
      if (!s.initialized) {
        app.className = 'empty card';
        app.innerHTML = '<h2>DevGuard is not initialized.</h2><p>Run:</p><pre>dev-guard init</pre>';
        return;
      }
      const files = s.recentFiles.length ? s.recentFiles.map(f => '<li class="mono">' + esc(f) + '</li>').join('') : '<li>none</li>';
      app.className = '';
      app.innerHTML = \`
        \${!s.watchRunning ? '<section class="empty"><h2>Watch is not running.</h2><p>Run:</p><pre>dev-guard watch</pre></section><br>' : ''}
        <div class="grid">
          <section>
            <div class="statusRow"><span class="pill \${esc(s.status)}">\${esc(s.status.replaceAll('_',' '))}</span><strong>\${esc(s.stage)}</strong></div>
            <div class="cards">
              <div><h3>Waiting For</h3><div>\${esc(s.waitingFor)}</div></div>
              <div><h3>Next</h3><div>\${esc(s.next)}</div></div>
              <div><h3>Idle Countdown</h3><div class="big">\${esc(s.next.startsWith('Idle in') ? s.next.replace('Idle in ', '') : '—')}</div></div>
            </div>
          </section>
          <section>
            <h2>Timeline</h2>
            <div><h3>Watching since</h3><div>\${esc(s.watchingSince)}</div></div>
            <div><h3>Elapsed</h3><div>\${esc(s.elapsed)}</div></div>
            <div><h3>Last activity</h3><div>\${esc(s.lastActivity)}</div></div>
          </section>
        </div>
        <div class="grid" style="margin-top:16px">
          <section>
            <h2>Recent Files</h2>
            <div class="subtle">Changes detected: \${esc(s.changeCount)}</div>
            <ul>\${files}</ul>
            \${s.moreFileCount > 0 ? '<div class="subtle">+' + esc(s.moreFileCount) + ' more</div>' : ''}
          </section>
          <section>
            <h2>Reports</h2>
            <div class="cards">
              \${reportBlock('Project handoff', s.reports.handoffExists, s.reports.handoffPreview)}
              \${reportBlock('Quality report', s.reports.qualityReportExists, s.reports.qualityReportPreview)}
              \${reportBlock('Agent context', s.reports.agentContextExists, s.reports.agentContextPreview)}
            </div>
          </section>
        </div>\`;
    }
    async function tick() {
      try {
        const res = await fetch('/api/state', { cache: 'no-store' });
        render(await res.json());
        updated.textContent = 'Updated ' + new Date().toLocaleTimeString();
      } catch (error) {
        app.className = 'empty card';
        app.innerHTML = '<h2>Dashboard unavailable</h2><p>' + esc(error.message) + '</p>';
      }
    }
    tick();
    setInterval(tick, 1000);
  </script>
</body>
</html>`;
}
