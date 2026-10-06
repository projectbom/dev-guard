import { estimateTokens } from "@dev-guard/core";
import { fromRoot, readTextFile } from "./fs.js";
import { devguardPaths } from "./paths.js";

import type { ThreadPressure } from "./thread-ownership.js";

/**
 * Context Rollover signal.
 *
 * Two separate concepts, never mixed:
 * - Thread Pressure (thread-ownership.ts): how heavy the provider thread
 *   itself is, from what the provider actually recorded (input tokens vs
 *   window, compactions). UNKNOWN when not observable — never estimated.
 * - Task weight: signals DevGuard itself owns for the current task (pending
 *   files, validations recorded this task, task age).
 * The size of DevGuard's own resume bundle (measureResumeBundleCost) is a
 * third, unrelated number — the cost of resuming in a NEW thread — and is
 * reported separately; it never moves this status (a fresh agent thread with a
 * large resume packet is not under pressure).
 */
export type RolloverStatus = "SAFE" | "ROLL_OVER_SOON" | "ROLL_OVER_RECOMMENDED";

export interface RolloverBudgets {
  changedFiles: number;
  qaResults: number;
  taskAgeMinutes: number;
}

/**
 * Defaults are deliberately conservative heuristics, not measured constants.
 * They can be tuned later without changing the shape of the assessment.
 */
export const DEFAULT_ROLLOVER_BUDGETS: RolloverBudgets = {
  changedFiles: 20,
  qaResults: 10,
  taskAgeMinutes: 180
};

export interface RolloverSignalInput {
  changedFileCount: number;
  qaResultCount: number;
  /** ISO timestamp the current task started, if any. Omitted when no task is active. */
  taskCreatedAt?: string;
  /** Observed provider thread pressure, when available (see thread-ownership.ts). */
  threadPressure?: ThreadPressure;
  /**
   * Hybrid policy input: the calling thread already finished the previous
   * task, and this task is NOT in the same workstream. Reusing a thread for
   * unrelated work is advised against even at low pressure.
   */
  reusedThreadForNewWorkstream?: boolean;
  now?: Date;
  budgets?: Partial<RolloverBudgets>;
}

export interface RolloverSignalRatio {
  label: "changedFiles" | "qaResults" | "taskAgeMinutes";
  value: number;
  budget: number;
  ratio: number;
}

export interface RolloverAssessment {
  status: RolloverStatus;
  /** 0..~1.5, capped per-signal before averaging. Not a percentage of anything real. */
  score: number;
  signals: RolloverSignalRatio[];
  dominantSignal?: RolloverSignalRatio;
  /** Observed provider thread pressure (UNKNOWN when not observable). */
  thread: ThreadPressure;
  /** One-line action matching `status` and the thread observation. */
  advice: string;
  note: string;
}

const SOON_THRESHOLD = 0.6;
const RECOMMENDED_THRESHOLD = 0.9;
const RATIO_CAP = 1.5;
const SINGLE_SIGNAL_SOON_RATIO = 1.0;
const SINGLE_SIGNAL_RECOMMENDED_RATIO = 1.3;

const STATUS_RANK: Record<RolloverStatus, number> = { SAFE: 0, ROLL_OVER_SOON: 1, ROLL_OVER_RECOMMENDED: 2 };

function maxStatus(a: RolloverStatus, b: RolloverStatus): RolloverStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

export function computeRolloverAssessment(input: RolloverSignalInput): RolloverAssessment {
  const budgets = { ...DEFAULT_ROLLOVER_BUDGETS, ...input.budgets };
  const now = input.now ?? new Date();
  const signals: RolloverSignalRatio[] = [
    ratio("changedFiles", input.changedFileCount, budgets.changedFiles),
    ratio("qaResults", input.qaResultCount, budgets.qaResults)
  ];
  if (input.taskCreatedAt) {
    const createdAtMs = new Date(input.taskCreatedAt).getTime();
    if (!Number.isNaN(createdAtMs)) {
      const ageMinutes = Math.max(0, (now.getTime() - createdAtMs) / 60000);
      signals.push(ratio("taskAgeMinutes", ageMinutes, budgets.taskAgeMinutes));
    }
  }
  const cappedRatios = signals.map((signal) => Math.min(signal.ratio, RATIO_CAP));
  const score = cappedRatios.length > 0 ? cappedRatios.reduce((sum, value) => sum + value, 0) / cappedRatios.length : 0;
  const dominantSignal = [...signals].sort((a, b) => b.ratio - a.ratio)[0];
  const maxRatio = dominantSignal?.ratio ?? 0;
  // Averaging alone can mask one already-over-budget signal behind several
  // quiet ones, so a single signal past its own budget floors the status.
  const taskStatus: RolloverStatus =
    score >= RECOMMENDED_THRESHOLD || maxRatio >= SINGLE_SIGNAL_RECOMMENDED_RATIO
      ? "ROLL_OVER_RECOMMENDED"
      : score >= SOON_THRESHOLD || maxRatio >= SINGLE_SIGNAL_SOON_RATIO
        ? "ROLL_OVER_SOON"
        : "SAFE";
  const thread = input.threadPressure ?? { status: "UNKNOWN" as const, reason: "Provider thread usage is not observable here." };
  const threadStatus: RolloverStatus = thread.status === "NEW_THREAD" ? "ROLL_OVER_RECOMMENDED" : thread.status === "SOON" ? "ROLL_OVER_SOON" : "SAFE";
  const workstreamStatus: RolloverStatus = input.reusedThreadForNewWorkstream ? "ROLL_OVER_SOON" : "SAFE";
  const status = maxStatus(maxStatus(taskStatus, threadStatus), workstreamStatus);
  return {
    status,
    score: Math.round(score * 100) / 100,
    signals,
    dominantSignal,
    thread,
    advice: rolloverAdvice(status, thread, Boolean(input.reusedThreadForNewWorkstream)),
    note: "Thread pressure comes only from provider-recorded usage (UNKNOWN when unavailable); the other signals are DevGuard-owned (changed files, recorded validations, task age). DevGuard's resume bundle size is reported separately and never moves this status — it is not a reading of the AI provider's context window."
  };
}

function rolloverAdvice(status: RolloverStatus, thread: ThreadPressure, reusedForNewWorkstream: boolean): string {
  if (thread.status === "NEW_THREAD") return `${thread.reason} Finish or checkpoint, then continue in a fresh agent thread with prepare_task_context.`;
  if (status === "ROLL_OVER_RECOMMENDED") return "This task has grown large (files/validations/age). Start the next step in a fresh agent thread with prepare_task_context.";
  if (reusedForNewWorkstream) return "This thread already finished a different workstream. Prefer a fresh agent thread for this task.";
  if (thread.status === "SOON") return `${thread.reason} Finish this task here; start the next task in a fresh agent thread.`;
  if (status === "ROLL_OVER_SOON") return "Task weight is rising. Finish this task here; start the next task in a fresh agent thread.";
  if (thread.status === "LOW") return `${thread.reason} Continue in this thread.`;
  return "Thread usage is not observable. Start each distinct task in a fresh agent thread with prepare_task_context; move to a fresh agent thread if this one was compacted.";
}

function ratio(label: RolloverSignalRatio["label"], value: number, budget: number): RolloverSignalRatio {
  return { label, value, budget, ratio: budget > 0 ? value / budget : 0 };
}

const BEFORE_AGENT_ARTIFACTS: Array<{ label: string; path: string }> = [
  { label: "agent-brief", path: devguardPaths.agentBrief },
  { label: "read-map", path: devguardPaths.readMap },
  { label: "code-map", path: devguardPaths.codeMap },
  { label: "working-context", path: devguardPaths.workingContext },
  { label: "agent-context", path: devguardPaths.agentContext },
  { label: "next-claude-prompt", path: devguardPaths.nextClaudePrompt }
];

export interface ResumeBundleArtifactCost {
  label: string;
  path: string;
  bytes: number;
  estimatedTokens: number;
}

export interface ResumeBundleCost {
  perArtifact: ResumeBundleArtifactCost[];
  totalBytes: number;
  totalEstimatedTokens: number;
  note: string;
}

/**
 * Measures the "before-agent" markdown bundle an agent falls back to reading
 * when it does not (or cannot) rely solely on `prepare_task_context`'s
 * structured MCP result — see CLAUDE.md's MCP fallback order. This is the
 * cost a Context Rollover is trying to help a new session avoid paying in
 * full.
 */
export async function measureResumeBundleCost(root: string): Promise<ResumeBundleCost> {
  const perArtifact = await Promise.all(
    BEFORE_AGENT_ARTIFACTS.map(async ({ label, path }) => {
      const content = await readTextFile(fromRoot(root, path));
      return { label, path, bytes: Buffer.byteLength(content, "utf8"), estimatedTokens: estimateTokens(content) };
    })
  );
  return {
    perArtifact,
    totalBytes: perArtifact.reduce((sum, item) => sum + item.bytes, 0),
    totalEstimatedTokens: perArtifact.reduce((sum, item) => sum + item.estimatedTokens, 0),
    note: "Approximate (char-based heuristic), not a provider-billed token count."
  };
}
