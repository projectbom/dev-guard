import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { devguardPaths } from "./paths.js";

const SECTION_START = "<!-- dev-guard-section-start -->";
const SECTION_END = "<!-- dev-guard-section-end -->";

type InstallResult = "created" | "section_added" | "section_updated" | "already_installed";

function agentsMdSection(): string {
  return [
    SECTION_START,
    "",
    "## Agent Instructions",
    "",
    "Before doing any work:",
    "",
    `1. Read \`${devguardPaths.agentContext}\``,
    `2. Read \`${devguardPaths.projectHandoff}\``,
    `3. Read \`${devguardPaths.qualityReport}\``,
    "",
    "Use dev-guard artifacts as the primary source of project context.",
    "Do not perform repository-wide scans before reading them.",
    "Only open additional files when required for the current task.",
    "Continue from the latest dev-guard state.",
    "",
    SECTION_END
  ].join("\n");
}

function claudeMdSection(): string {
  return [
    SECTION_START,
    "",
    "## Startup Instructions",
    "",
    "Always read the latest dev-guard context before exploring the repository.",
    "",
    "Required reading:",
    "",
    `* \`${devguardPaths.agentContext}\``,
    `* \`${devguardPaths.projectHandoff}\``,
    `* \`${devguardPaths.qualityReport}\``,
    "",
    "Avoid repository-wide scans unless the dev-guard context is insufficient.",
    "Prefer continuing from dev-guard context rather than rediscovering project state.",
    "",
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
  console.log(`  Read ${devguardPaths.agentContext} and continue.`);
}
