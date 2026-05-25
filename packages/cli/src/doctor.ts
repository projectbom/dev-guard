import { stat } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { fromRoot } from "./fs.js";
import { hasGitBaseline, getProjectFiles } from "./git.js";
import { detectProject } from "./project-detection.js";
import { fileExists } from "./project-memory.js";
import { listRunLogs } from "./runs.js";
import { readDriftTelemetryStats } from "./drift-telemetry.js";

export async function runDoctor(root: string): Promise<void> {
  const [resolved, baseline, projectFiles, runs, telemetry, cacheSize] = await Promise.all([
    loadConfig(root),
    hasGitBaseline(root).catch(() => false),
    getProjectFiles(root).catch(() => []),
    listRunLogs(root),
    readDriftTelemetryStats(root),
    memoryCacheSize(root)
  ]);
  const project = await detectProject(root, projectFiles).catch(() => undefined);
  const provider = resolved.config.ai?.provider ?? "none";
  const model = resolved.config.ai?.model ?? "gpt-4o-mini";
  const staleRuns = runs.filter((run) => isStale(run.createdAt)).length;
  const apiKeyFound = provider === "openai" ? resolved.env.apiKey.found : false;

  console.log("dev-guard doctor");
  console.log(`Provider: ${provider}`);
  console.log(`Model: ${model}`);
  console.log(`API Key: ${provider === "openai" ? (apiKeyFound ? "found" : "missing") : "not required"}`);
  console.log(`Config Source: ${resolved.source}`);
  console.log("ENV:");
  console.log(`- DEV_GUARD_OPENAI_API_KEY: ${resolved.env.apiKey.checked[0]?.found ? "found" : "missing"}`);
  console.log(`- OPENAI_API_KEY: ${resolved.env.apiKey.checked[1]?.found ? "found" : "missing"}`);
  console.log(`- selected provider: ${provider}`);
  console.log(`- selected model: ${model}`);
  console.log(`- selected API key source: ${resolved.env.apiKey.selectedKey ?? "none"}`);
  for (const warning of resolved.warnings) {
    console.log(`Config Warning: ${warning}`);
  }
  console.log(`Git Baseline: ${baseline ? "present" : "missing"}`);
  if (!baseline) {
    console.log('Git Baseline Recovery: git add . && git commit -m "initial commit"');
  }
  console.log(`Framework: ${project?.frameworks.join(", ") || "(unknown)"}`);
  console.log(`Language: ${project?.language ?? "(unknown)"}`);
  console.log(`Runtime: ${project?.runtime ?? "(unknown)"}`);
  console.log(`Package Manager: ${project?.packageManager ?? "(unknown)"}`);
  console.log(`Drift Telemetry: enabled (${telemetry.events} stored events)`);
  console.log(`Watch Capability: polling watch available; auto-refresh only by default`);
  console.log(`Local Heuristic Review: available (dev-guard review --heuristic)`);
  console.log(`Local Heuristic Check: available (dev-guard check --local)`);
  console.log(`Memory Runs: ${runs.length}`);
  console.log(`Stale Runs: ${staleRuns}`);
  console.log(`Memory Cache Size: ${cacheSize} bytes`);
  console.log(`Project Memory: ${(await fileExists(root, ".devguard/project-index.json")) ? "present" : "missing"}`);
  console.log(`Next: ${baseline ? "run dev-guard check --local before commit" : "create an initial git commit to reduce noisy untracked output"}`);
}

async function memoryCacheSize(root: string): Promise<number> {
  const files = [
    ".devguard/project-index.json",
    ".devguard/file-summaries.json",
    ".devguard/project-map.md",
    ".devguard/project-identity.json",
    ".devguard/drift-telemetry.json"
  ];
  const sizes = await Promise.all(
    files.map(async (file) => {
      try {
        return (await stat(fromRoot(root, file))).size;
      } catch {
        return 0;
      }
    })
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

function isStale(createdAt: string): boolean {
  const ageDays = (Date.now() - Date.parse(createdAt)) / 86_400_000;
  return Number.isFinite(ageDays) && ageDays > 90;
}
