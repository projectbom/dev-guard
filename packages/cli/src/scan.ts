import { buildProjectScan } from "@dev-guard/core";
import { loadConfig } from "./config.js";
import { fromRoot, writeTextFile } from "./fs.js";
import { getProjectFiles } from "./git.js";
import { detectProject } from "./project-detection.js";
import { readScanInputFile } from "./project-memory.js";
import { loadCurrentProjectIdentity, writeProjectIdentity } from "./project-identity.js";

interface ScanOptions {
  full: boolean;
  ai: boolean;
}

export async function runScan(root: string, args: string[]): Promise<void> {
  const options = parseScanOptions(args);
  const resolvedConfig = await loadConfig(root);
  const config = resolvedConfig.config;
  const projectFiles = await getProjectFiles(root);
  const detection = await detectProject(root, projectFiles);
  const inputFiles = await Promise.all(projectFiles.map((path) => readScanInputFile(root, path)));
  const scan = buildProjectScan(inputFiles);
  const identity = await loadCurrentProjectIdentity(root, projectFiles);

  await Promise.all([
    writeTextFile(fromRoot(root, ".devguard/project-index.json"), `${JSON.stringify(scan.index, null, 2)}\n`),
    writeTextFile(fromRoot(root, ".devguard/file-summaries.json"), `${JSON.stringify(scan.summaries, null, 2)}\n`),
    writeTextFile(fromRoot(root, ".devguard/project-map.md"), scan.projectMapMarkdown),
    writeProjectIdentity(root, identity)
  ]);

  console.log("dev-guard scan");
  console.log("Detected project:");
  console.log(`- package: ${detection.packageName}`);
  console.log(`- package manager: ${detection.packageManager}`);
  console.log(`- language: ${detection.language}`);
  console.log(`- runtime: ${detection.runtime}`);
  console.log(`- frameworks: ${detection.frameworks.length > 0 ? detection.frameworks.join(", ") : "none detected"}`);
  console.log(`- config source: ${resolvedConfig.source}`);
  console.log(`- markdown files: ${detection.markdownFiles.length > 0 ? detection.markdownFiles.join(", ") : "none detected"}`);
  console.log(`- context candidates: ${detection.contextCandidates.length > 0 ? detection.contextCandidates.join(", ") : "none detected"}`);
  console.log(`- project root: ${identity.root}`);
  console.log(`- root isolation: only files under this root are scanned`);
  console.log(`- files indexed: ${scan.index.length}`);
  console.log(`- mode: ${options.full ? "full" : "standard"}`);
  console.log(`- summaries: ${options.ai && config.ai?.provider !== "none" ? "rule-based (AI summary hook reserved)" : "rule-based"}`);
  console.log("- wrote: .devguard/project-index.json");
  console.log("- wrote: .devguard/file-summaries.json");
  console.log("- wrote: .devguard/project-map.md");
  console.log("- wrote: .devguard/project-identity.json");
  console.log("- reason: refresh project memory for task-ai/review/report");
  console.log("- skipped: node_modules, .git, .next, dist, build, coverage, lockfiles, binary assets");
  console.log("- next: run dev-guard task-ai \"<requirement>\" --debug-context or dev-guard check");
  console.log(`- project fingerprint: ${identity.fingerprint}`);
}

function parseScanOptions(args: string[]): ScanOptions {
  return {
    full: args.includes("--full"),
    ai: args.includes("--ai")
  };
}
