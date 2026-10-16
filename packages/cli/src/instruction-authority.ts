import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Instruction Authority: the one detector for obsolete DevGuard guidance in
 * user-level agent instruction files. Older DevGuard guides had users paste
 * "read project-handoff.md / quality-report.md first" into them, which now
 * contradicts the project-managed section (MCP first, no markdown reads) —
 * in real use agents copied those three paths into `explicitInputs`, where
 * they were rejected and the user's real inputs were never passed.
 *
 * Shared by `doctor`, `prepare_task_context` warnings, and Dashboard health.
 * DevGuard does not own these files — no marker section is ever written
 * there — so this only reads and reports; it never edits.
 */
export interface LegacyGlobalInstruction {
  path: string;
  lines: number[];
}

const LEGACY_LINE = /\.devguard\/(?:reports\/(?:project-handoff|quality-report|working-context)|prompts\/next-(?:codex|claude)-prompt)\.md/;

export function userInstructionFiles(home = homedir()): string[] {
  return [join(home, ".codex", "AGENTS.md"), join(home, ".claude", "CLAUDE.md")];
}

export function legacyLinesIn(text: string): number[] {
  if (!text || /prepare_task_context/.test(text)) return [];
  return text.split(/\r?\n/).flatMap((line, index) => (LEGACY_LINE.test(line) ? [index + 1] : []));
}

export async function findLegacyGlobalInstructions(home = homedir()): Promise<LegacyGlobalInstruction[]> {
  const found: LegacyGlobalInstruction[] = [];
  for (const path of userInstructionFiles(home)) {
    const lines = legacyLinesIn(await readFile(path, "utf8").catch(() => ""));
    if (lines.length > 0) found.push({ path, lines });
  }
  return found;
}

/**
 * Cached variant for per-task / per-poll callers. Each call costs one `stat`
 * per known file; a file is re-read only when its mtime or size changed, so
 * a user who removes the block is seen on the very next call — the cache
 * never outlives the file content it describes. Never scans the home
 * directory beyond the fixed file list above.
 */
const cache = new Map<string, { mtimeMs: number; size: number; lines: number[] }>();

export async function detectLegacyGlobalInstructions(home = homedir()): Promise<LegacyGlobalInstruction[]> {
  const found: LegacyGlobalInstruction[] = [];
  for (const path of userInstructionFiles(home)) {
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) {
      cache.delete(path);
      continue;
    }
    let entry = cache.get(path);
    if (!entry || entry.mtimeMs !== info.mtimeMs || entry.size !== info.size) {
      entry = { mtimeMs: info.mtimeMs, size: info.size, lines: legacyLinesIn(await readFile(path, "utf8").catch(() => "")) };
      cache.set(path, entry);
    }
    if (entry.lines.length > 0) found.push({ path, lines: entry.lines });
  }
  return found;
}

export function displayInstructionPath(path: string, home = homedir()): string {
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/** One concise agent-facing warning per conflicting file; never the file contents. */
export function legacyInstructionWarnings(found: LegacyGlobalInstruction[], home = homedir()): string[] {
  return found.map(
    (entry) =>
      `Legacy DevGuard instructions were detected in ${displayInstructionPath(entry.path, home)} (lines ${entry.lines.join(", ")}). They conflict with the current MCP-first workflow and may cause stale handoff files to be passed as inputs. Ignore that block for this task; the user should remove it by hand (DevGuard never edits user-level instruction files).`
  );
}
