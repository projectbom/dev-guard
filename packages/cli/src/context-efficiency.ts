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
  /** Highest provider-reported input/context-window ratio in this task (OBSERVED from the agent's local log), when logged. */
  peakContextUse?: number;
  /** Provided files read exactly once and never edited — suggestions that cost initial context but were not used further. */
  unusedSuggestionReads: { files: number; estTokens: number };
  /** Repo files the agent read that DevGuard did not provide (excluding files the task edits) — inputs it had to find itself. */
  nonProvidedReads: { files: number; estTokens: number };
  /** Provided Markdown/JSON read more than once without being edited — the given ranges were not enough; re-read cost only. */
  providedDocRereads: { files: number; estTokens: number };
  /** Repo files read/edited plus provided files (max 30) — for workstream overlap. */
  touchedFiles: string[];
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

// --- Problem-first view (developer dashboard) ------------------------------

export type ContextHealth = "GOOD" | "NEEDS_ATTENTION" | "POOR";
export type IssueId =
  | "CONTEXT_PRESSURE"
  | "DOC_REREADS"
  | "BROAD_SEARCH"
  | "MISSING_REQUIRED_INPUTS"
  | "INSUFFICIENT_DOCUMENT_RANGES"
  | "UNUSED_SUGGESTIONS"
  | "SUGGESTIONS_MISSED"
  | "CONTEXT_OVERHEAD"
  | "EXPLORATION_HEAVY";

export interface ContextIssue {
  id: IssueId;
  severity: "strong" | "mild";
  /** One sentence: what is wrong. */
  issue: string;
  /** One sentence: why (with the observed numbers). */
  why: string;
  /** One sentence: what to do. */
  action: string;
  evidence: EvidenceKind;
  /** Estimated tokens this issue accounts for — context-cost issues are ranked by it, largest first. */
  impactTokens?: number;
}

export type ContextGroup = "DEVGUARD" | "CODE" | "SEARCH" | "VALIDATION" | "CONTEXT_MANAGEMENT" | "OTHER";

/** Six human groups for the one default graph ("Where context went"). */
export function contextGroups(costs: Record<ContextCostCategory, number>): Record<ContextGroup, number> {
  return {
    DEVGUARD: costs.MCP,
    CODE: costs.CODE_READS + costs.CODE_EDITS,
    SEARCH: costs.SEARCH,
    VALIDATION: costs.VALIDATION,
    CONTEXT_MANAGEMENT: costs.FALLBACK_DOCS + costs.ADMIN,
    OTHER: costs.OTHER
  };
}

/**
 * Deterministic issues for one task. Thresholds come from the real
 * downstream baseline: before the context-workflow fixes a long thread showed
 * 2–6 DevGuard-doc re-reads and many repository-wide searches per task;
 * after them, healthy sessions showed 0 doc re-reads, 0 repository-wide
 * searches and 1.5–2% context overhead.
 */
export function contextIssues(task: TaskEfficiency): ContextIssue[] {
  const issues: ContextIssue[] = [];
  const total = Math.max(1, task.estTokens);
  if (task.compactions > 0) {
    issues.push({ id: "CONTEXT_PRESSURE", severity: "strong", issue: "The agent thread was compacted during this task.", why: `${task.compactions} compaction(s) were recorded in the agent's own log.`, action: "Finish this task here, then start the next task in a fresh thread.", evidence: "OBSERVED" });
  } else if (task.peakContextUse !== undefined && task.peakContextUse >= 0.6) {
    issues.push({
      id: "CONTEXT_PRESSURE",
      severity: "mild",
      issue: task.broadSearchCalls === 0 ? "Context usage was high, but repository discovery remained targeted." : "Context usage was high for this task.",
      why: `The agent's own log reported up to ${Math.round(task.peakContextUse * 100)}% of its context window in use.`,
      action: "Finish this task here; start a different or heavy next task in a fresh thread.",
      evidence: "OBSERVED"
    });
  }
  if (task.fallbackDocReads >= 2 || (task.fallbackDocReads > 0 && task.costByCategory.FALLBACK_DOCS > task.costByCategory.MCP)) {
    issues.push({ id: "DOC_REREADS", severity: "strong", issue: "The agent re-read DevGuard reports instead of using the task context it was given.", why: `${task.fallbackDocReads} DevGuard markdown read(s), ${share(task.costByCategory.FALLBACK_DOCS, total)}% of this task's estimated context.`, action: "Use the prepare_task_context result only; do not open DevGuard reports during the task.", evidence: "OBSERVED" });
  }
  if (task.broadSearchCalls >= 3 || (task.broadSearchCalls > 0 && task.searchBeforeProvidedRead)) {
    issues.push({ id: "BROAD_SEARCH", severity: task.broadSearchCalls >= 3 ? "strong" : "mild", issue: "The agent searched the whole repository instead of starting from DevGuard's suggestions.", why: `${task.broadSearchCalls} repository-wide search(es)${task.searchBeforeProvidedRead ? ", before any suggested file was opened" : ""}.`, action: "Open DevGuard target ranges before searching the repository.", evidence: "OBSERVED" });
  }
  const missing = task.nonProvidedReads;
  if (missing.estTokens >= 8000 && share(missing.estTokens, total) >= 15) {
    issues.push({
      id: "MISSING_REQUIRED_INPUTS",
      severity: share(missing.estTokens, total) >= 30 ? "strong" : "mild",
      issue: "The agent read many files DevGuard did not plan — required inputs were missing from the read plan.",
      why: `${missing.files} file(s) DevGuard did not provide (~${fmtK(missing.estTokens)} estimated tokens, ${share(missing.estTokens, total)}% of this task) were read.`,
      action: "Pass the files the user named as explicitInputs to prepare_task_context; DevGuard then plans them, and the scripts their evidence names, as one read plan.",
      evidence: "INFERRED",
      impactTokens: missing.estTokens
    });
  }
  if (task.providedDocRereads.files >= 1 && task.providedDocRereads.estTokens >= 2000) {
    issues.push({
      id: "INSUFFICIENT_DOCUMENT_RANGES",
      severity: "mild",
      issue: "Planned document ranges were not enough — the agent re-read the same documents.",
      why: `${task.providedDocRereads.files} provided document(s) were read again (~${fmtK(task.providedDocRereads.estTokens)} estimated tokens of re-reads).`,
      action: "Read a WHOLE_FILE target once; for large documents read the planned sections, then only the one missing section.",
      evidence: "INFERRED",
      impactTokens: task.providedDocRereads.estTokens
    });
  }
  if (task.unusedSuggestionReads.files >= 3 && task.unusedSuggestionReads.estTokens >= 3000) {
    issues.push({ id: "UNUSED_SUGGESTIONS", severity: "mild", issue: "Too much initial context was spent on suggested files the task did not use further.", why: `${task.unusedSuggestionReads.files} suggested files (~${fmtK(task.unusedSuggestionReads.estTokens)} estimated tokens) were read once and never used again.`, action: "Read TARGET files first; open CANDIDATE files only when the targets are not enough.", evidence: "INFERRED", impactTokens: task.unusedSuggestionReads.estTokens });
  }
  if (!issues.some((item) => item.id === "MISSING_REQUIRED_INPUTS") && task.candidateUtilization && task.candidateUtilization.of >= 3 && task.candidateUtilization.used / task.candidateUtilization.of < 0.4) {
    issues.push({ id: "SUGGESTIONS_MISSED", severity: "mild", issue: "Most files the agent worked with were not DevGuard suggestions.", why: `Only ${task.candidateUtilization.used} of the first ${task.candidateUtilization.of} files used were suggested.`, action: "Name the target area or files in the task description so DevGuard can suggest them.", evidence: "INFERRED" });
  }
  const overhead = share(task.costByCategory.FALLBACK_DOCS + task.costByCategory.ADMIN, total);
  if (overhead >= 15 && !issues.some((item) => item.id === "DOC_REREADS")) {
    issues.push({ id: "CONTEXT_OVERHEAD", severity: "mild", issue: "DevGuard workflow overhead is high for this task.", why: `${overhead}% of estimated context went to DevGuard docs/commands.`, action: "Avoid DevGuard status/report commands during the task.", evidence: "ESTIMATED" });
  }
  const exploration = share(task.modeTokens.EXPLORATION, total);
  if (exploration >= 50 && task.modeTokens.EXPLORATION > 2 * task.modeTokens.IMPLEMENTATION) {
    issues.push({ id: "EXPLORATION_HEAVY", severity: "mild", issue: "The agent is spending more context finding files than implementing.", why: `Exploration is ${exploration}% of estimated context vs ${share(task.modeTokens.IMPLEMENTATION, total)}% implementation.`, action: "Narrow the task to a specific area or file before reading further.", evidence: "INFERRED" });
  }
  // Workflow violations first (fixed order); context-cost issues by the
  // estimated tokens they account for, so the primary issue is the largest
  // real source, not whichever rule happens to be listed first.
  const order: IssueId[] = ["CONTEXT_PRESSURE", "DOC_REREADS", "BROAD_SEARCH", "MISSING_REQUIRED_INPUTS", "INSUFFICIENT_DOCUMENT_RANGES", "UNUSED_SUGGESTIONS", "SUGGESTIONS_MISSED", "CONTEXT_OVERHEAD", "EXPLORATION_HEAVY"];
  return issues.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "strong" ? -1 : 1) ||
      (a.impactTokens !== undefined && b.impactTokens !== undefined ? b.impactTokens - a.impactTokens : 0) ||
      order.indexOf(a.id) - order.indexOf(b.id)
  );
}

export function contextHealth(issues: ContextIssue[]): ContextHealth {
  const strong = issues.filter((issue) => issue.severity === "strong").length;
  if (issues.length === 0) return "GOOD";
  if (strong >= 2 || (strong >= 1 && issues.length >= 3)) return "POOR";
  return "NEEDS_ATTENTION";
}

export function agentFocus(task: TaskEfficiency): { mode: "IMPLEMENTING" | "EXPLORING" | "VALIDATING" | "MIXED"; sentence: string } {
  const { IMPLEMENTATION, EXPLORATION, VALIDATION } = task.modeTokens;
  const known = IMPLEMENTATION + EXPLORATION + VALIDATION;
  if (known === 0) return { mode: "MIXED", sentence: "Not enough classified activity yet." };
  if (EXPLORATION > IMPLEMENTATION * 1.5 && EXPLORATION >= VALIDATION) return { mode: "EXPLORING", sentence: "The agent is spending more context finding and reading files than implementing." };
  if (VALIDATION > IMPLEMENTATION && VALIDATION > EXPLORATION) return { mode: "VALIDATING", sentence: "Most activity is checking the work (tests, builds, runtime checks)." };
  if (IMPLEMENTATION >= EXPLORATION * 0.6) return { mode: "IMPLEMENTING", sentence: "Most activity is focused on implementing the task." };
  return { mode: "MIXED", sentence: "Activity is split between finding files and implementing." };
}

function fmtK(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
}

export interface ContextEfficiencyReport {
  generatedAt: string;
  /** The five-second view: is it OK, what is wrong, why, what to do, keep the thread? */
  now: {
    health: ContextHealth;
    task?: string;
    primaryIssue?: ContextIssue;
    otherIssues: ContextIssue[];
    message: string;
    action: string;
    thread: { state: RolloverState; reason: string; evidence: EvidenceKind };
  };
  /** At most four human-labelled numbers for the current task. */
  currentTask?: {
    suggestionsUsed?: { used: number; of: number };
    repositorySearches: { total: number; broad: number };
    contextOverheadPct: number;
    openBlockers: number;
    focus: { mode: string; sentence: string };
    whereContextWent: Record<ContextGroup, number>;
    estimatedContextTokens: number;
  };
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
  /** TARGET files (read first). */
  edit: string[];
  /** CANDIDATE files (open only if needed). */
  candidates: string[];
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
  const windowEvents = events.filter((event) => event.ts >= start && event.ts < end && userThreads.has(event.thread));
  const usage = windowEvents.filter((event) => event.kind === "context_usage" && event.inputTokens && event.contextWindow);
  const inWindow = windowEvents.filter((event) => event.kind !== "context_usage");
  const costByCategory = emptyCosts();
  const modeTokens = emptyModes();
  const otherBreakdown: Record<string, number> = {};
  const editedPaths = new Set(inWindow.filter((event) => event.category === "CODE_EDITS").flatMap((event) => event.paths ?? []));
  const provided = new Set(window.providedFiles.length ? window.providedFiles : inWindow.find((event) => event.providedPaths?.length)?.providedPaths ?? []);
  const usedOrder: string[] = [];
  const providedReadCounts = new Map<string, { reads: number; estTokens: number }>();
  const otherReadTokens = new Map<string, number>();
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
    if (event.category === "CODE_READS" || event.category === "CODE_EDITS" || event.category === "SEARCH") {
      const paths = event.paths ?? [];
      for (const path of paths) {
        if (!usedOrder.includes(path)) usedOrder.push(path);
        if (provided.has(path) && firstProvidedUseIndex < 0) firstProvidedUseIndex = index;
        if (provided.has(path) && event.category !== "CODE_EDITS") {
          const entry = providedReadCounts.get(path) ?? { reads: 0, estTokens: 0 };
          entry.reads += 1;
          entry.estTokens += Math.round(event.estTokens / paths.length);
          providedReadCounts.set(path, entry);
        }
        if (!provided.has(path) && event.category === "CODE_READS") otherReadTokens.set(path, (otherReadTokens.get(path) ?? 0) + Math.round(event.estTokens / paths.length));
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
    activityEvents: inWindow.length,
    ...(usage.length ? { peakContextUse: Math.max(...usage.map((event) => event.inputTokens! / event.contextWindow!)) } : {}),
    touchedFiles: [...new Set([...usedOrder, ...provided])].slice(0, 30),
    unusedSuggestionReads: [...providedReadCounts.entries()]
      .filter(([path, entry]) => entry.reads === 1 && !editedPaths.has(path))
      .reduce((sum, [, entry]) => ({ files: sum.files + 1, estTokens: sum.estTokens + entry.estTokens }), { files: 0, estTokens: 0 }),
    nonProvidedReads: [...otherReadTokens.entries()]
      .filter(([path]) => !editedPaths.has(path))
      .reduce((sum, [, estTokens]) => ({ files: sum.files + 1, estTokens: sum.estTokens + estTokens }), { files: 0, estTokens: 0 }),
    providedDocRereads: [...providedReadCounts.entries()]
      .filter(([path, entry]) => entry.reads > 1 && !editedPaths.has(path) && /\.(?:mdx?|json)$/i.test(path))
      .reduce((sum, [, entry]) => ({ files: sum.files + 1, estTokens: sum.estTokens + Math.round((entry.estTokens * (entry.reads - 1)) / entry.reads) }), { files: 0, estTokens: 0 })
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

export type WorkstreamRelation = "SAME" | "DIFFERENT" | "UNKNOWN";

const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "into", "only", "then", "that", "this", "without", "after", "before", "read", "write", "make", "update", "change", "check", "verify", "task", "phase", "using", "current", "existing", "또는", "그리고"]);

function goalWords(goal: string): Set<string> {
  return new Set((goal.toLowerCase().match(/[a-z0-9가-힣_]{4,}/g) ?? []).filter((word) => !STOP_WORDS.has(word)));
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Deterministic workstream relation between two consecutive tasks: shared
 * goal vocabulary and shared files. UNKNOWN when there is not enough data —
 * never assumed to be a different workstream.
 */
export function workstreamRelation(previous: { goal?: string; files: string[] }, current: { goal?: string; files: string[] }): { relation: WorkstreamRelation; goalOverlap: number; fileOverlap: number } {
  const previousWords = goalWords(previous.goal ?? "");
  const currentWords = goalWords(current.goal ?? "");
  const goalOverlap = jaccard(previousWords, currentWords);
  const sharedWords = [...currentWords].filter((word) => previousWords.has(word)).length;
  const hasFiles = previous.files.length > 0 && current.files.length > 0;
  const fileOverlap = hasFiles ? jaccard(new Set(previous.files), new Set(current.files)) : 0;
  const hasGoals = previousWords.size >= 3 && currentWords.size >= 3;
  if ((hasGoals && goalOverlap >= 0.15 && sharedWords >= 3) || fileOverlap >= 0.2) return { relation: "SAME", goalOverlap, fileOverlap };
  if (hasGoals && goalOverlap < 0.06 && (!hasFiles || fileOverlap < 0.05)) return { relation: "DIFFERENT", goalOverlap, fileOverlap };
  return { relation: "UNKNOWN", goalOverlap, fileOverlap };
}

const HIGH_CONTEXT_USE = 0.7;
const MODERATE_CONTEXT_USE = 0.45;

/**
 * CONTINUE / SOON / NEW THREAD from observed context pressure (compaction,
 * provider-reported context use in the agent's own log), thread reuse and
 * workstream relation — never from "a task finished" alone, and never from
 * an estimated provider context percentage.
 */
export function rolloverStateFor(
  current: TaskEfficiency | undefined,
  threadTaskCounts: Map<string, number>,
  hasActiveTask: boolean,
  relation: { relation: WorkstreamRelation; goalOverlap: number; fileOverlap: number } = { relation: "UNKNOWN", goalOverlap: 0, fileOverlap: 0 }
): { state: RolloverState; reason: string; evidence: EvidenceKind } {
  if (!current) return { state: "CONTINUE", reason: "No DevGuard task recorded yet.", evidence: "INFERRED" };
  const peak = current.peakContextUse;
  const peakText = peak !== undefined ? `${Math.round(peak * 100)}% of the context window (agent log)` : undefined;
  const thread = current.threads.at(-1);
  const tasksInThread = thread ? threadTaskCounts.get(thread) ?? 1 : 1;
  const observed = current.threads.length > 0;
  if (current.doneAt && !hasActiveTask) {
    if (current.compactions > 0) return { state: "NEW_THREAD_RECOMMENDED", reason: `The finished task's thread was compacted ${current.compactions}× — start the next task in a fresh thread.`, evidence: "OBSERVED" };
    if (peak !== undefined && peak >= HIGH_CONTEXT_USE) return { state: "NEW_THREAD_RECOMMENDED", reason: `The finished task was heavy (up to ${peakText}) — start the next task in a fresh thread.`, evidence: "OBSERVED" };
    if ((peak !== undefined && peak >= MODERATE_CONTEXT_USE) || tasksInThread >= 3) {
      return { state: "NEW_THREAD_SOON", reason: `${peakText ? `Context use reached ${peakText}` : `This thread has hosted ${tasksInThread} tasks`}: continue only a small follow-up in the same workstream; start anything else in a fresh thread.`, evidence: observed ? "OBSERVED" : "INFERRED" };
    }
    if (peak === undefined && !observed) return { state: "NEW_THREAD_SOON", reason: "Agent context use is not observable here; prefer a fresh thread for the next distinct task.", evidence: "INFERRED" };
    return { state: "CONTINUE", reason: `Light task with no context pressure${peakText ? ` (${peakText})` : ""}: continue here if the next task is in the same workstream; use a fresh thread for a different workstream.`, evidence: "OBSERVED" };
  }
  if (current.compactions > 0) return { state: "NEW_THREAD_RECOMMENDED", reason: `This thread was compacted ${current.compactions}× during the task — finish here and move on in a fresh thread.`, evidence: "OBSERVED" };
  if (peak !== undefined && peak >= HIGH_CONTEXT_USE) return { state: "NEW_THREAD_SOON", reason: `Context use reached ${peakText}: finish this task, then start the next one in a fresh thread.`, evidence: "OBSERVED" };
  if (current.sameThreadAsPrevious) {
    if (relation.relation === "DIFFERENT") return { state: "NEW_THREAD_RECOMMENDED", reason: "This task is a different workstream from the previous task in this thread (little goal or file overlap) — a fresh thread avoids carrying unrelated context.", evidence: "INFERRED" };
    if (relation.relation === "UNKNOWN") return { state: "NEW_THREAD_SOON", reason: "This thread already hosted another task and the workstream relation is unclear; prefer a fresh thread at the next boundary.", evidence: "INFERRED" };
    if (tasksInThread >= 4) return { state: "NEW_THREAD_SOON", reason: `Same workstream, but this thread has hosted ${tasksInThread} tasks; start a fresh thread at the next boundary.`, evidence: "OBSERVED" };
    return { state: "CONTINUE", reason: `Same workstream as the previous task (goal overlap ${Math.round(relation.goalOverlap * 100)}%, file overlap ${Math.round(relation.fileOverlap * 100)}%) and no context pressure observed.`, evidence: "INFERRED" };
  }
  if (!observed) {
    return current.rolloverStatusAtPrepare && current.rolloverStatusAtPrepare !== "SAFE"
      ? { state: "NEW_THREAD_SOON", reason: "DevGuard's own rollover signal (not the provider's context window) suggests a fresh thread at the next boundary.", evidence: "INFERRED" }
      : { state: "CONTINUE", reason: "No context pressure signal available for this task.", evidence: "INFERRED" };
  }
  return { state: "CONTINUE", reason: `This task runs in its own thread with no context pressure observed${peakText ? ` (${peakText})` : ""}.`, evidence: "OBSERVED" };
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
  const previous = tasks.at(-2);
  const relation = current && previous ? workstreamRelation({ goal: labels.get(previous.sessionId), files: previous.touchedFiles }, { goal: labels.get(current.sessionId), files: current.touchedFiles }) : undefined;
  const rollover = rolloverStateFor(current, threadTaskCounts, Boolean(runtime.currentTask?.text?.trim()), relation);
  const recommendations = recommendationsFor(current, rollover);

  const largest = current ? COST_CATEGORIES.map((category) => ({ category, value: current.costByCategory[category] })).sort((a, b) => b.value - a.value)[0] : undefined;
  const dominantMode = current ? WORK_MODES.map((mode) => ({ mode, value: current.modeTokens[mode] })).sort((a, b) => b.value - a.value)[0] : undefined;

  const issues = current ? contextIssues(current) : [];
  const primaryIssue = issues[0];
  const openBlockers = (taskCard?.openValidation.length ?? 0) + (current ? current.validation.fail : 0);
  return {
    generatedAt: new Date(now).toISOString(),
    now: {
      health: contextHealth(issues),
      task: current?.label,
      ...(primaryIssue ? { primaryIssue } : {}),
      otherIssues: issues.slice(1, 3),
      message: primaryIssue ? primaryIssue.issue : current ? "No significant context inefficiency detected." : "No DevGuard task recorded yet.",
      action: primaryIssue ? primaryIssue.action : rollover.state === "CONTINUE" ? "Keep going in this thread." : "Start the next task in a fresh agent thread.",
      thread: rollover
    },
    ...(current
      ? {
          currentTask: {
            ...(current.candidateUtilization ? { suggestionsUsed: current.candidateUtilization } : {}),
            repositorySearches: { total: current.searchCalls, broad: current.broadSearchCalls },
            contextOverheadPct: share(current.costByCategory.FALLBACK_DOCS + current.costByCategory.ADMIN, Math.max(1, current.estTokens)),
            openBlockers,
            focus: agentFocus(current),
            whereContextWent: contextGroups(current.costByCategory),
            estimatedContextTokens: current.estTokens
          }
        }
      : {}),
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
  files?: Array<{ path: string; relevance?: string; role?: string }>;
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
    edit: (stored.files ?? []).filter((file) => (file.role ?? (file.relevance === "Reference" ? "REFERENCE" : "TARGET")) === "TARGET").map((file) => file.path),
    candidates: (stored.files ?? []).filter((file) => file.role === "CANDIDATE").map((file) => file.path),
    reference: (stored.files ?? []).filter((file) => (file.role ?? (file.relevance === "Reference" ? "REFERENCE" : "")) === "REFERENCE").map((file) => file.path),
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
