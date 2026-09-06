import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ChangeFile, ChangeFileStatus } from "@dev-guard/core";

const execFileAsync = promisify(execFile);

// Kept intentionally independent from runtime-state.ts's isIgnoredWatchPath
// (importing it here would create a circular dependency, since runtime-state.ts
// imports this module). These paths are excluded from the content fingerprint
// below unconditionally — not only via the project's own .gitignore — because
// .devguard/ specifically is written to by DevGuard itself (e.g. every
// recorded evidence updates runtime.json); if it were included, recording
// evidence would immediately change the fingerprint it was just stamped
// with. Keep this list conceptually in sync with isIgnoredWatchPath.
const CONTENT_HASH_EXCLUDE_PATHSPECS = [".devguard", "node_modules", ".next", "dist", "build", "coverage", ".turbo", "*.tsbuildinfo"];

export interface GitChanges {
  changedFiles: string[];
  changeFiles: ChangeFile[];
  diffText: string;
  workingTreeDiffText: string;
  stagedDiffText: string;
}

export async function getChangedFiles(cwd: string): Promise<string[]> {
  const changes = await getGitChanges(cwd);
  return changes.changedFiles;
}

export async function getDiff(cwd: string): Promise<string> {
  const changes = await getGitChanges(cwd);
  return changes.diffText;
}

export async function getProjectFiles(cwd: string): Promise<string[]> {
  await assertGitRepo(cwd);
  const output = await git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard"]);

  return [...new Set(output.split("\n").map((line) => line.trim()).filter(Boolean))]
    .filter(isProjectFile)
    .sort()
    .slice(0, 500);
}

export async function getGitIdentity(cwd: string): Promise<{ gitHead: string; gitBranch: string }> {
  await assertGitRepo(cwd);
  const [gitHead, gitBranch] = await Promise.all([
    git(cwd, ["rev-parse", "--short", "HEAD"]).catch(() => ""),
    git(cwd, ["branch", "--show-current"]).catch(() => "")
  ]);

  return {
    gitHead: gitHead.trim(),
    gitBranch: gitBranch.trim()
  };
}

export async function getGitRemoteOrigin(cwd: string): Promise<string> {
  await assertGitRepo(cwd);
  return (await git(cwd, ["config", "--get", "remote.origin.url"]).catch(() => "")).trim();
}

export async function hasGitBaseline(cwd: string): Promise<boolean> {
  await assertGitRepo(cwd);
  return git(cwd, ["rev-parse", "--verify", "HEAD"]).then(() => true).catch(() => false);
}

/**
 * A content-addressed fingerprint of the effective current working tree
 * (HEAD, overlaid with staged, unstaged, and untracked changes — restricted
 * to non-ignored, non-DevGuard-noise paths), independent of which commit
 * HEAD happens to be. Two states with byte-identical resulting file content
 * produce the same hash even if one is a clean commit and the other is the
 * same content sitting uncommitted in the working tree — history and
 * content identity are deliberately different questions (see getGitIdentity
 * for the former).
 *
 * Implemented with git's own plumbing rather than reading file contents
 * ourselves: a disposable temporary index (via GIT_INDEX_FILE) is seeded
 * from HEAD's tree, then `git add -A` overlays the current working tree
 * (staged + unstaged + untracked, respecting .gitignore) onto it, noise
 * paths are unstaged from that temp index with `git rm --cached`, and
 * `git write-tree` returns the resulting tree object's SHA — a pure content
 * hash. This never touches the real index or working directory, so it is
 * safe to call concurrently with other git operations. It does write a
 * (small, garbage-collectable) tree/blob object into .git/objects, the same
 * way `git stash` or `git add` normally would.
 *
 * Noise exclusion deliberately runs as a separate `git rm --cached` pass
 * rather than negative pathspecs on `git add` (e.g. `:!.devguard`): git
 * treats a pathspec that names an already-gitignored path as an error
 * ("paths are ignored by one of your .gitignore files"), even when the
 * pathspec is negative — so passing `:!.devguard` to `add` fails outright
 * on the very common setup where `.devguard/` is itself gitignored.
 * `git rm --cached` has no such restriction.
 *
 * Returns undefined for non-git projects or if git plumbing fails for any
 * reason — callers must fall back to a weaker signal, never throw.
 */
export async function computeWorkingTreeContentHash(cwd: string): Promise<string | undefined> {
  let hasHead: boolean;
  try {
    hasHead = await hasGitBaseline(cwd);
  } catch {
    return undefined;
  }
  const tempIndexPath = join(tmpdir(), `devguard-idx-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: tempIndexPath };
  try {
    if (hasHead) {
      await execFileAsync("git", ["read-tree", "HEAD"], { cwd, env });
    }
    await execFileAsync("git", ["add", "-A", "--", "."], { cwd, env });
    await execFileAsync("git", ["rm", "--cached", "-r", "--ignore-unmatch", "-q", "--", ...CONTENT_HASH_EXCLUDE_PATHSPECS], { cwd, env });
    const { stdout } = await execFileAsync("git", ["write-tree"], { cwd, env });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  } finally {
    await rm(tempIndexPath, { force: true }).catch(() => undefined);
  }
}

export async function getGitChanges(cwd: string): Promise<GitChanges> {
  await assertGitRepo(cwd);

  const [
    workingTreeNameOnly,
    workingTreeNameStatus,
    stagedNameOnly,
    stagedNameStatus,
    untrackedOutput,
    workingTreeDiffText,
    stagedDiffText
  ] = await Promise.all([
    git(cwd, ["diff", "--name-only"]),
    git(cwd, ["diff", "--name-status", "-M"]),
    git(cwd, ["diff", "--cached", "--name-only"]),
    git(cwd, ["diff", "--cached", "--name-status", "-M"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard"]),
    git(cwd, ["diff"]),
    git(cwd, ["diff", "--cached"])
  ]);

  const changeFiles = [
    ...mergeNameOnlyFallback(parseNameStatus(workingTreeNameStatus, "workingTree"), workingTreeNameOnly, "workingTree"),
    ...mergeNameOnlyFallback(parseNameStatus(stagedNameStatus, "staged"), stagedNameOnly, "staged"),
    ...parseUntracked(untrackedOutput)
  ];
  const changedFiles = [...new Set(changeFiles.map((file) => file.path))].sort();
  const untrackedSummary = parseUntracked(untrackedOutput)
    .map((file) => `Untracked file: ${file.path} - 새 파일 생성됨`)
    .join("\n");
  const diffText = [workingTreeDiffText, stagedDiffText, untrackedSummary].filter((text) => text.trim().length > 0).join("\n\n");

  return {
    changedFiles,
    changeFiles,
    diffText,
    workingTreeDiffText,
    stagedDiffText
  };
}

export async function getStagedGitChanges(cwd: string): Promise<GitChanges> {
  await assertGitRepo(cwd);
  const [stagedNameOnly, stagedNameStatus, stagedDiffText] = await Promise.all([
    git(cwd, ["diff", "--cached", "--name-only"]),
    git(cwd, ["diff", "--cached", "--name-status", "-M"]),
    git(cwd, ["diff", "--cached"])
  ]);
  const changeFiles = mergeNameOnlyFallback(parseNameStatus(stagedNameStatus, "staged"), stagedNameOnly, "staged");
  const changedFiles = [...new Set(changeFiles.map((file) => file.path))].sort();

  return {
    changedFiles,
    changeFiles,
    diffText: stagedDiffText,
    workingTreeDiffText: "",
    stagedDiffText
  };
}

export async function getCommitGitChanges(cwd: string, ref: string): Promise<GitChanges> {
  await assertGitRepo(cwd);
  const range = `${ref}..HEAD`;
  const [nameOnly, nameStatus, diffText] = await Promise.all([
    git(cwd, ["diff", "--name-only", range]),
    git(cwd, ["diff", "--name-status", "-M", range]),
    git(cwd, ["diff", range])
  ]);
  const changeFiles = mergeNameOnlyFallback(parseNameStatus(nameStatus, "workingTree"), nameOnly, "workingTree");
  const changedFiles = [...new Set(changeFiles.map((file) => file.path))].sort();

  return {
    changedFiles,
    changeFiles,
    diffText,
    workingTreeDiffText: diffText,
    stagedDiffText: ""
  };
}

export async function getDiffForChangeFiles(
  cwd: string,
  changeFiles: ChangeFile[],
  options: { stagedOnly?: boolean; commitRef?: string } = {}
): Promise<string> {
  await assertGitRepo(cwd);
  const paths = [...new Set(changeFiles.flatMap((file) => [file.path, file.oldPath].filter((path): path is string => Boolean(path))))].sort();
  if (paths.length === 0) {
    return "";
  }

  if (options.commitRef) {
    return git(cwd, ["diff", `${options.commitRef}..HEAD`, "--", ...paths]);
  }

  if (options.stagedOnly) {
    return git(cwd, ["diff", "--cached", "--", ...paths]);
  }

  const workingTreePaths = changeFiles.filter((file) => file.source === "workingTree").map((file) => file.path);
  const stagedPaths = changeFiles.filter((file) => file.source === "staged").map((file) => file.path);
  const untrackedSummary = changeFiles
    .filter((file) => file.source === "untracked")
    .map((file) => `Untracked file: ${file.path} - 새 파일 생성됨`)
    .join("\n");
  const [workingTreeDiff, stagedDiff] = await Promise.all([
    workingTreePaths.length > 0 ? git(cwd, ["diff", "--", ...workingTreePaths]) : Promise.resolve(""),
    stagedPaths.length > 0 ? git(cwd, ["diff", "--cached", "--", ...stagedPaths]) : Promise.resolve("")
  ]);

  return [workingTreeDiff, stagedDiff, untrackedSummary].filter((text) => text.trim().length > 0).join("\n\n");
}

function isProjectFile(path: string): boolean {
  if (
    path.startsWith("node_modules/") ||
    path.startsWith(".next/") ||
    path.startsWith("dist/") ||
    path.startsWith("build/") ||
    path.startsWith("coverage/")
  ) {
    return false;
  }

  if (/^(package-lock|pnpm-lock|yarn)\.json$/.test(path) || path === "pnpm-lock.yaml" || path === "yarn.lock") {
    return false;
  }

  if (/\.(png|jpe?g|gif|webp|avif|ico|svg|ttf|otf|woff2?|mp4|mov|mp3|wav|pdf)$/i.test(path)) {
    return false;
  }

  const allowedRoots = /^(app|apps|components|lib|hooks|utils|supabase|styles|constants|public|src|packages)\//;
  const allowedRootFile = /^(next\.config|vite\.config|tsconfig|tailwind\.config|postcss\.config|eslint\.config|biome\.json|package\.json|README\.md)/;
  const allowedExtension = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|sass|sql|toml|ya?ml)$/i;

  return (allowedRoots.test(path) || allowedRootFile.test(path)) && allowedExtension.test(path);
}

function mergeNameOnlyFallback(parsed: ChangeFile[], nameOnlyOutput: string, source: "workingTree" | "staged"): ChangeFile[] {
  const knownPaths = new Set(parsed.map((file) => file.path));
  const fallbackFiles = nameOnlyOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => !knownPaths.has(path))
    .map((path) => ({
      path,
      status: "modified" as const,
      source
    }));

  return [...parsed, ...fallbackFiles];
}

async function assertGitRepo(cwd: string): Promise<void> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error("현재 디렉터리는 git 저장소가 아닙니다. git 저장소 안에서 dev-guard를 실행해 주세요.");
  }
}

function parseNameStatus(output: string, source: "workingTree" | "staged"): ChangeFile[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const rawStatus = parts[0] ?? "M";
      const status = parseStatus(rawStatus);

      if (status === "renamed") {
        return {
          path: parts[2] ?? parts[1] ?? "",
          oldPath: parts[1],
          status,
          source
        };
      }

      return {
        path: parts[1] ?? "",
        status,
        source
      };
    })
    .filter((file) => file.path.length > 0);
}

function parseUntracked(output: string): ChangeFile[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((path) => ({
      path,
      status: "untracked" as const,
      source: "untracked" as const
    }));
}

function parseStatus(rawStatus: string): ChangeFileStatus {
  const status = rawStatus[0];
  if (status === "A") {
    return "added";
  }
  if (status === "D") {
    return "deleted";
  }
  if (status === "R") {
    return "renamed";
  }
  if (status === "C") {
    return "added";
  }

  return "modified";
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "core.quotePath=false", ...args], { cwd, maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (isGitFailure(error)) {
      throw new Error(`git ${args.join(" ")} failed: ${error.stderr || error.message}`);
    }

    throw error;
  }
}

function isGitFailure(error: unknown): error is Error & { stderr?: string } {
  return error instanceof Error;
}
