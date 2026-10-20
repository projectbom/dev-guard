import { readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { appendTextFile, fromRoot, readTailLines, writeFileIfMissing } from "./fs.js";
import { DEVGUARD_DIR, devguardPaths } from "./paths.js";

/**
 * Retention for DevGuard's append-only JSONL logs (history, change-log,
 * task telemetry). Measured on a real downstream project: one week of
 * `watch` produced a 14 MB history.jsonl and an 8 MB change-log.jsonl —
 * every record embeds the full dirty-worktree file list, so a large dirty
 * tree costs ~50-290 KB per `done`, forever.
 *
 * Policy: once the live file passes `rotateBytes`, it is renamed to
 * `<file>.1` (replacing the previous `.1`) and the next append starts a new
 * live file. Readers (readBoundedJsonlTail) read the live tail and, when it
 * holds fewer records than they need, the tail of `.1` before it — so a
 * reader's view is the same just before and just after a rotation, and
 * `done` always sees the last history record.
 *
 * Why a single rename and nothing else:
 * - Concurrency: appends open the path per write (O_APPEND), so a line
 *   lands either in the old inode (now `.1`) or in the new live file —
 *   never in a file that is later replaced. No line is lost.
 * - Two processes rotating at once: an exclusive `<file>.rotate.lock`
 *   (create-only) admits one rotator; it re-checks the size after taking
 *   the lock, so a second rotator never renames the fresh small live file
 *   over the full `.1`. A lock left by a crashed process is reclaimed after
 *   ROTATE_LOCK_STALE_MS.
 * - Crash safety: rename is atomic. A crash before it leaves the live file
 *   untouched; after it, the data is complete in `.1` and readers fall back
 *   to it. There is no state in which both are empty.
 *
 * Disk use per log stays below ~2x `rotateBytes`; nothing outside these
 * machine-generated logs is ever touched.
 */
export interface JsonlRetentionPolicy {
  rotateBytes: number;
}

const MiB = 1024 * 1024;
const ROTATE_LOCK_STALE_MS = 60_000;

export const HISTORY_RETENTION: JsonlRetentionPolicy = { rotateBytes: 8 * MiB };
export const CHANGE_LOG_RETENTION: JsonlRetentionPolicy = { rotateBytes: 8 * MiB };
export const TELEMETRY_RETENTION: JsonlRetentionPolicy = { rotateBytes: 4 * MiB };
/** Structured task events (~1 KB per task): a rotation re-seeds the live file with a state checkpoint. */
export const PROJECT_EVENTS_RETENTION: JsonlRetentionPolicy = { rotateBytes: 2 * MiB };

/** Suffix of the single rotated generation kept next to each bounded log. */
export const ROTATED_SUFFIX = ".1";

export async function appendBoundedJsonl(path: string, line: string, policy: JsonlRetentionPolicy): Promise<void> {
  await appendTextFile(path, line);
  await rotateJsonlIfNeeded(path, policy);
}

/** Returns true when this call rotated the file. */
export async function rotateJsonlIfNeeded(path: string, policy: JsonlRetentionPolicy): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  if (!info || info.size <= policy.rotateBytes) return false;
  const lockPath = `${path}.rotate.lock`;
  if (!(await acquireRotateLock(lockPath))) return false;
  try {
    // Re-check under the lock: another process may have rotated already.
    const current = await stat(path).catch(() => undefined);
    if (!current || current.size <= policy.rotateBytes) return false;
    await rename(path, `${path}${ROTATED_SUFFIX}`);
    return true;
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

async function acquireRotateLock(lockPath: string): Promise<boolean> {
  if ((await writeFileIfMissing(lockPath, String(Date.now()))) === "created") return true;
  const held = await stat(lockPath).catch(() => undefined);
  if (held && Date.now() - held.mtimeMs <= ROTATE_LOCK_STALE_MS) return false;
  await unlink(lockPath).catch(() => undefined);
  return (await writeFileIfMissing(lockPath, String(Date.now()))) === "created";
}

/**
 * The last `limit` parsable JSONL records across the live file and, when
 * the live file alone has fewer, its rotated `.1` generation. Each file is
 * read only from its tail (at most `maxBytes`), so cost never depends on
 * how long the project has existed.
 */
export async function readBoundedJsonlTail<T>(path: string, maxBytes: number, limit: number): Promise<T[]> {
  const live = parseJsonLines<T>(await readTailLines(path, maxBytes));
  if (live.length >= limit) return live.slice(-limit);
  const rotated = parseJsonLines<T>(await readTailLines(`${path}${ROTATED_SUFFIX}`, maxBytes));
  return [...rotated, ...live].slice(-limit);
}

function parseJsonLines<T>(lines: string[]): T[] {
  const records: T[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch {
      // A leading fragment of a tail read, or a torn line — skip it.
    }
  }
  return records;
}

export interface StorageSummary {
  /** Canonical current-state files (overwritten in place). */
  currentBytes: number;
  /** Append-only history/telemetry logs, live + rotated generation. */
  historyBytes: number;
  /** Diagnostic hook/watch logs, live + rotated generations. */
  logBytes: number;
  /** Saved prompt/review run logs (`--save-run`), one file per run. */
  runsBytes: number;
  runFiles: number;
  /** Bounded logs currently above their rotation threshold (rotate on next append). */
  overThreshold: string[];
}

const BOUNDED_LOGS: Array<{ path: string; policy: JsonlRetentionPolicy }> = [
  { path: devguardPaths.history, policy: HISTORY_RETENTION },
  { path: devguardPaths.changeLog, policy: CHANGE_LOG_RETENTION },
  { path: devguardPaths.taskTelemetry, policy: TELEMETRY_RETENTION },
  { path: devguardPaths.projectEvents, policy: PROJECT_EVENTS_RETENTION }
];

/** Read-only size summary of `.devguard`, grouped by artifact lifecycle. */
export async function summarizeDevguardStorage(root: string): Promise<StorageSummary> {
  const files = await listFiles(fromRoot(root, DEVGUARD_DIR), "");
  const summary: StorageSummary = { currentBytes: 0, historyBytes: 0, logBytes: 0, runsBytes: 0, runFiles: 0, overThreshold: [] };
  const boundedNames = new Set(BOUNDED_LOGS.flatMap(({ path }) => [path, `${path}${ROTATED_SUFFIX}`, `${path}.rotate.lock`]));
  for (const file of files) {
    const rel = `${DEVGUARD_DIR}/${file.path}`;
    if (boundedNames.has(rel)) summary.historyBytes += file.size;
    else if (file.path.startsWith("logs/")) summary.logBytes += file.size;
    else if (file.path.startsWith("runs/")) {
      summary.runsBytes += file.size;
      if (file.path !== "runs/latest.json") summary.runFiles += 1;
    } else summary.currentBytes += file.size;
  }
  for (const { path, policy } of BOUNDED_LOGS) {
    const size = files.find((file) => `${DEVGUARD_DIR}/${file.path}` === path)?.size ?? 0;
    if (size > policy.rotateBytes) summary.overThreshold.push(path);
  }
  return summary;
}

async function listFiles(dir: string, prefix: string): Promise<Array<{ path: string; size: number }>> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const result: Array<{ path: string; size: number }> = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(...(await listFiles(join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      const info = await stat(join(dir, entry.name)).catch(() => undefined);
      if (info) result.push({ path: rel, size: info.size });
    }
  }
  return result;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MiB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MiB).toFixed(1)} MB`;
}
