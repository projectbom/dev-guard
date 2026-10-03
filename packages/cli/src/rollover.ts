import { estimateTokens } from "@dev-guard/core";
import { fromRoot, readTextFile } from "./fs.js";
import { devguardPaths } from "./paths.js";

/**
 * Context Rollover signal.
 *
 * DevGuard cannot read any AI provider's actual context-window usage — there
 * is no portable, official API for that, and guessing at a provider's
 * internal percentage would be exactly the kind of unverifiable claim this
 * feature must avoid. Instead this is built only from signals DevGuard
 * itself already owns: how many files are pending, how much validation
 * evidence has accumulated, how long the current task has been open, and
 * how large the generated "before-agent" markdown bundle has grown. It is a
 * recommendation a human can act on (start a new AI session), never a
 * guarantee about the AI provider's internal state.
 */
export type RolloverStatus = "SAFE" | "ROLL_OVER_SOON" | "ROLL_OVER_RECOMMENDED";

export interface RolloverBudgets {
  changedFiles: number;
  qaResults: number;
  taskAgeMinutes: number;
  contextTokens: number;
}

/**
 * Defaults are deliberately conservative heuristics, not measured constants.
 * They can be tuned later without changing the shape of the assessment.
 */
export const DEFAULT_ROLLOVER_BUDGETS: RolloverBudgets = {
  changedFiles: 20,
  qaResults: 10,
  taskAgeMinutes: 180,
  contextTokens: 6000
};

export interface RolloverSignalInput {
  changedFileCount: number;
  qaResultCount: number;
  /** ISO timestamp the current task started, if any. Omitted when no task is active. */
  taskCreatedAt?: string;
  /** Approximate — see context-cost.ts. */
  contextBundleEstimatedTokens: number;
  now?: Date;
  budgets?: Partial<RolloverBudgets>;
}

export interface RolloverSignalRatio {
  label: "changedFiles" | "qaResults" | "contextTokens" | "taskAgeMinutes";
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
  note: string;
}

const SOON_THRESHOLD = 0.6;
const RECOMMENDED_THRESHOLD = 0.9;
const RATIO_CAP = 1.5;
const SINGLE_SIGNAL_SOON_RATIO = 1.0;
const SINGLE_SIGNAL_RECOMMENDED_RATIO = 1.3;

export function computeRolloverAssessment(input: RolloverSignalInput): RolloverAssessment {
  const budgets = { ...DEFAULT_ROLLOVER_BUDGETS, ...input.budgets };
  const now = input.now ?? new Date();
  const signals: RolloverSignalRatio[] = [
    ratio("changedFiles", input.changedFileCount, budgets.changedFiles),
    ratio("qaResults", input.qaResultCount, budgets.qaResults),
    ratio("contextTokens", input.contextBundleEstimatedTokens, budgets.contextTokens)
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
  // Averaging alone can mask one already-over-budget signal (e.g. the
  // resume bundle itself exceeding its token budget) behind several quiet
  // ones. A single signal already past its own budget must floor the
  // status at ROLL_OVER_SOON regardless of the average.
  const status: RolloverStatus =
    score >= RECOMMENDED_THRESHOLD || maxRatio >= SINGLE_SIGNAL_RECOMMENDED_RATIO
      ? "ROLL_OVER_RECOMMENDED"
      : score >= SOON_THRESHOLD || maxRatio >= SINGLE_SIGNAL_SOON_RATIO
        ? "ROLL_OVER_SOON"
        : "SAFE";
  return {
    status,
    score: Math.round(score * 100) / 100,
    signals,
    dominantSignal,
    note: "Heuristic from DevGuard-owned signals only (changed files, recorded validations, task age, estimated artifact size). Not a reading of the AI provider's actual context window usage."
  };
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
