/**
 * Write Health: in-process record of whether DevGuard can currently persist
 * its own state files (runtime.json, state.json). It cannot live in
 * runtime.json — that is exactly the file that fails to write — so it is
 * kept in memory of the process that writes: the watch process, which also
 * serves the Dashboard and heartbeats every few seconds. A failing streak
 * therefore shows up in Dashboard health within one write, and the next
 * successful write (the following heartbeat once space is back) clears it
 * with no restart and no extra polling.
 *
 * It also owns log suppression for repeated identical write failures: a
 * persistent ENOSPC used to produce ~6 warning lines per second.
 */
export type WriteFailureCategory = "disk-full" | "permission" | "write-failed";

export interface WriteFailure {
  path: string;
  operation: string;
  code?: string;
  category: WriteFailureCategory;
  since: string;
  lastAt: string;
  count: number;
}

export interface WriteHealthSnapshot {
  failing: WriteFailure[];
}

/** At most one user-visible warning per path+code within this window. */
export const WRITE_FAILURE_LOG_INTERVAL_MS = 60_000;

const failures = new Map<string, WriteFailure & { lastLoggedAt: number; suppressed: number }>();

export function writeErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

export function categorizeWriteError(error: unknown): WriteFailureCategory {
  const code = writeErrorCode(error);
  if (code === "ENOSPC" || code === "EDQUOT") return "disk-full";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "permission";
  return "write-failed";
}

/** Errors a short retry cannot fix; retrying them only hammers the disk. */
export function isPersistentWriteError(error: unknown): boolean {
  return categorizeWriteError(error) !== "write-failed";
}

/**
 * Records a failed write. Returns the log line to emit, or undefined when an
 * identical failure was already reported within the interval (the count of
 * suppressed repeats is carried into the next emitted line).
 */
export function noteWriteFailure(path: string, operation: string, error: unknown, now = Date.now()): string | undefined {
  const code = writeErrorCode(error);
  const category = categorizeWriteError(error);
  const at = new Date(now).toISOString();
  const existing = failures.get(path);
  if (existing && existing.code === code && now - existing.lastLoggedAt < WRITE_FAILURE_LOG_INTERVAL_MS) {
    existing.count += 1;
    existing.lastAt = at;
    existing.operation = operation;
    existing.suppressed += 1;
    return undefined;
  }
  const suppressed = existing?.suppressed ?? 0;
  failures.set(path, {
    path,
    operation,
    code,
    category,
    since: existing?.since ?? at,
    lastAt: at,
    count: (existing?.count ?? 0) + 1,
    lastLoggedAt: now,
    suppressed: 0
  });
  // Code + operation only: Node's message embeds the random temp-file
  // suffix, which would make every line unique and defeat deduplication.
  return `atomic_write=failed path=${JSON.stringify(path)} code=${code ?? "unknown"} category=${category} operation=${operation}${suppressed > 0 ? ` suppressed_repeats=${suppressed}` : ""}`;
}

/** Records a successful write. Returns a recovery log line when it ends a failing streak. */
export function noteWriteSuccess(path: string, now = Date.now()): string | undefined {
  const existing = failures.get(path);
  if (!existing) return undefined;
  failures.delete(path);
  const seconds = Math.max(0, Math.round((now - Date.parse(existing.since)) / 1000));
  return `atomic_write=recovered path=${JSON.stringify(path)} code=${existing.code ?? "unknown"} failures=${existing.count} failing_for_s=${seconds}`;
}

export function getWriteHealth(): WriteHealthSnapshot {
  return { failing: [...failures.values()].map(({ lastLoggedAt: _l, suppressed: _s, ...failure }) => failure) };
}

/** True while `path` failed within `windowMs` — callers with their own cadence (heartbeat) skip a doomed write. */
export function isWriteBackingOff(path: string, windowMs: number, now = Date.now()): boolean {
  const failure = failures.get(path);
  return Boolean(failure && now - Date.parse(failure.lastAt) < windowMs);
}

export function resetWriteHealthForTests(): void {
  failures.clear();
}
