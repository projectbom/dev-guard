import type { ProjectIdentity } from "@dev-guard/core";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fromRoot, readJsonFile, writeTextFile } from "./fs.js";
import { getGitRemoteOrigin } from "./git.js";

interface PackageJsonLike {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const identityPath = ".devguard/project-identity.json";

export async function buildProjectIdentity(root: string, projectFiles: string[] = []): Promise<ProjectIdentity> {
  const absoluteRoot = resolve(root);
  const [origin, packageJson] = await Promise.all([
    getGitRemoteOrigin(root).catch(() => ""),
    readJsonFile<PackageJsonLike>(fromRoot(root, "package.json"), {})
  ]);
  const frameworkKeywords = inferFrameworkKeywords(packageJson, projectFiles);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        root: absoluteRoot,
        origin,
        packageName: packageJson.name ?? "",
        frameworkKeywords
      })
    )
    .digest("hex")
    .slice(0, 16);

  return {
    root: absoluteRoot,
    gitRemoteOrigin: origin || undefined,
    packageName: packageJson.name,
    frameworkKeywords,
    fingerprint
  };
}

export async function writeProjectIdentity(root: string, identity: ProjectIdentity): Promise<void> {
  await writeTextFile(fromRoot(root, identityPath), `${JSON.stringify(identity, null, 2)}\n`);
}

export async function readStoredProjectIdentity(root: string): Promise<ProjectIdentity | undefined> {
  const identity = await readJsonFile<ProjectIdentity | undefined>(fromRoot(root, identityPath), undefined);
  return identity?.fingerprint ? identity : undefined;
}

export async function loadCurrentProjectIdentity(root: string, projectFiles: string[] = []): Promise<ProjectIdentity> {
  return buildProjectIdentity(root, projectFiles);
}

export function sameProjectIdentity(current: ProjectIdentity, stored: ProjectIdentity | undefined): boolean {
  if (!stored) {
    return false;
  }

  return current.fingerprint === stored.fingerprint && resolve(current.root) === resolve(stored.root);
}

export function formatProjectIdentityWarning(source: string, current: ProjectIdentity, stored: ProjectIdentity | undefined): string {
  if (!stored) {
    return `${source} has no project identity; run dev-guard scan to refresh project memory.`;
  }

  return `${source} project identity mismatch; ignoring cached context (current=${current.fingerprint}, cached=${stored.fingerprint}).`;
}

function inferFrameworkKeywords(packageJson: PackageJsonLike, projectFiles: string[]): string[] {
  const dependencyNames = new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {})
  ]);
  const keywords = new Set<string>();

  const dependencyKeywordMap: Array<[string, string]> = [
    ["next", "next"],
    ["react", "react"],
    ["vite", "vite"],
    ["vue", "vue"],
    ["nuxt", "nuxt"],
    ["svelte", "svelte"],
    ["astro", "astro"],
    ["@remix-run/react", "remix"],
    ["tailwindcss", "tailwind"],
    ["@supabase/supabase-js", "supabase"],
    ["typescript", "typescript"]
  ];

  for (const [dependency, keyword] of dependencyKeywordMap) {
    if (dependencyNames.has(dependency)) {
      keywords.add(keyword);
    }
  }

  const fileHints: Array<[RegExp, string]> = [
    [/^app\//, "app-router"],
    [/^pages\//, "pages-router"],
    [/^supabase\//, "supabase"],
    [/tailwind\.config/i, "tailwind"],
    [/vite\.config/i, "vite"],
    [/next\.config/i, "next"]
  ];

  for (const file of projectFiles) {
    for (const [pattern, keyword] of fileHints) {
      if (pattern.test(file)) {
        keywords.add(keyword);
      }
    }
  }

  return [...keywords].sort();
}
