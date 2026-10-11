import { access } from "node:fs/promises";
import { fromRoot, readJsonFile } from "./fs.js";
import { ensureInitialProjectFiles, planInitialProjectFiles } from "./init.js";
import { ensureAgentInstructions, type AgentInstructionInstallSummary } from "./install-agent-instructions.js";
import { generateProjectKnowledge, getProjectKnowledgeRefreshStatus, type ProjectKnowledgeRefreshStatus } from "./knowledge.js";
import { installHooks, refreshGeneratedHookScripts } from "./hooks.js";
import { devguardPaths } from "./paths.js";
import { ensureCodeIndex, readRuntimeState, writeRuntimeState, type SetupStatus, type SetupStatusStep } from "./runtime-state.js";
import { ensureMcpSetup, type McpSetupResult } from "./mcp-setup.js";

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
  };
}

export interface PrepareOptions {
  /** Present only for `watch`: the dashboard is a watch-runtime concern, not setup. */
  dashboard?: { enabled: boolean; ready: boolean };
  onProgress?: (line: string) => void;
}

const baseSetupSteps: SetupStatusStep[] = [
  { key: "config", label: "Configuration", status: "pending" },
  { key: "code_index", label: "Code Index", status: "pending" },
  { key: "knowledge", label: "Project Knowledge", status: "pending" },
  { key: "agent_instructions", label: "AI Instructions", status: "pending" },
  { key: "hooks", label: "Git Hooks", status: "pending" },
  { key: "mcp", label: "MCP", status: "pending" }
];

/**
 * The single project-preparation engine. `dev-guard setup` runs it and
 * exits; `dev-guard watch` runs it before starting the watch runtime, so a
 * user who skips setup still gets the same zero-config first run. Every
 * step is idempotent: fresh artifacts are reused (Code Index present,
 * Project Knowledge newer than its inputs, managed sections unchanged,
 * hooks/MCP already configured), and only missing or stale parts are
 * written. Only DevGuard-owned files and marker-delimited sections change.
 */
export async function prepareProject(root: string, options: PrepareOptions = {}): Promise<PrepareResult> {
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

  await markStep(root, startedAt, setupSteps, "code_index", "running");
  const indexResult = await ensureCodeIndex(root);
  didWork = didWork || indexResult.generated;
  if (indexResult.warning) warnings.push(`Code Index warning: ${indexResult.warning}`);
  steps.push({
    key: "code_index",
    label: "Generated Code Index",
    status: indexResult.warning ? "warning" : indexResult.generated ? "done" : "skipped",
    changed: indexResult.generated,
    detail: indexResult.warning ?? `${indexResult.filesIndexed} files indexed`
  });
  await markStep(root, startedAt, setupSteps, "code_index", indexResult.warning ? "warning" : "done", indexResult.warning);

  await markStep(root, startedAt, setupSteps, "knowledge", "running");
  const knowledgeStatus = await getProjectKnowledgeRefreshStatus(root);
  let knowledgeChanged = false;
  let knowledgeWarning: string | undefined;
  if (knowledgeStatus.shouldGenerate) {
    try {
      options.onProgress?.("Learning project...");
      options.onProgress?.(`Detected: ${knowledgeStatus.detected.packageManager}`);
      options.onProgress?.(`Detected: ${knowledgeStatus.detected.framework}`);
      if (knowledgeStatus.detected.buildCommand !== "Unknown") {
        options.onProgress?.(`Detected: ${knowledgeStatus.detected.buildCommand}`);
      }
      if (knowledgeStatus.detected.testCommand !== "Unknown") {
        options.onProgress?.(`Detected: ${knowledgeStatus.detected.testCommand}`);
      }
      if (knowledgeStatus.detected.typecheckCommand !== "Unknown") {
        options.onProgress?.(`Detected: ${knowledgeStatus.detected.typecheckCommand}`);
      }
      options.onProgress?.("Generating Project Knowledge...");
      await generateProjectKnowledge(root);
      knowledgeChanged = true;
      didWork = true;
    } catch (error) {
      knowledgeWarning = errorMessage(error);
      warnings.push(`Project Knowledge warning: ${knowledgeWarning}`);
    }
  }
  steps.push({
    key: "knowledge",
    label: "Generated Project Knowledge",
    status: knowledgeWarning ? "warning" : knowledgeStatus.shouldGenerate ? "done" : "skipped",
    changed: knowledgeChanged,
    detail: knowledgeWarning ?? knowledgeDetail(knowledgeStatus)
  });
  await markStep(root, startedAt, setupSteps, "knowledge", knowledgeWarning ? "warning" : "done", knowledgeWarning);

  await markStep(root, startedAt, setupSteps, "agent_instructions", "running");
  const instructionResult = await ensureAgentInstructions(root);
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
    label: "Installed AI instructions",
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
        warnings.push(`Hook installation warning: ${hookWarning}`);
      }
    } catch (error) {
      hookWarning = errorMessage(error);
      warnings.push(`Hook installation warning: ${hookWarning}`);
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
    label: "Installed Git hooks",
    status: hookWarning ? "warning" : hooksAlreadyInstalled ? "skipped" : "done",
    changed: hooksChanged,
    detail: hookWarning
  });
  await markStep(root, startedAt, setupSteps, "hooks", hookWarning ? "warning" : "done", hookWarning);

  await markStep(root, startedAt, setupSteps, "mcp", "running");
  const mcpResult = await ensureMcpSetup(root);
  const mcpChanged = mcpResult.claude === "created" || mcpResult.claude === "updated" || mcpResult.codex === "created" || mcpResult.codex === "updated";
  didWork = didWork || mcpChanged;
  warnings.push(...mcpResult.warnings);
  const mcpDetail = `Claude: ${mcpResult.claude}; Codex: ${mcpResult.codex}; verification: ${mcpResult.verification}`;
  steps.push({
    key: "mcp",
    label: "Configured MCP",
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
      hooksInstalled: hooksAlreadyInstalled || hooksChanged
    }
  };
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
  if (status.staleFiles.length > 0) return `Refreshed after config change: ${status.staleFiles.slice(0, 3).join(", ")}${status.staleFiles.length > 3 ? ", ..." : ""}`;
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
