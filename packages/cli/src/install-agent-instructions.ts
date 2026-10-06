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

function sharedDevGuardInstructions(_agentName: "Codex" | "Claude"): string[] {
  return [
    "DevGuard is an AI Coding Context Provider. It does not shorten or speed up the AI provider's own context compaction; it makes starting a fresh agent thread cheap, so a long thread never has to be compacted.",
    "",
    "## DevGuard Task Context",
    "",
    "Primary context source — `prepare_task_context` (DevGuard MCP):",
    "",
    "1. For every new coding or code-analysis task, call `prepare_task_context` with the user's concrete request before any repository search or unrelated file reads.",
    "2. Read the TARGET files' ranges first. Open a CANDIDATE file only when the targets leave a concrete gap — do not batch-read every returned file. REFERENCE files are background only. The result also contains the task goal, source-tagged constraints, the carried-over dirty-work warning, unresolved validation from the previous task, and a next action.",
    "3. Do not immediately run repository-wide `rg`/`grep`/`find`. Search only for a concrete gap the returned ranges do not cover, and keep that search targeted.",
    `4. When \`prepare_task_context\` succeeds, do not also read DevGuard's markdown (\`${devguardPaths.projectHandoff}\`, \`${devguardPaths.qualityReport}\`, \`${devguardPaths.nextCodexPrompt}\`, \`${devguardPaths.nextClaudePrompt}\`, \`${devguardPaths.agentBrief}\`, \`${devguardPaths.workingContext}\`, \`${devguardPaths.agentContext}\`). They are fallback and human-diagnostic artifacts.`,
    "",
    "Fresh thread per task (rollover-first):",
    "",
    "- When a task is done and the next request is a separate task, recommend continuing in a fresh agent thread and call `prepare_task_context` there.",
    "- If this thread has already handled another task or has been compacted once, move the next task to a fresh thread instead of waiting for another compaction.",
    "- DevGuard cannot see the provider's context window; its rollover status is advice from DevGuard-owned signals only.",
    "",
    "Only when MCP is unavailable or its result is insufficient, in this order:",
    "",
    `1. \`${devguardPaths.agentBrief}\` — compact current-task brief.`,
    `2. \`${devguardPaths.readMap}\` — file priority.`,
    `3. \`${devguardPaths.codeMap}\` — file-internal ranges.`,
    "",
    "Only on explicit request:",
    "",
    `- \`${devguardPaths.projectHandoff}\` — when the user explicitly asks to resume previous work (then turn its next action into a concrete task and call \`prepare_task_context\`), or to debug DevGuard output.`,
    `- \`${devguardPaths.qualityReport}\` — when a person asks for quality details or an explicit QA investigation.`,
    "",
    "Validation and completion:",
    "",
    "- After running a build/test/manual check for the task, report it with `record_validation_result`.",
    "- Finish with `dev-guard done` (or let the installed Stop hook run it). Do not re-open the generated handoff or reports afterwards.",
    "",
    "Rules:",
    "",
    `- Do not manually edit \`${devguardPaths.contextDir}/*\`, \`${devguardPaths.reportsDir}/*\`, \`${devguardPaths.promptsDir}/*\`, or \`${devguardPaths.runtime}\`; they are generated artifacts.`,
    "- Do not make broad unrelated changes.",
    "- Do not invent unsupported DevGuard commands; verify commands with `dev-guard --help`."
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
