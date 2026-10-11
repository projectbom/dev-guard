import { readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendTextFile, fromRoot, readTailLines } from "./fs.js";
import { DEVGUARD_DIR, devguardPaths } from "./paths.js";

/**
 * Retention for DevGuard's append-only JSONL logs (history, change-log,
 * task telemetry). Measured on a real downstream project: one week of
 * `watch` produced a 14 MB history.jsonl and an 8 MB change-log.jsonl —
 * every record embeds the full dirty-worktree file list, so a large dirty
 * tree costs ~50-290 KB per `done`, forever.
 *
 * Policy: once the live file passes `rotateBytes`, it is renamed to
 * `<file>.1` (replacing the previous `.1`), and the most recent records —
 * at most `keepRecords`, within `keepBytes`, and always at least the last
 * one — are carried into a fresh live file. Readers only ever use the tail
 * (readHistoryRecords reads <= 20 records, task telemetry <= 1 MB), and
 * `done` needs the last history record for carried-over detection, so the
 * carried tail keeps every reader's view identical across a rotation.
 * Disk use per log stays below ~2x `rotateBytes`; nothing outside these
 * machine-generated logs is ever touched.
 */
export interface JsonlRetentionPolicy {
  rotateBytes: number;
  keepRecords: number;
  keepBytes: number;
}

const MiB = 1024 * 1024;

export const HISTORY_RETENTION: JsonlRetentionPolicy = { rotateBytes: 8 * MiB, keepRecords: 50, keepBytes: 2 * MiB };
export const CHANGE_LOG_RETENTION: JsonlRetentionPolicy = { rotateBytes: 8 * MiB, keepRecords: 50, keepBytes: 2 * MiB };
export const TELEMETRY_RETENTION: JsonlRetentionPolicy = { rotateBytes: 4 * MiB, keepRecords: 500, keepBytes: 1 * MiB };

/** Suffix of the single rotated generation kept next to each bounded log. */
export const ROTATED_SUFFIX = ".1";

export async function appendBoundedJsonl(path: string, line: string, policy: JsonlRetentionPolicy): Promise<void> {
  await appendTextFile(path, line);
  await rotateJsonlIfNeeded(path, policy);
}

/** Returns true when the file was rotated. */
export async function rotateJsonlIfNeeded(path: string, policy: JsonlRetentionPolicy): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  if (!info || info.size <= policy.rotateBytes) return false;
  // Read enough to hold the carried tail plus one oversized last record;
  // readTailLines drops the leading fragment and we drop unparsable lines.
  const lines = (await readTailLines(path, Math.min(info.size, policy.keepBytes + 4 * MiB)))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isJsonLine(line));
  const kept: string[] = [];
  let keptBytes = 0;
  for (let index = lines.length - 1; index >= 0 && kept.length < policy.keepRecords; index -= 1) {
    const bytes = Buffer.byteLength(lines[index], "utf8") + 1;
    if (kept.length > 0 && keptBytes + bytes > policy.keepBytes) break;
    kept.unshift(lines[index]);
    keptBytes += bytes;
  }
  const tempPath = `${path}.rotating`;
  await writeFile(tempPath, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8");
  await rename(path, `${path}${ROTATED_SUFFIX}`);
  await rename(tempPath, path);
  return true;
}

function isJsonLine(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
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
  { path: devguardPaths.taskTelemetry, policy: TELEMETRY_RETENTION }
];

/** Read-only size summary of `.devguard`, grouped by artifact lifecycle. */
export async function summarizeDevguardStorage(root: string): Promise<StorageSummary> {
  const files = await listFiles(fromRoot(root, DEVGUARD_DIR), "");
  const summary: StorageSummary = { currentBytes: 0, historyBytes: 0, logBytes: 0, runsBytes: 0, runFiles: 0, overThreshold: [] };
  const boundedNames = new Set(BOUNDED_LOGS.flatMap(({ path }) => [path, `${path}${ROTATED_SUFFIX}`]));
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
