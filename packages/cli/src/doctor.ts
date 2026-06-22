import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { fromRoot, readTextFile } from "./fs.js";
import { hasGitBaseline, getProjectFiles } from "./git.js";
import { getHookStatus, hookConfigPaths, claudeHookCommand, codexHookCommand } from "./hooks.js";
import { detectProject } from "./project-detection.js";
import { fileExists } from "./project-memory.js";
import { listRunLogs } from "./runs.js";
import { readDriftTelemetryStats } from "./drift-telemetry.js";
import { readRuntimeState } from "./runtime-state.js";
import { formatStrategyFlag, getAgentStrategyReport } from "./agent-strategies.js";
import { formatNotifyCommand, getCodexNotifyConfigStatus } from "./codex-notify.js";

export async function runDoctor(root: string, args: string[] = []): Promise<void> {
  if (args.includes("--agents")) {
    await runAgentDoctor(root);
    return;
  }
  if (args.includes("--hooks")) {
    await runHookDoctor(root, { dryRun: args.includes("--dry-run") });
    return;
  }

  const initialized = await isDevGuardInitialized(root);
  const [resolved, baseline, projectFiles, runs, telemetry, cacheSize, hookStatus, runtime] = await Promise.all([
    loadConfig(root),
    hasGitBaseline(root).catch(() => false),
    getProjectFiles(root).catch(() => []),
    listRunLogs(root),
    readDriftTelemetryStats(root),
    memoryCacheSize(root),
    getHookStatus(root),
    readRuntimeState(root)
  ]);
  const project = await detectProject(root, projectFiles).catch(() => undefined);
  const claudeCommand = await readHookCommand(root, hookConfigPaths.claudeSettingsPath, hookConfigPaths.claudeHookPath).catch(() => undefined);
  const codexCommand = await readHookCommand(root, hookConfigPaths.codexHooksPath, hookConfigPaths.codexHookPath).catch(() => undefined);
  const claudeTarget = resolveHookCommandTarget(root, claudeCommand ?? claudeHookCommand);
  const codexTarget = resolveHookCommandTarget(root, codexCommand ?? codexHookCommand);
  const provider = resolved.config.ai?.provider ?? "none";
  const model = resolved.config.ai?.model ?? "gpt-4o-mini";
  const staleRuns = runs.filter((run) => isStale(run.createdAt)).length;
  const apiKeyFound = provider === "openai" ? resolved.env.apiKey.found : false;

  console.log("dev-guard doctor");
  if (!initialized) {
    console.log("Setup: DevGuard project files are not initialized yet. Run dev-guard init, then dev-guard install-agent-instructions.");
  }
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
  console.log("");
  console.log("Hooks:");
  console.log(`- .devguard directory exists: ${await existsPath(root, ".devguard") ? "yes" : "no"}`);
  console.log(`- hook scripts exist: ${hookStatus.claudeHookFile && hookStatus.codexHookFile ? "yes" : "no"}`);
  console.log(`- hook scripts executable: ${(await isExecutable(root, hookConfigPaths.claudeHookPath)) && (await isExecutable(root, hookConfigPaths.codexHookPath)) ? "yes" : "no"}`);
  console.log(`- .claude/settings.json exists: ${hookStatus.claudeInstalled ? "yes" : "no"}`);
  console.log(`- .codex/hooks.json exists: ${hookStatus.codexInstalled ? "yes" : "no"}`);
  console.log(`- Claude hook command path: ${claudeCommand ?? "(not found; expected " + claudeHookCommand + ")"}`);
  console.log(`- Codex hook command path: ${codexCommand ?? "(not found; expected " + codexHookCommand + ")"}`);
  console.log(`- Claude hook command target exists: ${claudeTarget && await existsAbsolutePath(claudeTarget) ? "yes" : "no"}`);
  console.log(`- Codex hook command target exists: ${codexTarget && await existsAbsolutePath(codexTarget) ? "yes" : "no"}`);
  console.log(`- latest hook log exists: ${await latestHookLogExists(root) ? "yes" : "no"}`);
  console.log(`- latest hook trigger time: ${hookStatus.lastTrigger ?? "none"}`);
  console.log(`- latest hook success: ${hookStatus.lastSuccess === undefined ? "unknown" : hookStatus.lastSuccess ? "yes" : "no"}`);
  console.log(`- pending files count: ${runtime.pendingChangedFiles.length}`);
  console.log(`- runtime status: ${runtime.lastStatus ?? "idle"}`);
  console.log(`Next: ${baseline ? "run dev-guard check --local before commit" : "create an initial git commit to reduce noisy untracked output"}`);
  console.log(`Hook Next: ${expectedHookNextStep(hookStatus, runtime.pendingChangedFiles.length, runtime.lastStatus)}`);
  console.log("");
  await printAgentStrategies(root);
}

async function isDevGuardInitialized(root: string): Promise<boolean> {
  return (await existsPath(root, ".devguard/config.json")) || (await existsPath(root, ".devguard/task.md")) || (await existsPath(root, "docs/PROJECT_STATE.md"));
}

async function runHookDoctor(root: string, options: { dryRun: boolean }): Promise<void> {
  const beforeStatus = await getHookStatus(root);
  const runtime = await readRuntimeState(root);
  const claudeCommand = await readHookCommand(root, hookConfigPaths.claudeSettingsPath, hookConfigPaths.claudeHookPath).catch(() => undefined);
  const codexCommand = await readHookCommand(root, hookConfigPaths.codexHooksPath, hookConfigPaths.codexHookPath).catch(() => undefined);
  const claudeTarget = resolveHookCommandTarget(root, claudeCommand ?? claudeHookCommand);
  const codexTarget = resolveHookCommandTarget(root, codexCommand ?? codexHookCommand);

  console.log("dev-guard doctor --hooks");
  if (options.dryRun) {
    console.log("Mode: dry-run (hook scripts are not executed)");
  } else {
    console.log("Mode: active");
    console.log("Warning: doctor --hooks directly executes hook scripts; this can run dev-guard done and dev-guard status.");
  }
  console.log("");
  console.log("Files");
  console.log(`.devguard directory exists: ${await existsPath(root, ".devguard") ? "yes" : "no"}`);
  console.log(`Claude hook script exists: ${await existsPath(root, hookConfigPaths.claudeHookPath) ? "yes" : "no"}`);
  console.log(`Codex hook script exists: ${await existsPath(root, hookConfigPaths.codexHookPath) ? "yes" : "no"}`);
  console.log(`Claude hook script executable: ${await isExecutable(root, hookConfigPaths.claudeHookPath) ? "yes" : "no"}`);
  console.log(`Codex hook script executable: ${await isExecutable(root, hookConfigPaths.codexHookPath) ? "yes" : "no"}`);
  console.log(`.claude/settings.json exists: ${await existsPath(root, hookConfigPaths.claudeSettingsPath) ? "yes" : "no"}`);
  console.log(`.codex/hooks.json exists: ${await existsPath(root, hookConfigPaths.codexHooksPath) ? "yes" : "no"}`);
  console.log("");
  console.log("Commands");
  console.log(`Claude hook command path: ${claudeCommand ?? "(not found; expected " + claudeHookCommand + ")"}`);
  console.log(`Codex hook command path: ${codexCommand ?? "(not found; expected " + codexHookCommand + ")"}`);
  console.log(`Claude command target: ${claudeTarget ?? "unparseable"}`);
  console.log(`Codex command target: ${codexTarget ?? "unparseable"}`);
  console.log(`Claude command target exists: ${claudeTarget && await existsAbsolutePath(claudeTarget) ? "yes" : "no"}`);
  console.log(`Codex command target exists: ${codexTarget && await existsAbsolutePath(codexTarget) ? "yes" : "no"}`);
  console.log(`Claude command parseable: ${claudeTarget ? "yes" : "no"}`);
  console.log(`Codex command parseable: ${codexTarget ? "yes" : "no"}`);
  console.log("");
  console.log("Runtime");
  console.log(`latest hook log exists: ${await latestHookLogExists(root) ? "yes" : "no"}`);
  console.log(`latest hook trigger time: ${beforeStatus.lastTrigger ?? "none"}`);
  console.log(`latest hook success: ${beforeStatus.lastSuccess === undefined ? "unknown" : beforeStatus.lastSuccess ? "yes" : "no"}`);
  console.log(`pending files count: ${runtime.pendingChangedFiles.length}`);
  console.log(`runtime status: ${runtime.lastStatus ?? "idle"}`);

  if (!options.dryRun) {
    console.log("");
    console.log("Direct hook execution tests");
    const tests = [
      { label: ".devguard/hooks/claude-stop.sh", path: hookConfigPaths.claudeHookPath },
      { label: "echo '{}' | .devguard/hooks/claude-stop.sh", path: hookConfigPaths.claudeHookPath, input: "{}\n" },
      { label: ".devguard/hooks/codex-stop.sh", path: hookConfigPaths.codexHookPath },
      { label: "echo '{}' | .devguard/hooks/codex-stop.sh", path: hookConfigPaths.codexHookPath, input: "{}\n" }
    ];
    for (const test of tests) {
      const result = runHookScript(root, test.path, test.input);
      console.log(`${test.label}: ${result.ok ? "PASS" : "FAIL"} exit=${result.status ?? "signal"} duration_ms=${result.durationMs}`);
      if (!result.ok && result.error) console.log(`  ${result.error}`);
    }
  }

  const afterStatus = await getHookStatus(root);
  console.log("");
  console.log("After");
  console.log(`hook log generated: ${await latestHookLogExists(root) ? "yes" : "no"}`);
  console.log(`status Last Hook Trigger: ${afterStatus.lastTrigger ?? "none"}`);
  console.log(`status Last Hook Success: ${afterStatus.lastSuccess === undefined ? "unknown" : afterStatus.lastSuccess ? "yes" : "no"}`);
  console.log("");
  console.log("Expected next step:");
  console.log(expectedHookNextStep(afterStatus, runtime.pendingChangedFiles.length, runtime.lastStatus));
}

async function runAgentDoctor(root: string): Promise<void> {
  console.log("dev-guard doctor --agents");
  await printAgentStrategies(root);
}

async function printAgentStrategies(root: string): Promise<void> {
  const report = await getAgentStrategyReport(root);
  const codexNotify = await getCodexNotifyConfigStatus();
  console.log("Agent Strategies");
  console.log("");
  console.log("Claude Code");
  printStrategy(report.claude);
  console.log("");
  console.log("Codex");
  console.log(`- recommended strategy: ${report.codexNotify.name}`);
  console.log(`- user-level notify configured: ${formatStrategyFlag(codexNotify.notifyConfigured)}`);
  console.log(`- existing notify detected: ${formatStrategyFlag(codexNotify.existingNotifyDetected)}`);
  console.log(`- notify command: ${formatNotifyCommand(codexNotify.notify)}`);
  console.log(`- dispatcher installed: ${formatStrategyFlag(codexNotify.dispatcherInstalled)}`);
  console.log(`- dispatcher configured: ${formatStrategyFlag(codexNotify.notifyIsDispatcher)}`);
  console.log(`- dispatcher path: ${codexNotify.dispatcherPath}`);
  console.log(`- notify available: ${formatStrategyFlag(report.codexNotify.available)}`);
  console.log(`- notify installed: ${formatStrategyFlag(report.codexNotify.installed)}`);
  console.log(`- notify script verified: ${formatStrategyFlag(report.codexNotify.scriptVerified)}`);
  console.log(`- notify runtime verified: ${formatStrategyFlag(report.codexNotify.runtimeVerified)}`);
  console.log(`- stop hook installed: ${formatStrategyFlag(report.codexStopHook.installed)}`);
  console.log(`- stop hook script verified: ${formatStrategyFlag(report.codexStopHook.scriptVerified)}`);
  console.log(`- stop hook requires trust: ${formatStrategyFlag(report.codexStopHook.requiresUserTrust)}`);
  console.log(`- stop hook runtime verified: ${formatStrategyFlag(report.codexStopHook.runtimeVerified)}`);
  console.log(`- jsonl listener installed: ${formatStrategyFlag(report.codexJsonlListener.installed)}`);
  console.log(`- jsonl listener runtime verified: ${formatStrategyFlag(report.codexJsonlListener.runtimeVerified)}`);
  console.log(`- next: ${report.codexNotify.runtimeVerified ? "Codex notify runtime verified." : report.codexNotify.next}`);
  if (!report.codexStopHook.runtimeVerified) {
    console.log(`- stop hook next: ${report.codexStopHook.next}`);
  }
  console.log("");
  console.log("Manual");
  printStrategy(report.manual);
}

function printStrategy(strategy: Awaited<ReturnType<typeof getAgentStrategyReport>>["strategies"][number]): void {
  console.log(`- strategy: ${strategy.name}`);
  console.log(`- available: ${formatStrategyFlag(strategy.available)}`);
  console.log(`- installed: ${formatStrategyFlag(strategy.installed)}`);
  console.log(`- script verified: ${formatStrategyFlag(strategy.scriptVerified)}`);
  console.log(`- runtime verified: ${formatStrategyFlag(strategy.runtimeVerified)}`);
  console.log(`- requires user trust: ${formatStrategyFlag(strategy.requiresUserTrust)}`);
  console.log(`- recommended: ${formatStrategyFlag(strategy.recommended)}`);
  console.log(`- next: ${strategy.next}`);
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

async function existsPath(root: string, path: string): Promise<boolean> {
  return existsAbsolutePath(fromRoot(root, path));
}

async function existsAbsolutePath(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(root: string, path: string): Promise<boolean> {
  try {
    await access(fromRoot(root, path), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readHookCommand(root: string, configPath: string, hookPath: string): Promise<string | undefined> {
  const text = await readTextFile(fromRoot(root, configPath));
  const parsed = JSON.parse(text || "{}") as unknown;
  return findHookCommand(parsed, hookPath);
}

function findHookCommand(value: unknown, hookPath: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findHookCommand(item, hookPath);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.command === "string" && obj.command.includes(hookPath)) {
      return obj.command;
    }
    for (const item of Object.values(obj)) {
      const found = findHookCommand(item, hookPath);
      if (found) return found;
    }
  }
  return undefined;
}

function resolveHookCommandTarget(root: string, command: string): string | undefined {
  let value = command.trim();
  if (!value) return undefined;
  value = value.replace(/\$\{CLAUDE_PROJECT_DIR\}/g, root);
  value = value.replace(/\$\(git rev-parse --show-toplevel\)/g, root);
  value = stripMatchingQuotes(value);
  return value.startsWith("/") ? value : undefined;
}

function stripMatchingQuotes(value: string): string {
  let next = value.trim();
  while ((next.startsWith('"') && next.endsWith('"')) || (next.startsWith("'") && next.endsWith("'"))) {
    next = next.slice(1, -1).trim();
  }
  return next;
}

async function latestHookLogExists(root: string): Promise<boolean> {
  return (await existsPath(root, hookConfigPaths.claudeLogPath)) || (await existsPath(root, hookConfigPaths.codexLogPath));
}

function runHookScript(root: string, path: string, input?: string): { ok: boolean; status: number | null; durationMs: number; error?: string } {
  const started = Date.now();
  const result = spawnSync(fromRoot(root, path), {
    cwd: root,
    encoding: "utf8",
    input,
    env: { ...process.env, DEV_GUARD_HOOK_SOURCE: "direct_test" },
    timeout: 30_000
  });
  const error = result.error ? result.error.message : [result.stderr, result.stdout].filter(Boolean).join("\n").slice(0, 500);
  return {
    ok: result.status === 0,
    status: result.status,
    durationMs: Date.now() - started,
    error: error || undefined
  };
}

function expectedHookNextStep(status: Awaited<ReturnType<typeof getHookStatus>>, pendingCount: number, runtimeStatus?: string): string {
  const installed = (status.claudeInstalled && status.claudeHookFile) || (status.codexInstalled && status.codexHookFile);
  const verified = status.claudeLastSuccess === true || status.codexLastSuccess === true;
  if (!installed) return "Run dev-guard install-hooks, then dev-guard watch.";
  if (!verified) return "Hooks are installed but not verified. Run dev-guard doctor --hooks, trust Codex hooks with /hooks if needed, or fallback: dev-guard done.";
  if (pendingCount > 0 || runtimeStatus === "ready_for_done") return "Hook scripts are verified. Wait for the agent Stop Hook, or fallback: dev-guard done.";
  return "Hook scripts are verified. Run dev-guard watch before the next agent task.";
}
