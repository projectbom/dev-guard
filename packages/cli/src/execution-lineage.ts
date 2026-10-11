/**
 * Execution lineage: what the previous task actually RAN and BUILT, carried
 * into the next same-workstream task's read plan.
 *
 * In real PartnerFlow runs ~70% of a fresh thread's early reads were outside
 * the plan, mostly the previous run's own scripts (`run6x/prepare.py`,
 * `runtime.py`, `execute.py`) and older executors reused run after run.
 * Agents found them again with `rg --files` and whole-file `cat`. The
 * previous task's lifecycle already shows them — files it changed, scripts
 * it executed and read — so they are recorded at `done` (paths only,
 * bounded) and planned as CANDIDATEs next time, gated on workstream
 * evidence. File naming is only a secondary hint.
 */
import { stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { CodexLocalActivitySource, type AgentActivitySource } from "./agent-activity.js";

export interface ExecutionLineage {
  /** Repository scripts the task executed (first occurrence order). */
  executed: string[];
  /** Script/code files it read but did not produce. */
  usedScripts: string[];
  /** Other repository files it read but did not produce. */
  used: string[];
  /** Files it changed or created (files only, generated output excluded). */
  produced: string[];
}

const LIMITS = { executed: 10, usedScripts: 12, used: 12, produced: 20 } as const;
export const SCRIPT_FILE = /\.(?:py|sh|bash|zsh|sql|ts|tsx|mts|cts|js|mjs|cjs|rb|go|pl)$/i;
const GENERATED = /(?:^|\/)(?:__pycache__|node_modules|dist|build|\.next|\.turbo|\.devguard)\/|\.pyc$/;
const TEST_FILE = /(?:^|\/)(?:test_|tests?\/)|[._-](?:test|spec)\.[a-z]+$/i;
const VERIFY_HELPER = /(?:^|\/)(?:validate|check)[_-]?[\w-]*\.[a-z]+$/i;
/**
 * Disposable probes: a scratch/attempt/tmp directory segment, or a probe-named
 * file stem. Read once to look around, never the run's executor.
 */
const PROBE_DIR = /(?:^|[-_.])(?:attempts?|scratch|tmp|temp|probes?|sandbox)\d*(?:[-_.]|$)/i;
const PROBE_FILE = /^(?:probe|scratch|tmp|temp|debug|try|first[_-]?read|sandbox)(?:[_-]|\.|$)/i;
/** Verbs that make the previous run's executor the thing to run again. */
const RERUN_INTENT = /\b(?:execute|re-?run|resume|retry|rollback|roll back|re-?execute)\b|실행|재개|롤백/i;
/** Lineage files always offered (when present), whatever their size. */
export const LINEAGE_PLAN_LIMIT = 4;
/** Hard ceiling on lineage files, however small they are. */
export const LINEAGE_PLAN_MAX = 8;
/**
 * Estimated-token budget (file characters / 4, whole file — agents read
 * scripts whole) for the whole lineage plan. Files past LINEAGE_PLAN_LIMIT
 * join only while the plan stays inside it, so several small scripts can be
 * offered where one large one would not fit.
 */
export const LINEAGE_TOKEN_BUDGET = 12_000;
/** Scores at or above this are strong enough for a slot past LINEAGE_PLAN_LIMIT (an older executor qualifies; a demoted helper does not). */
const EXTRA_SLOT_MIN_SCORE = 3;

/**
 * Lineage of the task that is closing, from its own activity window. Only
 * the owning thread's events count when the owner is known; otherwise user
 * threads in the window. Undefined when nothing was observed.
 */
export async function collectExecutionLineage(
  root: string,
  input: { sinceIso: string; produced: string[]; ownerThreadHash?: string; source?: AgentActivitySource }
): Promise<ExecutionLineage | undefined> {
  const sinceMs = Date.parse(input.sinceIso);
  const produced = unique(input.produced.filter((file) => !GENERATED.test(file)));
  let executed: string[] = [];
  let reads: string[] = [];
  if (Number.isFinite(sinceMs)) {
    const snapshot = await (input.source ?? new CodexLocalActivitySource()).collect(root, sinceMs).catch(() => undefined);
    if (snapshot?.available) {
      const owned = input.ownerThreadHash ? snapshot.threads.filter((thread) => thread.ownerHash === input.ownerThreadHash) : [];
      const threads = new Set((owned.length > 0 ? owned : snapshot.threads.filter((thread) => thread.source === "user")).map((thread) => thread.thread));
      const events = snapshot.events.filter((event) => event.ts >= input.sinceIso && threads.has(event.thread));
      executed = unique(events.flatMap((event) => event.executedPaths ?? []));
      reads = unique(events.filter((event) => event.category === "CODE_READS" || event.category === "SEARCH").flatMap((event) => event.paths ?? []));
    }
  }
  const producedSet = new Set(produced);
  const notProduced = reads.filter((file) => !producedSet.has(file) && !GENERATED.test(file));
  const lineage: ExecutionLineage = {
    executed: executed.filter((file) => !GENERATED.test(file)).slice(0, LIMITS.executed),
    usedScripts: notProduced.filter((file) => SCRIPT_FILE.test(file) && !executed.includes(file)).slice(0, LIMITS.usedScripts),
    used: notProduced.filter((file) => !SCRIPT_FILE.test(file)).slice(0, LIMITS.used),
    produced: [...produced].sort((a, b) => Number(!SCRIPT_FILE.test(a)) - Number(!SCRIPT_FILE.test(b))).slice(0, LIMITS.produced)
  };
  return lineage.executed.length + lineage.usedScripts.length + lineage.used.length + lineage.produced.length > 0 ? lineage : undefined;
}

export interface PlannedLineageFile {
  path: string;
  kind: "executed" | "produced" | "used";
  /** Promote to TARGET: named by the task, or the previous executor of a task that runs it again. */
  target: boolean;
  score: number;
  /** From the last execution-bearing task before a script-less previous task, not the previous task itself. */
  older?: boolean;
  /** Whole-file estimated tokens (characters / 4). */
  estimatedTokens: number;
}

/**
 * The lineage a new task can inherit: the previous task's, and — only when
 * the previous task ran no script (e.g. a documentation step) and stayed in
 * its predecessor's workstream — the last execution-bearing task's before it.
 */
export interface LineageSources {
  recent?: ExecutionLineage;
  older?: ExecutionLineage;
}

/**
 * Executable lineage of the previous task, for the next task's plan — only
 * when the workstream gate passed, or a planned anchor (user input / TARGET)
 * sits with the lineage (same file or directory). Scripts only: the
 * previous task's documents and data already reach the plan as its prior
 * files and explicit inputs.
 *
 * Bounded: up to LINEAGE_PLAN_LIMIT files always, then up to
 * LINEAGE_PLAN_MAX while strong, same-workstream files fit
 * LINEAGE_TOKEN_BUDGET. An older executor (see LineageSources) is scored
 * below every direct lineage file of the same kind, so it never displaces
 * the previous task's own scripts.
 */
export async function planExecutionLineage(
  root: string,
  sources: LineageSources | ExecutionLineage | undefined,
  input: { planned: ReadonlySet<string>; anchors: readonly string[]; taskText: string; sameWorkstream: boolean; isExcluded: (path: string) => boolean; limit?: number; maxFiles?: number; tokenBudget?: number }
): Promise<PlannedLineageFile[]> {
  const { recent, older: olderLineage } = sources && "executed" in sources ? { recent: sources, older: undefined } : (sources ?? {});
  if (!recent && !olderLineage) return [];
  const recentFiles = recent ? [...recent.executed, ...recent.produced, ...recent.usedScripts] : [];
  const lineageDirs = new Set(recentFiles.map((file) => posix.dirname(file)));
  const anchored = input.anchors.some((anchor) => recentFiles.includes(anchor) || lineageDirs.has(posix.dirname(anchor)));
  if (!input.sameWorkstream && !anchored) return [];
  // An older task's lineage rides on workstream continuity only, never on a directory anchor.
  const older = input.sameWorkstream ? olderLineage : undefined;
  const taskText = input.taskText.toLowerCase();
  const mentionsTests = /\b(?:tests?|spec|pytest|unit test)\b|테스트/i.test(input.taskText);
  const mentionsValidation = /\bvalidat\w*|\bcheck\b|검증/i.test(input.taskText);
  const rerun = RERUN_INTENT.test(input.taskText);
  const anchorNames = input.anchors.map((anchor) => normalizeName(posix.basename(anchor)));
  const seen = new Set<string>();
  const scored: Array<Omit<PlannedLineageFile, "estimatedTokens">> = [];
  const consider = (path: string, kind: PlannedLineageFile["kind"], base: number, fromOlder = false) => {
    if (seen.has(path) || input.planned.has(path) || GENERATED.test(path) || !SCRIPT_FILE.test(path) || input.isExcluded(path)) return;
    seen.add(path);
    const name = posix.basename(path).toLowerCase();
    const namedByTask = taskText.includes(path.toLowerCase()) || (name.length >= 6 && taskText.includes(name));
    // Secondary hint only: the script's folder is named like a planned document.
    const dirName = normalizeName(posix.basename(posix.dirname(path)));
    const paired = dirName.length >= 6 && anchorNames.some((anchor) => anchor.includes(dirName));
    const demotion = isProbe(path) ? 6 : (TEST_FILE.test(path) && !mentionsTests) || (VERIFY_HELPER.test(path) && !mentionsValidation) ? 4 : 0;
    const score = base + (namedByTask ? 100 : 0) + (paired ? 2 : 0) - demotion;
    scored.push({ path, kind, target: namedByTask || (kind === "executed" && rerun && !fromOlder), score, ...(fromOlder ? { older: true } : {}) });
  };
  if (recent) {
    for (const file of recent.executed) consider(file, "executed", 6);
    for (const file of recent.produced) consider(file, "produced", 5);
    for (const file of recent.usedScripts) consider(file, "used", 4);
  }
  // Decayed: an older executor ranks below the previous task's own scripts.
  if (older) {
    for (const file of older.executed) consider(file, "executed", 3, true);
    for (const file of older.produced) consider(file, "produced", 2, true);
  }
  const limit = input.limit ?? LINEAGE_PLAN_LIMIT;
  const maxFiles = Math.max(limit, input.maxFiles ?? LINEAGE_PLAN_MAX);
  const budget = input.tokenBudget ?? LINEAGE_TOKEN_BUDGET;
  const planned: PlannedLineageFile[] = [];
  let plannedTokens = 0;
  for (const entry of scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))) {
    if (planned.length >= maxFiles) break;
    const extra = planned.length >= limit;
    if (extra && (!input.sameWorkstream || entry.score < EXTRA_SLOT_MIN_SCORE)) continue;
    const info = await stat(join(root, entry.path)).catch(() => undefined);
    if (!info?.isFile()) continue;
    const estimatedTokens = Math.ceil(info.size / 4);
    if (extra && plannedTokens + estimatedTokens > budget) continue;
    planned.push({ ...entry, estimatedTokens });
    plannedTokens += estimatedTokens;
  }
  return planned;
}

function isProbe(path: string): boolean {
  const segments = path.split("/");
  return PROBE_FILE.test(segments.at(-1) ?? "") || segments.slice(0, -1).some((segment) => PROBE_DIR.test(segment));
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]/g, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
