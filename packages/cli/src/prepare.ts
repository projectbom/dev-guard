import { access } from "node:fs/promises";
import { fromRoot } from "./fs.js";
import { ensureInitialProjectFiles } from "./init.js";
import { ensureAgentInstructions } from "./install-agent-instructions.js";
import { generateProjectKnowledge } from "./knowledge.js";
import { installHooks } from "./hooks.js";
import { devguardPaths } from "./paths.js";
import { readRuntimeState, writeRuntimeState, type SetupStatus, type SetupStatusStep } from "./runtime-state.js";

export interface PrepareResult {
  didWork: boolean;
  warnings: string[];
  steps: Array<{ key: SetupStatusStep["key"]; label: string; status: "done" | "warning" | "skipped"; changed: boolean; detail?: string }>;
}

const setupSteps: SetupStatusStep[] = [
  { key: "config", label: "Configuration", status: "pending" },
  { key: "agent_instructions", label: "AI Instructions", status: "pending" },
  { key: "hooks", label: "Git Hooks", status: "pending" },
  { key: "knowledge", label: "Project Knowledge", status: "pending" },
  { key: "dashboard", label: "Dashboard", status: "pending" }
];

export async function prepareWatchProject(root: string, options: { dashboardEnabled: boolean; dashboardReady: boolean }): Promise<PrepareResult> {
  const steps: PrepareResult["steps"] = [];
  const warnings: string[] = [];
  const startedAt = new Date().toISOString();
  let didWork = false;

  await writeSetupStatus(root, { active: true, startedAt, steps: setupSteps });

  await markStep(root, startedAt, "config", "running");
  const initResults = await ensureInitialProjectFiles(root);
  const initChanged = initResults.some((result) => result.status === "created");
  didWork = didWork || initChanged;
  steps.push({ key: "config", label: "Initialized project", status: "done", changed: initChanged });
  await markStep(root, startedAt, "config", "done");

  await markStep(root, startedAt, "agent_instructions", "running");
  const instructionResult = await ensureAgentInstructions(root);
  const instructionsChanged = instructionResult.agents === "created" || instructionResult.claude === "created";
  didWork = didWork || instructionsChanged;
  warnings.push(...instructionResult.warnings);
  steps.push({
    key: "agent_instructions",
    label: "Installed AI instructions",
    status: instructionResult.warnings.length > 0 ? "warning" : "done",
    changed: instructionsChanged,
    detail: instructionResult.warnings.join(" ")
  });
  await markStep(root, startedAt, "agent_instructions", instructionResult.warnings.length > 0 ? "warning" : "done", instructionResult.warnings.join(" "));

  await markStep(root, startedAt, "hooks", "running");
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
  }
  steps.push({
    key: "hooks",
    label: "Installed Git hooks",
    status: hookWarning ? "warning" : hooksAlreadyInstalled ? "skipped" : "done",
    changed: hooksChanged,
    detail: hookWarning
  });
  await markStep(root, startedAt, "hooks", hookWarning ? "warning" : "done", hookWarning);

  await markStep(root, startedAt, "knowledge", "running");
  const knowledgeExists = await fileExists(fromRoot(root, devguardPaths.projectKnowledge));
  let knowledgeChanged = false;
  let knowledgeWarning: string | undefined;
  if (!knowledgeExists) {
    try {
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
    status: knowledgeWarning ? "warning" : knowledgeExists ? "skipped" : "done",
    changed: knowledgeChanged,
    detail: knowledgeWarning
  });
  await markStep(root, startedAt, "knowledge", knowledgeWarning ? "warning" : "done", knowledgeWarning);

  steps.push({
    key: "dashboard",
    label: "Dashboard ready",
    status: options.dashboardEnabled && !options.dashboardReady ? "warning" : options.dashboardEnabled ? "done" : "skipped",
    changed: false,
    detail: options.dashboardEnabled && !options.dashboardReady ? "Dashboard server could not start; watch continues." : undefined
  });
  await markStep(root, startedAt, "dashboard", options.dashboardEnabled && !options.dashboardReady ? "warning" : "done");

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

  return { didWork, warnings, steps };
}

async function markStep(root: string, startedAt: string, key: SetupStatusStep["key"], status: SetupStatusStep["status"], detail?: string): Promise<void> {
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
