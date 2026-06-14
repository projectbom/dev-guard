import { constants, existsSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fromRoot, readTextFile } from "./fs.js";
import { getHookStatus, hookConfigPaths } from "./hooks.js";
import { devguardPaths } from "./paths.js";

export type AgentStrategyName = "claude-stop-hook" | "codex-notify" | "codex-stop-hook" | "codex-jsonl-listener" | "manual";

export interface AgentStrategyStatus {
  name: AgentStrategyName;
  agent: "Claude Code" | "Codex" | "Manual";
  available: boolean;
  installed: boolean;
  scriptVerified: boolean;
  runtimeVerified: boolean;
  requiresUserTrust: boolean;
  recommended: boolean;
  next: string;
}

export interface AgentStrategyReport {
  strategies: AgentStrategyStatus[];
  claude: AgentStrategyStatus;
  codexNotify: AgentStrategyStatus;
  codexStopHook: AgentStrategyStatus;
  codexJsonlListener: AgentStrategyStatus;
  manual: AgentStrategyStatus;
}

const codexUserConfigPath = join(homedir(), ".codex", "config.toml");

export async function getAgentStrategyReport(root: string): Promise<AgentStrategyReport> {
  const hookStatus = await getHookStatus(root);
  const [claudeScriptVerified, codexStopScriptVerified, codexNotifyScriptVerified, codexJsonlScriptVerified] = await Promise.all([
    isExecutable(root, devguardPaths.claudeHook),
    isExecutable(root, devguardPaths.codexHook),
    isExecutable(root, devguardPaths.codexNotifyHook),
    isExecutable(root, devguardPaths.codexEventListener)
  ]);
  const codexNotifyInstalled = await isCodexNotifyConfigured(root);
  const codexNotifyRuntimeVerified = await hasFinalLogLine(root, devguardPaths.codexNotifyLog, /hook=codex\.notify status=success\b.*source=agent_runtime\b/);
  const codexJsonlRuntimeVerified = await hasFinalLogLine(root, devguardPaths.codexLog, /hook=codex\.turn\.completed status=success\b/);
  const claudeInstalled = hookStatus.claudeInstalled && hookStatus.claudeHookFile;
  const codexStopInstalled = hookStatus.codexInstalled && hookStatus.codexHookFile;
  const codexCliAvailable = commandAvailable("codex");

  const claudeRuntimeVerified = await hasFinalLogLine(root, devguardPaths.claudeLog, /hook=claude\.stop status=success\b.*source=agent_runtime\b/);
  const codexStopRuntimeVerified = await hasFinalLogLine(root, devguardPaths.codexLog, /hook=codex\.stop status=success\b.*source=agent_runtime\b/);

  const claude: AgentStrategyStatus = {
    name: "claude-stop-hook",
    agent: "Claude Code",
    available: commandAvailable("claude") || existsSync(fromRoot(root, hookConfigPaths.claudeSettingsPath)),
    installed: claudeInstalled,
    scriptVerified: claudeScriptVerified,
    runtimeVerified: claudeRuntimeVerified,
    requiresUserTrust: false,
    recommended: true,
    next: claudeRuntimeVerified ? "Claude Stop Hook runtime verified." : "Run Claude Code in this repo and check .devguard/logs/claude-hook.log."
  };

  const codexNotify: AgentStrategyStatus = {
    name: "codex-notify",
    agent: "Codex",
    available: codexCliAvailable,
    installed: codexNotifyInstalled,
    scriptVerified: codexNotifyScriptVerified,
    runtimeVerified: codexNotifyRuntimeVerified,
    requiresUserTrust: false,
    recommended: true,
    next: codexNotifyInstalled
      ? "Run a Codex turn and check .devguard/logs/codex-notify.log."
      : "Configure user-level ~/.codex/config.toml notify to call .devguard/hooks/codex-notify.sh."
  };

  const codexStopHook: AgentStrategyStatus = {
    name: "codex-stop-hook",
    agent: "Codex",
    available: codexCliAvailable,
    installed: codexStopInstalled,
    scriptVerified: codexStopScriptVerified,
    runtimeVerified: codexStopRuntimeVerified,
    requiresUserTrust: true,
    recommended: false,
    next: codexStopRuntimeVerified ? "Codex Stop Hook runtime verified." : "Open Codex TUI in this repo and run /hooks to review/trust the Stop Hook."
  };

  const codexJsonlListener: AgentStrategyStatus = {
    name: "codex-jsonl-listener",
    agent: "Codex",
    available: codexCliAvailable,
    installed: existsSync(fromRoot(root, devguardPaths.codexEventListener)),
    scriptVerified: codexJsonlScriptVerified,
    runtimeVerified: codexJsonlRuntimeVerified,
    requiresUserTrust: false,
    recommended: false,
    next: "Use codex exec --json ... | .devguard/hooks/codex-event-listener.ts for non-interactive runs."
  };

  const manual: AgentStrategyStatus = {
    name: "manual",
    agent: "Manual",
    available: true,
    installed: true,
    scriptVerified: true,
    runtimeVerified: true,
    requiresUserTrust: false,
    recommended: false,
    next: "Run dev-guard done when the agent task finishes."
  };

  return {
    strategies: [claude, codexNotify, codexStopHook, codexJsonlListener, manual],
    claude,
    codexNotify,
    codexStopHook,
    codexJsonlListener,
    manual
  };
}

export function formatStrategyFlag(value: boolean): string {
  return value ? "yes" : "no";
}

async function isCodexNotifyConfigured(root: string): Promise<boolean> {
  const text = await readTextFile(codexUserConfigPath);
  if (!text) return false;
  return text.includes(fromRoot(root, devguardPaths.codexNotifyHook)) || text.includes(devguardPaths.codexNotifyHook);
}

async function hasFinalLogLine(root: string, path: string, pattern: RegExp): Promise<boolean> {
  const text = await readTextFile(fromRoot(root, path));
  return text.split(/\r?\n/).some((line) => pattern.test(line));
}

async function isExecutable(root: string, path: string): Promise<boolean> {
  try {
    await access(fromRoot(root, path), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandAvailable(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).status === 0;
}

export async function pathExists(root: string, path: string): Promise<boolean> {
  try {
    await stat(fromRoot(root, path));
    return true;
  } catch {
    return false;
  }
}
