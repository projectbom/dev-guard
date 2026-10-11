import { resolve } from "node:path";
import { resolveAIAssistOptIn } from "./config.js";
import { getHookStatus } from "./hooks.js";
import { readProjectKnowledge } from "./knowledge.js";
import { planProjectSetup, prepareProject, validateProjectRoot, type PrepareResult, type SetupPlanEntry } from "./prepare.js";

export { validateProjectRoot };

/**
 * `dev-guard setup` — OPTIONAL preflight. `dev-guard watch` is the normal
 * entry point and runs the very same preparation (prepareProject) on its
 * own; setup exists for preparing/inspecting a project without starting the
 * watcher (CI, scripted environments, `--dry-run`, onboarding diagnosis).
 * Deterministic and non-interactive: no prompts and no OpenAI calls.
 */
export async function runSetup(root: string, args: string[] = []): Promise<void> {
  const invalid = await validateProjectRoot(root);
  if (invalid) {
    console.error(`dev-guard setup: ${invalid}`);
    process.exitCode = 1;
    return;
  }

  if (args.includes("--dry-run")) {
    printPlan(await planProjectSetup(root));
    return;
  }

  const startedAt = Date.now();
  console.log("DevGuard setup");
  console.log("");
  let result: PrepareResult;
  try {
    result = await prepareProject(root, { onProgress: (line) => console.log(`  ${line}`) });
  } catch (error) {
    console.error(`dev-guard setup: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  const elapsedMs = Date.now() - startedAt;
  await printSummary(root, result, elapsedMs);
}

function printPlan(plan: SetupPlanEntry[]): void {
  console.log("DevGuard setup --dry-run (no files are written)");
  const groups: Array<{ title: string; action: SetupPlanEntry["action"] }> = [
    { title: "Would create", action: "create" },
    { title: "Would update", action: "update" },
    { title: "Already configured", action: "unchanged" },
    { title: "Warning", action: "warning" }
  ];
  for (const group of groups) {
    const entries = plan.filter((entry) => entry.action === group.action);
    if (entries.length === 0) continue;
    console.log("");
    console.log(group.title);
    for (const entry of entries) console.log(`  ${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}`);
  }
}

async function printSummary(root: string, result: PrepareResult, elapsedMs: number): Promise<void> {
  const [knowledge, hookStatus, aiOptIn] = await Promise.all([
    readProjectKnowledge(root),
    getHookStatus(root).catch(() => undefined),
    resolveAIAssistOptIn(root)
  ]);
  const gitRoot = result.facts.gitRoot;
  const detected = result.facts.knowledge.detected;
  // Only print what was actually detected — never "unknown" placeholders.
  const known = (value: string | undefined) => (value && !/^\(?unknown\)?$/i.test(value.trim()) ? value : undefined);

  console.log("");
  console.log(result.warnings.length > 0 ? "DevGuard setup complete (with warnings)" : "DevGuard setup complete");

  console.log("");
  console.log("Project");
  printLine("Package manager", known(knowledge?.summary.packageManager ?? detected.packageManager));
  printLine("Framework", known(knowledge?.summary.framework ?? detected.framework));
  printLine("Language", known(knowledge?.summary.language));
  if (knowledge && knowledge.summary.sourceRoots.length > 0) printLine("Source roots", String(knowledge.summary.sourceRoots.length));
  printLine("Files indexed", String(result.facts.filesIndexed));
  printLine("Git", gitRoot ? (resolve(gitRoot) === resolve(root) ? "repository" : `inside ${gitRoot} (run setup at the repository root)`) : "not a git repository (see warning below)");

  const commands = [
    ["Build", known(detected.buildCommand)],
    ["Test", known(detected.testCommand)],
    ["Typecheck", known(detected.typecheckCommand)]
  ] as const;
  if (commands.some(([, value]) => value)) {
    console.log("");
    console.log("Commands");
    for (const [label, value] of commands) printLine(label, value ?? "not detected");
  }

  const mcpState = (value: string) => (value === "warning" ? "warning" : "ready");
  console.log("");
  console.log("Integrations");
  printLine("Claude MCP", mcpState(result.facts.mcp.claude));
  printLine("Codex MCP", mcpState(result.facts.mcp.codex));
  printLine("MCP server check", result.facts.mcp.verification === "pass" ? "prepare_task_context available" : result.facts.mcp.verification);
  printLine("Agent instructions", result.facts.instructions.warnings.length > 0 ? "warning" : "ready (AGENTS.md, CLAUDE.md)");
  const hooks = [hookStatus?.claudeInstalled && hookStatus.claudeHookFile ? "Claude" : undefined, hookStatus?.codexInstalled && hookStatus.codexHookFile ? "Codex" : undefined].filter(Boolean);
  printLine("Completion hook", hooks.length > 0 ? `ready (${hooks.join(", ")})` : result.facts.hooksInstalled ? "configured" : "not installed — run dev-guard done manually");

  console.log("");
  console.log("AI");
  printLine("Context broker", "deterministic — no API key needed");
  printLine(
    "OpenAI API",
    !aiOptIn.enabled ? "not configured (optional)" : aiOptIn.apiKey ? "enabled (optional Quality Report summary)" : "enabled but no key — reports use local rules"
  );

  if (result.warnings.length > 0) {
    console.log("");
    console.log("Warnings");
    for (const warning of result.warnings) console.log(`  ! ${warning}`);
  }

  console.log("");
  console.log(`${result.didWork ? "Prepared" : "Already up to date"} in ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log("");
  console.log("Next");
  console.log("  dev-guard watch   (no need to run setup again; watch keeps this up to date)");
}

function printLine(label: string, value: string | undefined): void {
  if (value === undefined) return;
  console.log(`  ${`${label}:`.padEnd(20)}${value}`);
}
