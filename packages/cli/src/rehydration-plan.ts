/**
 * Rehydration read plan: the files a fresh agent thread must read to pick up
 * a task, as ONE list.
 *
 * Real Codex sessions spent 27–86K estimated tokens in the first two minutes
 * of every fresh thread batch-reading previous-phase documents, evidence JSON
 * and collector scripts. Three causes, each handled here:
 *
 * - The user's own "read first" file list never reached DevGuard (agents
 *   summarized the request), so DevGuard ranked blind and the agent read
 *   both lists. Explicit inputs are validated here and become TARGETs.
 * - The scripts the previous step ran were named in its evidence files
 *   (`inputFiles[].path`, `executedCollector.path`, ...) but never suggested.
 *   One-hop references from structured TARGETs are extracted here — one hop
 *   only, never a crawl.
 * - Ranges too short to carry a phase's conclusion were ignored and the
 *   whole file re-read. Small TARGET documents are planned as WHOLE_FILE.
 *
 * Estimates are characters / 4 over the planned files/ranges — never a
 * provider token count.
 */
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";

export const EXPLICIT_INPUT_LIMIT = 40;
export const REFERENCE_LIMIT = 4;
const CHARS_PER_TOKEN = 4;
/** Below these sizes a TARGET document is cheaper to read once, whole, than as sections an agent will not trust. */
export const WHOLE_FILE_MARKDOWN_TOKENS = 4000;
export const WHOLE_FILE_JSON_TOKENS = 2500;
const MAX_REFERENCE_FILE_BYTES = 1024 * 1024;
const MAX_SCANNED_DOCUMENT_CHARS = 2_000_000;

const PATH_SHAPE = /^(?:\.\/)?[A-Za-z0-9_.()@+-]+(?:\/[A-Za-z0-9_.()@+-]+)+\.[A-Za-z0-9]{1,8}$/;
const PATH_IN_TEXT = /[A-Za-z0-9_.()@+-]+(?:\/[A-Za-z0-9_.()@+-]+)+\.[A-Za-z0-9]{1,8}/g;
/** JSON keys whose string values name files (leaf key, or the key holding the array/object the value sits in). */
const FILE_KEY = /(?:path|file|script|source|artifact|input|output|evidence|collector|executor|runner|required|reference|document|doc)s?$/i;
/** Keys naming what a step consumed or ran. Not "source": it is just as often a provenance/audit list. */
const INPUT_KEY = /input|read|require|depend|uses?$|collector|executor|runner|script/i;
const TEST_HELPER = /(?:^|\/)(?:test_|tests?\/)|[._-](?:test|spec)\.[a-z]+$|(?:^|\/)(?:validate|check)[_-]?[\w-]*\.[a-z]+$/i;
/** Below this a reference is not worth a slot (e.g. one entry of a long audit list with no other signal). */
const MIN_REFERENCE_SCORE = 4;
const SCRIPT_EXTENSION = /\.(?:py|sql|sh|bash|zsh|ts|tsx|mts|cts|js|mjs|cjs|go|rb|rs|java|kt|php|ps1)$/i;
const BINARY_EXTENSION = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|tar|bz2|xz|7z|woff2?|ttf|eot|otf|mp[34]|mov|wav|bin|exe|dll|so|dylib|jar|class|wasm|sqlite3?|db|lockb)$/i;

export type ContextFileSource = "explicit-user-input" | "task-path" | "reference" | "execution-lineage";

export interface ExplicitInputResolution {
  accepted: string[];
  warnings: string[];
}

/** repo-relative, forward slashes, no leading "./"; undefined when not a usable in-repo path. */
function normalizeRepoPath(root: string, raw: string): { path?: string; problem?: string } {
  let value = raw.trim().replace(/^[`'"<(]+|[`'">),.;:]+$/g, "").replace(/\\/g, "/");
  if (!value) return { problem: "empty" };
  if (isAbsolute(value)) {
    const rel = relative(resolve(root), value).replace(/\\/g, "/");
    if (!rel || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) return { problem: "outside the repository" };
    value = rel;
  }
  value = value.replace(/^\.\//, "");
  if (value.split("/").includes("..")) return { problem: "path traversal" };
  return { path: posix.normalize(value) };
}

async function insideRealRoot(root: string, path: string): Promise<boolean> {
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(resolve(root, path))]);
    const rel = relative(realRoot, realFile);
    return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * Validates the files the user named. Only repo-relative paths are kept
 * (never the prompt): a missing file, a directory, a path outside the
 * repository (including via symlink) or a generated/ignored path is
 * reported in `warnings` and never promoted to context.
 */
export async function resolveExplicitInputs(root: string, inputs: readonly string[], isExcluded: (path: string) => boolean): Promise<ExplicitInputResolution> {
  const accepted: string[] = [];
  const warnings: string[] = [];
  const shown = (raw: string) => (raw.length > 80 ? `${raw.slice(0, 77)}...` : raw);
  for (const raw of inputs) {
    const { path, problem } = normalizeRepoPath(root, raw);
    if (!path) {
      warnings.push(`Explicit input \`${shown(raw)}\` ignored: ${problem}.`);
      continue;
    }
    if (accepted.includes(path)) continue;
    if (isExcluded(path)) {
      warnings.push(`Explicit input \`${path}\` ignored: generated or ignored path.`);
      continue;
    }
    const stats = await stat(resolve(root, path)).catch(() => undefined);
    if (!stats) {
      warnings.push(`Explicit input \`${path}\` not found in the repository.`);
      continue;
    }
    if (stats.isDirectory()) {
      warnings.push(`Explicit input \`${path}\` is a directory — pass the files under it individually.`);
      continue;
    }
    if (!stats.isFile() || !(await insideRealRoot(root, path))) {
      warnings.push(`Explicit input \`${path}\` ignored: not a regular file inside the repository.`);
      continue;
    }
    if (accepted.length >= EXPLICIT_INPUT_LIMIT) {
      warnings.push(`More than ${EXPLICIT_INPUT_LIMIT} explicit inputs; the rest were not planned.`);
      break;
    }
    accepted.push(path);
  }
  return { accepted, warnings };
}

interface RawReference {
  raw: string;
  /** Where in the source it was found, e.g. `executedCollector.path` or `inputFiles[].path`. */
  at: string;
  /** A single role-named reference (not one entry of a list). */
  named: boolean;
  inputLike: boolean;
  /** Entries in the list it came from (0 for a single reference). */
  listSize: number;
}

/** Path references a structured document makes — JSON values under file-like keys, path-shaped tokens in Markdown. */
export function extractPathReferences(path: string, content: string): RawReference[] {
  if (!content || content.length > MAX_SCANNED_DOCUMENT_CHARS) return [];
  if (/\.json$/i.test(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return [];
    }
    const found: RawReference[] = [];
    const walk = (value: unknown, keys: string[], listSize: number) => {
      if (found.length > 2000) return;
      if (Array.isArray(value)) {
        for (const item of value) walk(item, [...keys, "[]"], value.length);
        return;
      }
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) walk(child, [...keys, key], listSize);
        return;
      }
      if (typeof value !== "string" || !PATH_SHAPE.test(value.trim())) return;
      const named = keys.filter((key) => key !== "[]");
      const leaf = named.at(-1) ?? "";
      const parent = named.at(-2) ?? "";
      if (!FILE_KEY.test(leaf) && !FILE_KEY.test(parent)) return;
      found.push({ raw: value.trim(), at: keys.join(".").replace(/\.\[\]/g, "[]"), named: listSize === 0, inputLike: INPUT_KEY.test(leaf) || INPUT_KEY.test(parent), listSize });
    };
    walk(parsed, [], 0);
    return found;
  }
  if (/\.mdx?$/i.test(path)) {
    const mentioned = [...new Set(content.match(PATH_IN_TEXT) ?? [])];
    return mentioned.map((raw) => ({ raw, at: "document text", named: false, inputLike: false, listSize: mentioned.length }));
  }
  return [];
}

export interface PlannedReference {
  path: string;
  /** Structured documents that name it. */
  sources: string[];
  /** Where in the first source it appears. */
  at: string;
  /** The task text names the file itself (path or file name). */
  namedByTask: boolean;
  score: number;
}

/**
 * One hop of references out of the given structured documents: real,
 * in-repository, non-generated, non-binary files not already planned.
 * Ranked by evidence a fresh thread will need it — named by the task, a
 * single role-named reference (`collector.path`), an executable script,
 * an input-like key, named by several sources, a sibling of its source.
 */
export async function planReferences(
  root: string,
  sources: ReadonlyArray<{ path: string; content: string }>,
  input: { planned: ReadonlySet<string>; taskText: string; isExcluded: (path: string) => boolean; limit?: number }
): Promise<PlannedReference[]> {
  const byPath = new Map<string, { sources: Set<string>; at: string; named: boolean; inputLike: boolean; listSize: number }>();
  const usable = new Map<string, boolean>();
  const isUsable = async (path: string) => {
    if (!usable.has(path)) {
      const stats = BINARY_EXTENSION.test(path) || input.isExcluded(path) ? undefined : await stat(resolve(root, path)).catch(() => undefined);
      usable.set(path, Boolean(stats?.isFile() && stats.size <= MAX_REFERENCE_FILE_BYTES && (await insideRealRoot(root, path))));
    }
    return usable.get(path) === true;
  };
  for (const source of sources) {
    for (const reference of extractPathReferences(source.path, source.content)) {
      // Repo-relative first (how evidence files record paths), then relative to the document itself.
      const interpretations = [normalizeRepoPath(root, reference.raw).path, isAbsolute(reference.raw) ? undefined : normalizeRepoPath(root, posix.join(posix.dirname(source.path), reference.raw)).path];
      let path: string | undefined;
      for (const candidate of interpretations) {
        if (candidate && (await isUsable(candidate))) {
          path = candidate;
          break;
        }
      }
      if (!path || path === source.path || input.planned.has(path)) continue;
      const entry = byPath.get(path) ?? { sources: new Set<string>(), at: reference.at, named: false, inputLike: false, listSize: reference.listSize };
      entry.sources.add(source.path);
      entry.named ||= reference.named;
      entry.inputLike ||= reference.inputLike;
      entry.listSize = Math.min(entry.listSize, reference.listSize);
      byPath.set(path, entry);
    }
  }
  const taskText = input.taskText.toLowerCase();
  const scored: PlannedReference[] = [];
  for (const [path, entry] of byPath) {
    const fileName = posix.basename(path).toLowerCase();
    const namedByTask = taskText.includes(path.toLowerCase()) || (fileName.length >= 6 && taskText.includes(fileName));
    const sibling = [...entry.sources].some((source) => posix.dirname(source) === posix.dirname(path));
    const script = SCRIPT_EXTENSION.test(path);
    const sourceDirs = new Set([...entry.sources].map((source) => posix.dirname(source)));
    // One entry of a long list says little on its own; a short list or a
    // single role-named reference (`executedCollector.path`) says a lot.
    const listWeight = entry.named ? 5 : entry.listSize <= 5 ? 2 : entry.listSize <= 15 ? 1 : entry.listSize <= 40 ? 0 : -2;
    const score =
      (namedByTask ? 100 : 0) +
      listWeight +
      (script ? 3 : 0) +
      (entry.inputLike ? 2 : 0) +
      (sourceDirs.size > 1 ? 2 : 0) +
      (sibling ? (script ? 2 : 1) : 0) -
      (TEST_HELPER.test(path) && !/\b(?:tests?|spec|validat\w*)\b|테스트|검증/i.test(taskText) ? 3 : 0);
    if (score < MIN_REFERENCE_SCORE) continue;
    scored.push({ path, sources: [...entry.sources], at: entry.at, namedByTask, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, input.limit ?? REFERENCE_LIMIT);
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimated tokens of the given 1-based inclusive line ranges of `content` (overlaps counted once). */
export function estimateRangeTokens(content: string, ranges: ReadonlyArray<{ startLine: number; endLine: number }>): number {
  if (!content) return 0;
  const lines = content.split(/\r?\n/);
  const seen = new Set<number>();
  let chars = 0;
  for (const range of ranges) {
    for (let line = Math.max(1, range.startLine); line <= Math.min(lines.length, range.endLine); line += 1) {
      if (seen.has(line)) continue;
      seen.add(line);
      chars += lines[line - 1].length + 1;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** A TARGET document small enough that one whole read beats sections (which agents re-read whole anyway). */
export function wholeFileEligible(path: string, content: string): boolean {
  if (!content.trim()) return false;
  const tokens = estimateTextTokens(content);
  if (/\.mdx?$/i.test(path)) return tokens <= WHOLE_FILE_MARKDOWN_TOKENS;
  if (/\.json$/i.test(path)) return tokens <= WHOLE_FILE_JSON_TOKENS;
  if (SCRIPT_RANGE_FILE.test(path)) return tokens <= WHOLE_FILE_SCRIPT_TOKENS;
  return false;
}

/**
 * Scripts DevGuard plans by structure (def/function/statement sections),
 * not by the Code Index. Measured on PartnerFlow's 151 infra scripts: p50
 * ~1.4K, p75 ~3.2K, p90 ~5.1K, max ~12K estimated tokens — so a script up
 * to ~p75 is read once, whole; a larger one by its relevant sections.
 */
export const SCRIPT_RANGE_FILE = /\.(?:py|sh|bash|zsh|sql|rb)$/i;
export const WHOLE_FILE_SCRIPT_TOKENS = 3000;

export function isStructuredDocument(path: string): boolean {
  return /\.(?:mdx?|json)$/i.test(path);
}
