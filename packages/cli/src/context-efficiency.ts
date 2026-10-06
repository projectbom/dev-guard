import { CodexLocalActivitySource, ClaudeLocalActivitySource, type ActivityEvent, type ActivitySnapshot, type AgentActivitySource, type ContextCostCategory, type EvidenceKind, type ThreadInfo, type WorkMode } from "./agent-activity.js";
import { fromRoot, readJsonFile } from "./fs.js";
import { devguardPaths } from "./paths.js";
import { readTaskTelemetry, type TaskTelemetryEvent } from "./task-telemetry.js";

/**
 * Context Efficiency report: where an AI coding workflow's context goes,
 * per DevGuard task, built ONLY from
 *   - DevGuard's own telemetry (task windows, provided files, validation,
 *     completion, rollover status)            -> OBSERVED
 *   - provider-local activity logs (commands, MCP calls, edits, observed
 *     compactions, thread identity)            -> OBSERVED
 *   - text-size token estimates (chars/4)       -> ESTIMATED
 *   - deterministic rules over the above        -> INFERRED
 * Never provider-billed tokens, hidden reasoning, or a context-window %.
 */

export const COST_CATEGORIES: ContextCostCategory[] = ["MCP", "FALLBACK_DOCS", "SEARCH", "CODE_READS", "CODE_EDITS", "VALIDATION", "ADMIN", "OTHER"];
export const WORK_MODES: WorkMode[] = ["IMPLEMENTATION", "EXPLORATION", "VALIDATION", "CONTEXT_ADMIN", "RESUME_RECOVERY", "OTHER"];

export interface TaskEfficiency {
  sessionId: string;
  /** Task goal from the canonical prepared state when available (short). */
  label: string;
  startedAt: string;
  endedAt?: string;
  doneAt?: string;
  completionSource?: string;
  rolloverStatusAtPrepare?: string;
  estTokens: number;
  costByCategory: Record<ContextCostCategory, number>;
  modeTokens: Record<WorkMode, number>;
  otherBreakdown: Record<string, number>;
  provided: { files: number; ranges?: number; mcpPayloadTokens?: number };
  usedFiles: number;
  providedUsed: number;
  nonProvidedUsed: number;
  /** first-use files that were provided / first-use files considered (max 5). */
  candidateUtilization?: { used: number; of: number };
  searchCalls: number;
  broadSearchCalls: number;
  searchBeforeProvidedRead: boolean;
  fallbackDocReads: number;
  repeatedFallbackDocReads: number;
  validation: { pass: number; fail: number; unknown: number };
  threads: string[];
  /** Started in a provider thread that had already hosted an earlier DevGuard task (OBSERVED from the activity log). */
  sameThreadAsPrevious?: boolean;
  compactions: number;
  activityEvents: number;
}

export interface TimelineEvent {
  ts: string;
  type: "TASK_PREPARED" | "TASK_DONE" | "VALIDATION" | "ROLLOVER_SOON" | "ROLLOVER_RECOMMENDED" | "NEW_THREAD" | "COMPACTION";
  detail?: string;
  evidence: EvidenceKind;
}

export interface Recommendation {
  id: "A" | "B" | "C" | "D" | "E";
  text: string;
  reason: string;
  evidence: EvidenceKind;
}

export type RolloverState = "CONTINUE" | "NEW_THREAD_SOON" | "NEW_THREAD_RECOMMENDED";

export interface ContextEfficiencyReport {
  generatedAt: string;
  sources: Array<{ provider: string; available: boolean; note?: string; userThreads: number; subagentThreads: number }>;
  threadIdentity: "observed" | "unavailable";
  current?: TaskEfficiency;
  recent: TaskEfficiency[];
  summary: {
    task?: string;
    estimatedContextTokens: number;
    largestCost?: { category: ContextCostCategory; share: number };
    workMode?: { mode: WorkMode; share: number; heavy: boolean };
    candidateUsage?: { used: number; of: number };
    rollover: { state: RolloverState; reason: string; evidence: EvidenceKind };
    topRecommendation?: Recommendation;
  };
  recommendations: Recommendation[];
  timeline: { events: TimelineEvent[]; cumulative: Array<{ ts: string; estTokens: number }> };
  taskCard?: TaskCard;
  evidence: Record<string, EvidenceKind>;
}

export interface TaskCard {
  goal: string;
  nextAction?: string;
  edit: string[];
  reference: string[];
  protected: string[];
  freshValidation: string[];
  openValidation: string[];
  carriedOver?: number;
}

const ACTIVITY_LOOKBACK_MS = 14 * 86_400_000;
const RECENT_TASKS = 8;
const FIRST_USE_WINDOW = 5;

function emptyCosts(): Record<ContextCostCategory, number> {
  return Object.fromEntries(COST_CATEGORIES.map((key) => [key, 0])) as Record<ContextCostCategory, number>;
}

function emptyModes(): Record<WorkMode, number> {
  return Object.fromEntries(WORK_MODES.map((key) => [key, 0])) as Record<WorkMode, number>;
}

interface TaskWindow {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  doneAt?: string;
  completionSource?: string;
  rolloverStatus?: string;
  providedFiles: string[];
  providedRanges?: number;
  mcpPayloadTokens?: number;
  validation: { pass: number; fail: number; unknown: number };
  validationEvents: Array<{ ts: string; status: string; kind?: string }>;
}

/** Task windows from DevGuard telemetry: a new lineage starts at each TASK_PREPARED/REPLACED. */
export function taskWindows(events: TaskTelemetryEvent[]): TaskWindow[] {
  const windows: TaskWindow[] = [];
  const bySession = new Map<string, TaskWindow>();
  for (const event of events) {
    if (!event.sessionId) continue;
    if (event.event === "TASK_PREPARED" || event.event === "TASK_REPLACED" || (event.event === "TASK_CONTINUED" && !bySession.has(event.sessionId))) {
      const previous = windows.at(-1);
      if (previous && previous.sessionId !== event.sessionId && !previous.endedAt) previous.endedAt = event.timestamp;
      let window = bySession.get(event.sessionId);
      if (!window) {
        window = { sessionId: event.sessionId, startedAt: event.timestamp, providedFiles: [], validation: { pass: 0, fail: 0, unknown: 0 }, validationEvents: [] };
        bySession.set(event.sessionId, window);
        windows.push(window);
      }
      window.rolloverStatus = event.rolloverStatus ?? window.rolloverStatus;
      if (event.providedFiles?.length) window.providedFiles = [...new Set([...window.providedFiles, ...event.providedFiles])];
      if (event.providedRangeCount !== undefined) window.providedRanges = event.providedRangeCount;
      if (event.mcpPayloadTokens !== undefined) window.mcpPayloadTokens = event.mcpPayloadTokens;
      continue;
    }
    const window = bySession.get(event.sessionId);
    if (!window) continue;
    if (event.event === "TASK_CONTINUED") {
      if (event.providedFiles?.length) window.providedFiles = [...new Set([...window.providedFiles, ...event.providedFiles])];
    } else if (event.event === "TASK_DONE") {
      window.doneAt = event.timestamp;
      window.completionSource = event.completionSource ?? window.completionSource;
    } else if (event.event === "VALIDATION_RECORDED") {
      const status = (event.validationStatus ?? "").toUpperCase();
      if (status === "PASS") window.validation.pass += 1;
      else if (status === "FAIL") window.validation.fail += 1;
      else window.validation.unknown += 1;
      window.validationEvents.push({ ts: event.timestamp, status, kind: event.validationKind });
    }
  }
  return windows;
}

/** Pure aggregation of one task window over metadata-only activity events. */
export function aggregateTask(window: TaskWindow, events: ActivityEvent[], userThreads: Set<string>, previousThreads: Set<string>): TaskEfficiency {
  const start = window.startedAt;
  const end = window.endedAt ?? "9999";
  const inWindow = events.filter((event) => event.ts >= start && event.ts < end && userThreads.has(event.thread));
  const costByCategory = emptyCosts();
  const modeTokens = emptyModes();
  const otherBreakdown: Record<string, number> = {};
  const editedPaths = new Set(inWindow.filter((event) => event.category === "CODE_EDITS").flatMap((event) => event.paths ?? []));
  const provided = new Set(window.providedFiles.length ? window.providedFiles : inWindow.find((event) => event.providedPaths?.length)?.providedPaths ?? []);
  const usedOrder: string[] = [];
  const fallbackDocCounts = new Map<string, number>();
  let searchCalls = 0;
  let broadSearchCalls = 0;
  let firstBroadSearchIndex = -1;
  let firstProvidedUseIndex = -1;
  let compactions = 0;
  for (const [index, event] of inWindow.entries()) {
    costByCategory[event.category] += event.estTokens;
    // Reads of a file this task also edits are implementation work; other reads are exploration.
    const mode = event.category === "CODE_READS" && (event.paths ?? []).some((path) => editedPaths.has(path)) ? "IMPLEMENTATION" : event.mode;
    modeTokens[mode] += event.estTokens;
    if (event.category === "OTHER" && event.otherLabel) otherBreakdown[event.otherLabel] = (otherBreakdown[event.otherLabel] ?? 0) + event.estTokens;
    if (event.kind === "compaction") compactions += 1;
    if (event.category === "SEARCH") {
      searchCalls += 1;
      if (event.broadSearch) {
        broadSearchCalls += 1;
        if (firstBroadSearchIndex < 0) firstBroadSearchIndex = index;
      }
    }
    if (event.category === "FALLBACK_DOCS") for (const path of event.paths?.length ? event.paths : ["(devguard doc)"]) fallbackDocCounts.set(path, (fallbackDocCounts.get(path) ?? 0) + 1);
    if (event.category === "CODE_READS" || event.category === "CODE_EDITS") {
      for (const path of event.paths ?? []) {
        if (!usedOrder.includes(path)) usedOrder.push(path);
        if (provided.has(path) && firstProvidedUseIndex < 0) firstProvidedUseIndex = index;
      }
    }
  }
  const firstUse = usedOrder.slice(0, FIRST_USE_WINDOW);
  const providedUsed = usedOrder.filter((path) => provided.has(path)).length;
  const threads = [...new Set(inWindow.map((event) => event.thread))];
  const fallbackReads = [...fallbackDocCounts.values()].reduce((sum, count) => sum + count, 0);
  return {
    sessionId: window.sessionId,
    label: window.sessionId,
    startedAt: window.startedAt,
    endedAt: window.endedAt,
    doneAt: window.doneAt,
    completionSource: window.completionSource,
    rolloverStatusAtPrepare: window.rolloverStatus,
    estTokens: Object.values(costByCategory).reduce((sum, value) => sum + value, 0),
    costByCategory,
    modeTokens,
    otherBreakdown,
    provided: { files: provided.size, ranges: window.providedRanges, mcpPayloadTokens: window.mcpPayloadTokens },
    usedFiles: usedOrder.length,
    providedUsed,
    nonProvidedUsed: usedOrder.length - providedUsed,
    ...(provided.size > 0 && firstUse.length > 0 ? { candidateUtilization: { used: firstUse.filter((path) => provided.has(path)).length, of: firstUse.length } } : {}),
    searchCalls,
    broadSearchCalls,
    searchBeforeProvidedRead: firstBroadSearchIndex >= 0 && (firstProvidedUseIndex < 0 || firstBroadSearchIndex < firstProvidedUseIndex),
    fallbackDocReads: fallbackReads,
    repeatedFallbackDocReads: [...fallbackDocCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    validation: window.validation,
    threads,
    ...(threads.length > 0 && previousThreads.size > 0 ? { sameThreadAsPrevious: previousThreads.has(threads[0]) } : {}),
    compactions,
    activityEvents: inWindow.length
  };
}

function share(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

/** Deterministic, explainable rules; at most 3, in priority order. */
export function recommendationsFor(task: TaskEfficiency | undefined, rollover: { state: RolloverState; reason: string; evidence: EvidenceKind }): Recommendation[] {
  const list: Recommendation[] = [];
  if (task && task.estTokens > 0) {
    const fallback = task.costByCategory.FALLBACK_DOCS;
    const mcp = task.costByCategory.MCP;
    if (fallback > 0 && fallback > mcp) {
      list.push({
        id: "A",
        text: "Do not read DevGuard fallback docs after prepare_task_context succeeds.",
        reason: `Fallback docs used ${share(fallback, task.estTokens)}% of this task's estimated context (${task.fallbackDocReads} reads${task.repeatedFallbackDocReads ? `, ${task.repeatedFallbackDocReads} repeated` : ""}), more than the MCP result itself.`,
        evidence: "ESTIMATED"
      });
    }
    const utilization = task.candidateUtilization ? task.candidateUtilization.used / task.candidateUtilization.of : undefined;
    if (task.broadSearchCalls >= 3 && (utilization === undefined || utilization < 0.5)) {
      list.push({
        id: "B",
        text: "Read the provided ranges first; if they are wrong, check DevGuard candidate quality for this task.",
        reason: `${task.broadSearchCalls} repository-wide searches${task.candidateUtilization ? ` and only ${task.candidateUtilization.used}/${task.candidateUtilization.of} first-used files were DevGuard candidates` : " and no provided file was used"}.`,
        evidence: "INFERRED"
      });
    }
  }
  if (rollover.state === "NEW_THREAD_RECOMMENDED") list.push({ id: "C", text: "Start the next task in a fresh agent thread.", reason: rollover.reason, evidence: rollover.evidence });
  if (task && task.estTokens > 0) {
    const exploration = task.modeTokens.EXPLORATION;
    const implementation = task.modeTokens.IMPLEMENTATION;
    if (share(exploration, task.estTokens) >= 40 && exploration > 2 * implementation) {
      list.push({
        id: "D",
        text: "This task is exploration-heavy — narrow the target scope before reading further.",
        reason: `Exploration is ${share(exploration, task.estTokens)}% of estimated context vs ${share(implementation, task.estTokens)}% implementation.`,
        evidence: "INFERRED"
      });
    }
    const admin = task.modeTokens.CONTEXT_ADMIN;
    if (share(admin, task.estTokens) >= 15 && !list.some((item) => item.id === "A")) {
      list.push({
        id: "E",
        text: "DevGuard workflow/doc consumption is high for this task.",
        reason: `Context admin (DevGuard docs/commands) is ${share(admin, task.estTokens)}% of estimated context.`,
        evidence: "INFERRED"
      });
    }
  }
  return list.slice(0, 3);
}

/** Rollover state from observed facts first, DevGuard's own heuristic second. Never a context-window %. */
export function rolloverStateFor(current: TaskEfficiency | undefined, threadTaskCounts: Map<string, number>, hasActiveTask: boolean): { state: RolloverState; reason: string; evidence: EvidenceKind } {
  if (current?.doneAt && !hasActiveTask) {
    return { state: "NEW_THREAD_RECOMMENDED", reason: "Previous task completed. Starting the next distinct task in a fresh agent thread reduces carried context.", evidence: "OBSERVED" };
  }
  const thread = current?.threads.at(-1);
  if (current && thread && (threadTaskCounts.get(thread) ?? 0) >= 2) {
    return { state: "NEW_THREAD_RECOMMENDED", reason: `This agent thread has already hosted ${threadTaskCounts.get(thread)} DevGuard tasks${current.compactions ? ` and was compacted ${current.compactions}×` : ""}. Continue the next task in a fresh thread.`, evidence: "OBSERVED" };
  }
  if (current && current.compactions > 0) {
    return { state: "NEW_THREAD_RECOMMENDED", reason: `The agent thread was compacted ${current.compactions}× during this task. Move the next task to a fresh thread.`, evidence: "OBSERVED" };
  }
  if (current?.rolloverStatusAtPrepare && current.rolloverStatusAtPrepare !== "SAFE") {
    return { state: "NEW_THREAD_SOON", reason: "DevGuard's own rollover signal (DevGuard-owned heuristics, not the provider's context window) suggests a fresh thread soon.", evidence: "INFERRED" };
  }
  return { state: "CONTINUE", reason: "No completed task, thread reuse or compaction observed for the current task.", evidence: "INFERRED" };
}

const TIMELINE_LIMIT = 200;

export async function buildContextEfficiencyReport(
  root: string,
  options: { sources?: AgentActivitySource[]; now?: number; telemetry?: TaskTelemetryEvent[] } = {}
): Promise<ContextEfficiencyReport> {
  const now = options.now ?? Date.now();
  const telemetry = options.telemetry ?? (await readTaskTelemetry(root, 4000));
  const sources = options.sources ?? defaultSources();
  const snapshots: ActivitySnapshot[] = await Promise.all(sources.map((source) => source.collect(root, now - ACTIVITY_LOOKBACK_MS).catch(() => ({ provider: source.provider, available: false, note: "Activity source failed to read.", threads: [], events: [] }) as ActivitySnapshot)));
  const threads: ThreadInfo[] = snapshots.flatMap((snapshot) => snapshot.threads);
  const userThreads = new Set(threads.filter((thread) => thread.source === "user").map((thread) => thread.thread));
  const events = snapshots.flatMap((snapshot) => snapshot.events).sort((a, b) => a.ts.localeCompare(b.ts));

  const windows = taskWindows(telemetry);
  const recentWindows = windows.slice(-RECENT_TASKS);
  const taskCard = await readTaskCard(root);
  const tasks: TaskEfficiency[] = [];
  const threadTaskCounts = new Map<string, number>();
  let previousThreads = new Set<string>();
  for (const window of windows.slice(-RECENT_TASKS - 1)) {
    const task = aggregateTask(window, events, userThreads, previousThreads);
    for (const thread of task.threads) threadTaskCounts.set(thread, (threadTaskCounts.get(thread) ?? 0) + 1);
    if (task.threads.length) previousThreads = new Set(task.threads);
    if (recentWindows.includes(window)) tasks.push(task);
  }
  // Labels only from DevGuard's canonical goal records (telemetry itself
  // never stores task text): the prepared task state, the active runtime
  // task, and the last finalized goal.
  const runtime = await readJsonFile<{ sessionId?: string; currentTask?: { text?: string } }>(fromRoot(root, devguardPaths.runtime), {});
  const state = await readJsonFile<{ lastTaskGoal?: string; lastTaskGoalSessionId?: string }>(fromRoot(root, devguardPaths.state), {});
  const labels = new Map<string, string>();
  if (state.lastTaskGoalSessionId && state.lastTaskGoal) labels.set(state.lastTaskGoalSessionId, state.lastTaskGoal);
  if (runtime.sessionId && runtime.currentTask?.text) labels.set(runtime.sessionId, runtime.currentTask.text);
  if (taskCard?.sessionId) labels.set(taskCard.sessionId, taskCard.goal);
  for (const task of tasks) {
    const label = labels.get(task.sessionId);
    task.label = label ? shortLabel(label) : `Task ${task.startedAt.slice(5, 16).replace("T", " ")}`;
  }
  const current = tasks.at(-1);
  const rollover = rolloverStateFor(current, threadTaskCounts, Boolean(runtime.currentTask?.text?.trim()));
  const recommendations = recommendationsFor(current, rollover);

  const largest = current ? COST_CATEGORIES.map((category) => ({ category, value: current.costByCategory[category] })).sort((a, b) => b.value - a.value)[0] : undefined;
  const dominantMode = current ? WORK_MODES.map((mode) => ({ mode, value: current.modeTokens[mode] })).sort((a, b) => b.value - a.value)[0] : undefined;

  return {
    generatedAt: new Date(now).toISOString(),
    sources: snapshots.map((snapshot) => ({
      provider: snapshot.provider,
      available: snapshot.available,
      note: snapshot.note,
      userThreads: snapshot.threads.filter((thread) => thread.source === "user").length,
      subagentThreads: snapshot.threads.filter((thread) => thread.source === "subagent").length
    })),
    threadIdentity: userThreads.size > 0 ? "observed" : "unavailable",
    current,
    recent: tasks,
    summary: {
      task: current?.label,
      estimatedContextTokens: current?.estTokens ?? 0,
      ...(current && largest && largest.value > 0 ? { largestCost: { category: largest.category, share: share(largest.value, current.estTokens) } } : {}),
      ...(current && dominantMode && dominantMode.value > 0
        ? { workMode: { mode: dominantMode.mode, share: share(dominantMode.value, current.estTokens), heavy: share(dominantMode.value, current.estTokens) >= 40 } }
        : {}),
      ...(current?.provided.files ? { candidateUsage: { used: current.providedUsed, of: current.provided.files } } : {}),
      rollover,
      ...(recommendations[0] ? { topRecommendation: recommendations[0] } : {})
    },
    recommendations,
    timeline: buildTimeline(recentWindows, tasks, events, threads, userThreads),
    taskCard: taskCard ? stripSession(taskCard) : undefined,
    evidence: {
      estimatedContextTokens: "ESTIMATED",
      costByCategory: "ESTIMATED",
      searchCalls: "OBSERVED",
      fallbackDocReads: "OBSERVED",
      providedFiles: "OBSERVED",
      candidateUtilization: "INFERRED",
      workMode: "INFERRED",
      threads: "OBSERVED",
      compactions: "OBSERVED",
      rollover: rollover.evidence,
      recommendations: "INFERRED"
    }
  };
}

function buildTimeline(windows: TaskWindow[], tasks: TaskEfficiency[], events: ActivityEvent[], threads: ThreadInfo[], userThreads: Set<string>): ContextEfficiencyReport["timeline"] {
  const start = windows[0]?.startedAt;
  if (!start) return { events: [], cumulative: [] };
  const timeline: TimelineEvent[] = [];
  for (const window of windows) {
    timeline.push({ ts: window.startedAt, type: "TASK_PREPARED", detail: tasks.find((task) => task.sessionId === window.sessionId)?.label, evidence: "OBSERVED" });
    if (window.rolloverStatus === "ROLL_OVER_SOON") timeline.push({ ts: window.startedAt, type: "ROLLOVER_SOON", evidence: "INFERRED" });
    if (window.rolloverStatus === "ROLL_OVER_RECOMMENDED") timeline.push({ ts: window.startedAt, type: "ROLLOVER_RECOMMENDED", evidence: "INFERRED" });
    for (const validation of window.validationEvents) timeline.push({ ts: validation.ts, type: "VALIDATION", detail: `${validation.kind ?? ""} ${validation.status}`.trim(), evidence: "OBSERVED" });
    if (window.doneAt) timeline.push({ ts: window.doneAt, type: "TASK_DONE", detail: window.completionSource, evidence: "OBSERVED" });
  }
  for (const thread of threads) if (thread.source === "user" && thread.startedAt >= start) timeline.push({ ts: thread.startedAt, type: "NEW_THREAD", evidence: "OBSERVED" });
  const scoped = events.filter((event) => event.ts >= start && userThreads.has(event.thread));
  for (const event of scoped) if (event.kind === "compaction") timeline.push({ ts: event.ts, type: "COMPACTION", evidence: "OBSERVED" });
  timeline.sort((a, b) => a.ts.localeCompare(b.ts));
  const cumulative: Array<{ ts: string; estTokens: number }> = [];
  let total = 0;
  const step = Math.max(1, Math.ceil(scoped.length / TIMELINE_LIMIT));
  scoped.forEach((event, index) => {
    total += event.estTokens;
    if (index % step === 0 || index === scoped.length - 1) cumulative.push({ ts: event.ts, estTokens: total });
  });
  return { events: timeline.slice(-TIMELINE_LIMIT), cumulative };
}

interface StoredTaskContext {
  sessionId?: string;
  task?: string;
  nextAction?: string;
  files?: Array<{ path: string; relevance: string }>;
  constraints?: string[];
  scope?: { carriedOverDirtyFiles?: number };
  validation?: { freshForThisTask?: string[] };
  openValidation?: string[];
}

async function readTaskCard(root: string): Promise<(TaskCard & { sessionId?: string }) | undefined> {
  const stored = await readJsonFile<StoredTaskContext | null>(fromRoot(root, devguardPaths.taskContextState), null, { maxBytes: 512 * 1024 });
  if (!stored?.task) return undefined;
  return {
    sessionId: stored.sessionId,
    goal: stored.task,
    nextAction: stored.nextAction,
    edit: (stored.files ?? []).filter((file) => file.relevance !== "Reference").map((file) => file.path),
    reference: (stored.files ?? []).filter((file) => file.relevance === "Reference").map((file) => file.path),
    protected: stored.constraints ?? [],
    freshValidation: stored.validation?.freshForThisTask ?? [],
    openValidation: stored.openValidation ?? [],
    carriedOver: stored.scope?.carriedOverDirtyFiles
  };
}

function stripSession(card: TaskCard & { sessionId?: string }): TaskCard {
  const { sessionId: _sessionId, ...rest } = card;
  return rest;
}

function shortLabel(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > 80 ? `${single.slice(0, 77)}...` : single;
}

let sharedSources: AgentActivitySource[] | undefined;

function defaultSources(): AgentActivitySource[] {
  sharedSources ??= [new CodexLocalActivitySource(), new ClaudeLocalActivitySource()];
  return sharedSources;
}

const CACHE_TTL_MS = 10_000;
const reportCache = new Map<string, { at: number; report: Promise<ContextEfficiencyReport> }>();

/** Cached for the dashboard: recomputed at most every 10s; sources parse incrementally. */
export function getContextEfficiencyReport(root: string): Promise<ContextEfficiencyReport> {
  const cached = reportCache.get(root);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.report;
  const report = buildContextEfficiencyReport(root);
  reportCache.set(root, { at: Date.now(), report });
  report.catch(() => reportCache.delete(root));
  return report;
}
