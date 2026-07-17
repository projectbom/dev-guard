import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { devguardPaths } from "./paths.js";

const SECTION_START = "<!-- dev-guard-section-start -->";
const SECTION_END = "<!-- dev-guard-section-end -->";

type InstallResult = "created" | "section_added" | "section_updated" | "already_installed";
type AutoInstallResult = "created" | "section_added" | "section_updated" | "already_installed";

export interface AgentInstructionInstallSummary {
  agents: AutoInstallResult;
  claude: AutoInstallResult;
  warnings: string[];
}

function sharedDevGuardInstructions(agentName: "Codex" | "Claude"): string[] {
  const nextPrompt = agentName === "Claude" ? devguardPaths.nextClaudePrompt : devguardPaths.nextCodexPrompt;
  return [
    "DevGuard is an AI Coding Context Provider. It prepares context before AI work and preserves context after AI work in local `.devguard/` files.",
    "",
    "## DevGuard Task Context",
    "",
    "For every new coding or code-analysis task, before broad repository search or reading unrelated source files:",
    "",
    "1. Call the DevGuard MCP tool `prepare_task_context` with the user's current concrete request.",
    "2. Start with the highest-priority files and line ranges returned by DevGuard.",
    "3. Expand to additional callers, dependencies, routes, schemas, or tests only when needed to verify data flow or impact.",
    "4. Do not begin with broad repository-wide search when DevGuard returns relevant candidates.",
    "5. Use `.devguard/context/agent-brief.md`, `.devguard/reports/read-map.md`, and `.devguard/reports/code-map.md` only when MCP is unavailable or its result is insufficient.",
    "6. Do not treat `.devguard/reports/project-handoff.md` as the source of truth for a new task.",
    "",
    "For explicitly resumed work:",
    "",
    `1. Read \`${devguardPaths.projectHandoff}\`.`,
    "2. Convert the next action into a concrete task.",
    "3. Call `prepare_task_context` with that concrete task.",
    "4. Continue from the returned files and ranges.",
    "",
    "MCP fallback order:",
    "",
    `1. \`${devguardPaths.agentBrief}\` — compact current-task brief.`,
    `2. \`${devguardPaths.readMap}\` — file priority.`,
    `3. \`${devguardPaths.codeMap}\` — file-internal ranges.`,
    `4. \`${devguardPaths.workingContext}\` — structural background only when needed.`,
    "",
    "Read only when needed:",
    "",
    `- \`${devguardPaths.projectHandoff}\` — previous-session resume instruction, not the default entry for a new task.`,
    `- \`${devguardPaths.qualityReport}\` — QA result and remaining verification.`,
    `- \`${devguardPaths.agentContext}\` — agent rules and current constraints.`,
    `- \`${devguardPaths.projectKnowledge}\` — long-term project structure before broad exploration.`,
    "- `dev-guard status` — current runtime state when unclear.",
    "",
    "Common commands:",
    "",
    "- `dev-guard --help`",
    "- `dev-guard doctor`",
    "- `dev-guard init`",
    "- `dev-guard install-agent-instructions`",
    "- `dev-guard install-hooks`",
    "- `dev-guard watch`",
    "- `dev-guard status`",
    "- `dev-guard done`",
    "- `dev-guard handoff`",
    "- `dev-guard knowledge`",
    "- `dev-guard prompt`",
    "- `dev-guard self-check`",
    "",
    "Session workflow:",
    "",
    "- Start new work: call `prepare_task_context`, then inspect only the returned file ranges needed for the task.",
    "- Resume previous work: read the handoff, turn its next action into a concrete task, then call `prepare_task_context`.",
    "- During work: keep `dev-guard watch` running in another terminal when continuous change tracking is wanted.",
    "- Finish: run the relevant project checks, then run `dev-guard done` and `dev-guard status` so handoff/status files are current.",
    `- Next ${agentName} session: use \`${devguardPaths.readMap}\`, \`${devguardPaths.codeMap}\`, \`${devguardPaths.agentBrief}\`, \`${devguardPaths.workingContext}\`, or \`${nextPrompt}\` to resume without rediscovering the repo.`,
    "",
    "Rules:",
    "",
    "- Use the DevGuard MCP result as the primary source for where to read first on new tasks.",
    "- Do not perform repository-wide scans before calling DevGuard MCP when it is available.",
    `- Use \`${devguardPaths.agentBrief}\`, \`${devguardPaths.readMap}\`, and \`${devguardPaths.codeMap}\` as fallback when MCP is unavailable or insufficient.`,
    `- Use \`${devguardPaths.projectHandoff}\` only for explicitly resumed work and \`${devguardPaths.qualityReport}\` only for QA status.`,
    `- Treat \`${devguardPaths.projectKnowledge}\` as long-term structure memory, not a task instruction.`,
    `- Do not manually edit \`${devguardPaths.contextDir}/*\`, \`${devguardPaths.reportsDir}/*\`, \`${devguardPaths.promptsDir}/*\`, or \`${devguardPaths.runtime}\`; they are generated artifacts.`,
    "- Do not make broad unrelated changes.",
    "- Do not invent unsupported DevGuard commands; verify commands with `dev-guard --help` or the current CLI source."
  ];
}

function agentsMdSection(): string {
  return [
    SECTION_START,
    "",
    "## DevGuard Instructions for Codex",
    "",
    ...sharedDevGuardInstructions("Codex"),
    SECTION_END
  ].join("\n");
}

function claudeMdSection(): string {
  return [
    SECTION_START,
    "",
    "## DevGuard Instructions for Claude",
    "",
    ...sharedDevGuardInstructions("Claude"),
    SECTION_END
  ].join("\n");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function installSection(filePath: string, section: string, force: boolean): Promise<InstallResult> {
  const exists = await fileExists(filePath);
  if (!exists) {
    await writeFile(filePath, section + "\n", "utf8");
    return "created";
  }
  const existing = await readFile(filePath, "utf8");
  const hasSection = existing.includes(SECTION_START) && existing.includes(SECTION_END);
  if (hasSection) {
    const startIdx = existing.indexOf(SECTION_START);
    const endIdx = existing.indexOf(SECTION_END) + SECTION_END.length;
    const currentSection = existing.slice(startIdx, endIdx);
    if (currentSection === section) {
      return "already_installed";
    }
    // Managed DevGuard sections are safe to refresh. User-authored content
    // outside the markers is preserved.
    const updated = existing.slice(0, startIdx) + section + existing.slice(endIdx);
    await writeFile(filePath, updated, "utf8");
    return "section_updated";
  }
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(filePath, existing + separator + section + "\n", "utf8");
  return "section_added";
}

async function ensureGeneratedSection(filePath: string, section: string): Promise<AutoInstallResult> {
  const exists = await fileExists(filePath);
  if (!exists) {
    await writeFile(filePath, section + "\n", "utf8");
    return "created";
  }

  const existing = await readFile(filePath, "utf8");
  const hasSection = existing.includes(SECTION_START) && existing.includes(SECTION_END);
  if (!hasSection) {
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    await writeFile(filePath, existing + separator + section + "\n", "utf8");
    return "section_added";
  }
  const startIdx = existing.indexOf(SECTION_START);
  const endIdx = existing.indexOf(SECTION_END) + SECTION_END.length;
  const currentSection = existing.slice(startIdx, endIdx);
  if (currentSection === section) return "already_installed";
  const updated = existing.slice(0, startIdx) + section + existing.slice(endIdx);
  await writeFile(filePath, updated, "utf8");
  return "section_updated";
}

function describeResult(result: InstallResult): string {
  switch (result) {
    case "created":
      return "created";
    case "section_added":
      return "dev-guard section added";
    case "section_updated":
      return "dev-guard section updated";
    case "already_installed":
      return "already installed";
  }
}

export async function runInstallAgentInstructions(root: string, args: string[]): Promise<void> {
  const force = args.includes("--force");
  const agentsMdPath = join(root, "AGENTS.md");
  const claudeMdPath = join(root, "CLAUDE.md");
  const [agentsResult, claudeResult] = await Promise.all([
    installSection(agentsMdPath, agentsMdSection(), force),
    installSection(claudeMdPath, claudeMdSection(), force)
  ]);
  console.log("dev-guard install-agent-instructions");
  console.log("");
  console.log(`AGENTS.md: ${describeResult(agentsResult)}`);
  console.log(`CLAUDE.md: ${describeResult(claudeResult)}`);
  console.log("");
  console.log("Purpose:");
  console.log("  These files suggest that agents should call DevGuard MCP");
  console.log("  before broad repository search. They are guidance, not enforced rules.");
  console.log("");
  console.log("New-task prompt for agent sessions:");
  console.log("  Call DevGuard MCP prepare_task_context with the current request, then start from the returned files and ranges.");
  console.log("");
  console.log("Fallback when MCP is unavailable:");
  console.log(`  Read ${devguardPaths.agentBrief}, ${devguardPaths.readMap}, and ${devguardPaths.codeMap}; then continue.`);
}

export async function ensureAgentInstructions(root: string): Promise<AgentInstructionInstallSummary> {
  const agentsMdPath = join(root, "AGENTS.md");
  const claudeMdPath = join(root, "CLAUDE.md");
  const [agents, claude] = await Promise.all([
    ensureGeneratedSection(agentsMdPath, agentsMdSection()),
    ensureGeneratedSection(claudeMdPath, claudeMdSection())
  ]);
  const warnings: string[] = [];
  return { agents, claude, warnings };
}
