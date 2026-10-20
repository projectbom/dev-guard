/**
 * Every surface's rendering of the ONE current-state projection
 * (project-state.ts): the agent's prepare payload, the Quality Report and
 * Handoff markdown section, and the dashboard summary. None of these
 * re-derive freshness, supersession or provenance — they only format the
 * view they are handed, so the surfaces cannot disagree.
 */
import type { DevGuardLocale } from "./locale.js";
import type { ProjectStateView, ProjectedValidation, TaskOutcomeStatus } from "./project-state.js";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function provenanceLabel(validation: ProjectedValidation): string {
  if (validation.verification === "MISMATCH") return "MISMATCH: transcript disagrees";
  if (validation.provenance === "OBSERVED") return "observed";
  return validation.legacy ? "agent-reported, pre-0.12" : "agent-reported";
}

function validationLine(validation: ProjectedValidation): string {
  const name = validation.identity.replace("::", " ");
  return clip(`${name}: ${validation.status} (${provenanceLabel(validation)}${validation.because && validation.lifecycle !== "CURRENT" ? `; ${validation.because}` : ""})`, 160);
}

export interface CompactVerifiedState {
  outcome: string | null;
  blockers?: string[];
  decisions?: string[];
  validations: {
    verified: string[];
    reported?: string[];
    mismatched?: string[];
    stale?: number;
    superseded?: number;
  };
  nextIntent: string | null;
  note: string;
}

/** The prepare_task_context `state` block: small, bounded, newest first. Undefined when the ledger holds nothing yet. */
export function compactVerifiedState(view: ProjectStateView | undefined): CompactVerifiedState | undefined {
  if (!view) return undefined;
  const hasState = view.outcome || view.activeBlockers.length || view.activeDecisions.length || view.validations.counts.current || view.validations.counts.stale || view.validations.counts.mismatched;
  if (!hasState) return undefined;
  const outcome = view.outcome
    ? clip(`${view.outcome.status}${view.outcome.reason ? ` — ${view.outcome.reason}` : ""}${view.outcome.isCurrentTask ? "" : ` (previous task: ${clip(view.outcome.task || view.outcome.taskId, 80)})`}`, 240)
    : null;
  const verified = view.validations.current.filter((entry) => entry.provenance === "OBSERVED").slice(0, 5).map(validationLine);
  const reported = view.validations.current.filter((entry) => entry.provenance !== "OBSERVED").slice(0, 3).map(validationLine);
  const mismatched = view.validations.mismatched.slice(0, 3).map(validationLine);
  return {
    outcome,
    ...(view.activeBlockers.length
      ? {
          // The outcome's own blocker already carries its reason above.
          blockers: view.activeBlockers.slice(0, 3).map((blocker) => {
            const reason = blocker.reason && blocker.taskId !== view.outcome?.taskId ? ` — ${blocker.reason}` : "";
            return clip(`${blocker.status}${blocker.blockedOn ? ` on ${blocker.blockedOn}` : ""}${reason} (task ${blocker.taskId}: ${clip(blocker.task || "", 60)})`, 240);
          })
        }
      : {}),
    ...(view.activeDecisions.length ? { decisions: view.activeDecisions.slice(0, 5).map((decision) => clip(`${decision.decision} [user, ${decision.scope.toLowerCase()}]`, 200)) } : {}),
    validations: {
      verified,
      ...(reported.length ? { reported } : {}),
      ...(mismatched.length ? { mismatched } : {}),
      ...(view.validations.counts.stale ? { stale: view.validations.counts.stale } : {}),
      ...(view.validations.counts.superseded ? { superseded: view.validations.counts.superseded } : {})
    },
    nextIntent: view.nextIntent ? clip(view.nextIntent.text, 300) : null,
    note: "Verified project state: `verified` = DevGuard observed the command and exit code; `reported` = the agent's word only; STOPPED/BLOCKED are deliberate stops, not defects; decisions are the user's and carry until superseded."
  };
}

const COPY = {
  "en-US": {
    title: "Verified Project State",
    outcome: "Outcome",
    none: "none recorded",
    previous: "previous task",
    blockers: "Active blockers",
    decisions: "Active user decisions",
    verified: "Verified (observed)",
    reported: "Current, agent-reported only",
    mismatched: "Mismatched (agent report disagrees with the transcript)",
    stale: "Stale",
    superseded: "Superseded",
    next: "Next intent",
    stopNote: "STOPPED/BLOCKED is a deliberate stop or an external dependency — not a defect.",
    source: "Source: `.devguard/state/current.json` (projection of `.devguard/events/task-events.jsonl`)."
  },
  "ko-KR": {
    title: "검증된 프로젝트 상태",
    outcome: "결과",
    none: "기록 없음",
    previous: "이전 작업",
    blockers: "활성 차단 요인",
    decisions: "유효한 사용자 결정",
    verified: "검증됨 (관측)",
    reported: "유효, 에이전트 보고만",
    mismatched: "불일치 (에이전트 보고와 transcript가 다름)",
    stale: "오래됨(stale)",
    superseded: "대체됨(superseded)",
    next: "다음 의도",
    stopNote: "STOPPED/BLOCKED는 의도된 중단 또는 외부 의존성 대기이며 결함이 아닙니다.",
    source: "출처: `.devguard/state/current.json` (`.devguard/events/task-events.jsonl`의 projection)."
  }
} as const;

/** Markdown section (heading + bullets) for Quality Report and Handoff. Empty when the ledger holds nothing. */
export function verifiedStateMarkdown(view: ProjectStateView | undefined, locale: DevGuardLocale, heading = "##"): string[] {
  if (!compactVerifiedState(view) || !view) return [];
  const copy = COPY[locale === "ko-KR" ? "ko-KR" : "en-US"];
  const lines: string[] = [`${heading} ${copy.title}`, ""];
  const outcome = view.outcome;
  lines.push(`- ${copy.outcome}: ${outcome ? `**${outcome.status}**${outcome.reason ? ` — ${outcome.reason}` : ""} (${outcome.provenance}${outcome.isCurrentTask ? "" : `; ${copy.previous}: ${clip(outcome.task || outcome.taskId, 80)}`})` : copy.none}`);
  if (view.activeBlockers.length) {
    lines.push(`- ${copy.blockers}:`);
    for (const blocker of view.activeBlockers) lines.push(`  - ${blocker.status}${blocker.blockedOn ? ` on ${blocker.blockedOn}` : ""}${blocker.reason ? ` — ${blocker.reason}` : ""} (${clip(blocker.task || blocker.taskId, 80)})`);
  }
  if (view.activeDecisions.length) {
    lines.push(`- ${copy.decisions}:`);
    for (const decision of view.activeDecisions) lines.push(`  - ${decision.decision} (USER_DECISION, ${decision.scope})`);
  }
  const verified = view.validations.current.filter((entry) => entry.provenance === "OBSERVED");
  const reported = view.validations.current.filter((entry) => entry.provenance !== "OBSERVED");
  if (verified.length) lines.push(`- ${copy.verified}: ${verified.map(validationLine).join("; ")}`);
  if (reported.length) lines.push(`- ${copy.reported}: ${reported.map(validationLine).join("; ")}`);
  if (view.validations.mismatched.length) lines.push(`- ${copy.mismatched}: ${view.validations.mismatched.map(validationLine).join("; ")}`);
  if (view.validations.counts.stale) lines.push(`- ${copy.stale}: ${view.validations.counts.stale} — ${view.validations.stale.slice(0, 3).map(validationLine).join("; ")}`);
  if (view.validations.counts.superseded) lines.push(`- ${copy.superseded}: ${view.validations.counts.superseded}`);
  lines.push(`- ${copy.next}: ${view.nextIntent ? `${view.nextIntent.text} (${view.nextIntent.provenance})` : copy.none}`);
  if (outcome && (outcome.status === "STOPPED" || outcome.status === "BLOCKED")) lines.push(`- ${copy.stopNote}`);
  lines.push(`- ${copy.source}`, "");
  return lines;
}

/** Inserts the section right after the document's first heading line. */
export function withVerifiedStateSection(markdown: string, section: string[]): string {
  if (section.length === 0) return markdown;
  const lines = markdown.split("\n");
  const titleIndex = lines.findIndex((line) => /^# /.test(line));
  const insertAt = titleIndex >= 0 ? titleIndex + 1 : 0;
  return [...lines.slice(0, insertAt), "", ...section, ...lines.slice(insertAt).filter((line, index) => !(index === 0 && line === ""))].join("\n");
}

/** Dashboard summary: STATE / VERIFIED / BLOCKED ON / ACTIVE DECISIONS. */
export interface DashboardVerifiedState {
  state: TaskOutcomeStatus | "NONE";
  stateReason?: string;
  verified: number;
  current: number;
  stale: number;
  mismatched: number;
  blockedOn?: string;
  blockers: number;
  decisions: number;
  topDecision?: string;
  nextIntent?: string;
}

export function dashboardVerifiedState(view: ProjectStateView | undefined): DashboardVerifiedState | undefined {
  if (!compactVerifiedState(view) || !view) return undefined;
  const blocker = view.activeBlockers[0];
  return {
    state: view.outcome?.status ?? "NONE",
    ...(view.outcome?.reason ? { stateReason: clip(view.outcome.reason, 160) } : {}),
    verified: view.validations.counts.verified,
    current: view.validations.counts.current,
    stale: view.validations.counts.stale,
    mismatched: view.validations.counts.mismatched,
    ...(blocker ? { blockedOn: clip(blocker.blockedOn ?? blocker.reason ?? blocker.status, 120) } : {}),
    blockers: view.activeBlockers.length,
    decisions: view.decisions.active,
    ...(view.activeDecisions[0] ? { topDecision: clip(view.activeDecisions[0].decision, 120) } : {}),
    ...(view.nextIntent ? { nextIntent: clip(view.nextIntent.text, 160) } : {})
  };
}
