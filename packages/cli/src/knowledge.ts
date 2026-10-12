import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { readJsonFile, readTextFile, writeTextFile, fromRoot } from "./fs.js";
import { enumerateProjectFiles, groupByRoots, mapLimit, spreadAcross, type ProjectFileList } from "./project-files.js";
import { devguardPaths } from "./paths.js";

export interface ProjectKnowledge {
  schemaVersion: 1;
  generatedAt: string;
  projectName: string;
  summary: {
    framework: string;
    language: string;
    packageManager: string;
    entryPoints: string[];
    sourceRoots: string[];
    filesIndexed: number;
  };
  pages: Array<{ route: string; file: string; type: "page" | "layout" | "api" }>;
  components: Array<{ name: string; file: string; exportType: "function" | "const" | "default" }>;
  apis: Array<{ kind: "next-route" | "pages-api" | "express" | "cli-command"; route: string; file: string; methods?: string[] }>;
  database: Array<{ kind: string; path: string; tables?: string[] }>;
  commands: Array<{ name: string; source: string; script?: string }>;
  importantFiles: Array<{ path: string; reason: string }>;
  architecture: {
    modules: Array<{ name: string; files: string[]; reason: string }>;
  };
  extraction: {
    strategy: "static";
    ignored: string[];
    futureCompatible: string[];
  };
  /** Structural fingerprint at generation time (absent on pre-0.10 files). */
  fingerprint?: KnowledgeFingerprint;
  /**
   * Per-category detected vs kept counts (absent on pre-0.11 files). Every
   * list above is a bounded, representative sample; `detected` says how much
   * was found before the category's own budget was applied.
   */
  coverage?: Record<KnowledgeCategory, { detected: number; kept: number }>;
}

export type KnowledgeCategory = "pages" | "layouts" | "nextRoutes" | "httpRoutes" | "components";

/**
 * Independent per-category output budgets. UI pages, Next.js API routes and
 * HTTP-framework handlers used to share one list budget, so in a large app
 * the alphabetically-first `app/api/**` routes took every slot and pages
 * dropped to zero. Each category is now sampled on its own.
 */
const KNOWLEDGE_BUDGETS: Record<KnowledgeCategory, number> = {
  pages: 200,
  layouts: 60,
  nextRoutes: 200,
  httpRoutes: 300,
  components: 200
};

/**
 * What Project Knowledge is derived from, cheaply comparable at every
 * `watch`/`setup` start:
 * - `structure`: hash of the project file set (paths only, from the same
 *   bounded walk generation uses) minus Markdown and dot-paths — so a new
 *   route, component, migration, workspace or source root makes Knowledge
 *   stale, while editing README text or DevGuard's own `.mcp.json` /
 *   `.claude/` / `.codex/` setup does not.
 * - `inputs`: content hashes of the few files whose CONTENT Knowledge
 *   reads structurally — package manifests (scripts, deps, workspaces),
 *   framework/TS config, and the CLI command router.
 * No other file content is read or hashed.
 */
export interface KnowledgeFingerprint {
  version: 1;
  structure: string;
  inputs: Record<string, string>;
}

interface PackageJson {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface ProjectKnowledgeRefreshStatus {
  exists: boolean;
  shouldGenerate: boolean;
  reason: "missing" | "stale" | "fresh";
  /** Paths whose content changed, plus "project file set" when files were added/removed. */
  staleFiles: string[];
  detected: {
    packageManager: string;
    framework: string;
    buildCommand: string;
    testCommand: string;
    typecheckCommand: string;
    packageScripts: string[];
    entryPoints: string[];
    sourceRoots: string[];
    configFiles: string[];
  };
}

// Informational only (reported in the generated ProjectKnowledge.extraction.ignored
// field) — the actual enforcement is enumerateProjectFiles (project-files.ts):
// .gitignore inside git, plus the shared generated/DevGuard path policy.
const IGNORED_DIRECTORY_LABELS = [".git", ".devguard", ".devguard.*", "devguard", "devguard.*", "node_modules", "dist", "build", ".next", "coverage", ".turbo", ".cache"];

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".sql"]);
const MAX_WORKSPACE_PACKAGES = 500;
const READ_CONCURRENCY = 16;

const knowledgeRefreshCandidates = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "tsconfig.json",
  "tsconfig.base.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "astro.config.js",
  "astro.config.mjs",
  "astro.config.ts",
  "nuxt.config.js",
  "nuxt.config.mjs",
  "nuxt.config.ts",
  "svelte.config.js",
  "svelte.config.ts"
];

export async function runKnowledge(root: string): Promise<void> {
  const knowledge = await generateProjectKnowledge(root);
  console.log("dev-guard knowledge");
  console.log("");
  console.log(`Project: ${knowledge.projectName}`);
  console.log(`Framework: ${knowledge.summary.framework}`);
  console.log(`Language: ${knowledge.summary.language}`);
  console.log(`Package manager: ${knowledge.summary.packageManager}`);
  console.log(`Files indexed: ${knowledge.summary.filesIndexed}`);
  console.log(`Routes: ${knowledge.pages.length}`);
  console.log(`Components: ${knowledge.components.length}`);
  console.log(`APIs: ${knowledge.apis.length}`);
  console.log(`Architecture modules: ${knowledge.architecture.modules.length}`);
  console.log(`Knowledge generated at: ${knowledge.generatedAt}`);
  console.log("");
  console.log(`Written: ${devguardPaths.projectKnowledge}`);
}

/**
 * Generic workspace/monorepo source-root discovery, reused by the Code
 * Index bootstrap (see `listInitialCodeIndexFiles` in runtime-state.ts) so
 * it is not limited to a fixed, single-app-shaped root list. Delegates
 * entirely to the same `detectSourceRoots`/`readWorkspacePackages` logic
 * Project Knowledge already uses — real workspace package directories
 * (anywhere a `package.json` is found, under any name: `apps/admin`,
 * `services/api`, `modules/auth`, ...) come from `readWorkspacePackages`,
 * not from guessing a directory-name convention.
 */
export async function discoverWorkspaceSourceRoots(root: string, enumeration?: ProjectFileList): Promise<string[]> {
  const files = await listProjectFiles(root, enumeration);
  const workspacePackages = await readWorkspacePackages(root, files);
  return detectSourceRoots(files, workspacePackages);
}

export async function generateProjectKnowledge(root: string, enumeration?: ProjectFileList): Promise<ProjectKnowledge> {
  const files = await listProjectFiles(root, enumeration);
  const fingerprint = await computeKnowledgeFingerprint(root, files);
  const rootPackage = await readJsonFile<PackageJson>(fromRoot(root, "package.json"), {});
  const workspacePackages = await readWorkspacePackages(root, files);
  // Content-reading detectors sample round-robin across workspace packages
  // (or top-level directories), so a large repo yields a representative
  // Knowledge instead of the first N files of one subtree.
  const workspaceDirs = workspacePackages.map((pkg) => pkg.path.slice(0, -"/package.json".length));
  const groupOf = groupByRoots(workspaceDirs);
  const packageJsons = [rootPackage, ...workspacePackages.map((entry) => entry.packageJson)];
  const coverage = {} as NonNullable<ProjectKnowledge["coverage"]>;
  const httpRoots = httpFrameworkRoots(rootPackage, workspacePackages);
  const knowledge: ProjectKnowledge = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectName: rootPackage.name ?? basename(root),
    summary: {
      framework: detectFramework(packageJsons, files),
      language: detectLanguage(files),
      packageManager: await detectPackageManager(root, rootPackage),
      entryPoints: detectEntryPoints(files),
      sourceRoots: detectSourceRoots(files, workspacePackages),
      filesIndexed: files.length
    },
    pages: detectPages(files, workspaceDirs, groupOf, coverage),
    components: await detectComponents(root, files, groupOf, coverage),
    apis: await detectApis(root, files, workspaceDirs, groupOf, httpRoots, coverage),
    database: await detectDatabase(root, files, groupOf),
    commands: await detectCommands(root, files, rootPackage, workspacePackages),
    importantFiles: detectImportantFiles(files),
    architecture: {
      modules: detectArchitectureModules(files)
    },
    extraction: {
      strategy: "static",
      ignored: IGNORED_DIRECTORY_LABELS,
      futureCompatible: ["dependency graph", "symbol index", "cross-reference graph", "semantic relationships"]
    },
    fingerprint,
    coverage
  };
  await writeTextFile(fromRoot(root, devguardPaths.projectKnowledge), `${JSON.stringify(knowledge, null, 2)}\n`);
  return knowledge;
}

export async function ensureProjectKnowledge(root: string): Promise<{
  path: string;
  generated: boolean;
  status: ProjectKnowledgeRefreshStatus;
  warning?: string;
}> {
  const status = await getProjectKnowledgeRefreshStatus(root);
  if (!status.shouldGenerate) {
    return { path: devguardPaths.projectKnowledge, generated: false, status };
  }
  try {
    await generateProjectKnowledge(root);
    return { path: devguardPaths.projectKnowledge, generated: true, status };
  } catch (error) {
    if (status.exists) {
      return {
        path: devguardPaths.projectKnowledge,
        generated: false,
        status,
        warning: error instanceof Error ? error.message : String(error)
      };
    }
    throw error;
  }
}

export async function getProjectKnowledgeRefreshStatus(root: string, enumeration?: ProjectFileList): Promise<ProjectKnowledgeRefreshStatus> {
  const [stored, detected] = await Promise.all([
    readJsonFile<Partial<ProjectKnowledge> | null>(fromRoot(root, devguardPaths.projectKnowledge), null),
    detectProjectBasics(root)
  ]);
  if (!stored || typeof stored !== "object" || !stored.summary) {
    return { exists: false, shouldGenerate: true, reason: "missing", staleFiles: [], detected };
  }
  const current = await computeKnowledgeFingerprint(root, await listProjectFiles(root, enumeration));
  const previous = stored.fingerprint;
  // Knowledge written before fingerprints existed is refreshed once.
  const staleFiles = previous?.version === 1 ? diffFingerprints(previous, current) : ["fingerprint missing (older DevGuard)"];
  return {
    exists: true,
    shouldGenerate: staleFiles.length > 0,
    reason: staleFiles.length > 0 ? "stale" : "fresh",
    staleFiles,
    detected
  };
}

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"];

export async function computeKnowledgeFingerprint(root: string, files?: string[]): Promise<KnowledgeFingerprint> {
  const projectFiles = files ?? (await listProjectFiles(root));
  const structural = projectFiles.filter((file) => !/\.mdx?$/i.test(file) && !file.split("/").some((segment) => segment.startsWith(".")));
  // Lockfile presence decides the package manager; its content does not matter here.
  const lockfiles = (await Promise.all(LOCKFILES.map(async (file) => ((await exists(join(root, file))) ? `lock:${file}` : undefined)))).filter(Boolean);
  const cliRouter = projectFiles.includes("packages/cli/src/index.ts") ? "packages/cli/src/index.ts" : projectFiles.find((file) => file.endsWith("/index.ts"));
  const contentInputs = [
    ...new Set([
      ...knowledgeRefreshCandidates.filter((file) => !LOCKFILES.includes(file) && projectFiles.includes(file)),
      ...projectFiles.filter((file) => file === "package.json" || file.endsWith("/package.json")),
      ...(cliRouter ? [cliRouter] : [])
    ])
  ].sort();
  const inputs: Record<string, string> = {};
  for (const file of contentInputs) inputs[file] = hashText(await readTextFile(fromRoot(root, file)));
  return { version: 1, structure: hashText([...lockfiles, ...structural].join("\n")), inputs };
}

function diffFingerprints(previous: KnowledgeFingerprint, current: KnowledgeFingerprint): string[] {
  const changed = [...new Set([...Object.keys(previous.inputs ?? {}), ...Object.keys(current.inputs)])].filter((file) => previous.inputs?.[file] !== current.inputs[file]).sort();
  return previous.structure !== current.structure ? [...changed, "project file set"] : changed;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export async function readProjectKnowledge(root: string): Promise<ProjectKnowledge | undefined> {
  try {
    return await readJsonFile<ProjectKnowledge>(fromRoot(root, devguardPaths.projectKnowledge), undefined as unknown as ProjectKnowledge);
  } catch {
    return undefined;
  }
}

async function detectProjectBasics(root: string): Promise<ProjectKnowledgeRefreshStatus["detected"]> {
  const rootPackage = await readJsonFile<PackageJson>(fromRoot(root, "package.json"), {});
  const packageScripts = Object.keys(rootPackage.scripts ?? {}).sort();
  const configFiles = (
    await Promise.all(
      knowledgeRefreshCandidates.map(async (file) => ((await exists(join(root, file))) ? file : undefined))
    )
  ).filter((file): file is string => Boolean(file));
  const entryPointCandidates = ["README.md", "package.json", "packages/cli/src/index.ts", "src/index.ts", "app/page.tsx", "pages/index.tsx"];
  const sourceRootCandidates = ["app", "pages", "src", "packages", "components", "lib", "server", "supabase", "prisma", "docs"];
  const [entryPoints, sourceRoots] = await Promise.all([
    filterExisting(root, entryPointCandidates),
    filterExisting(root, sourceRootCandidates)
  ]);
  const packageManager = await detectPackageManager(root, rootPackage);
  return {
    packageManager,
    framework: await detectFrameworkLight(root, rootPackage),
    buildCommand: scriptCommand(packageManager, rootPackage, ["build"]),
    testCommand: scriptCommand(packageManager, rootPackage, ["test", "test:unit", "vitest"]),
    typecheckCommand: scriptCommand(packageManager, rootPackage, ["typecheck", "type-check", "check"]),
    packageScripts,
    entryPoints,
    sourceRoots,
    configFiles
  };
}

async function detectFrameworkLight(root: string, packageJson: PackageJson): Promise<string> {
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  if (deps.next || (await exists(join(root, "next.config.js"))) || (await exists(join(root, "next.config.mjs"))) || (await exists(join(root, "next.config.ts")))) return "Next.js";
  if (deps.astro || (await exists(join(root, "astro.config.js"))) || (await exists(join(root, "astro.config.mjs"))) || (await exists(join(root, "astro.config.ts")))) return "Astro";
  if (deps.nuxt || (await exists(join(root, "nuxt.config.js"))) || (await exists(join(root, "nuxt.config.mjs"))) || (await exists(join(root, "nuxt.config.ts")))) return "Nuxt";
  if (deps["@vitejs/plugin-react"] || deps.vite || (await exists(join(root, "vite.config.js"))) || (await exists(join(root, "vite.config.mjs"))) || (await exists(join(root, "vite.config.ts")))) return "Vite";
  if (deps.express) return "Express";
  if (deps.react) return "React";
  if (deps.typescript || (await exists(join(root, "tsconfig.json")))) return "Node.js / TypeScript";
  return "Unknown";
}

function scriptCommand(packageManager: string, packageJson: PackageJson, names: string[]): string {
  const scripts = packageJson.scripts ?? {};
  const found = names.find((name) => scripts[name]);
  return found ? `${packageManagerCommand(packageManager)} ${found}` : "Unknown";
}

function packageManagerCommand(packageManager: string): string {
  const manager = packageManager.split("@")[0];
  if (manager === "yarn") return "yarn";
  if (manager === "bun") return "bun run";
  if (manager === "npm") return "npm run";
  return "pnpm";
}

async function filterExisting(root: string, paths: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const path of paths) {
    if (await exists(join(root, path))) result.push(path);
  }
  return result;
}

/**
 * Every project file Knowledge cares about (by extension or well-known
 * name), from the shared enumeration — no file-count cap: enumeration is
 * metadata-only, and content reads are budgeted per detector instead.
 */
async function listProjectFiles(root: string, enumeration?: ProjectFileList): Promise<string[]> {
  const { files } = enumeration ?? (await enumerateProjectFiles(root));
  return files.filter((file) => {
    const name = file.slice(file.lastIndexOf("/") + 1);
    return sourceExtensions.has(extname(name)) || importantFileNames.has(name);
  });
}
const importantFileNames = new Set([
  "README.md",
  "README.ko.md",
  "package.json",
  "tsconfig.json",
  "next.config.js",
  "next.config.mjs",
  "vite.config.ts",
  "AGENTS.md",
  "CLAUDE.md"
]);

async function readWorkspacePackages(root: string, files: string[]): Promise<Array<{ path: string; packageJson: PackageJson }>> {
  const packageFiles = files.filter((file) => file.endsWith("/package.json")).slice(0, MAX_WORKSPACE_PACKAGES);
  const packages = await Promise.all(
    packageFiles.map(async (file) => ({
      path: file,
      packageJson: await readJsonFile<PackageJson>(fromRoot(root, file), {})
    }))
  );
  return packages;
}

function detectFramework(packages: PackageJson[], files: string[]): string {
  const deps = Object.assign({}, ...packages.map((pkg) => ({ ...pkg.dependencies, ...pkg.devDependencies })));
  if (deps.next || files.some((file) => file.startsWith("app/") || file.includes("/app/"))) return "Next.js";
  if (deps["@vitejs/plugin-react"] || deps.vite) return "Vite";
  if (deps.express || files.some((file) => /\bexpress\b/.test(file))) return "Express";
  if (deps.react || files.some((file) => file.endsWith(".tsx") || file.endsWith(".jsx"))) return "React";
  return "Node.js / TypeScript";
}

function detectLanguage(files: string[]): string {
  if (files.some((file) => file.endsWith(".ts") || file.endsWith(".tsx"))) return "TypeScript";
  if (files.some((file) => file.endsWith(".js") || file.endsWith(".jsx"))) return "JavaScript";
  return "unknown";
}

async function detectPackageManager(root: string, packageJson: PackageJson): Promise<string> {
  if (packageJson.packageManager) return packageJson.packageManager;
  if (await exists(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(root, "yarn.lock"))) return "yarn";
  if (await exists(join(root, "package-lock.json"))) return "npm";
  if (await exists(join(root, "bun.lockb"))) return "bun";
  return "unknown";
}

function detectEntryPoints(files: string[]): string[] {
  return [
    "README.md",
    "package.json",
    "packages/cli/src/index.ts",
    "src/index.ts",
    "app/page.tsx",
    "pages/index.tsx"
  ].filter((file) => files.includes(file));
}

function detectSourceRoots(files: string[], workspacePackages: Array<{ path: string; packageJson: PackageJson }>): string[] {
  const roots = new Set<string>();
  // Common single-app conventions, kept as before, extended with the
  // monorepo-shaped ones ("apps", "infra") that a plain top-level-name scan
  // was previously missing entirely.
  const knownRoots = ["app", "pages", "src", "packages", "components", "lib", "server", "supabase", "prisma", "docs", "apps", "infra"];
  for (const candidate of knownRoots) {
    if (files.some((file) => file === candidate || file.startsWith(`${candidate}/`))) roots.add(candidate);
  }
  // Real workspace package directories (e.g. "apps/admin/package.json" ->
  // "apps/admin") — this is what makes a monorepo's sourceRoots reflect its
  // actual structure instead of only top-level folder names.
  for (const pkg of workspacePackages) {
    const dir = pkg.path.slice(0, pkg.path.length - "/package.json".length);
    if (dir) roots.add(dir);
  }
  return [...roots].sort();
}

/**
 * Splits `file` into (app directory, path inside it) when it lives in a
 * Next.js-style `app/`, `src/app/` or `pages/` directory at the project root
 * or at the root of a workspace package (e.g. `apps/web/app/...`).
 */
function appRelativePath(file: string, workspaceDirs: string[]): { kind: "app" | "pages"; rel: string } | undefined {
  for (const prefix of ["", ...workspaceDirs.map((dir) => `${dir}/`)]) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const match = rest.match(/^(?:src\/)?app\/(.+)$/);
    if (match) return { kind: "app", rel: `app/${match[1]}` };
    if (rest.startsWith("pages/")) return { kind: "pages", rel: rest };
  }
  return undefined;
}

/**
 * UI pages and layouts, each under its own budget. API routes are not listed
 * here — they live in `apis` (next-route / pages-api) with their own budget,
 * so they can no longer crowd pages out.
 */
function detectPages(files: string[], workspaceDirs: string[], groupOf: (file: string) => string, coverage: NonNullable<ProjectKnowledge["coverage"]>): ProjectKnowledge["pages"] {
  const pages: ProjectKnowledge["pages"] = [];
  const layouts: ProjectKnowledge["pages"] = [];
  for (const file of files) {
    const located = appRelativePath(file, workspaceDirs);
    if (!located) continue;
    if (located.kind === "pages" && located.rel.startsWith("pages/api/")) continue;
    if ((located.kind === "app" && /\/page\.(tsx|jsx|ts|js|mdx)$/.test(located.rel)) || (located.kind === "pages" && /\.(tsx|jsx|ts|js|mdx)$/.test(located.rel))) {
      pages.push({ route: routeFromPageFile(located.rel), file, type: "page" });
    } else if (located.kind === "app" && /\/layout\.(tsx|jsx|ts|js)$/.test(located.rel)) {
      layouts.push({ route: routeFromAppFile(located.rel), file, type: "layout" });
    }
  }
  const keptPages = representativeRoutes(pages, KNOWLEDGE_BUDGETS.pages, groupOf);
  const keptLayouts = representativeRoutes(layouts, KNOWLEDGE_BUDGETS.layouts, groupOf);
  coverage.pages = { detected: pages.length, kept: keptPages.length };
  coverage.layouts = { detected: layouts.length, kept: keptLayouts.length };
  return [...keptPages, ...keptLayouts];
}

/**
 * Representative, bounded sample of route-shaped entries — never the
 * alphabetically-first N: shallow (structurally central) routes first, then
 * round-robin across workspaces and, inside each, across first route
 * segments (`/orders/*`, `/settings/*`, ...).
 */
function representativeRoutes<T extends { route: string; file: string }>(items: T[], limit: number, groupOf: (file: string) => string): T[] {
  if (items.length <= limit) return items;
  const depth = (route: string) => route.split("/").filter(Boolean).length;
  const ordered = [...items].sort((a, b) => depth(a.route) - depth(b.route) || a.file.localeCompare(b.file));
  // The section is the first meaningful segment: `/api/orders/:id` and
  // `/v1/orders` both belong to "orders".
  const section = (item: T) => `${groupOf(item.file)}\0${item.route.split("/").filter((segment) => segment && !/^(?:api|v\d+)$/i.test(segment))[0] ?? ""}`;
  return spreadAcross(roundRobin(ordered, section), limit, (item) => groupOf(item.file));
}

/** Round-robin order across `keyOf` groups (each group's own order kept), unbounded. */
function roundRobin<T>(items: T[], keyOf: (item: T) => string): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  const buckets = [...groups.values()];
  const result: T[] = [];
  for (let round = 0; result.length < items.length; round += 1) {
    for (const bucket of buckets) if (round < bucket.length) result.push(bucket[round]);
  }
  return result;
}

async function detectComponents(root: string, files: string[], groupOf: (file: string) => string, coverage: NonNullable<ProjectKnowledge["coverage"]>): Promise<ProjectKnowledge["components"]> {
  const candidates = files.filter((file) => /\.(tsx|jsx)$/.test(file) && /(^components\/|\/components\/|^app\/|^src\/)/.test(file));
  const components: ProjectKnowledge["components"] = [];
  const sample = spreadAcross(candidates, 400, groupOf);
  const texts = await mapLimit(sample, READ_CONCURRENCY, (file) => readTextFile(fromRoot(root, file)));
  for (const [index, file] of sample.entries()) {
    const text = texts[index];
    for (const match of text.matchAll(/export\s+function\s+([A-Z][A-Za-z0-9_]*)/g)) {
      components.push({ name: match[1], file, exportType: "function" });
    }
    for (const match of text.matchAll(/export\s+const\s+([A-Z][A-Za-z0-9_]*)\s*=/g)) {
      components.push({ name: match[1], file, exportType: "const" });
    }
    const defaultMatch = text.match(/export\s+default\s+function\s+([A-Z][A-Za-z0-9_]*)?/);
    if (defaultMatch) {
      components.push({ name: defaultMatch[1] ?? componentNameFromFile(file), file, exportType: "default" });
    }
  }
  const unique = dedupeBy(components, (item) => `${item.name}:${item.file}`);
  const kept = spreadAcross(unique, KNOWLEDGE_BUDGETS.components, (item) => groupOf(item.file));
  coverage.components = { detected: unique.length, kept: kept.length };
  return kept;
}

/**
 * API surface, one independent budget per category: Next.js API routes
 * (app `route.ts` + `pages/api`), HTTP-framework handlers, CLI commands.
 */
async function detectApis(
  root: string,
  files: string[],
  workspaceDirs: string[],
  groupOf: (file: string) => string,
  httpRoots: string[],
  coverage: NonNullable<ProjectKnowledge["coverage"]>
): Promise<ProjectKnowledge["apis"]> {
  const nextRoutes: Array<{ file: string; rel: string; route: string; kind: "next-route" | "pages-api" }> = [];
  for (const file of files) {
    const located = appRelativePath(file, workspaceDirs);
    if (located?.kind === "app" && /\/route\.(ts|js)$/.test(located.rel)) {
      nextRoutes.push({ file, rel: located.rel, route: routeFromAppFile(located.rel), kind: "next-route" });
    } else if (located?.kind === "pages" && /^pages\/api\/.*\.(ts|js)$/.test(located.rel)) {
      nextRoutes.push({ file, rel: located.rel, route: routeFromPagesApi(located.rel), kind: "pages-api" });
    }
  }
  const routeSample = representativeRoutes(nextRoutes, KNOWLEDGE_BUDGETS.nextRoutes, groupOf);
  coverage.nextRoutes = { detected: nextRoutes.length, kept: routeSample.length };
  const appRoutes = routeSample.filter((entry) => entry.kind === "next-route");
  const routeTexts = await mapLimit(appRoutes, READ_CONCURRENCY, (entry) => readTextFile(fromRoot(root, entry.file)));
  const methodsOf = new Map(appRoutes.map((entry, index) => [entry.file, detectHttpMethods(routeTexts[index])]));
  const apis: ProjectKnowledge["apis"] = routeSample.map((entry) =>
    entry.kind === "next-route" ? { kind: entry.kind, route: entry.route, file: entry.file, methods: methodsOf.get(entry.file) } : { kind: entry.kind, route: entry.route, file: entry.file }
  );
  const routeFileSet = new Set(nextRoutes.map((entry) => entry.file));
  const httpRoutes = await detectHttpRoutes(root, files.filter((file) => !routeFileSet.has(file) && !appRelativePath(file, workspaceDirs)), httpRoots, groupOf);
  const keptHttp = representativeRoutes(httpRoutes, KNOWLEDGE_BUDGETS.httpRoutes, groupOf);
  // Counted in handlers (method + path), the unit a reader cares about.
  const handlers = (entries: ProjectKnowledge["apis"]) => entries.reduce((sum, entry) => sum + Math.max(1, entry.methods?.length ?? 0), 0);
  coverage.httpRoutes = { detected: handlers(httpRoutes), kept: handlers(keptHttp) };
  apis.push(...keptHttp);
  for (const command of await detectCliCommands(root, files)) {
    apis.push({ kind: "cli-command", route: `dev-guard ${command}`, file: "packages/cli/src/index.ts" });
  }
  return dedupeBy(apis, (item) => `${item.kind}:${item.methods?.join(",") ?? ""}:${item.route}:${item.file}`);
}

const HTTP_FRAMEWORK_DEPENDENCIES = ["express", "fastify", "koa", "@koa/router", "koa-router", "hono", "@hapi/hapi", "restify", "polka", "@nestjs/core"];
const HTTP_PATH_TERM = /(?:^|\/)(?:server|servers|router|routers|routes?|api|apis|handlers?|controllers?|endpoints?|middlewares?)(?:\/|\.|-|_)/i;
const HTTP_ROUTE_SYNTAX = /\b(?:app|router|server|fastify)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|tests?|__mocks__)\//;
/** Total content reads for HTTP handler detection (was 600 spread evenly over every source root). */
const HTTP_READ_BUDGET = 900;
/** First-wave probe size; directories where it finds route syntax are read next. */
const HTTP_PROBE_WAVE = 200;

/** Package directories ("" = project root) that depend on an HTTP server framework. */
function httpFrameworkRoots(rootPackage: PackageJson, workspacePackages: Array<{ path: string; packageJson: PackageJson }>): string[] {
  const usesFramework = (pkg: PackageJson) => HTTP_FRAMEWORK_DEPENDENCIES.some((dep) => pkg.dependencies?.[dep] || pkg.devDependencies?.[dep]);
  return [
    ...(usesFramework(rootPackage) ? [""] : []),
    ...workspacePackages.filter((entry) => usesFramework(entry.packageJson)).map((entry) => entry.path.slice(0, -"/package.json".length))
  ];
}

/**
 * Two-stage, bounded HTTP handler detection. Stage 1 ranks files by metadata
 * only — inside a package that depends on an HTTP framework, and/or a
 * server/router/routes/api/handlers/controllers path — without reading them.
 * Stage 2 reads a probe wave of the likeliest files spread across
 * directories, then the rest of the directories where route syntax was
 * actually found, then other likely files, and only a small tail of
 * unranked files. Never more than HTTP_READ_BUDGET reads.
 */
async function detectHttpRoutes(root: string, files: string[], httpRoots: string[], groupOf: (file: string) => string): Promise<ProjectKnowledge["apis"]> {
  const inHttpRoot = (file: string) => httpRoots.some((dir) => dir === "" || file.startsWith(`${dir}/`));
  const dirOf = (file: string) => file.slice(0, Math.max(0, file.lastIndexOf("/")));
  const pool = files.filter((file) => /\.[cm]?[jt]s$/.test(file) && !file.endsWith(".d.ts") && !TEST_FILE.test(file));
  const score = (file: string) => (inHttpRoot(file) ? 2 : 0) + (HTTP_PATH_TERM.test(file) ? 1 : 0);
  const tiers = new Map<number, string[]>();
  for (const file of pool) {
    const tier = score(file);
    const bucket = tiers.get(tier);
    if (bucket) bucket.push(file);
    else tiers.set(tier, [file]);
  }
  const likely = [3, 2, 1].flatMap((tier) => roundRobin(tiers.get(tier) ?? [], dirOf));
  const unranked = tiers.get(0) ?? [];

  const found: ProjectKnowledge["apis"] = [];
  const read = new Set<string>();
  const hitDirs = new Set<string>();
  const scan = async (batch: string[], cap: number) => {
    const fresh = batch.filter((file) => !read.has(file)).slice(0, Math.max(0, cap - read.size));
    for (const file of fresh) read.add(file);
    const texts = await mapLimit(fresh, READ_CONCURRENCY, (file) => readTextFile(fromRoot(root, file)));
    fresh.forEach((file, index) => {
      for (const match of texts[index].matchAll(HTTP_ROUTE_SYNTAX)) {
        found.push({ kind: "express", route: match[2], file, methods: [match[1].toUpperCase()] });
        hitDirs.add(dirOf(file));
      }
    });
  };
  // A small reserved tail of unranked files keeps unconventional layouts discoverable.
  const tail = spreadAcross(unranked, Math.floor(HTTP_READ_BUDGET / 6), groupOf);
  const likelyCap = HTTP_READ_BUDGET - tail.length;
  await scan(likely.slice(0, HTTP_PROBE_WAVE), likelyCap);
  await scan(likely.filter((file) => hitDirs.has(dirOf(file))), likelyCap);
  await scan(likely, likelyCap);
  await scan(tail, HTTP_READ_BUDGET);
  // One entry per (route, file), its methods merged: `GET`+`POST /v1/orders`.
  const byRoute = new Map<string, ProjectKnowledge["apis"][number]>();
  for (const item of found) {
    const key = `${item.route}\0${item.file}`;
    const entry = byRoute.get(key);
    if (!entry) byRoute.set(key, { ...item, methods: [...(item.methods ?? [])] });
    else for (const method of item.methods ?? []) if (!entry.methods?.includes(method)) entry.methods?.push(method);
  }
  return [...byRoute.values()];
}

async function detectDatabase(root: string, files: string[], groupOf: (file: string) => string): Promise<ProjectKnowledge["database"]> {
  const database: ProjectKnowledge["database"] = [];
  // Newest first (migration names are sortable), spread across directories,
  // so the 100 recorded entries describe the current schema, not the oldest.
  const candidates = files.filter((file) => /^supabase\/.*\.(sql|ts)$/.test(file) || /^prisma\/.*\.(prisma|sql)$/.test(file) || /migrations\/.*\.sql$/.test(file)).reverse();
  const sample = spreadAcross(candidates, 100, (file) => file.slice(0, file.lastIndexOf("/")) || groupOf(file));
  const tables = await mapLimit(sample, READ_CONCURRENCY, (file) => detectSqlTables(root, file));
  sample.forEach((file, index) => {
    const kind = /^supabase\//.test(file) ? "supabase" : /^prisma\//.test(file) ? "prisma" : "sql-migration";
    database.push({ kind, path: file, tables: tables[index] });
  });
  return database.slice(0, 100);
}

async function detectCommands(root: string, files: string[], rootPackage: PackageJson, workspacePackages: Array<{ path: string; packageJson: PackageJson }>): Promise<ProjectKnowledge["commands"]> {
  const commands: ProjectKnowledge["commands"] = [];
  for (const [name, script] of Object.entries(rootPackage.scripts ?? {})) {
    commands.push({ name, source: "package.json", script });
  }
  for (const workspacePackage of workspacePackages) {
    for (const [name, script] of Object.entries(workspacePackage.packageJson.scripts ?? {})) {
      commands.push({ name, source: workspacePackage.path, script });
    }
  }
  for (const command of await detectCliCommands(root, files)) {
    commands.push({ name: `dev-guard ${command}`, source: "packages/cli/src/index.ts" });
  }
  return dedupeBy(commands, (item) => `${item.source}:${item.name}`).slice(0, 200);
}

function detectImportantFiles(files: string[]): ProjectKnowledge["importantFiles"] {
  const rules: Array<[RegExp, string]> = [
    [/^README\.md$/, "project overview"],
    [/^README\.ko\.md$/, "localized project overview"],
    [/^package\.json$/, "workspace scripts and package metadata"],
    [/^packages\/cli\/src\/index\.ts$/, "CLI command router"],
    [/^packages\/cli\/src\/watch\.ts$/, "watch engine"],
    [/^packages\/cli\/src\/dashboard\.ts$/, "local dashboard server and UI"],
    [/^packages\/cli\/src\/runtime-state\.ts$/, "runtime state, reports, and session completion"],
    [/^packages\/cli\/src\/knowledge\.ts$/, "project knowledge generator"],
    [/^packages\/cli\/src\/config.*\.ts$/, "configuration handling"],
    [/^packages\/cli\/src\/install-agent-instructions\.ts$/, "agent instruction file generation"]
  ];
  return rules
    .flatMap(([pattern, reason]) => files.filter((file) => pattern.test(file)).map((path) => ({ path, reason })))
    .slice(0, 80);
}

function detectArchitectureModules(files: string[]): ProjectKnowledge["architecture"]["modules"] {
  const modules = [
    moduleFrom(files, "Dashboard", [/dashboard/i], "local web dashboard and browser UX"),
    moduleFrom(files, "Watch Engine", [/watch\.ts$/, /watch-format/], "file monitoring and session state transitions"),
    moduleFrom(files, "Runtime State", [/runtime-state/, /paths\.ts$/], "state, history, reports, and generated artifacts"),
    moduleFrom(files, "Reporting", [/report/, /review/, /quality/, /prompt/], "completion reports, quality checks, and prompts"),
    moduleFrom(files, "Configuration", [/config/, /configure/, /doctor/], "project and provider configuration"),
    moduleFrom(files, "Agent Instructions", [/install-agent-instructions/, /hooks/], "Codex/Claude setup and completion strategy integration"),
    moduleFrom(files, "Project Knowledge", [/knowledge/], "static project knowledge layer for AI sessions")
  ];
  return modules.filter((module) => module.files.length > 0);
}

function moduleFrom(files: string[], name: string, patterns: RegExp[], reason: string): ProjectKnowledge["architecture"]["modules"][number] {
  return {
    name,
    reason,
    files: files.filter((file) => patterns.some((pattern) => pattern.test(file))).slice(0, 20)
  };
}

async function detectCliCommands(root: string, files: string[]): Promise<string[]> {
  const indexFile = files.includes("packages/cli/src/index.ts") ? "packages/cli/src/index.ts" : files.find((file) => file.endsWith("/index.ts"));
  if (!indexFile) return [];
  const text = await readTextFile(fromRoot(root, indexFile));
  return [...new Set([...text.matchAll(/command\s*===\s*["'`]([^"'`]+)["'`]/g)].map((match) => match[1]).filter((command) => command !== "help" && !command.startsWith("-")))].sort();
}

function routeFromAppFile(file: string): string {
  return "/" + file.replace(/^src\/app\//, "").replace(/^app\//, "").replace(/\/(page|layout|route)\.(tsx|jsx|ts|js|mdx)$/, "").replace(/\/index$/, "").replace(/\([^)]*\)\//g, "").replace(/\[([^\]]+)\]/g, ":$1");
}

function routeFromPageFile(file: string): string {
  if (file.startsWith("pages/")) {
    return "/" + file.replace(/^pages\//, "").replace(/\.(tsx|jsx|ts|js|mdx)$/, "").replace(/^index$/, "").replace(/\/index$/, "").replace(/\[([^\]]+)\]/g, ":$1");
  }
  return routeFromAppFile(file);
}

function routeFromPagesApi(file: string): string {
  return "/" + file.replace(/^pages\/api\//, "api/").replace(/\.(ts|js)$/, "").replace(/\/index$/, "").replace(/\[([^\]]+)\]/g, ":$1");
}

function detectHttpMethods(text: string): string[] {
  const methods = [...text.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)].map((match) => match[1]);
  return [...new Set(methods)].sort();
}

async function detectSqlTables(root: string, file: string): Promise<string[] | undefined> {
  const text = await readTextFile(fromRoot(root, file));
  const tables = [...text.matchAll(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?["`]?([a-zA-Z0-9_."`]+)/gi)].map((match) => match[1].replace(/["`]/g, ""));
  return tables.length > 0 ? [...new Set(tables)].slice(0, 20) : undefined;
}

function componentNameFromFile(file: string): string {
  return basename(file, extname(file))
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const itemKey = key(item);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    result.push(item);
  }
  return result;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
