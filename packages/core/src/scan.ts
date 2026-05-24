import { dirname, extname, posix } from "node:path";
import type {
  CodeGraphEntry,
  FileSummary,
  ImpactHint,
  ProjectIndexEntry,
  ProjectRefreshInput,
  ProjectRefreshResult,
  ProjectScanInputFile,
  ProjectScanResult
} from "./types.js";

export function buildProjectScan(files: ProjectScanInputFile[]): ProjectScanResult {
  const index = files.map(buildProjectIndexEntry).sort((a, b) => a.path.localeCompare(b.path));
  const summaries = buildFileSummaries(index);
  const codeGraph = buildCodeGraph(files, index);

  return {
    index,
    summaries,
    projectMapMarkdown: buildProjectMapMarkdown(index, summaries),
    codeGraph
  };
}

export function refreshProjectScan(input: ProjectRefreshInput): ProjectRefreshResult {
  const removed = new Set(input.removedPaths);
  const updatedEntries = input.updatedFiles.map(buildProjectIndexEntry);
  const updatedPaths = new Set(updatedEntries.map((entry) => entry.path));
  const index = [
    ...input.existingIndex.filter((entry) => !removed.has(entry.path) && !updatedPaths.has(entry.path)),
    ...updatedEntries
  ].sort((a, b) => a.path.localeCompare(b.path));
  const summaries = buildFileSummaries(index);
  const codeGraph = refreshCodeGraph(input.existingCodeGraph ?? [], input.updatedFiles, index, removed);

  return {
    index,
    summaries,
    projectMapMarkdown: buildProjectMapMarkdown(index, summaries),
    codeGraph,
    updatedPaths: [...updatedPaths].sort(),
    removedPaths: [...removed].sort(),
    unchangedCount: input.existingIndex.filter((entry) => !removed.has(entry.path) && !updatedPaths.has(entry.path)).length
  };
}

export function buildCodeGraph(files: ProjectScanInputFile[], index: ProjectIndexEntry[] = files.map(buildProjectIndexEntry)): CodeGraphEntry[] {
  const fileSet = new Set(files.map((file) => file.path));
  const indexByPath = new Map(index.map((entry) => [entry.path, entry]));
  const entries = files.map((file) => buildCodeGraphEntry(file, fileSet, indexByPath));
  return attachReverseDependencies(entries);
}

export function buildImpactHints(changedFiles: string[], codeGraph: CodeGraphEntry[], limit = 5): ImpactHint[] {
  const graphByFile = new Map(codeGraph.map((entry) => [entry.file, entry]));
  return [...new Set(changedFiles)]
    .map((file) => {
      const entry = graphByFile.get(file);
      if (!entry || entry.importedBy.length === 0) {
        return undefined;
      }
      const affectedAreas = [...new Set(entry.importedBy.map((importer) => graphByFile.get(importer)?.category ?? areaFromPath(importer)))].slice(0, 6);
      return {
        file,
        importedByCount: entry.importedBy.length,
        importedBy: entry.importedBy.slice(0, limit),
        impactCandidates: entry.impactCandidates.slice(0, limit),
        affectedAreas
      };
    })
    .filter((hint): hint is ImpactHint => Boolean(hint))
    .sort((a, b) => b.importedByCount - a.importedByCount || a.file.localeCompare(b.file))
    .slice(0, limit);
}

function refreshCodeGraph(
  existingCodeGraph: CodeGraphEntry[],
  updatedFiles: ProjectScanInputFile[],
  index: ProjectIndexEntry[],
  removed: Set<string>
): CodeGraphEntry[] {
  const updatedPaths = new Set(updatedFiles.map((file) => file.path));
  const existingFiles = new Set([
    ...existingCodeGraph.map((entry) => entry.file),
    ...updatedFiles.map((file) => file.path),
    ...index.map((entry) => entry.path)
  ].filter((path) => !removed.has(path)));
  const indexByPath = new Map(index.map((entry) => [entry.path, entry]));
  const retained = existingCodeGraph
    .filter((entry) => !removed.has(entry.file) && !updatedPaths.has(entry.file))
    .map((entry) => ({
      ...entry,
      imports: entry.imports.filter((file) => existingFiles.has(file)),
      importedBy: []
    }));
  const updated = updatedFiles.map((file) => buildCodeGraphEntry(file, existingFiles, indexByPath));

  return attachReverseDependencies([...retained, ...updated]);
}

function buildCodeGraphEntry(
  file: ProjectScanInputFile,
  fileSet: Set<string>,
  indexByPath: Map<string, ProjectIndexEntry>
): CodeGraphEntry {
  const imports = extractImportSpecifiers(file.content)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolveImportPath(file.path, specifier, fileSet))
    .filter((path): path is string => Boolean(path));
  const exports = extractExportHints(file.content);
  const index = indexByPath.get(file.path);
  const category = index?.category ?? categorize(file.path, index?.keywords ?? []);

  return {
    file: file.path,
    imports: [...new Set(imports)].sort(),
    importedBy: [],
    exports,
    category,
    impactCandidates: [],
    usageHints: buildUsageHints(file.path, category, exports)
  };
}

function attachReverseDependencies(entries: CodeGraphEntry[]): CodeGraphEntry[] {
  const entryByFile = new Map(entries.map((entry) => [entry.file, { ...entry, importedBy: [] as string[] }]));
  for (const entry of entryByFile.values()) {
    for (const imported of entry.imports) {
      const target = entryByFile.get(imported);
      if (target) {
        target.importedBy.push(entry.file);
      }
    }
  }

  return [...entryByFile.values()]
    .map((entry) => {
      const importedBy = [...new Set(entry.importedBy)].sort();
      const impactCandidates = [...new Set([...importedBy, ...entry.imports])].slice(0, 12);
      return {
        ...entry,
        importedBy,
        impactCandidates,
        usageHints: [
          ...entry.usageHints,
          importedBy.length > 0 ? `used by ${importedBy.length} file(s)` : ""
        ].filter(Boolean)
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

function extractImportSpecifiers(content: string): string[] {
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^'"]+\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
  ];

  return [...new Set(patterns.flatMap((pattern) => [...content.matchAll(pattern)].map((match) => match[1]).filter(Boolean)))];
}

function extractExportHints(content: string): string[] {
  const named = [
    ...content.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z0-9_]+)/g),
    ...content.matchAll(/\bexport\s+default\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)
  ].map((match) => match[1]);
  const grouped = [...content.matchAll(/\bexport\s*\{([^}]+)\}/g)].flatMap((match) =>
    (match[1] ?? "")
      .split(",")
      .map((item) => item.replace(/\s+as\s+.+$/i, "").trim())
      .filter(Boolean)
  );
  return [...new Set([...named, ...grouped].map(cleanKeyword).filter(Boolean))].slice(0, 30);
}

function resolveImportPath(fromFile: string, specifier: string, fileSet: Set<string>): string | undefined {
  const base = posix.normalize(posix.join(dirname(fromFile), specifier));
  const withoutJsExtension = base.replace(/\.(?:js|jsx|mjs|cjs)$/, "");
  const candidates = [
    base,
    withoutJsExtension,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].map((extension) => `${withoutJsExtension}${extension}`),
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].map((extension) => `${base}${extension}`),
    ...["index.ts", "index.tsx", "index.js", "index.jsx"].map((indexFile) => posix.join(base, indexFile))
  ];
  return candidates.find((candidate) => fileSet.has(candidate));
}

function buildUsageHints(file: string, category: string, exports: string[]): string[] {
  const hints = [`category:${category}`];
  if (/^(app|pages)\//.test(file)) {
    hints.push(`route:${routeFromPath(file)}`);
  }
  const components = exports.filter((name) => /^[A-Z]/.test(name)).slice(0, 3);
  if (components.length > 0) {
    hints.push(`component:${components.join(",")}`);
  }
  return hints;
}

function routeFromPath(file: string): string {
  return `/${file
    .replace(/^(app|pages)\//, "")
    .replace(/\/(page|route|index)\.[^.]+$/, "")
    .replace(/\.[^.]+$/, "")}`;
}

function areaFromPath(file: string): string {
  const parts = file.split("/");
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0] || "general";
}

export function selectRelatedFilesFromScan(requirement: string, index: ProjectIndexEntry[], summaries: FileSummary[]): string[] {
  const tokens = extractScanTokens(requirement);
  const scores = new Map<string, number>();

  for (const entry of index) {
    const haystack = [entry.path, entry.category, ...entry.keywords].join(" ").toLowerCase();
    for (const token of tokens) {
      if (haystack.includes(token)) {
        scores.set(entry.path, (scores.get(entry.path) ?? 0) + 2 + priorityBonus(entry.path, token));
      }
    }
  }

  for (const summary of summaries) {
    const haystack = [summary.path, summary.role, ...summary.keywords, ...summary.features].join(" ").toLowerCase();
    for (const token of tokens) {
      if (haystack.includes(token)) {
        scores.set(summary.path, (scores.get(summary.path) ?? 0) + 3 + priorityBonus(summary.path, token));
      }
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([path]) => path)
    .slice(0, 8);
}

export function buildProjectIndexEntry(file: ProjectScanInputFile): ProjectIndexEntry {
  const keywords = extractKeywords(file.path, file.content);

  return {
    path: file.path,
    extension: extname(file.path).replace(".", ""),
    category: categorize(file.path, keywords),
    keywords,
    size: file.size,
    lastModified: file.lastModified,
    hash: file.hash
  };
}

export function buildFileSummaries(index: ProjectIndexEntry[]): FileSummary[] {
  return index.map((entry) => buildFileSummary(entry, index));
}

function buildFileSummary(entry: ProjectIndexEntry, index: ProjectIndexEntry[]): FileSummary {
  const relatedFiles = index
    .filter((candidate) => candidate.path !== entry.path && candidate.category === entry.category)
    .map((candidate) => candidate.path)
    .slice(0, 8);

  return {
    path: entry.path,
    role: describeRole(entry),
    keywords: entry.keywords.slice(0, 20),
    features: inferFeatures(entry),
    relatedFiles
  };
}

export function buildProjectMapMarkdown(index: ProjectIndexEntry[], summaries: FileSummary[]): string {
  const categories = [...new Set(index.map((entry) => entry.category))].sort();
  const sections = categories.map((category) => {
    const entries = index.filter((entry) => entry.category === category).slice(0, 20);
    const files = entries
      .map((entry) => {
        const summary = summaries.find((item) => item.path === entry.path);
        return `- ${entry.path}: ${summary?.role ?? describeRole(entry)}`;
      })
      .join("\n");
    return `## ${category}\n${files}`;
  });

  return `# Dev Guard Project Map\n\nGenerated by \`dev-guard scan\`.\n\n${sections.join("\n\n")}\n`;
}

function categorize(path: string, keywords: string[]): string {
  const haystack = `${path} ${keywords.join(" ")}`.toLowerCase();
  const rules: Array<[string, RegExp]> = [
    ["auth", /auth|login|kakao|oauth|sign/],
    ["settings", /settings|setting|설정/],
    ["admin", /admin|관리자/],
    ["dashboard", /dashboard|home|홈/],
    ["tree", /tree|leaf|트리|잎/],
    ["supabase", /supabase/],
    ["api", /api|route|endpoint/],
    ["styles", /css|scss|style|theme|dark|light/],
    ["config", /config|tsconfig|eslint|tailwind|package\.json/],
    ["ui", /component|button|modal|dialog|card|ui/]
  ];

  return rules.find(([, pattern]) => pattern.test(haystack))?.[0] ?? "general";
}

function extractKeywords(path: string, content: string): string[] {
  const pathTokens = path.split(/[/.\\_-]+/g);
  const codeTokens = [
    ...content.matchAll(/\b(?:export\s+)?(?:function|const|class)\s+([A-Za-z0-9_]+)/g),
    ...content.matchAll(/\bexport\s+default\s+function\s+([A-Za-z0-9_]+)/g)
  ].map((match) => match[1]);
  const routeTokens = [...path.matchAll(/(?:app|pages)\/([^/]+)/g)].map((match) => match[1]);

  return [...new Set([...pathTokens, ...codeTokens, ...routeTokens].map(cleanKeyword).filter(Boolean))].slice(0, 40);
}

function inferFeatures(entry: ProjectIndexEntry): string[] {
  return [...new Set([entry.category, ...entry.keywords.filter((keyword) => keyword.length > 3)])].slice(0, 12);
}

function describeRole(entry: ProjectIndexEntry): string {
  if (entry.category === "config") {
    return "Project configuration or build setup file.";
  }

  if (entry.category === "styles") {
    return "Styling/theme related file.";
  }

  return `${entry.category} related code or UI file.`;
}

function extractScanTokens(text: string): string[] {
  const aliases: Record<string, string[]> = {
    설정: ["settings", "setting", "설정"],
    관리자: ["admin", "관리자"],
    의견: ["feedback", "opinion", "comment", "의견", "피드백"],
    피드백: ["feedback", "opinion", "comment", "의견", "피드백"],
    문의: ["contact", "inquiry", "support", "문의"],
    카카오: ["kakao", "카카오"],
    로그인: ["login", "auth", "로그인"],
    트리: ["tree", "leaf", "트리"],
    홈: ["home", "dashboard", "홈"]
  };
  const raw = text.toLowerCase().match(/[a-z0-9가-힣]{2,}/g) ?? [];
  const expanded = raw.flatMap((token) => aliases[token] ?? [token]);

  return [...new Set(expanded.map((token) => token.toLowerCase()))].slice(0, 30);
}

function priorityBonus(path: string, token: string): number {
  const lowerPath = path.toLowerCase();
  const highPriority = [
    "app/settings",
    "components/settings",
    "settings",
    "app/admin",
    "components/admin",
    "admin",
    "feedback",
    "contact"
  ];
  const relevantTokens = ["settings", "설정", "admin", "관리자", "feedback", "피드백", "의견", "contact", "문의"];

  if (highPriority.some((pattern) => lowerPath.includes(pattern)) && relevantTokens.includes(token)) {
    return 5;
  }

  return 0;
}

function cleanKeyword(keyword: string | undefined): string {
  if (!keyword) {
    return "";
  }

  const cleaned = keyword.trim();
  if (cleaned.length < 2 || /^\d+$/.test(cleaned)) {
    return "";
  }

  return cleaned;
}
