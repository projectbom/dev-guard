import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isDevGuardArtifactPath, isGeneratedArtifactPath } from "@dev-guard/core";

const execFileAsync = promisify(execFile);

/**
 * Upper bound on enumerated paths — a guard against pathological trees
 * (e.g. a vendored dependency dump outside node_modules), not a sampling
 * limit. Enumeration is metadata-only, so this is far above real projects
 * (25K source files enumerate in ~140-200 ms).
 */
export const MAX_ENUMERATED_FILES = 200_000;

export interface ProjectFileList {
  /** Repository-relative POSIX paths, sorted, generated/DevGuard paths removed. */
  files: string[];
  source: "git" | "walk";
  truncated: boolean;
}

/**
 * One enumeration of the project's files, shared by everything a
 * preparation run needs (Project Knowledge, its fingerprint, the Code Index
 * bootstrap) instead of each doing its own partial walk.
 *
 * Inside a git work tree this is `git ls-files --cached --others
 * --exclude-standard` minus deleted files: tracked plus untracked-but-not-
 * ignored, so `.gitignore` is honored — ignored secrets, local scratch
 * directories and build output never enter DevGuard's analysis. Outside git
 * (or if git is unavailable) it falls back to a plain directory walk with
 * DevGuard's generated-path exclusions. Benchmarked against the walk and
 * `fdir`: git is ~30% faster than the walk on 5K-25K files and needs no
 * dependency; fdir was faster still but only matters for the non-git
 * fallback, where it would save <150 ms at 25K files.
 */
export async function enumerateProjectFiles(root: string): Promise<ProjectFileList> {
  const fromGit = await gitFiles(root).catch(() => undefined);
  const raw = fromGit ?? (await walkFiles(root));
  const files = raw.filter((file) => !isGeneratedArtifactPath(file) && !isDevGuardArtifactPath(file));
  const truncated = files.length > MAX_ENUMERATED_FILES;
  return { files: (truncated ? files.slice(0, MAX_ENUMERATED_FILES) : files).sort(), source: fromGit ? "git" : "walk", truncated };
}

async function gitFiles(root: string): Promise<string[]> {
  const run = async (args: string[]) => {
    // -z: NUL-separated, so spaces, quotes and unicode names arrive verbatim.
    const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=off", "ls-files", "-z", ...args], { cwd: root, maxBuffer: 512 * 1024 * 1024 });
    return stdout.split("\0").filter(Boolean);
  };
  const [listed, deleted] = await Promise.all([run(["--cached", "--others", "--exclude-standard"]), run(["--deleted"])]);
  // --cached still lists tracked files deleted from the work tree.
  const gone = new Set(deleted);
  return [...new Set(listed)].filter((file) => !gone.has(file));
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (out.length > MAX_ENUMERATED_FILES) return;
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isGeneratedArtifactPath(entry.name) && !isDevGuardArtifactPath(entry.name)) await visit(rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  await visit("");
  return out;
}

/**
 * Picks up to `limit` items spread round-robin across groups (e.g. workspace
 * packages or top-level directories), keeping each group's own order. Used
 * wherever analysis must read file CONTENT under a budget, so a large
 * project yields a representative sample instead of the first N files of
 * whichever directory sorts first.
 */
export function spreadAcross<T>(items: T[], limit: number, groupOf: (item: T) => string): T[] {
  if (items.length <= limit) return items;
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = groupOf(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  const buckets = [...groups.values()];
  const picked: T[] = [];
  for (let round = 0; picked.length < limit; round += 1) {
    let any = false;
    for (const bucket of buckets) {
      if (round < bucket.length) {
        picked.push(bucket[round]);
        any = true;
        if (picked.length >= limit) break;
      }
    }
    if (!any) break;
  }
  return picked;
}

/** Group key: the deepest of `roots` containing `file`, else its top-level directory. */
export function groupByRoots(roots: string[]): (file: string) => string {
  const sorted = [...roots].sort((a, b) => b.length - a.length);
  return (file: string) => sorted.find((root) => file.startsWith(`${root}/`)) ?? (file.includes("/") ? file.slice(0, file.indexOf("/")) : ".");
}

/** Bounded-concurrency map preserving input order (I/O-bound content reads). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
