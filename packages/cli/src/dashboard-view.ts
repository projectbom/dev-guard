// The dashboard's first screen as data: five answers a developer needs in
// five seconds (is it OK, what task, biggest problem, what to do, keep this
// thread?) plus at most five task numbers and one context-flow chart.
// Everything else belongs in collapsed details. Pure — derived from the
// watch/setup state and the context-efficiency report the dashboard already
// serves; no repository scan, no extra I/O.
import type { ContextEfficiencyReport, ContextGroup, ContextIssue, RolloverState } from "./context-efficiency.js";
import type { EvidenceKind } from "./agent-activity.js";
import { LEGACY_FIX_COMMAND } from "./instruction-authority.js";

/**
 * System/setup correctness only — never context or work quality, and never
 * the project's own build/test/validation results. WARNING = DevGuard works
 * but something will degrade it (e.g. an obsolete user-level instruction).
 */
export type OverviewHealth = "HEALTHY" | "SETTING_UP" | "WARNING" | "ATTENTION";
export type OverviewHealthReason =
  | "ok"
  | "setup-running"
  | "not-initialized"
  | "watch-stopped"
  | "runtime-write-disk-full"
  | "runtime-write-permission"
  | "runtime-write-failed"
  | "legacy-instructions";
/** User-facing thread levels (the raw rollover enum stays in details). */
export type OverviewThread = "LOW" | "SOON" | "NEW_THREAD";
export type OverviewActionId = "FIX_HEALTH" | "FIX_INSTRUCTIONS" | "START_WATCH" | "WAIT_SETUP" | "NEW_THREAD" | "FIX_ISSUE" | "REVIEW_QUALITY" | "FINISH_THEN_NEW_THREAD" | "CONTINUE" | "START_TASK";
export type OverviewMetricKey = "context" | "readPlan" | "suggestions" | "validation" | "filesChanged";

export interface OverviewMetric {
  key: OverviewMetricKey;
  /** Structured value; the client formats it. `null` = not observable. */
  value: { percent: number } | { required: number; optional: number } | { used: number; of: number } | { pass: number; fail: number; unknown: number } | { count: number } | null;
  /** PLANNED: DevGuard's own read plan (a fact about the plan, not a measurement). */
  evidence: EvidenceKind | "PLANNED";
}

export interface DashboardOverview {
  /** `detail`: affected path(s) for the reason, e.g. "~/.codex/AGENTS.md". */
  health: { level: OverviewHealth; reason: OverviewHealthReason; detail?: string };
  thread: { level: OverviewThread; raw: RolloverState; reason: string; evidence: EvidenceKind };
  /** One line (the client truncates visually; the full goal is a tooltip). */
  task?: string;
  /** Exactly zero or one — the biggest actionable context/workflow problem. */
  issue?: OverviewIssue;
  /** Exactly one next user action. */
  action: { id: OverviewActionId; text: string; command?: string };
  /** At most five, in a fixed order. */
  metrics: OverviewMetric[];
  /** The single default chart: where this task's (estimated) context went. */
  flow?: { groups: Record<ContextGroup, number>; approxTokens: number; evidence: "ESTIMATED" };
  /** Issues beyond the primary one — details only. */
  secondaryIssues: ContextIssue[];
}

/** A context issue, or the setup-level legacy instruction conflict shown in its place. */
export type OverviewIssue = Omit<Pick<ContextIssue, "id" | "cause" | "severity" | "issue" | "why" | "action" | "evidence">, "id"> & { id: ContextIssue["id"] | "LEGACY_INSTRUCTIONS" };

export interface OverviewStateInput {
  initialized: boolean;
  watchRunning: boolean;
  setupActive: boolean;
  qualityVerdict?: string;
  sessionFileCount: number;
  /** Active runtime-state write failure (Write Health), if any. */
  writeFailure?: "disk-full" | "permission" | "write-failed";
  /** Display paths of user-level instruction files with an obsolete DevGuard block. */
  legacyInstructionPaths?: string[];
}

export const MAX_OVERVIEW_METRICS = 5;

const RUNTIME_WRITE_ACTION: Partial<Record<OverviewHealthReason, string>> = {
  "runtime-write-disk-full": "DevGuard cannot save state because the disk is full. Free disk space; DevGuard recovers on its own.",
  "runtime-write-permission": "DevGuard cannot save state: no write permission for .devguard/. Fix the permission; DevGuard recovers on its own.",
  "runtime-write-failed": "DevGuard cannot write runtime state. Check .devguard/logs/watch.log."
};

const THREAD_LEVEL: Record<RolloverState, OverviewThread> = {
  CONTINUE: "LOW",
  NEW_THREAD_SOON: "SOON",
  NEW_THREAD_RECOMMENDED: "NEW_THREAD"
};

export function buildDashboardOverview(state: OverviewStateInput, report: ContextEfficiencyReport | undefined, readPlan?: { required: number; optional: number }): DashboardOverview {
  const legacyPaths = state.legacyInstructionPaths ?? [];
  const health: DashboardOverview["health"] = state.setupActive
    ? { level: "SETTING_UP", reason: "setup-running" }
    : !state.initialized
      ? { level: "ATTENTION", reason: "not-initialized" }
      : !state.watchRunning
        ? { level: "ATTENTION", reason: "watch-stopped" }
        : state.writeFailure
          ? { level: "ATTENTION", reason: `runtime-write-${state.writeFailure}` as OverviewHealthReason }
          : legacyPaths.length > 0
            ? { level: "WARNING", reason: "legacy-instructions", detail: legacyPaths.join(", ") }
            : { level: "HEALTHY", reason: "ok" };
  const rollover = report?.now.thread ?? { state: "CONTINUE" as const, reason: "No DevGuard task recorded yet.", evidence: "INFERRED" as const };
  const thread: DashboardOverview["thread"] = { level: THREAD_LEVEL[rollover.state], raw: rollover.state, reason: rollover.reason, evidence: rollover.evidence };
  const primary = report?.now.primaryIssue;
  // While an obsolete user-level DevGuard block is active it is the primary
  // issue: it is the one cause the user can remove in a single command, and
  // it can steer agents toward stale markdown and off the read plan. It is
  // not claimed to explain every issue — the context issue it displaces
  // stays first in the secondary list and returns once the file is fixed.
  const legacyActive = health.reason === "legacy-instructions";
  const issue: OverviewIssue | undefined = legacyActive
    ? {
        id: "LEGACY_INSTRUCTIONS",
        severity: "strong",
        issue: "Obsolete DevGuard instructions conflict with the current MCP flow.",
        why: `${legacyPaths.join(", ")} still tells agents to read DevGuard markdown first, which can pull agents toward stale files instead of the read plan.`,
        action: `Run ${LEGACY_FIX_COMMAND} (previews and asks before changing anything).`,
        evidence: "OBSERVED"
      }
    : primary
      ? { id: primary.id, ...(primary.cause ? { cause: primary.cause } : {}), severity: primary.severity, issue: primary.issue, why: primary.why, action: primary.action, evidence: primary.evidence }
      : undefined;
  const current = report?.current;
  const hasTask = Boolean(report?.now.task);

  // One action, by precedence: a broken setup blocks everything; a thread
  // that must roll over beats tuning this one; then a strong issue, a pending
  // quality review (something only the user can do), a mild issue, an
  // approaching rollover, and finally "continue".
  const reviewPending = state.qualityVerdict === "BLOCKED" || state.qualityVerdict === "NEEDS_REVIEW";
  const action: DashboardOverview["action"] = health.level === "SETTING_UP"
    ? { id: "WAIT_SETUP", text: "DevGuard is preparing this project; it finishes on its own." }
    : health.level === "ATTENTION" && health.reason.startsWith("runtime-write-")
      ? { id: "FIX_HEALTH", text: RUNTIME_WRITE_ACTION[health.reason] ?? "DevGuard cannot write runtime state." }
    : health.level === "ATTENTION"
      ? { id: "START_WATCH", text: "Start DevGuard in this project.", command: "dev-guard watch" }
      : legacyActive
        ? { id: "FIX_INSTRUCTIONS", text: "Remove the obsolete DevGuard instructions:", command: LEGACY_FIX_COMMAND }
      : thread.level === "NEW_THREAD"
        ? { id: "NEW_THREAD", text: "Start the next task in a fresh agent thread." }
        : issue && (issue.severity === "strong" || !reviewPending)
          ? { id: "FIX_ISSUE", text: issue.action }
          : reviewPending
            ? { id: "REVIEW_QUALITY", text: "Review the checks listed in the quality report." }
            : thread.level === "SOON"
              ? { id: "FINISH_THEN_NEW_THREAD", text: "Finish this task here; start the next large task in a fresh thread." }
              : hasTask
                ? { id: "CONTINUE", text: "Keep going in this thread." }
                : { id: "START_TASK", text: "Ask your agent for a task; it appears here once prepared." };

  const metrics: OverviewMetric[] = [];
  if (hasTask) {
    metrics.push({ key: "context", value: current?.peakContextUse !== undefined ? { percent: Math.round(current.peakContextUse * 100) } : null, evidence: "OBSERVED" });
    metrics.push({ key: "readPlan", value: readPlan ? { required: readPlan.required, optional: readPlan.optional } : null, evidence: "PLANNED" });
    metrics.push({ key: "suggestions", value: current?.candidateUtilization ? { used: current.candidateUtilization.used, of: current.candidateUtilization.of } : null, evidence: "INFERRED" });
    metrics.push({ key: "validation", value: current ? { ...current.validation } : null, evidence: "OBSERVED" });
    metrics.push({ key: "filesChanged", value: { count: state.sessionFileCount }, evidence: "OBSERVED" });
  }
  const groups = report?.currentTask?.whereContextWent;
  return {
    health,
    thread,
    ...(report?.now.task ? { task: report.now.task.replace(/\s+/g, " ").trim() } : {}),
    ...(issue ? { issue } : {}),
    action,
    metrics: metrics.slice(0, MAX_OVERVIEW_METRICS),
    ...(groups && report?.currentTask ? { flow: { groups, approxTokens: report.currentTask.estimatedContextTokens, evidence: "ESTIMATED" as const } } : {}),
    secondaryIssues: [...(legacyActive && primary ? [primary] : []), ...(report?.now.otherIssues ?? [])]
  };
}
