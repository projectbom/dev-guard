/**
 * Verified Project State.
 *
 *   small append-only structured events  (.devguard/events/task-events.jsonl)
 *              ↓  fold (pure) + freshness (current file fingerprints)
 *   deterministic current-state projection (.devguard/state/current.json)
 *              ↓
 *   prepare_task_context · handoff · quality report · dashboard
 *
 * The ledger records what happened; the projection says what is still true
 * and why it can be trusted. Every fact carries a provenance:
 *   OBSERVED        DevGuard saw it itself (transcript command + exit code,
 *                   file fingerprints, its own self-check).
 *   AGENT_REPORTED  an agent said so and DevGuard could not confirm it.
 *   USER_DECISION   an explicit user decision carried through the agent.
 *   DERIVED         computed deterministically from other evidence.
 *
 * `current.json` is a cache: `rebuildProjectState` recomputes it from the
 * ledger plus the current working tree at any time. Markdown reports are
 * views of the projection, never its source. Nothing here calls a model.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { PROJECT_EVENTS_RETENTION, ROTATED_SUFFIX, rotateJsonlIfNeeded } from "./artifact-retention.js";
import { appendTextFile, fromRoot, writeTextFile } from "./fs.js";
import { commandKey, normalizeCommand, type Verification } from "./observed-commands.js";
import { devguardPaths } from "./paths.js";

const execFileAsync = promisify(execFile);

export const PROJECT_STATE_SCHEMA_VERSION = 1 as const;

export type Provenance = "OBSERVED" | "AGENT_REPORTED" | "USER_DECISION" | "DERIVED";
export type TaskOutcomeStatus = "PASS" | "FAIL" | "STOPPED" | "BLOCKED" | "UNKNOWN";
export type Lifecycle = "CURRENT" | "STALE" | "SUPERSEDED";
export type DecisionLifecycle = "CURRENT" | "SUPERSEDED" | "EXPIRED";
export type DecisionScope = "TASK" | "LINEAGE" | "PROJECT";
export type { Verification };

export const TASK_OUTCOME_STATUSES: readonly TaskOutcomeStatus[] = ["PASS", "FAIL", "STOPPED", "BLOCKED", "UNKNOWN"];
export const DECISION_SCOPES: readonly DecisionScope[] = ["TASK", "LINEAGE", "PROJECT"];

/** Field bounds: the ledger holds structured state, never reports. */
export const LIMITS = {
  taskText: 240,
  reason: 400,
  blockedOn: 240,
  nextIntent: 400,
  decision: 300,
  command: 200,
  summary: 200,
  supersedes: 8,
  scopeFiles: 400,
  ownedFilesListed: 40,
  observedCommandsPerTask: 10
} as const;

// --- events ---------------------------------------------------------------

export type ValidationScope =
  /** Per-file content fingerprints of the files that support the check. */
  | { mode: "SCOPED"; files: Record<string, string> }
  /** No safe file scope: bound to the whole working-tree fingerprint (the pre-0.12 rule). */
  | { mode: "WORKTREE"; codeStateHash?: string }
  /** No git: valid only within the task that recorded it. */
  | { mode: "SESSION" };

export interface TaskStartedPayload {
  task: string;
  /** The task this one continues (same workstream, or a bare "continue" request). */
  continues?: string;
  /** DERIVED reason for `continues`. */
  continuesBy?: "workstream" | "continue-request";
  /** Validated user-named input paths (paths only, bounded) — inherited by a bare "continue" request. */
  explicitInputs?: string[];
}

export interface ValidationRecordedPayload {
  /** kind::name — the validation identity qaResults uses. */
  identity: string;
  kind: string;
  name: string;
  status: "PASS" | "FAIL" | "UNKNOWN";
  command?: string;
  commandKey?: string;
  reportedExitCode?: number;
  observedExitCode?: number;
  observedAt?: string;
  verification: Verification;
  note?: string;
  scope: ValidationScope;
  summary?: string;
  binding: "BOUND" | "UNBOUND" | "COMPLETED_TASK";
  /** Imported from pre-0.12 runtime state: never stronger than AGENT_REPORTED/UNVERIFIED. */
  legacy?: boolean;
  /** Matches QAExecutionResult.completedAt, to join with runtime qaResults. */
  completedAt: string;
}

export interface TaskOutcomePayload {
  status: TaskOutcomeStatus;
  reason?: string;
  blockedOn?: string;
  nextIntent?: string;
  /** Task ids, validation identities, or event ids this outcome explicitly supersedes. */
  supersedes?: string[];
}

export interface UserDecisionPayload {
  decisionId: string;
  decision: string;
  scope: DecisionScope;
  supersedes?: string[];
}

export interface TaskClosedPayload {
  /** First LIMITS.ownedFilesListed task-owned changed files. */
  taskOwnedChanges: string[];
  taskOwnedCount: number;
  /** Fingerprints of task-owned files at close (bounded), to stale checks recorded before later edits. */
  ownedFingerprints?: Record<string, string>;
  carriedDirtyCount: number;
  carriedDirtyHash?: string;
}

export interface CommandObservedPayload {
  command: string;
  commandKey: string;
  exitCode?: number;
  observedAt: string;
}

export interface StateCheckpointPayload {
  folded: FoldedState;
}

interface EventEnvelope<T extends string, P> {
  schemaVersion: typeof PROJECT_STATE_SCHEMA_VERSION;
  eventId: string;
  timestamp: string;
  taskId?: string;
  lineageId?: string;
  type: T;
  provenance: Provenance;
  payload: P;
}

export type ProjectEvent =
  | EventEnvelope<"TASK_STARTED", TaskStartedPayload>
  | EventEnvelope<"VALIDATION_RECORDED", ValidationRecordedPayload>
  | EventEnvelope<"TASK_OUTCOME_RECORDED", TaskOutcomePayload>
  | EventEnvelope<"USER_DECISION_RECORDED", UserDecisionPayload>
  | EventEnvelope<"TASK_CLOSED", TaskClosedPayload>
  | EventEnvelope<"COMMAND_OBSERVED", CommandObservedPayload>
  | EventEnvelope<"STATE_CHECKPOINT", StateCheckpointPayload>;

export type ProjectEventType = ProjectEvent["type"];
type NewEvent = Omit<ProjectEvent, "schemaVersion" | "eventId" | "timestamp"> & { timestamp?: string; eventId?: string };

export function newEventId(): string {
  return `ev_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function bound(text: string | undefined, max: number): string | undefined {
  const value = text?.replace(/\s+/g, " ").trim();
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// --- folded state (pure) --------------------------------------------------

export interface FoldedTask {
  taskId: string;
  lineageId: string;
  task: string;
  startedAt: string;
  continues?: string;
  explicitInputs?: string[];
  closedAt?: string;
  closed?: TaskClosedPayload;
  outcomes: FoldedOutcome[];
  /** Event id of the later outcome / explicit reference that superseded this task's outcome. */
  outcomeSupersededBy?: string;
}

export interface FoldedOutcome extends TaskOutcomePayload {
  eventId: string;
  taskId: string;
  recordedAt: string;
  provenance: Provenance;
}

export interface FoldedValidation extends ValidationRecordedPayload {
  eventId: string;
  taskId?: string;
  recordedAt: string;
  provenance: Provenance;
  supersededBy?: string;
}

export interface FoldedDecision extends UserDecisionPayload {
  eventId: string;
  taskId?: string;
  lineageId?: string;
  recordedAt: string;
  supersededBy?: string;
}

export interface FoldedCommand extends CommandObservedPayload {
  taskId?: string;
}

export interface FoldedState {
  tasks: FoldedTask[];
  validations: FoldedValidation[];
  decisions: FoldedDecision[];
  commands: FoldedCommand[];
  events: number;
  lastEventId?: string;
}

export function emptyFolded(): FoldedState {
  return { tasks: [], validations: [], decisions: [], commands: [], events: 0 };
}

/** Bounds on what a fold keeps (and therefore what a checkpoint carries). */
const FOLD_KEEP = { tasks: 200, validations: 400, decisions: 100, commands: 100 } as const;

/**
 * Deterministic fold of ledger events into structured state. Supersession
 * rules (conservative — a later task alone never supersedes anything):
 *  V1 a BOUND validation supersedes earlier ones with the same identity
 *     (kind::name) or the same normalized command;
 *  V2 an outcome's explicit `supersedes` names a validation identity/event;
 *  O1 within one task, the latest outcome is the task's outcome;
 *  O2 an outcome recorded by a task supersedes the outcome of every task it
 *     continues (its continuation chain), and of tasks named in `supersedes`;
 *  D1 a decision's explicit `supersedes` retires the named decisions.
 */
export function foldEvents(events: readonly ProjectEvent[], start: FoldedState = emptyFolded()): FoldedState {
  const state: FoldedState = structuredClone(start);
  const taskById = new Map(state.tasks.map((task) => [task.taskId, task]));
  const ensureTask = (taskId: string, at: string, lineageId?: string): FoldedTask => {
    let task = taskById.get(taskId);
    if (!task) {
      task = { taskId, lineageId: lineageId ?? taskId, task: "", startedAt: at, outcomes: [] };
      taskById.set(taskId, task);
      state.tasks.push(task);
    }
    return task;
  };
  for (const event of events) {
    state.events += 1;
    state.lastEventId = event.eventId;
    switch (event.type) {
      case "STATE_CHECKPOINT": {
        const restored = structuredClone(event.payload.folded);
        state.tasks = restored.tasks;
        state.validations = restored.validations;
        state.decisions = restored.decisions;
        state.commands = restored.commands;
        taskById.clear();
        for (const task of state.tasks) taskById.set(task.taskId, task);
        break;
      }
      case "TASK_STARTED": {
        if (!event.taskId) break;
        const task = ensureTask(event.taskId, event.timestamp, event.lineageId);
        task.task = event.payload.task;
        task.startedAt = event.timestamp;
        task.lineageId = event.lineageId ?? task.lineageId;
        if (event.payload.continues) task.continues = event.payload.continues;
        if (event.payload.explicitInputs?.length) task.explicitInputs = event.payload.explicitInputs;
        break;
      }
      case "TASK_CLOSED": {
        if (!event.taskId) break;
        const task = ensureTask(event.taskId, event.timestamp, event.lineageId);
        task.closedAt = event.timestamp;
        task.closed = event.payload;
        break;
      }
      case "VALIDATION_RECORDED": {
        const entry: FoldedValidation = { ...event.payload, eventId: event.eventId, taskId: event.taskId, recordedAt: event.timestamp, provenance: event.provenance };
        if (entry.binding !== "UNBOUND") {
          for (const previous of state.validations) {
            if (previous.supersededBy || previous.binding === "UNBOUND") continue;
            const sameIdentity = previous.identity === entry.identity;
            const sameCommand = Boolean(previous.commandKey && entry.commandKey && previous.commandKey === entry.commandKey);
            if ((sameIdentity || sameCommand) && previous.recordedAt <= entry.recordedAt) previous.supersededBy = entry.eventId;
          }
        }
        state.validations.push(entry);
        break;
      }
      case "TASK_OUTCOME_RECORDED": {
        if (!event.taskId) break;
        const task = ensureTask(event.taskId, event.timestamp, event.lineageId);
        task.outcomes.push({ ...event.payload, eventId: event.eventId, taskId: event.taskId, recordedAt: event.timestamp, provenance: event.provenance });
        // O2: the continuation chain this task carries forward.
        const seen = new Set<string>([task.taskId]);
        let ancestor = task.continues ? taskById.get(task.continues) : undefined;
        while (ancestor && !seen.has(ancestor.taskId)) {
          seen.add(ancestor.taskId);
          if (ancestor.outcomes.length > 0) ancestor.outcomeSupersededBy ??= event.eventId;
          ancestor = ancestor.continues ? taskById.get(ancestor.continues) : undefined;
        }
        for (const reference of event.payload.supersedes ?? []) {
          const named = taskById.get(reference);
          if (named && named.taskId !== task.taskId) named.outcomeSupersededBy ??= event.eventId;
          for (const validation of state.validations) {
            if (!validation.supersededBy && (validation.identity === reference || validation.eventId === reference)) validation.supersededBy = event.eventId;
          }
        }
        break;
      }
      case "USER_DECISION_RECORDED": {
        for (const reference of event.payload.supersedes ?? []) {
          for (const decision of state.decisions) {
            if (!decision.supersededBy && decision.decisionId === reference) decision.supersededBy = event.payload.decisionId;
          }
        }
        state.decisions.push({ ...event.payload, eventId: event.eventId, taskId: event.taskId, lineageId: event.lineageId, recordedAt: event.timestamp });
        break;
      }
      case "COMMAND_OBSERVED": {
        state.commands = state.commands.filter((command) => !(command.taskId === event.taskId && command.commandKey === event.payload.commandKey));
        state.commands.push({ ...event.payload, taskId: event.taskId });
        break;
      }
    }
  }
  return pruneFolded(state);
}

/**
 * Keeps the fold bounded without losing anything current: superseded
 * entries and old tasks are dropped first, never a live blocker, an
 * unsuperseded decision, or the newest validation of an identity.
 */
function pruneFolded(state: FoldedState): FoldedState {
  if (state.validations.length > FOLD_KEEP.validations) {
    const live = state.validations.filter((entry) => !entry.supersededBy);
    const superseded = state.validations.filter((entry) => entry.supersededBy).slice(-Math.max(0, FOLD_KEEP.validations - live.length));
    const keep = new Set([...live.slice(-FOLD_KEEP.validations), ...superseded]);
    state.validations = state.validations.filter((entry) => keep.has(entry));
  }
  if (state.decisions.length > FOLD_KEEP.decisions) {
    const live = state.decisions.filter((entry) => !entry.supersededBy);
    const superseded = state.decisions.filter((entry) => entry.supersededBy).slice(-Math.max(0, FOLD_KEEP.decisions - live.length));
    const keep = new Set([...live, ...superseded]);
    state.decisions = state.decisions.filter((entry) => keep.has(entry));
  }
  if (state.tasks.length > FOLD_KEEP.tasks) {
    const isLiveBlocker = (task: FoldedTask) => !task.outcomeSupersededBy && ["BLOCKED", "STOPPED"].includes(task.outcomes.at(-1)?.status ?? "");
    const recent = new Set(state.tasks.slice(-FOLD_KEEP.tasks));
    state.tasks = state.tasks.filter((task) => recent.has(task) || isLiveBlocker(task));
  }
  if (state.commands.length > FOLD_KEEP.commands) state.commands = state.commands.slice(-FOLD_KEEP.commands);
  return state;
}

// --- projection (pure, given current fingerprints) -------------------------

export interface ProjectedValidation {
  identity: string;
  status: "PASS" | "FAIL" | "UNKNOWN";
  provenance: Provenance;
  verification: Verification;
  lifecycle: Lifecycle;
  taskId?: string;
  recordedAt: string;
  completedAt: string;
  command?: string;
  scope: ValidationScope["mode"];
  /** Why STALE/SUPERSEDED (DERIVED). */
  because?: string;
  legacy?: boolean;
  observedExitCode?: number;
}

export interface ProjectedBlocker {
  taskId: string;
  task: string;
  status: "BLOCKED" | "STOPPED";
  reason?: string;
  blockedOn?: string;
  recordedAt: string;
}

export interface ProjectedDecision {
  decisionId: string;
  decision: string;
  scope: DecisionScope;
  lifecycle: DecisionLifecycle;
  taskId?: string;
  recordedAt: string;
  supersededBy?: string;
}

export interface ProjectStateView {
  schemaVersion: typeof PROJECT_STATE_SCHEMA_VERSION;
  generatedAt: string;
  ledger: { events: number; lastEventId?: string };
  task: { taskId: string; lineageId: string; task: string; startedAt: string; closedAt?: string; continues?: string } | null;
  /** The most recent outcome that is still in force (any task), AGENT_REPORTED. */
  outcome: { taskId: string; task: string; status: TaskOutcomeStatus; reason?: string; blockedOn?: string; recordedAt: string; provenance: Provenance; isCurrentTask: boolean } | null;
  activeBlockers: ProjectedBlocker[];
  activeDecisions: ProjectedDecision[];
  decisions: { active: number; superseded: number; dormant: number; recentlySuperseded: ProjectedDecision[] };
  validations: {
    current: ProjectedValidation[];
    stale: ProjectedValidation[];
    superseded: ProjectedValidation[];
    mismatched: ProjectedValidation[];
    counts: { current: number; verified: number; stale: number; superseded: number; mismatched: number; unbound: number };
  };
  /** Validation-like commands the latest task ran (OBSERVED), newest first. */
  currentEvidence: Array<{ command: string; exitCode?: number; observedAt: string }>;
  nextIntent: { text: string; taskId?: string; provenance: Provenance } | null;
}

export interface CurrentFileState {
  /** Fingerprint per repo-relative path ("-" = missing). Must cover every SCOPED file to judge. */
  fingerprints: Record<string, string>;
  codeStateHash?: string;
  /** The open task and every file it has touched so far (a file outside a check's scope was touched after it). */
  openTask?: { taskId: string; touched: readonly string[] };
}

const LIST_CAPS = { current: 8, stale: 5, superseded: 5, mismatched: 5, blockers: 5, decisions: 8, evidence: 5 } as const;

/** Files whose fingerprints `projectFoldedState` needs (non-superseded SCOPED validations + closed tasks' owned files). */
export function filesNeededForProjection(folded: FoldedState): string[] {
  const files = new Set<string>();
  for (const validation of folded.validations) {
    if (validation.supersededBy || validation.binding === "UNBOUND" || validation.scope.mode !== "SCOPED") continue;
    for (const file of Object.keys(validation.scope.files)) files.add(file);
  }
  return [...files].sort();
}

export function needsWorktreeHash(folded: FoldedState): boolean {
  return folded.validations.some((validation) => !validation.supersededBy && validation.binding !== "UNBOUND" && validation.scope.mode === "WORKTREE");
}

export function projectFoldedState(folded: FoldedState, now: CurrentFileState, generatedAt = new Date().toISOString()): ProjectStateView {
  const tasks = [...folded.tasks].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const latest = tasks.at(-1);
  const taskView = latest ? { taskId: latest.taskId, lineageId: latest.lineageId, task: latest.task, startedAt: latest.startedAt, ...(latest.closedAt ? { closedAt: latest.closedAt } : {}), ...(latest.continues ? { continues: latest.continues } : {}) } : null;

  // Outcomes in force: each task's latest outcome, unless superseded.
  const inForce = tasks
    .filter((task) => task.outcomes.length > 0 && !task.outcomeSupersededBy)
    .map((task) => ({ task, outcome: task.outcomes[task.outcomes.length - 1] }))
    .sort((a, b) => b.outcome.recordedAt.localeCompare(a.outcome.recordedAt));
  const top = inForce[0];
  const outcome: ProjectStateView["outcome"] = top
    ? {
        taskId: top.task.taskId,
        task: top.task.task,
        status: top.outcome.status,
        ...(top.outcome.reason ? { reason: top.outcome.reason } : {}),
        ...(top.outcome.blockedOn ? { blockedOn: top.outcome.blockedOn } : {}),
        recordedAt: top.outcome.recordedAt,
        provenance: top.outcome.provenance,
        isCurrentTask: top.task.taskId === latest?.taskId
      }
    : null;
  const activeBlockers: ProjectedBlocker[] = inForce
    .filter(({ outcome: entry }) => entry.status === "BLOCKED" || entry.status === "STOPPED")
    .slice(0, LIST_CAPS.blockers)
    .map(({ task, outcome: entry }) => ({
      taskId: task.taskId,
      task: task.task,
      status: entry.status as "BLOCKED" | "STOPPED",
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.blockedOn ? { blockedOn: entry.blockedOn } : {}),
      recordedAt: entry.recordedAt
    }));

  // Decisions: CURRENT unless superseded; TASK-scoped ones expire once a
  // different, non-continuing task starts. Relevance follows the current
  // task's lineage (PROJECT scope is always relevant).
  const lineageOf = (taskId: string | undefined) => (taskId ? taskById.get(taskId)?.lineageId : undefined);
  const chain = new Set<string>();
  for (let cursor = latest; cursor && !chain.has(cursor.taskId); cursor = cursor.continues ? taskById.get(cursor.continues) : undefined) chain.add(cursor.taskId);
  const decisionViews = folded.decisions.map((decision): ProjectedDecision => {
    const expired = decision.scope === "TASK" && decision.taskId !== undefined && !chain.has(decision.taskId);
    const lifecycle: DecisionLifecycle = decision.supersededBy ? "SUPERSEDED" : expired ? "EXPIRED" : "CURRENT";
    return { decisionId: decision.decisionId, decision: decision.decision, scope: decision.scope, lifecycle, ...(decision.taskId ? { taskId: decision.taskId } : {}), recordedAt: decision.recordedAt, ...(decision.supersededBy ? { supersededBy: decision.supersededBy } : {}) };
  });
  const relevant = (decision: ProjectedDecision, lineage: string | undefined) =>
    decision.scope === "PROJECT" || (decision.taskId !== undefined && chain.has(decision.taskId)) || (lineage !== undefined && lineage === latest?.lineageId);
  const current = decisionViews.filter((decision) => decision.lifecycle === "CURRENT");
  const activeDecisions = current
    .filter((decision) => relevant(decision, folded.decisions.find((entry) => entry.decisionId === decision.decisionId)?.lineageId ?? lineageOf(decision.taskId)))
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const supersededDecisions = decisionViews.filter((decision) => decision.lifecycle === "SUPERSEDED").sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

  // Validations.
  const views: ProjectedValidation[] = [];
  let unbound = 0;
  for (const validation of folded.validations) {
    if (validation.binding === "UNBOUND") {
      unbound += 1;
      continue;
    }
    const base: ProjectedValidation = {
      identity: validation.identity,
      status: validation.status,
      provenance: validation.provenance,
      verification: validation.verification,
      lifecycle: "CURRENT",
      ...(validation.taskId ? { taskId: validation.taskId } : {}),
      recordedAt: validation.recordedAt,
      completedAt: validation.completedAt,
      ...(validation.command ? { command: validation.command } : {}),
      scope: validation.scope.mode,
      ...(validation.legacy ? { legacy: true } : {}),
      ...(validation.observedExitCode !== undefined ? { observedExitCode: validation.observedExitCode } : {})
    };
    if (validation.supersededBy) {
      views.push({ ...base, lifecycle: "SUPERSEDED", because: "a later result for the same check" });
      continue;
    }
    const stale = staleReason(validation, now, validation.taskId ? taskById.get(validation.taskId) : undefined, latest);
    views.push(stale ? { ...base, lifecycle: "STALE", because: stale } : base);
  }
  const newestFirst = (a: ProjectedValidation, b: ProjectedValidation) => b.recordedAt.localeCompare(a.recordedAt);
  const currentValidations = views.filter((view) => view.lifecycle === "CURRENT" && view.verification !== "MISMATCH").sort(newestFirst);
  const mismatched = views.filter((view) => view.lifecycle !== "SUPERSEDED" && view.verification === "MISMATCH").sort(newestFirst);
  const stale = views.filter((view) => view.lifecycle === "STALE" && view.verification !== "MISMATCH").sort(newestFirst);
  const superseded = views.filter((view) => view.lifecycle === "SUPERSEDED").sort(newestFirst);

  const currentEvidence = latest
    ? folded.commands
        .filter((command) => command.taskId === latest.taskId)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
        .slice(0, LIST_CAPS.evidence)
        .map((command) => ({ command: command.command, ...(command.exitCode !== undefined ? { exitCode: command.exitCode } : {}), observedAt: command.observedAt }))
    : [];

  // Next intent: only from the outcome now in force — never from a
  // superseded STOP/FAIL, never invented. A blocker with a stated
  // dependency yields a DERIVED "resolve it" intent; otherwise null.
  let nextIntent: ProjectStateView["nextIntent"] = null;
  if (top?.outcome.nextIntent) {
    nextIntent = { text: top.outcome.nextIntent, taskId: top.task.taskId, provenance: top.outcome.provenance };
  } else if (top && top.outcome.status === "BLOCKED" && top.outcome.blockedOn) {
    nextIntent = { text: `Resolve the blocker first: ${top.outcome.blockedOn}`, taskId: top.task.taskId, provenance: "DERIVED" };
  }

  return {
    schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
    generatedAt,
    ledger: { events: folded.events, ...(folded.lastEventId ? { lastEventId: folded.lastEventId } : {}) },
    task: taskView,
    outcome,
    activeBlockers,
    activeDecisions: activeDecisions.slice(0, LIST_CAPS.decisions),
    decisions: {
      active: activeDecisions.length,
      superseded: supersededDecisions.length,
      dormant: current.length - activeDecisions.length,
      recentlySuperseded: supersededDecisions.slice(0, 3)
    },
    validations: {
      current: currentValidations.slice(0, LIST_CAPS.current),
      stale: stale.slice(0, LIST_CAPS.stale),
      superseded: superseded.slice(0, LIST_CAPS.superseded),
      mismatched: mismatched.slice(0, LIST_CAPS.mismatched),
      counts: {
        current: currentValidations.length,
        verified: currentValidations.filter((view) => view.provenance === "OBSERVED").length,
        stale: stale.length,
        superseded: superseded.length,
        mismatched: mismatched.length,
        unbound
      }
    },
    currentEvidence,
    nextIntent
  };
}

function staleReason(validation: FoldedValidation, now: CurrentFileState, task: FoldedTask | undefined, latest: FoldedTask | undefined): string | undefined {
  const scope = validation.scope;
  if (scope.mode === "SCOPED") {
    const changed = Object.entries(scope.files).filter(([file, fingerprint]) => (now.fingerprints[file] ?? "?") !== fingerprint).map(([file]) => file);
    if (changed.length > 0) return `${changed.length} supporting file(s) changed: ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", …" : ""}`;
    if (now.openTask && validation.taskId === now.openTask.taskId) {
      const unseen = now.openTask.touched.filter((file) => !(file in scope.files));
      if (unseen.length > 0) return `the task changed ${unseen.length} more file(s) after this check: ${unseen.slice(0, 3).join(", ")}${unseen.length > 3 ? ", …" : ""}`;
    }
    // The task kept editing after this check: files it owned at close that
    // the check never saw.
    if (task?.closed && task.closedAt && task.closedAt > validation.recordedAt) {
      const unseen = Object.keys(task.closed.ownedFingerprints ?? {}).filter((file) => !(file in scope.files));
      if (unseen.length > 0) return `the task changed ${unseen.length} more file(s) after this check: ${unseen.slice(0, 3).join(", ")}${unseen.length > 3 ? ", …" : ""}`;
    }
    return undefined;
  }
  if (scope.mode === "WORKTREE") {
    if (!scope.codeStateHash || !now.codeStateHash) return "working-tree state not comparable";
    return scope.codeStateHash === now.codeStateHash ? undefined : "the working tree changed since this check (no narrower scope was available)";
  }
  return validation.taskId && validation.taskId === latest?.taskId ? undefined : "recorded by an earlier task (no git to scope it)";
}

// --- ledger I/O ------------------------------------------------------------

let appendQueue: Promise<unknown> = Promise.resolve();

/** Appends events in order (one process-wide queue); rotation re-seeds the live file with a checkpoint. */
export async function appendProjectEvents(root: string, events: NewEvent[]): Promise<ProjectEvent[]> {
  const stamped = events.map((event) => ({
    schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
    eventId: event.eventId ?? newEventId(),
    timestamp: event.timestamp ?? new Date().toISOString(),
    ...event
  }) as ProjectEvent);
  const run = appendQueue.then(async () => {
    const path = fromRoot(root, devguardPaths.projectEvents);
    await appendTextFile(path, stamped.map((event) => `${JSON.stringify(event)}\n`).join(""));
    if (await rotateJsonlIfNeeded(path, PROJECT_EVENTS_RETENTION)) {
      // The rotated generation is dropped at the NEXT rotation; carry every
      // still-live fact forward so the projection never loses current state.
      const folded = compactForCheckpoint(foldEvents(fromLastCheckpoint(await readLedgerFile(`${path}${ROTATED_SUFFIX}`))));
      const checkpoint: ProjectEvent = { schemaVersion: PROJECT_STATE_SCHEMA_VERSION, eventId: newEventId(), timestamp: new Date().toISOString(), type: "STATE_CHECKPOINT", provenance: "DERIVED", payload: { folded } };
      await appendTextFile(path, `${JSON.stringify(checkpoint)}\n`);
    }
  });
  appendQueue = run.catch(() => undefined);
  await run;
  return stamped;
}

async function readLedgerFile(path: string): Promise<ProjectEvent[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  const events: ProjectEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as ProjectEvent;
      if (event && event.schemaVersion === PROJECT_STATE_SCHEMA_VERSION && typeof event.type === "string") events.push(event);
    } catch {
      // torn line — skip
    }
  }
  return events;
}

/**
 * Ledger events to fold: the live file's checkpoint first (it summarizes the
 * rotated generation), then every other live event — including one another
 * process appended between the rotation and the checkpoint write, which a
 * plain "from the checkpoint on" read would drop. Without a live checkpoint:
 * the rotated generation (from its own checkpoint) followed by the live file.
 */
export async function readProjectEvents(root: string): Promise<ProjectEvent[]> {
  const path = fromRoot(root, devguardPaths.projectEvents);
  const live = await readLedgerFile(path);
  if (live.some((event) => event.type === "STATE_CHECKPOINT")) return fromLastCheckpoint(live);
  return [...fromLastCheckpoint(await readLedgerFile(`${path}${ROTATED_SUFFIX}`)), ...live];
}

function fromLastCheckpoint(events: ProjectEvent[]): ProjectEvent[] {
  let index = -1;
  for (let cursor = events.length - 1; cursor >= 0; cursor -= 1) {
    if (events[cursor].type === "STATE_CHECKPOINT") {
      index = cursor;
      break;
    }
  }
  if (index < 0) return events;
  return [events[index], ...events.filter((event, cursor) => cursor !== index && event.type !== "STATE_CHECKPOINT")];
}

/** What a checkpoint must carry: live facts only (no superseded checks, old tasks only when they still matter). */
const CHECKPOINT_KEEP = { validations: 150, tasks: 30, supersededDecisions: 10, commands: 20 } as const;
export function compactForCheckpoint(folded: FoldedState): FoldedState {
  const validations = folded.validations.filter((entry) => !entry.supersededBy).slice(-CHECKPOINT_KEEP.validations);
  const decisions = [...folded.decisions.filter((entry) => !entry.supersededBy), ...folded.decisions.filter((entry) => entry.supersededBy).slice(-CHECKPOINT_KEEP.supersededDecisions)];
  const referenced = new Set([...validations.map((entry) => entry.taskId), ...decisions.map((entry) => entry.taskId)]);
  const recent = new Set(folded.tasks.slice(-CHECKPOINT_KEEP.tasks).map((task) => task.taskId));
  const liveBlocker = (task: FoldedTask) => !task.outcomeSupersededBy && ["BLOCKED", "STOPPED"].includes(task.outcomes.at(-1)?.status ?? "");
  const tasks = folded.tasks
    .filter((task) => recent.has(task.taskId) || liveBlocker(task) || referenced.has(task.taskId))
    .map((task) => ({ ...task, outcomes: task.outcomes.slice(-1), ...(recent.has(task.taskId) || !task.closed ? {} : { closed: { ...task.closed, taskOwnedChanges: [] } }) }));
  return { ...folded, tasks, validations, decisions, commands: folded.commands.slice(-CHECKPOINT_KEEP.commands) };
}

export async function ledgerExists(root: string): Promise<boolean> {
  const path = fromRoot(root, devguardPaths.projectEvents);
  const [live, rotated] = await Promise.all([stat(path).catch(() => undefined), stat(`${path}${ROTATED_SUFFIX}`).catch(() => undefined)]);
  return Boolean((live && live.size > 0) || (rotated && rotated.size > 0));
}

// --- fingerprints & scope ----------------------------------------------------

const MISSING = "-";
const SKIP_DIR = /^(?:node_modules|\.git|dist|build|\.next|\.turbo|__pycache__|\.devguard|\.venv|venv|coverage)$/;

/** Content fingerprints (sha256 prefix) for repo-relative files; "-" when missing or not a file. */
export async function fingerprintFiles(root: string, files: readonly string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  await Promise.all(files.map(async (file) => {
    try {
      const content = await readFile(join(root, file));
      result[file] = createHash("sha256").update(content).digest("hex").slice(0, 16);
    } catch {
      result[file] = MISSING;
    }
  }));
  return result;
}

async function filesUnder(root: string, dir: string, limit: number, match?: RegExp): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    if (out.length >= limit) return;
    const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= limit) return;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIR.test(entry.name)) await walk(child);
      } else if (entry.isFile() && (!match || match.test(child))) {
        out.push(child);
      }
    }
  };
  await walk(dir);
  return out;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?");
  return new RegExp(`^${escaped}$`);
}

/**
 * Repository files a validation command names directly: file and directory
 * arguments (`-s infra/x`, `tests/a.test.ts`) and simple globs
 * (`packages/cli/test/*.test.js`). Resolved against the repository root
 * (and `cd <dir> &&` prefixes). Bounded; never a whole-repository scan.
 */
export async function commandReferencedFiles(root: string, command: string | undefined, limit = 200): Promise<string[]> {
  if (!command?.trim()) return [];
  const bases = [""];
  const cd = /(?:^|&&|;)\s*cd\s+([^\s;&|]+)/g;
  for (let match = cd.exec(command); match; match = cd.exec(command)) {
    const dir = match[1].replace(/["']/g, "").replace(/^\.\//, "");
    if (dir && !dir.startsWith("/") && !dir.startsWith("~")) bases.push(dir.replace(/\/+$/, ""));
    else if (dir.startsWith(root)) bases.push(dir.slice(root.length).replace(/^\/+|\/+$/g, ""));
  }
  const tokens = command.split(/[\s=]+/).map((token) => token.replace(/^["'(]+|["'),;]+$/g, "")).filter((token) => token && !token.startsWith("-") && (token.includes("/") || /\.[A-Za-z0-9]{1,6}$/.test(token)));
  const files = new Set<string>();
  for (const token of tokens) {
    if (files.size >= limit) break;
    const relative = token.startsWith(root + "/") ? token.slice(root.length + 1) : token.replace(/^\.\//, "");
    if (relative.startsWith("/") || relative.startsWith("~") || relative.includes("://") || relative.startsWith("..")) continue;
    for (const base of bases) {
      const candidate = posix.normalize(base ? `${base}/${relative}` : relative);
      if (candidate.startsWith("..")) continue;
      if (candidate.includes("*")) {
        const fixed = candidate.slice(0, candidate.indexOf("*"));
        const dir = fixed.includes("/") ? fixed.slice(0, fixed.lastIndexOf("/")) : "";
        for (const file of await filesUnder(root, dir, limit - files.size, globToRegExp(candidate))) files.add(file);
        continue;
      }
      const info = await stat(join(root, candidate)).catch(() => undefined);
      if (info?.isFile()) {
        files.add(candidate);
        break;
      }
      if (info?.isDirectory() && candidate !== "." && candidate !== "") {
        for (const file of await filesUnder(root, candidate, limit - files.size)) files.add(file);
        break;
      }
    }
  }
  return [...files].filter((file) => !file.startsWith(".devguard/")).slice(0, limit);
}

/**
 * The files that materially support a validation: what the task itself
 * changed, plus what the command names. Falls back to the whole-working-tree
 * fingerprint when no safe narrow scope exists (nothing identifiable, or too
 * many files to fingerprint) — conservative, never a false CURRENT.
 */
export async function computeValidationScope(root: string, input: { command?: string; taskOwnedFiles: readonly string[]; codeStateHash?: string; gitAvailable: boolean }): Promise<ValidationScope> {
  if (!input.gitAvailable) return { mode: "SESSION" };
  const referenced = await commandReferencedFiles(root, input.command);
  const files = [...new Set([...input.taskOwnedFiles, ...referenced])].filter((file) => !file.startsWith(".devguard/")).sort();
  if (files.length === 0 || files.length > LIMITS.scopeFiles) return { mode: "WORKTREE", ...(input.codeStateHash ? { codeStateHash: input.codeStateHash } : {}) };
  return { mode: "SCOPED", files: await fingerprintFiles(root, files) };
}

export function listHash(values: readonly string[]): string {
  return createHash("sha256").update([...values].sort().join("\n")).digest("hex").slice(0, 12);
}

// --- projection entry points ---------------------------------------------------

export interface ComputeProjectStateOptions {
  /** Already-computed working-tree fingerprint (saves a second pass). */
  codeStateHash?: string;
  /** Compute the working-tree fingerprint when a WORKTREE-scoped check needs it. */
  resolveCodeStateHash?: () => Promise<string | undefined>;
  /** Write `.devguard/state/current.json` (default true). */
  write?: boolean;
  /** The open task; `touched` is called only when that task has scoped checks to judge. */
  openTask?: { taskId: string; touched: () => Promise<string[]> };
}

export async function computeProjectState(root: string, options: ComputeProjectStateOptions = {}): Promise<ProjectStateView> {
  const folded = foldEvents(await readProjectEvents(root));
  const fingerprints = await fingerprintFiles(root, filesNeededForProjection(folded));
  const codeStateHash = options.codeStateHash ?? (needsWorktreeHash(folded) && options.resolveCodeStateHash ? await options.resolveCodeStateHash().catch(() => undefined) : undefined);
  const openTask = options.openTask;
  const judgeOpenTask = openTask && folded.validations.some((entry) => entry.taskId === openTask.taskId && !entry.supersededBy && entry.scope.mode === "SCOPED");
  const touched = judgeOpenTask ? await openTask.touched().catch(() => undefined) : undefined;
  const view = projectFoldedState(folded, { fingerprints, codeStateHash, ...(openTask && touched ? { openTask: { taskId: openTask.taskId, touched } } : {}) });
  if (options.write !== false) await writeProjectStateCache(root, view).catch(() => undefined);
  return view;
}

/** Full rebuild from the ledger — `current.json` is never the only source of truth. */
export async function rebuildProjectState(root: string, options: Omit<ComputeProjectStateOptions, "write"> = {}): Promise<ProjectStateView> {
  return computeProjectState(root, { ...options, write: true });
}

export async function writeProjectStateCache(root: string, view: ProjectStateView): Promise<void> {
  await writeTextFile(fromRoot(root, devguardPaths.projectStateCurrent), `${JSON.stringify(view, null, 1)}\n`);
}

export async function readProjectStateCache(root: string): Promise<ProjectStateView | undefined> {
  try {
    const parsed = JSON.parse(await readFile(fromRoot(root, devguardPaths.projectStateCurrent), "utf8")) as ProjectStateView;
    return parsed?.schemaVersion === PROJECT_STATE_SCHEMA_VERSION ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Lifecycle per runtime qaResults entry (`kind::name@completedAt`), so legacy tables read the same freshness. */
export function validationLifecycleIndex(view: ProjectStateView | undefined): Map<string, Lifecycle> | undefined {
  if (!view) return undefined;
  const index = new Map<string, Lifecycle>();
  for (const entry of [...view.validations.superseded, ...view.validations.stale, ...view.validations.mismatched, ...view.validations.current]) {
    index.set(`${entry.identity}@${entry.completedAt}`, entry.lifecycle);
  }
  return index;
}

// --- recording helpers (used by runtime-state) ----------------------------------

/** A bare "continue the current work" request (no other content) — continues the previous task. */
export function isContinueRequest(text: string): boolean {
  const value = text.trim().toLowerCase().replace(/[.!。]+$/, "");
  return value.length <= 60 && /^(?:please\s+)?(?:continue|resume|keep going|carry on|proceed)(?:\s+(?:the|with the|with)?\s*(?:current|previous|last)?\s*(?:work|task|step)?)?$|^(?:현재\s*)?(?:작업\s*)?(?:계속|이어서|재개)/.test(value);
}

export function validationIdentity(kind: string, name: string): string {
  return `${kind}::${name}`;
}

export function normalizeForLedger(command: string | undefined): { command?: string; commandKey?: string } {
  if (!command?.trim()) return {};
  const normalized = normalizeCommand(command);
  return normalized ? { command: bound(normalized, LIMITS.command), commandKey: commandKey(command) } : {};
}

/** True when `git status` works in root. */
export async function gitAvailable(root: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Validation-like commands (test/build/lint/typecheck runners) — what COMMAND_OBSERVED keeps at done. */
export const VALIDATION_COMMAND = /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+|--filter\s+\S+\s+|-r\s+|-w\s+|exec\s+)*(?:test|lint|typecheck|type-check|build|check|verify|vitest|jest)\b|\bnode\s+--test\b|\b(?:tsc|vitest|jest|pytest|eslint|playwright|cargo\s+test|go\s+test)\b|\bpython3?\s+(?:-\w+\s+)*-m\s+(?:unittest|pytest)\b/;
