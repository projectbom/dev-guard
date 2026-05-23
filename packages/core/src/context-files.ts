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
  ".devguard/project-map.md"
]);

export function isDevGuardContextFile(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized.startsWith(".devguard/") || devGuardDocPaths.has(normalized);
}

export function isAlwaysIgnoredContextPath(path: string): boolean {
  const normalized = normalizePath(path);
  const segments = normalized.split("/");
  const fileName = segments.at(-1) ?? "";

  return (
    normalized.startsWith(".next/") ||
    normalized.startsWith(".git/") ||
    normalized.startsWith("node_modules/") ||
    normalized.startsWith("dist/") ||
    normalized.startsWith("build/") ||
    normalized.startsWith("coverage/") ||
    normalized.startsWith(".devguard/runs/") ||
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
