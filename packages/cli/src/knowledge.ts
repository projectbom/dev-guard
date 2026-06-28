import { access, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { readJsonFile, readTextFile, writeTextFile, fromRoot } from "./fs.js";
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
}

interface PackageJson {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const ignoredDirectories = new Set([
  ".git",
  ".devguard",
  "devguard",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  ".cache"
]);

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".sql"]);
const maxFiles = 2_000;

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

export async function generateProjectKnowledge(root: string): Promise<ProjectKnowledge> {
  const files = await listProjectFiles(root);
  const rootPackage = await readJsonFile<PackageJson>(fromRoot(root, "package.json"), {});
  const workspacePackages = await readWorkspacePackages(root, files);
  const packageJsons = [rootPackage, ...workspacePackages.map((entry) => entry.packageJson)];
  const knowledge: ProjectKnowledge = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectName: rootPackage.name ?? basename(root),
    summary: {
      framework: detectFramework(packageJsons, files),
      language: detectLanguage(files),
      packageManager: await detectPackageManager(root, rootPackage),
      entryPoints: detectEntryPoints(files),
      sourceRoots: detectSourceRoots(files),
      filesIndexed: files.length
    },
    pages: detectPages(files),
    components: await detectComponents(root, files),
    apis: await detectApis(root, files),
    database: await detectDatabase(root, files),
    commands: await detectCommands(root, files, rootPackage, workspacePackages),
    importantFiles: detectImportantFiles(files),
    architecture: {
      modules: detectArchitectureModules(files)
    },
    extraction: {
      strategy: "static",
      ignored: [...ignoredDirectories],
      futureCompatible: ["dependency graph", "symbol index", "cross-reference graph", "semantic relationships"]
    }
  };
  await writeTextFile(fromRoot(root, devguardPaths.projectKnowledge), `${JSON.stringify(knowledge, null, 2)}\n`);
  return knowledge;
}

export async function readProjectKnowledge(root: string): Promise<ProjectKnowledge | undefined> {
  try {
    return await readJsonFile<ProjectKnowledge>(fromRoot(root, devguardPaths.projectKnowledge), undefined as unknown as ProjectKnowledge);
  } catch {
    return undefined;
  }
}

async function listProjectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (files.length >= maxFiles) return;
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await walk(rel);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (sourceExtensions.has(extname(entry.name)) || importantFileNames.has(entry.name)) {
        files.push(rel);
      }
    }
  }
  await walk("");
  return files.sort();
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
  const packageFiles = files.filter((file) => file.endsWith("/package.json"));
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

function detectSourceRoots(files: string[]): string[] {
  const roots = ["app", "pages", "src", "packages", "components", "lib", "server", "supabase", "prisma", "docs"];
  return roots.filter((root) => files.some((file) => file === root || file.startsWith(`${root}/`)));
}

function detectPages(files: string[]): ProjectKnowledge["pages"] {
  const pages: ProjectKnowledge["pages"] = [];
  for (const file of files) {
    if (!/^(app|src\/app|pages)\//.test(file)) continue;
    if (/\/route\.(ts|js)$/.test(file)) {
      pages.push({ route: routeFromAppFile(file), file, type: "api" });
    } else if (/\/page\.(tsx|jsx|ts|js|mdx)$/.test(file) || /^pages\/.*\.(tsx|jsx|ts|js|mdx)$/.test(file)) {
      pages.push({ route: routeFromPageFile(file), file, type: "page" });
    } else if (/\/layout\.(tsx|jsx|ts|js)$/.test(file)) {
      pages.push({ route: routeFromAppFile(file), file, type: "layout" });
    }
  }
  return pages.slice(0, 200);
}

async function detectComponents(root: string, files: string[]): Promise<ProjectKnowledge["components"]> {
  const candidates = files.filter((file) => /\.(tsx|jsx)$/.test(file) && /(^components\/|\/components\/|^app\/|^src\/)/.test(file));
  const components: ProjectKnowledge["components"] = [];
  for (const file of candidates.slice(0, 400)) {
    const text = await readTextFile(fromRoot(root, file));
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
  return dedupeBy(components, (item) => `${item.name}:${item.file}`).slice(0, 200);
}

async function detectApis(root: string, files: string[]): Promise<ProjectKnowledge["apis"]> {
  const apis: ProjectKnowledge["apis"] = [];
  for (const file of files) {
    if (/^(app|src\/app)\/.*\/route\.(ts|js)$/.test(file)) {
      const text = await readTextFile(fromRoot(root, file));
      apis.push({ kind: "next-route", route: routeFromAppFile(file), file, methods: detectHttpMethods(text) });
    } else if (/^pages\/api\/.*\.(ts|js)$/.test(file)) {
      apis.push({ kind: "pages-api", route: routeFromPagesApi(file), file });
    }
  }
  const routeFiles = files.filter((file) => /\.(ts|js)$/.test(file) && !file.includes(".d.ts")).slice(0, 600);
  for (const file of routeFiles) {
    const text = await readTextFile(fromRoot(root, file));
    for (const match of text.matchAll(/\b(?:app|router)\.(get|post|put|patch|delete)\(["'`]([^"'`]+)["'`]/g)) {
      apis.push({ kind: "express", route: match[2], file, methods: [match[1].toUpperCase()] });
    }
  }
  const cliCommands = await detectCliCommands(root, files);
  for (const command of cliCommands) {
    apis.push({ kind: "cli-command", route: `dev-guard ${command}`, file: "packages/cli/src/index.ts" });
  }
  return dedupeBy(apis, (item) => `${item.kind}:${item.route}:${item.file}`).slice(0, 250);
}

async function detectDatabase(root: string, files: string[]): Promise<ProjectKnowledge["database"]> {
  const database: ProjectKnowledge["database"] = [];
  for (const file of files) {
    if (/^supabase\/.*\.(sql|ts)$/.test(file)) {
      database.push({ kind: "supabase", path: file, tables: await detectSqlTables(root, file) });
    } else if (/^prisma\/.*\.(prisma|sql)$/.test(file)) {
      database.push({ kind: "prisma", path: file, tables: await detectSqlTables(root, file) });
    } else if (/migrations\/.*\.sql$/.test(file)) {
      database.push({ kind: "sql-migration", path: file, tables: await detectSqlTables(root, file) });
    }
  }
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
