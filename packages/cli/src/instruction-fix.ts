import { chmod, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { detectLegacyGlobalInstructions, displayInstructionPath, legacyLinesIn, userInstructionFiles } from "./instruction-authority.js";

/**
 * The explicit, user-invoked fixer for obsolete DevGuard blocks in
 * user-level instruction files (`dev-guard doctor --agents --fix`). Watch,
 * setup, prepare and the Dashboard never call it — they only detect.
 *
 * Ownership is decided per line, never by keyword: a line belongs to a
 * legacy block only when its whole text (ignoring list markers, backticks
 * and spacing) is one of the sentences old DevGuard guides told users to
 * paste. A block must contain both a DevGuard markdown path and a
 * "treat DevGuard artifacts as the project state" directive. If any line the
 * shared detector flags is not inside such a block, the file is refused and
 * the user is told which lines to review by hand.
 */

type SignatureKind = "path" | "directive" | "filler";

const SIGNATURES: Array<{ kind: SignatureKind; pattern: RegExp }> = [
  { kind: "path", pattern: /^(?:read )?\.devguard\/(?:reports\/(?:project-handoff|quality-report|working-context)|prompts\/next-(?:codex|claude)-prompt|context\/agent-(?:context|brief))\.md\.?$/ },
  { kind: "directive", pattern: /^use (?:dev-?guard|them) (?:artifacts )?as the primary source of (?:project context|current project state)\.?$/ },
  { kind: "directive", pattern: /^do not perform repository-wide scans before reading (?:them|the current dev-?guard context|the dev-?guard (?:documents|artifacts))\.?$/ },
  { kind: "directive", pattern: /^treat the dev-?guard (?:documents|artifacts) as the current project state(?: and continue from there)?\.?$/ },
  { kind: "directive", pattern: /^continue from the latest dev-?guard state\.?$/ },
  { kind: "filler", pattern: /^read:?$/ },
  { kind: "filler", pattern: /^only open additional files when required (?:for the current task|to complete the task)\.?$/ },
  { kind: "filler", pattern: /^## startup instructions$/ },
  { kind: "filler", pattern: /^<!-- dev-guard-section-(?:start|end) -->$/ }
];

function normalizeLine(line: string): string {
  return line
    .replace(/^﻿/, "")
    .replace(/\r?\n$/, "")
    .trim()
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function signatureOf(line: string): SignatureKind | undefined {
  const normalized = normalizeLine(line);
  return SIGNATURES.find((signature) => signature.pattern.test(normalized))?.kind;
}

const isBlank = (line: string) => line.trim() === "";

/** Lines with their own terminators, so CRLF/LF and a missing final newline survive untouched. */
export function splitKeepingEndings(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export interface LegacyBlock {
  /** 1-based, inclusive: the recognized DevGuard lines (blank lines inside included). */
  startLine: number;
  endLine: number;
  /** 1-based, inclusive: what is actually removed (the block plus the blank gap it leaves). */
  removeStart: number;
  removeEnd: number;
  /** The recognized template lines, trimmed — never user text. */
  preview: string[];
}

export interface LegacyRemovalPlan {
  status: "clean" | "fixable" | "ambiguous";
  /** Lines the shared detector flags (same numbers doctor and prepare print). */
  conflictLines: number[];
  blocks: LegacyBlock[];
  /** Flagged lines outside any recognized block (status "ambiguous"). */
  reviewLines: number[];
  /** The text after removal (status "fixable"). */
  next?: string;
}

/** Pure: decide what an explicit fix would remove from `text`. */
export function planLegacyRemoval(text: string): LegacyRemovalPlan {
  const conflictLines = legacyLinesIn(text);
  if (conflictLines.length === 0) return { status: "clean", conflictLines, blocks: [], reviewLines: [] };
  const lines = splitKeepingEndings(text);
  const kinds = lines.map((line) => (isBlank(line) ? "blank" : signatureOf(line)));
  const blocks: LegacyBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!kinds[index] || kinds[index] === "blank") {
      index += 1;
      continue;
    }
    let end = index;
    for (let cursor = index; cursor < lines.length && kinds[cursor]; cursor += 1) if (kinds[cursor] !== "blank") end = cursor;
    const run = kinds.slice(index, end + 1);
    if (run.includes("path") && run.includes("directive")) {
      blocks.push({
        startLine: index + 1,
        endLine: end + 1,
        removeStart: index + 1,
        removeEnd: end + 1,
        preview: lines.slice(index, end + 1).filter((line) => !isBlank(line)).map((line) => line.trim())
      });
    }
    index = end + 1;
  }
  const covered = (line: number) => blocks.some((block) => line >= block.startLine && line <= block.endLine);
  const reviewLines = conflictLines.filter((line) => !covered(line));
  if (reviewLines.length > 0 || blocks.length === 0) return { status: "ambiguous", conflictLines, blocks: [], reviewLines: reviewLines.length ? reviewLines : conflictLines };

  // Take the blank gap the block leaves with it, so removal never leaves a
  // double gap: the following blank lines when the block starts the file or
  // a paragraph, or the preceding ones when it ends the file. Text the block
  // is glued to keeps its own spacing.
  for (const block of blocks) {
    let after = block.endLine; // 1-based index of the last line; lines[after] is the next line
    while (after < lines.length && isBlank(lines[after])) after += 1;
    const atStart = block.startLine === 1 || isBlank(lines[block.startLine - 2]);
    if (after === lines.length) {
      block.removeEnd = lines.length;
      let before = block.startLine - 1;
      while (before >= 1 && isBlank(lines[before - 1]) && !blocks.some((other) => other !== block && before >= other.removeStart && before <= other.removeEnd)) before -= 1;
      block.removeStart = before + 1;
    } else if (atStart) {
      block.removeEnd = after;
    }
  }
  const removed = new Set<number>();
  for (const block of blocks) for (let line = block.removeStart; line <= block.removeEnd; line += 1) removed.add(line);
  // Kept lines keep their own terminators, so a kept line that was mid-file
  // keeps its newline even when the removed block held the file's last line.
  const next = lines.filter((_, i) => !removed.has(i + 1)).join("");
  return { status: "fixable", conflictLines, blocks, reviewLines: [], next };
}

/** "4–6, 9" */
export function formatLineRanges(lines: number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j += 1;
    ranges.push(i === j ? String(lines[i]) : `${lines[i]}–${lines[j]}`);
    i = j + 1;
  }
  return ranges.join(", ");
}

export interface LegacyFilePlan extends LegacyRemovalPlan {
  path: string;
  displayPath: string;
  totalLines: number;
  /** Set when the file cannot be fixed safely as bytes (not UTF-8). */
  unsafe?: string;
}

/** Read-only: plans for every known user-level instruction file that has a conflict. */
export async function planLegacyInstructionFixes(home = homedir()): Promise<LegacyFilePlan[]> {
  const plans: LegacyFilePlan[] = [];
  for (const path of userInstructionFiles(home)) {
    const bytes = await readFile(path).catch(() => undefined);
    if (!bytes) continue;
    const text = bytes.toString("utf8");
    const plan = planLegacyRemoval(text);
    if (plan.status === "clean") continue;
    const unsafe = Buffer.from(text, "utf8").equals(bytes) ? undefined : "the file is not valid UTF-8, so it cannot be rewritten byte-for-byte";
    plans.push({ ...plan, ...(unsafe ? { status: "ambiguous" as const, unsafe, reviewLines: plan.conflictLines, blocks: [] } : {}), path, displayPath: displayInstructionPath(path, home), totalLines: splitKeepingEndings(text).length });
  }
  return plans;
}

export type LegacyFixOutcome =
  | { status: "FIXED"; path: string; backupPath: string }
  | { status: "PARTIAL"; path: string; backupPath: string; remainingLines: number[] }
  | { status: "FAILED"; path: string; reason: string; backupPath?: string };

function backupStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Never overwrites: exclusive create, with a numeric suffix if the name exists. */
async function createBackup(path: string, bytes: Buffer, now: Date): Promise<string> {
  const base = `${path}.devguard-backup-${backupStamp(now)}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    let handle;
    try {
      handle = await open(candidate, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    if (!(await readFile(candidate)).equals(bytes)) throw new Error(`backup ${candidate} does not match the original`);
    return candidate;
  }
  throw new Error(`could not find a free backup name next to ${path}`);
}

/**
 * One explicit mutation pass for one planned file: re-read and re-plan (the
 * file may have changed since the preview), back up byte-for-byte, write the
 * planned text atomically (to the symlink target, keeping its mode), then
 * re-run the shared detector. Never loops: a remaining conflict is PARTIAL.
 */
export async function applyLegacyInstructionFix(plan: LegacyFilePlan, options: { home?: string; now?: Date } = {}): Promise<LegacyFixOutcome> {
  const home = options.home ?? homedir();
  const path = plan.path;
  let original: Buffer;
  try {
    original = await readFile(path);
  } catch (error) {
    return { status: "FAILED", path, reason: `cannot read the file: ${(error as Error).message}` };
  }
  const fresh = planLegacyRemoval(original.toString("utf8"));
  if (fresh.status !== "fixable" || fresh.next === undefined || fresh.next !== plan.next) {
    return { status: "FAILED", path, reason: "the file changed after it was checked; run the command again" };
  }
  let backupPath: string;
  try {
    backupPath = await createBackup(path, original, options.now ?? new Date());
  } catch (error) {
    return { status: "FAILED", path, reason: `backup failed, the file was not modified: ${(error as Error).message}` };
  }
  try {
    const target = await realpath(path);
    const mode = (await stat(target)).mode & 0o7777;
    const temp = `${target}.devguard-tmp-${process.pid}`;
    try {
      await writeFile(temp, fresh.next, { encoding: "utf8", mode, flag: "wx" });
      await chmod(temp, mode);
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    return { status: "FAILED", path, backupPath, reason: `write failed, the original is unchanged: ${(error as Error).message}` };
  }
  let after: string;
  try {
    after = await readFile(path, "utf8");
  } catch (error) {
    return { status: "FAILED", path, backupPath, reason: `the file is not readable after the fix: ${(error as Error).message}` };
  }
  const remaining = legacyLinesIn(after);
  const stillDetected = (await detectLegacyGlobalInstructions(home)).some((entry) => entry.path === path);
  if (remaining.length > 0 || stillDetected) return { status: "PARTIAL", path, backupPath, remainingLines: remaining };
  return { status: "FIXED", path, backupPath };
}
