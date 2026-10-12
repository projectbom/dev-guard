// Tier 1 of task routing in large repositories: a path-only ("shallow") view
// of EVERY project file, used to find task-relevant files that sit outside
// the bounded deep Code Index (~1,200 representative files with content,
// symbols and tokens). Built per call from the same git-aware enumeration the
// rest of DevGuard uses — no file content is read here. Only the few
// best-scoring paths are then read lazily and scored by the normal deep
// ranking, so a weak path match can never be promoted on its own.

/** Path segments too common to say anything about a task. */
const GENERIC_TERMS = new Set([
  "src", "lib", "app", "apps", "packages", "package", "index", "main", "components", "component", "utils", "util", "helpers",
  "test", "tests", "spec", "specs", "page", "route", "layout", "types", "type", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json",
  "md", "mdx", "sql", "yaml", "yml", "sh", "dist", "build", "public", "assets", "common", "shared", "core", "modules", "features"
]);

export interface ShallowCandidate {
  path: string;
  score: number;
  matched: string[];
}

interface PathTerms {
  base: Set<string>;
  dirs: Set<string>;
}

function termsOf(text: string): string[] {
  const words = text
    .replace(/\.[A-Za-z0-9]+$/, "")
    .split(/[^A-Za-z0-9가-힣]+/)
    .filter(Boolean);
  const terms: string[] = [];
  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower.length >= 3) terms.push(lower);
    // camelCase and letter/digit boundaries: "invoiceReconcile2" -> invoice, reconcile
    const parts = word.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/);
    if (parts.length > 1) for (const part of parts) if (part.length >= 3 && !/^\d+$/.test(part)) terms.push(part.toLowerCase());
  }
  return terms.filter((term) => !GENERIC_TERMS.has(term));
}

function pathTerms(path: string): PathTerms {
  const slash = path.lastIndexOf("/");
  return { base: new Set(termsOf(path.slice(slash + 1))), dirs: new Set(termsOf(slash > 0 ? path.slice(0, slash) : "")) };
}

/**
 * Exact, or a shared stem of at least 5 letters ("reconcile" ~
 * "reconciliation", "purged" ~ "purge"). Numbered names ("Widget1530") only
 * match exactly — "widget" must not hit every unique numbered variant.
 */
function termMatches(taskToken: string, term: string): boolean {
  if (taskToken === term) return true;
  if (taskToken.length < 5 || term.length < 5 || /\d/.test(taskToken) || /\d/.test(term)) return false;
  const stem = Math.min(taskToken.length, term.length, 7);
  return taskToken.slice(0, stem) === term.slice(0, stem) && Math.abs(taskToken.length - term.length) <= 5;
}

/**
 * Ranks every enumerated path by filename/path-term overlap with the task,
 * weighting each filename term by its rarity across all filenames (a term in
 * hundreds of filenames — "page", "widget" — contributes nothing). A path
 * qualifies only with a filename match; directory terms add a little. The
 * caller reads and deep-scores the top few.
 */
export function rankShallowCandidates(files: string[], taskTokens: Iterable<string>, options: { skip: (path: string) => boolean; limit: number }): ShallowCandidate[] {
  const tokens = [...new Set([...taskTokens].map((token) => token.toLowerCase()).filter((token) => token.length >= 3 && !GENERIC_TERMS.has(token)))];
  if (tokens.length === 0 || files.length === 0) return [];
  const parsed = files.map((path) => ({ path, terms: pathTerms(path) }));
  const baseFrequency = new Map<string, number>();
  for (const { terms } of parsed) for (const term of terms.base) baseFrequency.set(term, (baseFrequency.get(term) ?? 0) + 1);
  const commonCutoff = Math.max(50, Math.round(files.length * 0.005));
  const rarity = (term: string) => {
    const df = baseFrequency.get(term) ?? 0;
    return df <= 3 ? 3 : df <= 20 ? 2 : df <= commonCutoff ? 1 : 0;
  };
  const candidates: ShallowCandidate[] = [];
  for (const { path, terms } of parsed) {
    let baseScore = 0;
    let dirScore = 0;
    const matched: string[] = [];
    for (const token of tokens) {
      let best = 0;
      for (const term of terms.base) if (termMatches(token, term)) best = Math.max(best, rarity(term));
      if (best > 0) {
        baseScore += best * 2;
        matched.push(token);
        continue;
      }
      for (const term of terms.dirs) {
        if (termMatches(token, term)) {
          dirScore += 1;
          matched.push(token);
          break;
        }
      }
    }
    // A single medium-rare filename term is not enough on its own.
    if (baseScore < 4) continue;
    if (options.skip(path)) continue;
    candidates.push({ path, score: baseScore + Math.min(dirScore, 3), matched });
  }
  return candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, options.limit);
}
