import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { devguardPaths } from "./paths.js";

const SECTION_START = "<!-- dev-guard-section-start -->";
const SECTION_END = "<!-- dev-guard-section-end -->";

type InstallResult = "created" | "section_added" | "section_updated" | "already_installed";
type AutoInstallResult = "created" | "already_installed" | "user_managed";

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
    "Before changing code:",
    "",
    `1. Read \`${devguardPaths.readMap}\` — what to read first.`,
    `2. Read \`${devguardPaths.codeMap}\` — where to read inside changed files.`,
    `3. Read \`${devguardPaths.agentBrief}\` — compact current-task brief.`,
    `4. Read \`${devguardPaths.workingContext}\` — current work structure.`,
    "",
    "Read only when needed:",
    "",
    `- \`${devguardPaths.projectHandoff}\` — next-session work instruction.`,
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
    "- Start: read the Read Map and Code Map first, then inspect only the targeted file regions needed for the task.",
    "- During work: keep `dev-guard watch` running in another terminal when continuous change tracking is wanted.",
    "- Finish: run the relevant project checks, then run `dev-guard done` and `dev-guard status` so handoff/status files are current.",
    `- Next ${agentName} session: use \`${devguardPaths.readMap}\`, \`${devguardPaths.codeMap}\`, \`${devguardPaths.agentBrief}\`, \`${devguardPaths.workingContext}\`, or \`${nextPrompt}\` to resume without rediscovering the repo.`,
    "",
    "Rules:",
    "",
    "- Use DevGuard artifacts as the primary source of current project state.",
    `- Start from \`${devguardPaths.readMap}\` and \`${devguardPaths.codeMap}\`; do not scan the full repository first.`,
    `- Use \`${devguardPaths.agentBrief}\` as the compact task brief and \`${devguardPaths.workingContext}\` for work structure.`,
    `- Use \`${devguardPaths.projectHandoff}\` for next-work instructions and \`${devguardPaths.qualityReport}\` only for QA status.`,
    `- Treat \`${devguardPaths.projectKnowledge}\` as long-term structure memory, not a task instruction.`,
    "- Do not perform repository-wide scans before reading the current DevGuard context.",
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
    if (!force) {
      return "already_installed";
    }
    const startIdx = existing.indexOf(SECTION_START);
    const endIdx = existing.indexOf(SECTION_END) + SECTION_END.length;
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
  return hasSection ? "already_installed" : "user_managed";
}

function describeResult(result: InstallResult): string {
  switch (result) {
    case "created":
      return "created";
    case "section_added":
      return "dev-guard section added";
    case "section_updated":
      return "dev-guard section updated (--force)";
    case "already_installed":
      return "already installed (use --force to update)";
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
  if (agentsResult === "already_installed" || claudeResult === "already_installed") {
    console.log("");
    console.log("Note: use --force to update existing dev-guard sections");
  }
  console.log("");
  console.log("Purpose:");
  console.log("  These files suggest to agents that they should read dev-guard context");
  console.log("  before exploring the repository. They are guidance, not enforced rules.");
  console.log("");
  console.log("Resume prompt for new sessions:");
  console.log(`  Read ${devguardPaths.readMap}, ${devguardPaths.codeMap}, and ${devguardPaths.agentBrief}; then continue.`);
}

export async function ensureAgentInstructions(root: string): Promise<AgentInstructionInstallSummary> {
  const agentsMdPath = join(root, "AGENTS.md");
  const claudeMdPath = join(root, "CLAUDE.md");
  const [agents, claude] = await Promise.all([
    ensureGeneratedSection(agentsMdPath, agentsMdSection()),
    ensureGeneratedSection(claudeMdPath, claudeMdSection())
  ]);
  const warnings: string[] = [];
  if (agents === "user_managed") {
    warnings.push("AGENTS.md exists without a DevGuard section; left unchanged.");
  }
  if (claude === "user_managed") {
    warnings.push("CLAUDE.md exists without a DevGuard section; left unchanged.");
  }
  return { agents, claude, warnings };
}
