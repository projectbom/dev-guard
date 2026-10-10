import { appendTextFile, fromRoot, readTailLines } from "./fs.js";
import { devguardPaths } from "./paths.js";
import type { RolloverStatus } from "./rollover.js";

/**
 * Minimal effectiveness-telemetry stream: one compact JSON line per
 * task/session lifecycle event, appended to `.devguard/telemetry.jsonl`.
 *
 * This exists to answer, from DevGuard's OWN recorded state alone (no
 * external APM, no reading of AI provider internals): how long after
 * `prepare_task_context` did real work start, how long did a task stay
 * open, how many files did it actually touch, what validation was
 * recorded, and was completion triggered by a human running `dev-guard
 * done` or by a Claude/Codex Stop hook. See CLAUDE.md task history for the
 * PartnerFlow audit this answers — that audit could not reconstruct any of
 * this because no such event stream existed.
 *
 * Deliberately NOT a copy of history.jsonl/change-log.jsonl: those record
 * the full accumulated diff/intent of a `done` cycle (expensive, prose-
 * heavy, and — as the audit found — not scoped to one task). This stream
 * records only small, typed, already-computed facts (counts, ids,
 * statuses) — never prompt text, file contents, or diff text — so it stays
 * cheap to append and safe to retain indefinitely.
 */
export type TaskTelemetryEventType =
  | "TASK_PREPARED"
  | "TASK_CONTINUED"
  | "TASK_REPLACED"
  | "VALIDATION_RECORDED"
  /**
   * A completion actor (hook, manual `dev-guard done`, watch auto-finalize,
   * dashboard) asked for finalization — recorded on EVERY such request,
   * before the Idempotent Finalization Boundary check decides whether it
   * is new work or a duplicate. This is the "raw signal" count; TASK_DONE
   * below is the "effective finalization" count, and the two are expected
   * to diverge whenever a hook fires more often than the code actually
   * changes (e.g. once per agent turn instead of once per real edit).
   */
  | "COMPLETION_SIGNAL_RECEIVED"
  /** The one effective finalization that closes a task — exactly once per task. */
  | "TASK_DONE"
  /**
   * A later finalization in the same lineage after its task was already
   * closed (edits made after `dev-guard done`). Real work, not a completion.
   */
  | "TASK_FOLLOWUP_FINALIZED"
  /**
   * A hook completion that was NOT acted on because it came from a provider
   * thread other than the current task's owner (diagnostic only — nothing
   * was finalized, cleared, or regenerated).
   */
  | "COMPLETION_IGNORED"
  | "HOOK_DONE_TRIGGERED";

export interface TaskTelemetryEvent {
  timestamp: string;
  event: TaskTelemetryEventType;
  /** Session/task lineage id — see RuntimeState.sessionId. */
  sessionId?: string;
  /** Number of files `prepare_task_context` returned as candidates (TASK_PREPARED/CONTINUED/REPLACED). */
  candidateFileCount?: number;
  /** Approximate cost of the before-agent markdown bundle — see rollover.ts. Never a provider-billed count. */
  estimatedResumeTokens?: number;
  /** DevGuard-owned Context Rollover signal at event time — see rollover.ts. */
  rolloverStatus?: RolloverStatus;
  /** Files newly dirty since the current task lineage's baseline — see BeforeAgentTask.changedFilesAtCreation. */
  changedFileDeltaCount?: number;
  /** Files dirty before the current task lineage started (carried over from earlier, undeclared work). */
  carriedOverFileCount?: number;
  /** VALIDATION_RECORDED only. */
  validationKind?: string;
  validationStatus?: string;
  /** TASK_DONE/HOOK_DONE_TRIGGERED only — which real trigger produced this completion. */
  completionSource?: string;
  /**
   * TASK_DONE only — reuses BeforeAgentTask.createdAt (already recorded by
   * prepare_task_context) and RuntimeState.firstChangedAt (already recorded
   * by `dev-guard watch`'s file-change detection). Their difference is an
   * APPROXIMATE time-to-first-observed-change — DevGuard has no way to
   * observe an AI agent's actual first file read or first edit, only the
   * first change `watch` happened to see on disk. Both fields are omitted
   * (never guessed) when the underlying signal is unavailable, e.g. `watch`
   * was never running this round.
   */
  taskPreparedAt?: string;
  firstChangeObservedAt?: string;
  /** TASK_PREPARED/CONTINUED/REPLACED: repo-relative paths prepare_task_context provided (max 16; paths only). */
  providedFiles?: string[];
  /** TASK_PREPARED/CONTINUED/REPLACED: validated user-named inputs planned as TARGETs (count only). */
  explicitInputCount?: number;
  /** TASK_PREPARED/CONTINUED/REPLACED: one-hop references planned from structured TARGETs. */
  referenceFileCount?: number;
  /** TASK_PREPARED/CONTINUED/REPLACED: estimated tokens of the planned TARGET reads (characters / 4). Never provider-billed. */
  plannedInitialTokens?: number;
  /** TASK_PREPARED/CONTINUED/REPLACED: the subset of providedFiles marked TARGET (read first). */
  providedTargets?: string[];
  /** TASK_PREPARED/CONTINUED/REPLACED: number of line ranges provided across those files. */
  providedRangeCount?: number;
  /** TASK_PREPARED/CONTINUED/REPLACED: estimated tokens of the MCP agent payload as delivered (single copy). Never provider-billed. */
  mcpPayloadTokens?: number;
  /** TASK_PREPARED/CONTINUED/REPLACED: observed provider thread pressure (see thread-ownership.ts). */
  threadPressure?: string;
  /** TASK_PREPARED/CONTINUED/REPLACED: how the task's owning thread was identified, if at all. */
  ownerSource?: string;
  /** COMPLETION_SIGNAL_RECEIVED: true when the request was a no-op duplicate of an already-finalized state. */
  alreadyProcessed?: boolean;
  /** COMPLETION_SIGNAL_RECEIVED (hook sources): "owner" or "unverified" (no observable thread identity — fail-open). */
  ownership?: string;
  /** COMPLETION_IGNORED: why the request was not acted on. */
  reason?: string;
  /** COMPLETION_IGNORED: hashed thread ids (never raw provider ids). */
  ownerThreadHash?: string;
  sourceThreadHash?: string;
}

const telemetryPath = devguardPaths.taskTelemetry;
const TAIL_READ_BYTES = 1 * 1024 * 1024;

export async function recordTaskTelemetry(root: string, event: Omit<TaskTelemetryEvent, "timestamp">): Promise<void> {
  const stamped: TaskTelemetryEvent = { timestamp: new Date().toISOString(), ...event };
  await appendTextFile(fromRoot(root, telemetryPath), `${JSON.stringify(stamped)}\n`).catch(() => undefined);
}

/**
 * Bounded tail read (mirrors readHistoryRecords) — this file grows for the
 * lifetime of a project under continuous use, so reading it must never cost
 * more than `limit` records regardless of how long the project has existed.
 */
export async function readTaskTelemetry(root: string, limit = 50): Promise<TaskTelemetryEvent[]> {
  const lines = await readTailLines(fromRoot(root, telemetryPath), TAIL_READ_BYTES);
  const events = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TaskTelemetryEvent;
      } catch {
        return undefined;
      }
    })
    .filter((event): event is TaskTelemetryEvent => Boolean(event));
  return events.slice(-limit);
}
