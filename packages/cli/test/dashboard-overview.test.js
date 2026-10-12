// Compact dashboard contract: the first screen answers five questions —
// healthy? current task? thread okay? biggest problem? what to do? — with
// one primary issue, one action, at most five task numbers and one chart;
// everything else is collapsed. Rendered by running the page's own client
// script against a stub DOM (no browser, no `dev-guard watch`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";

import { buildDashboardOverview, MAX_OVERVIEW_METRICS } from "../dist/dashboard-view.js";
import { dashboardTranslations } from "../dist/dashboard-i18n.js";

const HEALTHY = { initialized: true, watchRunning: true, setupActive: false, sessionFileCount: 7 };

function issue(id, over = {}) {
  return { id, severity: "strong", issue: `${id} issue`, why: `${id} why`, action: `${id} action`, evidence: "INFERRED", impactTokens: 1000, ...over };
}

function report(over = {}) {
  const now = {
    health: "NEEDS_ATTENTION",
    task: "Fix the invoice\nreconcile rounding   in billing",
    primaryIssue: issue("MISSING_EXECUTION_CONTEXT"),
    otherIssues: [issue("BROAD_SEARCH"), issue("DOC_REREADS")],
    message: "",
    action: "",
    thread: { state: "CONTINUE", reason: "Light task.", evidence: "OBSERVED" },
    ...over.now
  };
  return {
    generatedAt: "2026-10-12T00:00:00Z",
    now,
    currentTask: {
      suggestionsUsed: { used: 6, of: 8 },
      repositorySearches: { total: 3, broad: 1 },
      contextOverheadPct: 12,
      openBlockers: 0,
      focus: { mode: "IMPLEMENTING", sentence: "x" },
      whereContextWent: { DEVGUARD: 2000, CODE: 12347, SEARCH: 3000, VALIDATION: 1000, CONTEXT_MANAGEMENT: 0, OTHER: 0 },
      estimatedContextTokens: 18347
    },
    sources: [],
    threadIdentity: "observed",
    current: {
      sessionId: "s1", label: now.task, startedAt: "2026-10-12T00:00:00Z", estTokens: 18347,
      costByCategory: { MCP: 1000, FALLBACK_DOCS: 0, SEARCH: 3000, CODE_READS: 10000, CODE_EDITS: 2347, VALIDATION: 1000, ADMIN: 1000, OTHER: 0 },
      modeTokens: { IMPLEMENTATION: 12000, EXPLORATION: 5347, VALIDATION: 1000, CONTEXT_ADMIN: 0, RESUME_RECOVERY: 0, OTHER: 0 },
      otherBreakdown: {}, provided: { files: 8, ranges: 12 }, usedFiles: 10, providedUsed: 6, nonProvidedUsed: 4,
      candidateUtilization: { used: 6, of: 8 }, searchCalls: 3, broadSearchCalls: 1, searchBeforeProvidedRead: false,
      fallbackDocReads: 0, repeatedFallbackDocReads: 0, validation: { pass: 4, fail: 0, unknown: 1 }, threads: ["t1"],
      compactions: 0, activityEvents: 40, peakContextUse: 0.47, unusedSuggestionReads: { files: 1, estTokens: 900 },
      nonProvidedReads: { files: 4, estTokens: 5000 }, missingScripts: ["scripts/run.py"], providedDocRereads: { files: 0, estTokens: 0 }, touchedFiles: []
    },
    recent: [],
    summary: { estimatedContextTokens: 18347, rollover: now.thread },
    recommendations: [],
    timeline: { events: [], cumulative: [] },
    taskCard: { goal: now.task, edit: ["src/a.ts"], candidates: [], reference: [], protected: [], freshValidation: [], openValidation: [], readPlan: { required: 8, optional: 3 } },
    evidence: {},
    ...over.top
  };
}

function state(over = {}) {
  return {
    status: "idle", initialized: true, watchRunning: true, sessionFileCount: 7, changeCount: 7, locale: "en-US",
    reports: { qualityReportExists: true, qualitySummary: { warningCount: 0, blockedCount: 0, requiredVerificationCount: 0 } },
    knowledge: { exists: true, filesIndexed: 9100, architectureModules: 3, framework: "Next.js", sourceRoots: 21, coverage: { pages: { detected: 800, kept: 200 } } },
    openAI: { configured: false, source: "none" },
    ...over
  };
}

async function renderFirstScreen(data, language = "en") {
  const D = new URL("../dist/", import.meta.url).pathname;
  const src = await readFile(`${D}dashboard.js`, "utf8");
  const probe = `${D}__overview_probe_${process.pid}_${Math.random().toString(36).slice(2)}.js`;
  await writeFile(probe, src + "\nexport { renderPage as __renderPage };\n");
  try {
    const { __renderPage } = await import(probe);
    const html = __renderPage();
    const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
    const elements = {};
    const doc = { getElementById: (id) => (elements[id] ??= { innerHTML: "", textContent: "", classList: { toggle() {} } }), querySelectorAll: () => [], documentElement: {} };
    const fakeFetch = async (url) => ({ ok: true, json: async () => (String(url).startsWith("/api/overview") ? data : { ok: true }) });
    new Function("document", "localStorage", "navigator", "fetch", "setInterval", script)(doc, { getItem: () => language, setItem() {} }, { languages: [language] }, fakeFetch, () => 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { html: elements.root.innerHTML, page: html };
  } finally {
    await rm(probe, { force: true });
  }
}

function overviewData(stateOver = {}, reportOver = {}) {
  const s = state(stateOver);
  const r = report(reportOver);
  const overview = buildDashboardOverview({ initialized: s.initialized, watchRunning: s.watchRunning, setupActive: Boolean(s.setup?.active), qualityVerdict: s.qualityVerdict, sessionFileCount: s.sessionFileCount }, r, r.taskCard.readPlan);
  return { state: s, efficiency: r, overview };
}

const firstScreen = (html) => html.slice(0, html.indexOf('data-testid="ov-details"'));
const count = (text, needle) => text.split(needle).length - 1;

test("N–T: Health, Thread, one-line task, one issue, one action, <=5 metrics, collapsed details — in that order", async () => {
  const { html, page } = await renderFirstScreen(overviewData());
  const order = ["ov-health", "ov-thread", "ov-task", "ov-issue", "ov-action", "ov-metrics", "ov-flow", "ov-details"].map((id) => html.indexOf(`data-testid="${id}"`));
  assert.ok(order.every((index) => index >= 0), `all first-screen elements present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "NOW → this task → context flow → details");
  const top = firstScreen(html);
  // P: one line, whitespace collapsed, ellipsis styling
  assert.match(top, /data-testid="ov-task"[^>]*>Fix the invoice reconcile rounding in billing</);
  assert.match(page, /\.ov-task \{[^}]*white-space: nowrap/);
  // Q: exactly one primary issue; secondary issues only in details
  assert.equal(count(top, 'data-testid="ov-issue"'), 1);
  assert.ok(top.includes("MISSING_EXECUTION_CONTEXT issue"));
  assert.ok(!top.includes("BROAD_SEARCH issue") && !top.includes("DOC_REREADS issue"), "secondary issues are not on the first screen");
  assert.ok(html.includes("BROAD_SEARCH issue"), "secondary issues are in details");
  // R: exactly one action
  assert.equal(count(top, 'data-testid="ov-action"'), 1);
  assert.match(top, /data-testid="ov-action-text">MISSING_EXECUTION_CONTEXT action</);
  // S: at most five numbers
  assert.ok(count(top, 'class="ov-metric"') <= MAX_OVERVIEW_METRICS);
  assert.equal(count(top, 'class="ov-metric"'), 5);
  // one chart only
  assert.equal(count(top, 'class="stack"'), 1);
  assert.equal(count(top, "<svg"), 0, "no timeline on the first screen");
  // T: details and every section collapsed
  assert.match(html, /<details class="ov-details" data-testid="ov-details" data-key="details" ontoggle/);
  assert.ok(!/<details[^>]* open/.test(html), "nothing is expanded by default");
});

test("U: observed vs estimated vs inferred stay distinct; estimates are approximate", async () => {
  const { html } = await renderFirstScreen(overviewData());
  const top = firstScreen(html);
  assert.match(top, /data-metric="context"><div class="ov-k">Context<\/div><div class="ov-v">47%<\/div><div class="ov-note"><span class="ov-ev ev-OBSERVED"/);
  assert.match(top, /data-metric="readPlan">.*8 required \/ 3 optional.*ev-PLANNED/);
  assert.match(top, /data-metric="suggestions">.*6 \/ 8.*ev-INFERRED/);
  assert.match(top, /data-metric="validation">.*4 PASS \/ 1 UNKNOWN.*ev-OBSERVED/);
  assert.match(top, /data-metric="filesChanged">.*>7<.*ev-OBSERVED/);
  assert.match(top, /data-testid="ov-flow"><div class="section-label">Context flow · ~18K <span class="ov-ev ev-ESTIMATED"/);
  assert.ok(!top.includes("18347") && !top.includes("18,347"), "no fake precision for estimates");

  // Context is the provider's observed usage only: unknown stays unknown.
  const unobserved = overviewData();
  delete unobserved.efficiency.current.peakContextUse;
  unobserved.overview = buildDashboardOverview(HEALTHY, unobserved.efficiency, { required: 1, optional: 0 });
  assert.equal(unobserved.overview.metrics.find((m) => m.key === "context").value, null);
  const rendered = firstScreen((await renderFirstScreen(unobserved)).html);
  assert.match(rendered, /data-metric="context">.*<div class="ov-v">—<\/div>.*not reported by the provider/);
});

test("V: LOW / SOON / NEW_THREAD wording (en + ko); raw enum only in details", async () => {
  const cases = [["CONTINUE", "LOW", "Room to continue", "여유 있음"], ["NEW_THREAD_SOON", "SOON", "Next large task: new thread", "다음 큰 작업은 새 스레드 권장"], ["NEW_THREAD_RECOMMENDED", "NEW_THREAD", "New thread recommended", "새 스레드 권장"]];
  for (const [raw, level, en, ko] of cases) {
    const data = overviewData({}, { now: { thread: { state: raw, reason: "r", evidence: "OBSERVED" } } });
    assert.equal(data.overview.thread.level, level);
    const enHtml = (await renderFirstScreen(data)).html;
    assert.match(firstScreen(enHtml), new RegExp(`data-testid="ov-thread"[^>]*><span class="ov-k">Thread</span><b>${en}</b>`));
    assert.ok(!firstScreen(enHtml).includes(raw), "raw enum is not on the first screen");
    const koHtml = (await renderFirstScreen({ ...data, state: { ...data.state, locale: "ko-KR" } }, "ko")).html;
    assert.match(firstScreen(koHtml), new RegExp(`<span class="ov-k">스레드</span><b>${ko}</b>`));
  }
});

test("W: every overview string exists in English and Korean; Korean issue copy is short product language", () => {
  const { en, ko } = dashboardTranslations;
  const keys = Object.keys(en).filter((key) => /^(ov|m_|ev_|evHelp_|d[A-Z]|cov_)/.test(key));
  assert.ok(keys.length > 40);
  for (const key of keys) assert.ok(ko[key], `missing ko: ${key}`);
  for (const key of Object.keys(ko).filter((key) => /^(ov|m_|ev_|evHelp_|d[A-Z]|cov_)/.test(key))) assert.ok(en[key], `missing en: ${key}`);
  assert.equal(ko.iss_MISSING_EXECUTION_CONTEXT, "이전 실행 파일을 다시 찾고 있어요.");
  for (const key of Object.keys(ko).filter((key) => key.startsWith("iss_"))) {
    assert.ok(!/agent|thread|run의/.test(ko[key]), `${key} avoids untranslated jargon: ${ko[key]}`);
  }
});

test("one action by precedence; Health is system/setup only, never context quality", () => {
  const r = report();
  // Context issues never make Health unhealthy.
  const healthy = buildDashboardOverview(HEALTHY, r);
  assert.equal(healthy.health.level, "HEALTHY");
  assert.equal(healthy.action.id, "FIX_ISSUE");
  // A stopped watch blocks everything else.
  const stopped = buildDashboardOverview({ ...HEALTHY, watchRunning: false }, r);
  assert.deepEqual([stopped.health.level, stopped.health.reason, stopped.action.id, stopped.action.command], ["ATTENTION", "watch-stopped", "START_WATCH", "dev-guard watch"]);
  assert.equal(buildDashboardOverview({ ...HEALTHY, setupActive: true }, r).action.id, "WAIT_SETUP");
  assert.equal(buildDashboardOverview({ ...HEALTHY, initialized: false }, r).health.reason, "not-initialized");
  // A thread that must roll over beats tuning the current one.
  const roll = report({ now: { thread: { state: "NEW_THREAD_RECOMMENDED", reason: "compacted", evidence: "OBSERVED" } } });
  assert.equal(buildDashboardOverview(HEALTHY, roll).action.id, "NEW_THREAD");
  // A pending quality review outranks a mild issue, never a strong one.
  const mild = report({ now: { primaryIssue: issue("UNUSED_SUGGESTIONS", { severity: "mild" }) } });
  assert.equal(buildDashboardOverview({ ...HEALTHY, qualityVerdict: "NEEDS_REVIEW" }, mild).action.id, "REVIEW_QUALITY");
  assert.equal(buildDashboardOverview(HEALTHY, mild).action.id, "FIX_ISSUE");
  assert.equal(buildDashboardOverview({ ...HEALTHY, qualityVerdict: "NEEDS_REVIEW" }, r).action.id, "FIX_ISSUE");
  // No issue: quality review, then SOON, then continue.
  const clean = report({ now: { primaryIssue: undefined, otherIssues: [] } });
  assert.equal(buildDashboardOverview({ ...HEALTHY, qualityVerdict: "NEEDS_REVIEW" }, clean).action.id, "REVIEW_QUALITY");
  const soon = report({ now: { primaryIssue: undefined, otherIssues: [], thread: { state: "NEW_THREAD_SOON", reason: "r", evidence: "OBSERVED" } } });
  assert.equal(buildDashboardOverview(HEALTHY, soon).action.id, "FINISH_THEN_NEW_THREAD");
  assert.equal(buildDashboardOverview(HEALTHY, clean).action.id, "CONTINUE");
  // No task yet: no task metrics, a "start a task" action.
  const none = buildDashboardOverview(HEALTHY, undefined);
  assert.deepEqual([none.action.id, none.metrics.length, none.thread.level], ["START_TASK", 0, "LOW"]);
  assert.equal(none.issue, undefined);
});

test("details lists are bounded", async () => {
  const data = overviewData();
  data.efficiency.taskCard.candidates = Array.from({ length: 500 }, (_, i) => `src/file${i}.ts`);
  const { html } = await renderFirstScreen(data);
  assert.ok(count(html, "src/file") <= 12, "at most 12 rows per list");
  assert.ok(html.includes("+488 more"));
});

test("browser regressions: Details sections are light rows, the timeline is bounded, narrow key/values stack, Korean report term is consistent", async () => {
  const { page } = await renderFirstScreen(overviewData());
  // Found in the real-browser pass: the generic `details` card style made every section a nested box.
  assert.match(page, /\.ov-sub \{ border: 0; border-top: 1px solid var\(--line\); border-radius: 0; overflow: visible; \}/);
  assert.match(page, /\.ov-sub > summary \{[^}]*text-transform: none/);
  // The timeline SVG had no height rule once it moved into Details.
  assert.match(page, /\.ov-sub-body svg \{ width: 100%; height: 120px; display: block; \}/);
  // At phone width, label/value pairs stack instead of squeezing values mid-word.
  assert.match(page, /@media \(max-width: 640px\) \{[^@]*\.ov-sub-body \.eff-kv \{ grid-template-columns: 1fr; gap: 0; \}/);
  const ko = dashboardTranslations.ko;
  assert.ok(!Object.values(ko).some((value) => value.includes("리포트")), "Korean UI uses 보고서 consistently");
});
