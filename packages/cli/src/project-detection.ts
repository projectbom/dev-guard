import { readdir } from "node:fs/promises";
import { fromRoot, readJsonFile } from "./fs.js";
import { fileExists } from "./project-memory.js";

interface PackageJsonLike {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

export interface ProjectDetectionSummary {
  packageName: string;
  packageManager: string;
  language: string;
  runtime: string;
  frameworks: string[];
  markdownFiles: string[];
  contextCandidates: string[];
}

const contextCandidateFiles = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  ".devguard/task.md",
  ".devguard/rules.md",
  ".devguard/mistakes.md",
  "docs/PROJECT_STATE.md",
  "docs/CURRENT_TASK.md",
  "docs/DECISIONS.md",
  "docs/DO_NOT_REPEAT.md"
];

export async function detectProject(root: string, projectFiles: string[]): Promise<ProjectDetectionSummary> {
  const packageJson = await readJsonFile<PackageJsonLike>(fromRoot(root, "package.json"), {});
  const [packageManager, rootMarkdownFiles, contextCandidates] = await Promise.all([
    detectPackageManager(root, packageJson),
    detectRootMarkdownFiles(root, projectFiles),
    detectContextCandidates(root)
  ]);

  return {
    packageName: packageJson.name ?? "(unknown)",
    packageManager,
    language: inferLanguage(packageJson, projectFiles),
    runtime: inferRuntime(packageJson, projectFiles),
    frameworks: inferFrameworks(packageJson, projectFiles),
    markdownFiles: rootMarkdownFiles,
    contextCandidates
  };
}

async function detectPackageManager(root: string, packageJson: PackageJsonLike): Promise<string> {
  if (packageJson.packageManager) {
    return packageJson.packageManager;
  }
  if (await fileExists(root, "pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (await fileExists(root, "yarn.lock")) {
    return "yarn";
  }
  if (await fileExists(root, "package-lock.json")) {
    return "npm";
  }
  if (await fileExists(root, "bun.lockb")) {
    return "bun";
  }
  return "(unknown)";
}

async function detectRootMarkdownFiles(root: string, projectFiles: string[]): Promise<string[]> {
  const markdown = new Set(projectFiles.filter((file) => /\.md$/i.test(file)));
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.md$/i.test(entry.name)) {
        markdown.add(entry.name);
      }
    }
  } catch {
    // Best-effort summary only.
  }
  return [...markdown].sort();
}

async function detectContextCandidates(root: string): Promise<string[]> {
  const existing = await Promise.all(
    contextCandidateFiles.map(async (path) => ((await fileExists(root, path)) ? path : undefined))
  );
  return existing.filter((path): path is string => Boolean(path));
}

function inferFrameworks(packageJson: PackageJsonLike, projectFiles: string[]): string[] {
  const dependencies = new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {})
  ]);
  const frameworks = new Set<string>();
  const dependencyHints: Array<[string, string]> = [
    ["next", "nextjs"],
    ["react", "react"],
    ["vite", "vite"],
    ["vue", "vue"],
    ["nuxt", "nuxt"],
    ["svelte", "svelte"],
    ["astro", "astro"],
    ["@remix-run/react", "remix"],
    ["tailwindcss", "tailwind"],
    ["@supabase/supabase-js", "supabase"],
    ["express", "express"],
    ["fastify", "fastify"],
    ["@nestjs/core", "nest"],
    ["turbo", "turborepo"],
    ["typescript", "typescript"]
  ];
  for (const [dependency, label] of dependencyHints) {
    if (dependencies.has(dependency)) {
      frameworks.add(label);
    }
  }
  if (projectFiles.some((file) => file.startsWith("app/"))) {
    frameworks.add("app-router");
  }
  if (projectFiles.some((file) => file.startsWith("pages/"))) {
    frameworks.add("pages-router");
  }
  if (projectFiles.some((file) => file === "turbo.json")) {
    frameworks.add("turborepo");
  }
  if (projectFiles.some((file) => file === "pubspec.yaml" || file.startsWith("lib/") && file.endsWith(".dart"))) {
    frameworks.add("flutter");
  }
  return [...frameworks].sort();
}

function inferLanguage(packageJson: PackageJsonLike, projectFiles: string[]): string {
  const dependencies = new Set([...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.devDependencies ?? {})]);
  if (dependencies.has("typescript") || projectFiles.some((file) => /\.(ts|tsx)$/.test(file))) {
    return "typescript";
  }
  if (projectFiles.some((file) => /\.(js|jsx|mjs|cjs)$/.test(file))) {
    return "javascript";
  }
  if (projectFiles.some((file) => /\.py$/.test(file) || file === "pyproject.toml" || file === "requirements.txt")) {
    return "python";
  }
  if (projectFiles.some((file) => /\.dart$/.test(file) || file === "pubspec.yaml")) {
    return "dart";
  }
  return "(unknown)";
}

function inferRuntime(packageJson: PackageJsonLike, projectFiles: string[]): string {
  const dependencies = new Set([...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.devDependencies ?? {})]);
  if (dependencies.has("next")) {
    return "node/nextjs";
  }
  if (dependencies.has("express") || dependencies.has("fastify") || dependencies.has("@nestjs/core") || projectFiles.some((file) => file === "package.json")) {
    return "node";
  }
  if (projectFiles.some((file) => /\.py$/.test(file) || file === "pyproject.toml" || file === "requirements.txt")) {
    return "python";
  }
  if (projectFiles.some((file) => file === "pubspec.yaml")) {
    return "flutter";
  }
  return "(unknown)";
}
