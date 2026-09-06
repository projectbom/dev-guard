import type { ChangeFile } from "./types.js";

const devGuardDocPaths = new Set([
  "docs/PROJECT_STATE.md",
  "docs/CURRENT_TASK.md",
  "docs/DECISIONS.md",
  "docs/DO_NOT_REPEAT.md"
]);

const devGuardCachePaths = new Set([
  ".devguard/project-index.json",
  ".devguard/file-summaries.json",
  ".devguard/code-graph.json",
  ".devguard/project-map.md"
]);

/**
 * Single canonical list of generated/build-output directory names, shared by
 * every subsystem that classifies paths (Project Knowledge, Code Index,
 * changed-files filtering, diff summarization, task inference, Quality
 * Report, Handoff, Working Context, Read Map, Code Map, prepare_task_context
 * candidates). Matched by path SEGMENT, not by string prefix, so a nested
 * occurrence (e.g. "apps/admin/.next/server/...") is caught the same way a
 * root-level one is — a prefix-only check like `path.startsWith(".next/")`
 * misses exactly this monorepo-shaped case.
 */
const GENERATED_DIRECTORY_SEGMENTS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo", ".cache"]);

/**
 * DevGuard's own artifact naming convention: the live `.devguard`/`devguard`
 * directory, and any backup/temp copy of it. Backups are named by appending
 * `.` or `-` plus a suffix (e.g. `.devguard.backup-20260101`, the legacy
 * `devguard.backup-<ts>` from the root .gitignore) — matched by prefix on
 * that exact convention, not a bare substring, so an unrelated user
 * directory (e.g. "devguardian/") is never caught.
 */
function isDevGuardArtifactSegment(segment: string): boolean {
  return (
    segment === ".devguard" ||
    segment === "devguard" ||
    segment.startsWith(".devguard.") ||
    segment.startsWith(".devguard-") ||
    segment.startsWith("devguard.") ||
    segment.startsWith("devguard-")
  );
}

function isGeneratedDirectorySegment(segment: string): boolean {
  return GENERATED_DIRECTORY_SEGMENTS.has(segment);
}

/** True if any path segment is a known generated/build-output directory. */
export function isGeneratedArtifactPath(path: string): boolean {
  return normalizePath(path)
    .split("/")
    .some((segment) => isGeneratedDirectorySegment(segment));
}

/** True if any path segment matches DevGuard's own (live or backup) artifact naming. */
export function isDevGuardArtifactPath(path: string): boolean {
  return normalizePath(path)
    .split("/")
    .some((segment) => isDevGuardArtifactSegment(segment));
}

export function isDevGuardContextFile(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized.startsWith(".devguard/") || devGuardDocPaths.has(normalized);
}

export function isAlwaysIgnoredContextPath(path: string): boolean {
  const normalized = normalizePath(path);
  const segments = normalized.split("/");
  const fileName = segments.at(-1) ?? "";

  return (
    isGeneratedArtifactPath(normalized) ||
    isDevGuardArtifactPath(normalized) ||
    /^\.devguard\/[^/]+\.json$/i.test(normalized) ||
    devGuardCachePaths.has(normalized) ||
    fileName === "pnpm-lock.yaml" ||
    fileName === "package-lock.json" ||
    fileName === "yarn.lock" ||
    /turbopack|\/cache\//i.test(normalized)
  );
}

export function filterDevGuardContextFiles(changeFiles: ChangeFile[], includeContextFiles?: boolean): ChangeFile[] {
  return changeFiles.filter((file) => !isAlwaysIgnoredContextPath(file.path) && (includeContextFiles || !isDevGuardContextFile(file.path)));
}

export function normalizeContextPath(path: string): string {
  return normalizePath(path);
}

function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, "");
}
