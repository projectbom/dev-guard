// The dashboard's first screen as data: five answers a developer needs in
// five seconds (is it OK, what task, biggest problem, what to do, keep this
// thread?) plus at most five task numbers and one context-flow chart.
// Everything else belongs in collapsed details. Pure — derived from the
// watch/setup state and the context-efficiency report the dashboard already
// serves; no repository scan, no extra I/O.
import type { ContextEfficiencyReport, ContextGroup, ContextIssue, RolloverState } from "./context-efficiency.js";
import type { EvidenceKind } from "./agent-activity.js";

/** System/setup correctness only — never context or work quality. */
export type OverviewHealth = "HEALTHY" | "SETTING_UP" | "ATTENTION";
export type OverviewHealthReason = "ok" | "setup-running" | "not-initialized" | "watch-stopped";
/** User-facing thread levels (the raw rollover enum stays in details). */
export type OverviewThread = "LOW" | "SOON" | "NEW_THREAD";
export type OverviewActionId = "START_WATCH" | "WAIT_SETUP" | "NEW_THREAD" | "FIX_ISSUE" | "REVIEW_QUALITY" | "FINISH_THEN_NEW_THREAD" | "CONTINUE" | "START_TASK";
export type OverviewMetricKey = "context" | "readPlan" | "suggestions" | "validation" | "filesChanged";

export interface OverviewMetric {
  key: OverviewMetricKey;
  /** Structured value; the client formats it. `null` = not observable. */
  value: { percent: number } | { required: number; optional: number } | { used: number; of: number } | { pass: number; fail: number; unknown: number } | { count: number } | null;
  /** PLANNED: DevGuard's own read plan (a fact about the plan, not a measurement). */
  evidence: EvidenceKind | "PLANNED";
}

export interface DashboardOverview {
  health: { level: OverviewHealth; reason: OverviewHealthReason };
  thread: { level: OverviewThread; raw: RolloverState; reason: string; evidence: EvidenceKind };
  /** One line (the client truncates visually; the full goal is a tooltip). */
  task?: string;
  /** Exactly zero or one — the biggest actionable context/workflow problem. */
  issue?: Pick<ContextIssue, "id" | "cause" | "severity" | "issue" | "why" | "action" | "evidence">;
  /** Exactly one next user action. */
  action: { id: OverviewActionId; text: string; command?: string };
  /** At most five, in a fixed order. */
  metrics: OverviewMetric[];
  /** The single default chart: where this task's (estimated) context went. */
  flow?: { groups: Record<ContextGroup, number>; approxTokens: number; evidence: "ESTIMATED" };
  /** Issues beyond the primary one — details only. */
  secondaryIssues: ContextIssue[];
}

export interface OverviewStateInput {
  initialized: boolean;
  watchRunning: boolean;
  setupActive: boolean;
  qualityVerdict?: string;
  sessionFileCount: number;
}

export const MAX_OVERVIEW_METRICS = 5;

const THREAD_LEVEL: Record<RolloverState, OverviewThread> = {
  CONTINUE: "LOW",
  NEW_THREAD_SOON: "SOON",
  NEW_THREAD_RECOMMENDED: "NEW_THREAD"
};

export function buildDashboardOverview(state: OverviewStateInput, report: ContextEfficiencyReport | undefined, readPlan?: { required: number; optional: number }): DashboardOverview {
  const health: DashboardOverview["health"] = state.setupActive
    ? { level: "SETTING_UP", reason: "setup-running" }
    : !state.initialized
      ? { level: "ATTENTION", reason: "not-initialized" }
      : !state.watchRunning
        ? { level: "ATTENTION", reason: "watch-stopped" }
        : { level: "HEALTHY", reason: "ok" };
  const rollover = report?.now.thread ?? { state: "CONTINUE" as const, reason: "No DevGuard task recorded yet.", evidence: "INFERRED" as const };
  const thread: DashboardOverview["thread"] = { level: THREAD_LEVEL[rollover.state], raw: rollover.state, reason: rollover.reason, evidence: rollover.evidence };
  const primary = report?.now.primaryIssue;
  const issue = primary ? { id: primary.id, ...(primary.cause ? { cause: primary.cause } : {}), severity: primary.severity, issue: primary.issue, why: primary.why, action: primary.action, evidence: primary.evidence } : undefined;
  const current = report?.current;
  const hasTask = Boolean(report?.now.task);

  // One action, by precedence: a broken setup blocks everything; a thread
  // that must roll over beats tuning this one; then a strong issue, a pending
  // quality review (something only the user can do), a mild issue, an
  // approaching rollover, and finally "continue".
  const reviewPending = state.qualityVerdict === "BLOCKED" || state.qualityVerdict === "NEEDS_REVIEW";
  const action: DashboardOverview["action"] = health.level === "SETTING_UP"
    ? { id: "WAIT_SETUP", text: "DevGuard is preparing this project; it finishes on its own." }
    : health.level === "ATTENTION"
      ? { id: "START_WATCH", text: "Start DevGuard in this project.", command: "dev-guard watch" }
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
    secondaryIssues: report?.now.otherIssues ?? []
  };
}
