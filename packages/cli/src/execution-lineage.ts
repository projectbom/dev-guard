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
const TEST_HELPER = /(?:^|\/)(?:test_|tests?\/)|[._-](?:test|spec)\.[a-z]+$|(?:^|\/)(?:validate|check)[_-]?[\w-]*\.[a-z]+$/i;
/** Verbs that make the previous run's executor the thing to run again. */
const RERUN_INTENT = /\b(?:execute|re-?run|resume|retry|rollback|roll back|re-?execute)\b|실행|재개|롤백/i;
export const LINEAGE_PLAN_LIMIT = 4;

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
}

/**
 * Executable lineage of the previous task, for the next task's plan — only
 * when the workstream gate passed, or a planned anchor (user input / TARGET)
 * sits with the lineage (same file or directory). Scripts only: the
 * previous task's documents and data already reach the plan as its prior
 * files and explicit inputs.
 */
export async function planExecutionLineage(
  root: string,
  lineage: ExecutionLineage | undefined,
  input: { planned: ReadonlySet<string>; anchors: readonly string[]; taskText: string; sameWorkstream: boolean; isExcluded: (path: string) => boolean; limit?: number }
): Promise<PlannedLineageFile[]> {
  if (!lineage) return [];
  const lineageFiles = [...lineage.executed, ...lineage.produced, ...lineage.usedScripts];
  const lineageDirs = new Set(lineageFiles.map((file) => posix.dirname(file)));
  const anchored = input.anchors.some((anchor) => lineageFiles.includes(anchor) || lineageDirs.has(posix.dirname(anchor)));
  if (!input.sameWorkstream && !anchored) return [];
  const taskText = input.taskText.toLowerCase();
  const mentionsTests = /\b(?:tests?|spec|validat\w*)\b|테스트|검증/i.test(input.taskText);
  const rerun = RERUN_INTENT.test(input.taskText);
  const anchorNames = input.anchors.map((anchor) => normalizeName(posix.basename(anchor)));
  const seen = new Set<string>();
  const scored: PlannedLineageFile[] = [];
  const consider = (path: string, kind: PlannedLineageFile["kind"], base: number) => {
    if (seen.has(path) || input.planned.has(path) || GENERATED.test(path) || !SCRIPT_FILE.test(path) || input.isExcluded(path)) return;
    seen.add(path);
    const name = posix.basename(path).toLowerCase();
    const namedByTask = taskText.includes(path.toLowerCase()) || (name.length >= 6 && taskText.includes(name));
    // Secondary hint only: the script's folder is named like a planned document.
    const dirName = normalizeName(posix.basename(posix.dirname(path)));
    const paired = dirName.length >= 6 && anchorNames.some((anchor) => anchor.includes(dirName));
    const score = base + (namedByTask ? 100 : 0) + (paired ? 2 : 0) - (TEST_HELPER.test(path) && !mentionsTests ? 4 : 0);
    scored.push({ path, kind, target: namedByTask || (kind === "executed" && rerun), score });
  };
  for (const file of lineage.executed) consider(file, "executed", 6);
  for (const file of lineage.produced) consider(file, "produced", 5);
  for (const file of lineage.usedScripts) consider(file, "used", 4);
  const existing: PlannedLineageFile[] = [];
  for (const entry of scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))) {
    if (existing.length >= (input.limit ?? LINEAGE_PLAN_LIMIT)) break;
    const info = await stat(join(root, entry.path)).catch(() => undefined);
    if (info?.isFile()) existing.push(entry);
  }
  return existing;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]/g, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
