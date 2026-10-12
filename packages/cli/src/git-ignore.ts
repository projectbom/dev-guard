// Keeps DevGuard's machine-local state out of Git on the zero-setup first
// run: `.devguard/` (runtime state, indexes, logs) and `devguard.backup-*/`
// (legacy-directory migration backups). Project integration files —
// AGENTS.md, CLAUDE.md, .mcp.json, .codex/config.toml — are deliberately
// NOT ignored: teams may commit and share them.
//
// Ownership is minimal: Git itself decides whether a rule is already
// effective (`git check-ignore`), so an equivalent user rule (`/.devguard`,
// `.devguard/**`, a global excludes file) is never duplicated; missing
// rules are APPENDED — existing bytes, order, comments and line endings are
// never rewritten. Outside a Git work tree nothing is written. A tracked
// `.devguard/` is reported, never untracked: the Git index is not touched.
import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEVGUARD_IGNORE_HEADER = "# DevGuard local state";
/** Each rule with a representative path Git is asked about. */
const RULES: Array<{ rule: string; probe: string }> = [
  { rule: ".devguard/", probe: ".devguard/runtime.json" },
  { rule: "devguard.backup-*/", probe: "devguard.backup-20260101-000000/state.json" }
];

export interface GitIgnoreResult {
  /** not-git: no Git work tree, nothing written. */
  status: "not-git" | "created" | "added" | "already-ignored";
  /** Rules this run added (or, in a dry run, would add). */
  added: string[];
  /** Files under `.devguard/` already in the Git index (left untouched). */
  trackedDevguardFiles: number;
  warning?: string;
}

export function trackedDevguardWarning(count: number): string {
  return `.devguard/ is already tracked by Git (${count} file${count === 1 ? "" : "s"}). DevGuard will not modify the index automatically. To stop tracking it yourself: git rm -r --cached .devguard`;
}

export async function ensureDevguardGitIgnore(root: string, options: { dryRun?: boolean } = {}): Promise<GitIgnoreResult> {
  if (!(await isGitWorkTree(root))) return { status: "not-git", added: [], trackedDevguardFiles: 0 };
  const missing: string[] = [];
  for (const { rule, probe } of RULES) {
    if (!(await isIgnored(root, probe))) missing.push(rule);
  }
  const tracked = await trackedDevguardFileCount(root);
  const warning = tracked > 0 ? trackedDevguardWarning(tracked) : undefined;
  if (missing.length === 0) return { status: "already-ignored", added: [], trackedDevguardFiles: tracked, ...(warning ? { warning } : {}) };

  const path = join(root, ".gitignore");
  const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!options.dryRun) await appendFile(path, appendedText(existing, missing));
  return { status: existing === undefined ? "created" : "added", added: missing, trackedDevguardFiles: tracked, ...(warning ? { warning } : {}) };
}

/** The exact text appended after `existing` (undefined = new file). */
export function appendedText(existing: string | undefined, rules: string[]): string {
  const eol = existing?.includes("\r\n") ? "\r\n" : "\n";
  const lines = [...(existing?.includes(DEVGUARD_IGNORE_HEADER) ? [] : [DEVGUARD_IGNORE_HEADER]), ...rules];
  if (existing === undefined || existing.length === 0) return lines.join(eol) + eol;
  const separator = existing.endsWith("\n") ? (existing.endsWith(`${eol}${eol}`) || existing.trim() === "" ? "" : eol) : eol + eol;
  return separator + lines.join(eol) + eol;
}

async function isGitWorkTree(root: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

// `--no-index`: judge the ignore RULES even for paths already tracked.
async function isIgnored(root: string, path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--no-index", "--", path], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

async function trackedDevguardFileCount(root: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--", ".devguard"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    return stdout.split("\0").filter(Boolean).length;
  } catch {
    return 0;
  }
}
