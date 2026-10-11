import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { parse, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fromRoot, readJsonFile } from "./fs.js";
import { ensureInitialProjectFiles, planInitialProjectFiles } from "./init.js";
import { ensureAgentInstructions, type AgentInstructionInstallSummary } from "./install-agent-instructions.js";
import { generateProjectKnowledge, getProjectKnowledgeRefreshStatus, readProjectKnowledge, type ProjectKnowledgeRefreshStatus } from "./knowledge.js";
import { installHooks, refreshGeneratedHookScripts } from "./hooks.js";
import { devguardPaths } from "./paths.js";
import { ensureCodeIndex, readRuntimeState, writeRuntimeState, type SetupStatus, type SetupStatusStep } from "./runtime-state.js";
import { ensureMcpSetup, type McpSetupResult } from "./mcp-setup.js";
import { enumerateProjectFiles } from "./project-files.js";

const execFileAsync = promisify(execFile);

export interface PrepareResult {
  didWork: boolean;
  warnings: string[];
  steps: Array<{ key: SetupStatusStep["key"]; label: string; status: "done" | "warning" | "skipped"; changed: boolean; detail?: string }>;
  /** Facts observed while preparing — what `dev-guard setup` prints. */
  facts: {
    filesIndexed: number;
    knowledge: ProjectKnowledgeRefreshStatus;
    instructions: AgentInstructionInstallSummary;
    mcp: McpSetupResult;
    hooksInstalled: boolean;
    /** Detected from the Project Knowledge file (absent if it could not be generated). */
    summary?: { packageManager: string; language: string; framework: string; sourceRoots: string[] };
    gitRoot?: string;
  };
}

export interface PrepareOptions {
  /**
   * "always" (setup, explicit diagnosis) or "on-change" (watch default):
   * spawning the MCP server to list its tools costs ~180 ms, so a watch
   * whose MCP config is already in place does not re-verify it every start.
   */
  verifyMcp?: "always" | "on-change";
  /** Present only for `watch`: the dashboard is a watch-runtime concern, not setup. */
  dashboard?: { enabled: boolean; ready: boolean };
  onProgress?: (line: string) => void;
}

const baseSetupSteps: SetupStatusStep[] = [
  { key: "config", label: "Configuration", status: "pending" },
  { key: "code_index", label: "Code Index", status: "pending" },
  { key: "knowledge", label: "Project Knowledge", status: "pending" },
  { key: "agent_instructions", label: "AI Instructions", status: "pending" },
  { key: "hooks", label: "Completion Hooks", status: "pending" },
  { key: "mcp", label: "MCP", status: "pending" }
];

/**
 * The single project-preparation engine. `dev-guard setup` runs it and
 * exits; `dev-guard watch` runs it before starting the watch runtime, so a
 * user who skips setup still gets the same zero-config first run. Every
 * step is idempotent: fresh artifacts are reused (Code Index present,
 * Project Knowledge fingerprint unchanged, managed sections unchanged,
 * hooks/MCP already configured), and only missing or stale parts are
 * written. Only DevGuard-owned files and marker-delimited sections change.
 */
export async function prepareProject(root: string, options: PrepareOptions = {}): Promise<PrepareResult> {
  // Critical boundary: an invalid root stops here, before anything is
  // written. Every later step is non-critical — it degrades to a warning
  // and the remaining steps still run.
  const invalidRoot = await validateProjectRoot(root);
  if (invalidRoot) throw new Error(invalidRoot);
  const steps: PrepareResult["steps"] = [];
  const warnings: string[] = [];
  const startedAt = new Date().toISOString();
  let didWork = false;
  const setupSteps: SetupStatusStep[] = options.dashboard ? [...baseSetupSteps, { key: "dashboard", label: "Dashboard", status: "pending" }] : baseSetupSteps;

  await writeSetupStatus(root, { active: true, startedAt, steps: setupSteps });

  await markStep(root, startedAt, setupSteps, "config", "running");
  const initResults = await ensureInitialProjectFiles(root);
  const initChanged = initResults.some((result) => result.status === "created");
  didWork = didWork || initChanged;
  steps.push({ key: "config", label: "Initialized project", status: "done", changed: initChanged });
  await markStep(root, startedAt, setupSteps, "config", "done");

  // One enumeration of the project (git-aware, .gitignore honored) shared
  // by the Code Index bootstrap, the Knowledge fingerprint and generation.
  const enumeration = await enumerateProjectFiles(root);

  await markStep(root, startedAt, setupSteps, "code_index", "running");
  const indexResult = await ensureCodeIndex(root, enumeration);
  didWork = didWork || indexResult.generated;
  if (indexResult.warning) warnings.push(`Code Index not built: ${indexResult.warning}. Task context has fewer file suggestions until it exists; DevGuard retries on the next watch/setup.`);
  steps.push({
    key: "code_index",
    label: "Code Index",
    status: indexResult.warning ? "warning" : indexResult.generated ? "done" : "skipped",
    changed: indexResult.generated,
    detail: indexResult.warning ?? `${indexResult.filesIndexed} files indexed`
  });
  await markStep(root, startedAt, setupSteps, "code_index", indexResult.warning ? "warning" : "done", indexResult.warning);

  await markStep(root, startedAt, setupSteps, "knowledge", "running");
  const knowledgeStatus = await getProjectKnowledgeRefreshStatus(root, enumeration);
  let knowledgeChanged = false;
  let knowledgeWarning: string | undefined;
  if (knowledgeStatus.shouldGenerate) {
    try {
      options.onProgress?.(knowledgeStatus.exists ? "Refreshing Project Knowledge..." : "Analyzing project structure...");
      await generateProjectKnowledge(root, enumeration);
      knowledgeChanged = true;
      didWork = true;
    } catch (error) {
      knowledgeWarning = errorMessage(error);
      warnings.push(`Project Knowledge not ${knowledgeStatus.exists ? "refreshed" : "generated"}: ${knowledgeWarning}. ${knowledgeStatus.exists ? "The previous Knowledge stays in use" : "Task context works without it"}; DevGuard retries on the next watch/setup.`);
    }
  }
  steps.push({
    key: "knowledge",
    label: "Project Knowledge",
    status: knowledgeWarning ? "warning" : knowledgeStatus.shouldGenerate ? "done" : "skipped",
    changed: knowledgeChanged,
    detail: knowledgeWarning ?? knowledgeDetail(knowledgeStatus)
  });
  await markStep(root, startedAt, setupSteps, "knowledge", knowledgeWarning ? "warning" : "done", knowledgeWarning);

  await markStep(root, startedAt, setupSteps, "agent_instructions", "running");
  const instructionResult = await ensureAgentInstructions(root).catch((error): AgentInstructionInstallSummary => ({
    agents: "already_installed",
    claude: "already_installed",
    warnings: [`AGENTS.md / CLAUDE.md not updated: ${errorMessage(error)}. Agents will not see the DevGuard workflow until this is fixed; check the file permissions, then rerun dev-guard watch.`]
  }));
  const instructionsChanged =
    instructionResult.agents === "created" ||
    instructionResult.agents === "section_added" ||
    instructionResult.agents === "section_updated" ||
    instructionResult.claude === "created" ||
    instructionResult.claude === "section_added" ||
    instructionResult.claude === "section_updated";
  didWork = didWork || instructionsChanged;
  warnings.push(...instructionResult.warnings);
  steps.push({
    key: "agent_instructions",
    label: "Agent instructions",
    status: instructionResult.warnings.length > 0 ? "warning" : "done",
    changed: instructionsChanged,
    detail: instructionResult.warnings.join(" ")
  });
  await markStep(root, startedAt, setupSteps, "agent_instructions", instructionResult.warnings.length > 0 ? "warning" : "done", instructionResult.warnings.join(" "));

  await markStep(root, startedAt, setupSteps, "hooks", "running");
  const hooksAlreadyInstalled = await hasAnyHookInstall(root);
  let hooksChanged = false;
  let hookWarning: string | undefined;
  if (!hooksAlreadyInstalled) {
    try {
      const hookResult = await installHooks(root);
      hooksChanged = hookResult.created.length > 0;
      didWork = didWork || hooksChanged;
      const failures = hookResult.skipped.filter((line) => /failed|\berror\b|\bdenied\b/i.test(line));
      if (failures.length > 0) {
        hookWarning = failures.join(" ");
        warnings.push(hookWarningText(hookWarning));
      }
    } catch (error) {
      hookWarning = errorMessage(error);
      warnings.push(hookWarningText(hookWarning));
    }
  } else {
    // Existing installs keep their hook scripts, but scripts generated by
    // an older DevGuard (unbounded raw-payload logging, no rotation, no
    // hook-state) are regenerated in place. Agent configs are untouched.
    const refreshed = await refreshGeneratedHookScripts(root).catch(() => []);
    hooksChanged = refreshed.length > 0;
  }
  steps.push({
    key: "hooks",
    label: "Completion hooks",
    status: hookWarning ? "warning" : hooksAlreadyInstalled ? "skipped" : "done",
    changed: hooksChanged,
    detail: hookWarning
  });
  await markStep(root, startedAt, setupSteps, "hooks", hookWarning ? "warning" : "done", hookWarning);

  await markStep(root, startedAt, setupSteps, "mcp", "running");
  const mcpResult = await ensureMcpSetup(root, { verify: options.verifyMcp ?? "on-change" });
  const mcpChanged = mcpResult.claude === "created" || mcpResult.claude === "updated" || mcpResult.codex === "created" || mcpResult.codex === "updated";
  didWork = didWork || mcpChanged;
  warnings.push(...mcpResult.warnings);
  const mcpDetail = `Claude: ${mcpResult.claude}; Codex: ${mcpResult.codex}; verification: ${mcpResult.verification}`;
  steps.push({
    key: "mcp",
    label: "MCP",
    status: mcpResult.warnings.length > 0 || mcpResult.verification === "warning" ? "warning" : mcpChanged ? "done" : "skipped",
    changed: mcpChanged,
    detail: mcpDetail
  });
  await markStep(root, startedAt, setupSteps, "mcp", mcpResult.warnings.length > 0 || mcpResult.verification === "warning" ? "warning" : "done", mcpDetail);

  if (options.dashboard) {
    const { enabled, ready } = options.dashboard;
    steps.push({
      key: "dashboard",
      label: "Dashboard ready",
      status: enabled && !ready ? "warning" : enabled ? "done" : "skipped",
      changed: false,
      detail: enabled && !ready ? "Dashboard server could not start; watch continues." : undefined
    });
    await markStep(root, startedAt, setupSteps, "dashboard", enabled && !ready ? "warning" : "done");
  }

  const [summary, gitRoot] = await Promise.all([readProjectKnowledge(root).then((knowledge) => knowledge?.summary).catch(() => undefined), gitTopLevel(root)]);
  if (!gitRoot) {
    warnings.push("Not a git repository: MCP task context works, but `done` cannot detect changed files, so reports stay empty. Run `git init` (and commit once) to enable change tracking.");
  }

  const completedAt = new Date().toISOString();
  await writeSetupStatus(root, {
    active: false,
    startedAt,
    completedAt,
    steps: setupSteps.map((step) => {
      const done = steps.find((entry) => entry.key === step.key);
      return {
        ...step,
        status: done?.status === "warning" ? "warning" : "done",
        detail: done?.detail
      };
    })
  });

  return {
    didWork,
    warnings,
    steps,
    facts: {
      filesIndexed: indexResult.filesIndexed,
      knowledge: knowledgeStatus,
      instructions: instructionResult,
      mcp: mcpResult,
      hooksInstalled: hooksAlreadyInstalled || hooksChanged,
      summary,
      gitRoot
    }
  };
}

function hookWarningText(detail: string): string {
  return `Completion hooks not installed: ${detail}. Watch falls back to finalizing after file inactivity; run \`dev-guard done\` yourself if needed, or \`dev-guard doctor --hooks --dry-run\` to diagnose.`;
}

/** Returns an error message when `root` must not be prepared, else undefined. */
export async function validateProjectRoot(root: string): Promise<string | undefined> {
  const absolute = resolve(root);
  const info = await stat(absolute).catch(() => undefined);
  if (!info?.isDirectory()) return `${absolute} is not a directory.`;
  // Indexing a whole home directory or filesystem root is never intended.
  if (absolute === resolve(homedir()) || absolute === parse(absolute).root) {
    return `${absolute} is not a project root. cd into a project directory and run DevGuard there.`;
  }
  return undefined;
}

export async function gitTopLevel(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: root });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Human output of one preparation run, shared by `watch` and `setup`.
 * Only what this run actually did or detected is listed; an already
 * prepared project collapses to "Project ready.".
 */
export function formatPreparation(result: PrepareResult): { headline: string; lines: string[] } {
  const step = (key: SetupStatusStep["key"]) => result.steps.find((entry) => entry.key === key);
  const firstRun = Boolean(step("config")?.changed);
  const lines: string[] = [];
  if (step("code_index")?.changed) lines.push(`✓ Indexed ${result.facts.filesIndexed} project files`);
  if (step("knowledge")?.changed) {
    const detected = [result.facts.summary?.packageManager, result.facts.summary?.language, result.facts.summary?.framework].filter(
      (value): value is string => Boolean(value) && !/^\(?unknown\)?$/i.test(String(value))
    );
    if (detected.length > 0) lines.push(`✓ Detected ${detected.join(" / ")}`);
    lines.push(result.facts.knowledge.exists ? `✓ Project Knowledge refreshed (${result.facts.knowledge.staleFiles.slice(0, 3).join(", ")})` : "✓ Project Knowledge ready");
  }
  const mcpLine = (label: string, value: McpSetupResult["claude"], file: string) =>
    value === "created" || value === "updated" ? `✓ ${label} MCP configured (${file})` : undefined;
  for (const line of [mcpLine("Claude", result.facts.mcp.claude, ".mcp.json"), mcpLine("Codex", result.facts.mcp.codex, ".codex/config.toml")]) {
    if (line) lines.push(line);
  }
  if (step("agent_instructions")?.changed) lines.push("✓ Agent instructions ready (DevGuard section in AGENTS.md, CLAUDE.md)");
  if (step("hooks")?.changed) lines.push(firstRun ? "✓ Completion hooks ready" : "✓ Completion hook scripts refreshed");
  for (const warning of result.warnings) lines.push(`! ${warning}`);
  const headline = lines.length === 0 ? "Project ready." : firstRun ? "First-time project preparation" : "Project preparation updated";
  return { headline, lines };
}

/** `watch`'s historical entry point — the same engine, plus the dashboard step. */
export async function prepareWatchProject(
  root: string,
  options: { dashboardEnabled: boolean; dashboardReady: boolean; onProgress?: (line: string) => void }
): Promise<PrepareResult> {
  return prepareProject(root, { dashboard: { enabled: options.dashboardEnabled, ready: options.dashboardReady }, onProgress: options.onProgress });
}

export interface SetupPlanEntry {
  key: SetupStatusStep["key"];
  label: string;
  action: "create" | "update" | "unchanged" | "warning";
  detail?: string;
}

/**
 * Read-only preview of what prepareProject would do (`setup --dry-run`):
 * the same decisions, evaluated without writing a single file, starting a
 * server, or recording setup status.
 */
export async function planProjectSetup(root: string): Promise<SetupPlanEntry[]> {
  const plan: SetupPlanEntry[] = [];
  const missing = (await planInitialProjectFiles(root)).filter((file) => file.status === "missing").map((file) => file.path);
  plan.push({ key: "config", label: "DevGuard workspace", action: missing.length > 0 ? "create" : "unchanged", detail: missing.length > 0 ? missing.join(", ") : undefined });

  const index = await readJsonFile<{ files?: Record<string, unknown> }>(fromRoot(root, devguardPaths.codeIndex), {});
  const indexed = Object.keys(index.files ?? {}).length;
  plan.push({ key: "code_index", label: "Code Index", action: indexed > 0 ? "unchanged" : "create", detail: indexed > 0 ? `${indexed} files indexed` : devguardPaths.codeIndex });

  const knowledge = await getProjectKnowledgeRefreshStatus(root);
  plan.push({
    key: "knowledge",
    label: "Project Knowledge",
    action: knowledge.reason === "missing" ? "create" : knowledge.reason === "stale" ? "update" : "unchanged",
    detail: knowledge.reason === "stale" ? `inputs changed: ${knowledge.staleFiles.join(", ")}` : knowledge.reason === "missing" ? devguardPaths.projectKnowledge : undefined
  });

  const instructions = await ensureAgentInstructions(root, { dryRun: true });
  for (const [file, result] of [["AGENTS.md", instructions.agents], ["CLAUDE.md", instructions.claude]] as const) {
    plan.push({
      key: "agent_instructions",
      label: `${file} DevGuard section`,
      action: result === "created" || result === "section_added" ? "create" : result === "section_updated" ? "update" : "unchanged",
      detail: result === "section_added" ? "appended after existing text" : result === "section_updated" ? "managed section only; text outside markers kept" : undefined
    });
  }

  const hooksInstalled = await hasAnyHookInstall(root);
  plan.push({ key: "hooks", label: "Completion hooks", action: hooksInstalled ? "unchanged" : "create", detail: hooksInstalled ? "outdated generated scripts are refreshed in place" : undefined });

  const mcp = await ensureMcpSetup(root, { dryRun: true });
  for (const [label, result] of [["Claude MCP (.mcp.json)", mcp.claude], ["Codex MCP (.codex/config.toml)", mcp.codex]] as const) {
    plan.push({
      key: "mcp",
      label,
      action: result === "created" ? "create" : result === "updated" ? "update" : result === "warning" ? "warning" : "unchanged",
      detail: result === "warning" ? mcp.warnings.join(" ") : result === "updated" ? "dev-guard entry only; other servers kept" : undefined
    });
  }
  return plan;
}

function knowledgeDetail(status: Awaited<ReturnType<typeof getProjectKnowledgeRefreshStatus>>): string | undefined {
  if (status.reason === "fresh") return undefined;
  if (status.reason === "missing") return `${status.detected.packageManager}; ${status.detected.framework}`;
  if (status.staleFiles.length > 0) return `Refreshed after project change: ${status.staleFiles.slice(0, 3).join(", ")}${status.staleFiles.length > 3 ? ", ..." : ""}`;
  return undefined;
}

async function markStep(root: string, startedAt: string, setupSteps: SetupStatusStep[], key: SetupStatusStep["key"], status: SetupStatusStep["status"], detail?: string): Promise<void> {
  const current = await readRuntimeState(root);
  const currentSetup = current.setupStatus?.steps.length ? current.setupStatus.steps : setupSteps;
  await writeRuntimeState(root, {
    ...current,
    setupStatus: {
      active: true,
      startedAt,
      steps: currentSetup.map((step) => (step.key === key ? { ...step, status, detail } : step))
    }
  });
}

async function writeSetupStatus(root: string, setupStatus: SetupStatus): Promise<void> {
  const current = await readRuntimeState(root);
  await writeRuntimeState(root, { ...current, setupStatus });
}

async function hasAnyHookInstall(root: string): Promise<boolean> {
  return (
    (await fileExists(fromRoot(root, devguardPaths.claudeHook))) ||
    (await fileExists(fromRoot(root, devguardPaths.codexHook))) ||
    (await fileExists(fromRoot(root, devguardPaths.codexNotifyHook))) ||
    (await fileExists(fromRoot(root, ".claude/settings.json"))) ||
    (await fileExists(fromRoot(root, ".codex/hooks.json")))
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
