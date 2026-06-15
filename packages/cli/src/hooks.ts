import { chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fromRoot, readTextFile, writeTextFile } from "./fs.js";
import { migrateLegacyDevguardDir } from "./migration.js";
import { devguardPaths } from "./paths.js";
import { formatNotifyCommand, getCodexNotifyConfigStatus, installCodexNotifyDispatcher } from "./codex-notify.js";

interface InstallHooksResult {
  created: string[];
  skipped: string[];
  reportPath: string;
}

type InstallAgent = "claude" | "codex" | "codex-notify" | "all" | "auto";

export interface HookStatus {
  claudeInstalled: boolean;
  codexInstalled: boolean;
  claudeHookFile: boolean;
  codexHookFile: boolean;
  lastTrigger?: string;
  lastSuccess?: boolean;
  claudeLastTrigger?: string;
  claudeLastSuccess?: boolean;
  codexLastTrigger?: string;
  codexLastSuccess?: boolean;
}

const claudeHookPath = devguardPaths.claudeHook;
const codexHookPath = devguardPaths.codexHook;
const codexNotifyHookPath = devguardPaths.codexNotifyHook;
const codexListenerPath = devguardPaths.codexEventListener;
const claudeSettingsPath = ".claude/settings.json";
const codexHooksPath = ".codex/hooks.json";
const hookStatusPath = devguardPaths.hookStatus;
const claudeLogPath = devguardPaths.claudeLog;
const codexLogPath = devguardPaths.codexLog;
export const claudeHookCommand = '${CLAUDE_PROJECT_DIR}/.devguard/hooks/claude-stop.sh';
export const codexHookCommand = '"$(git rev-parse --show-toplevel)/.devguard/hooks/codex-stop.sh"';
export const hookConfigPaths = {
  claudeSettingsPath,
  codexHooksPath,
  claudeHookPath,
  codexHookPath,
  codexNotifyHookPath,
  claudeLogPath,
  codexLogPath
} as const;

export async function runInstallHooks(root: string, args: string[]): Promise<void> {
  const force = args.includes("--force");
  const installDispatcher = args.includes("--install-dispatcher");
  const agent = readAgentOption(args);
  const result = await installHooks(root, { force, agent, installDispatcher });
  console.log("dev-guard install-hooks");
  console.log(`agent: ${agent}`);
  if (result.created.length > 0) {
    console.log("created:");
    for (const file of result.created) console.log(`- ${file}`);
  }
  if (result.skipped.length > 0) {
    console.log("skipped:");
    for (const file of result.skipped) console.log(`- ${file}`);
  }
  console.log(`report: ${result.reportPath}`);
}

export async function installHooks(root: string, options: { force?: boolean; agent?: InstallAgent; installDispatcher?: boolean } = {}): Promise<InstallHooksResult> {
  const migration = await migrateLegacyDevguardDir(root, { force: options.force });
  const created: string[] = [];
  const skipped: string[] = migration.message ? [migration.message] : [];
  const agent = options.agent ?? "auto";
  const installClaude = agent === "all" || agent === "claude" || (agent === "auto" && commandAvailable("claude"));
  const installCodexStopHook = agent === "all" || agent === "codex" || agent === "auto";
  const installCodexNotify = agent === "all" || agent === "codex-notify" || agent === "codex" || agent === "auto";
  const files: Array<{ path: string; content: string; executable?: boolean }> = [
    ...(installClaude ? [{ path: claudeHookPath, content: shellHook("claude", claudeLogPath), executable: true }] : []),
    ...(installCodexStopHook ? [{ path: codexHookPath, content: shellHook("codex", codexLogPath), executable: true }] : []),
    ...(installCodexNotify ? [{ path: codexNotifyHookPath, content: codexNotifyHook(), executable: true }] : []),
    ...(installCodexStopHook ? [{ path: codexListenerPath, content: codexEventListener(), executable: true }] : [])
  ];

  for (const file of files) {
    const absolute = fromRoot(root, file.path);
    if (existsSync(absolute) && !options.force) {
      skipped.push(`${file.path} (exists; use --force to overwrite)`);
      continue;
    }
    try {
      await writeTextFile(absolute, file.content);
      if (file.executable) {
        await chmod(absolute, 0o755);
      }
      created.push(file.path);
    } catch (error) {
      skipped.push(`${file.path} (${errorMessage(error)})`);
    }
  }
  if (installClaude) {
    await installJsonHookConfig(root, claudeSettingsPath, createClaudeHookConfig, { ...options, mergeExisting: true }, created, skipped);
  } else if (agent === "auto") {
    skipped.push("Claude Code Stop Hook (claude command not detected; run dev-guard install-hooks --agent claude to force)");
  }
  if (installCodexStopHook) {
    await installJsonHookConfig(root, codexHooksPath, createCodexHookConfig, { ...options, mergeExisting: false }, created, skipped);
  }
  if (installCodexNotify) {
    const notifyStatus = await getCodexNotifyConfigStatus();
    if (options.force || options.installDispatcher) {
      try {
        const dispatcher = await installCodexNotifyDispatcher({ force: options.force });
        if (dispatcher.changed) {
          created.push(dispatcher.dispatcherPath);
        }
        if (dispatcher.backupPath) created.push(`${dispatcher.backupPath} (backup)`);
        skipped.push(dispatcher.message);
      } catch (error) {
        skipped.push(`Codex notify dispatcher install failed (${errorMessage(error)})`);
      }
    } else if (notifyStatus.notifyIsDispatcher) {
      skipped.push("Codex notify dispatcher already configured in ~/.codex/config.toml");
    } else if (notifyStatus.existingNotifyDetected) {
      skipped.push(`Existing Codex notify detected: ${formatNotifyCommand(notifyStatus.notify)}`);
      skipped.push("Run dev-guard install-hooks --agent codex-notify --install-dispatcher to preserve it through ~/.codex/dev-guard-notify-dispatcher.sh");
    } else {
      skipped.push("Codex notify config is user-level only; run dev-guard install-hooks --agent codex-notify --install-dispatcher to configure ~/.codex/config.toml");
    }
  }
  await writeHookStatusReport(root);
  return { created, skipped, reportPath: hookStatusPath };
}

export async function getHookStatus(root: string): Promise<HookStatus> {
  const [claudeLog, codexLog] = await Promise.all([
    readTextFile(fromRoot(root, claudeLogPath)),
    readTextFile(fromRoot(root, codexLogPath))
  ]);
  const logLines = [...claudeLog.split(/\r?\n/), ...codexLog.split(/\r?\n/)].filter(Boolean);
  const claudeLastLine = latestFinalHookLine(claudeLog.split(/\r?\n/).filter(Boolean));
  const codexLastLine = latestFinalHookLine(codexLog.split(/\r?\n/).filter(Boolean));
  const finalLines = logLines.filter((line) => /hook=[a-z]+\.stop status=(success|failed)\b/.test(line));
  const lastLine = latestTimestampedLine(finalLines) ?? latestTimestampedLine(logLines);
  return {
    claudeInstalled: existsSync(fromRoot(root, claudeSettingsPath)),
    codexInstalled: existsSync(fromRoot(root, codexHooksPath)),
    claudeHookFile: existsSync(fromRoot(root, claudeHookPath)),
    codexHookFile: existsSync(fromRoot(root, codexHookPath)),
    lastTrigger: lastLine ? extractLogValue(lastLine, "timestamp") : undefined,
    lastSuccess: lastLine ? extractLogValue(lastLine, "status") === "success" : undefined,
    claudeLastTrigger: claudeLastLine ? extractLogValue(claudeLastLine, "timestamp") : undefined,
    claudeLastSuccess: claudeLastLine ? extractLogValue(claudeLastLine, "status") === "success" : undefined,
    codexLastTrigger: codexLastLine ? extractLogValue(codexLastLine, "timestamp") : undefined,
    codexLastSuccess: codexLastLine ? extractLogValue(codexLastLine, "status") === "success" : undefined
  };
}

function codexNotifyHook(): string {
  return `#!/usr/bin/env bash
set +e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="$ROOT/${devguardPaths.codexNotifyLog}"
mkdir -p "$(dirname "$LOG")" "$ROOT/${devguardPaths.reportsDir}"

payload="$1"
if [ -z "$payload" ]; then
  if IFS= read -r -t 1 line || [ -n "$line" ]; then
    payload="$line"
  else
    payload="{}"
  fi
fi

timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
hook_source="\${DEV_GUARD_HOOK_SOURCE:-agent_runtime}"
event_type="$(printf '%s\\n' "$payload" | sed -n 's/.*"type"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)"
if [ -z "$event_type" ]; then
  event_type="$(printf '%s\\n' "$payload" | sed -n 's/.*"event"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)"
fi
if [ -z "$event_type" ]; then
  event_type="unknown"
fi

{
  echo "timestamp=$timestamp hook=codex.notify status=start source=$hook_source event=$event_type"
  echo "timestamp=$timestamp hook=codex.notify payload_begin"
  printf '%s\\n' "$payload"
  echo "timestamp=$timestamp hook=codex.notify payload_end"
  if [ "$event_type" != "agent-turn-complete" ]; then
    echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=codex.notify status=skipped source=$hook_source event=$event_type reason=not_agent_turn_complete"
    exit 0
  fi
  cd "$ROOT" || exit 1
  if [ -f package.json ] && grep -q '"cli"' package.json; then
    if command -v pnpm >/dev/null 2>&1; then
      echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=codex.notify command=pnpm_cli_done status=running"
      pnpm cli done
      done_status=$?
      echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=codex.notify command=pnpm_cli_done status=completed exit=$done_status"
      echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=codex.notify command=pnpm_cli_status status=running"
      pnpm cli status
      status_status=$?
      echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=codex.notify command=pnpm_cli_status status=completed exit=$status_status"
    else
      echo "dev-guard Codex notify failed: pnpm was not found. Install pnpm or run dev-guard done/status manually."
      done_status=127
      status_status=127
    fi
  else
    if command -v dev-guard >/dev/null 2>&1; then
      dev-guard done
      done_status=$?
      dev-guard status
      status_status=$?
    else
      echo "dev-guard Codex notify failed: dev-guard was not found on PATH."
      done_status=127
      status_status=127
    fi
  fi
  if [ "$done_status" -eq 0 ] && [ "$status_status" -eq 0 ]; then
    echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=codex.notify status=success source=$hook_source done=$done_status status_cmd=$status_status"
  else
    echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=codex.notify status=failed source=$hook_source done=$done_status status_cmd=$status_status"
  fi
} >> "$LOG" 2>&1

exit 0
`;
}

export async function writeHookStatusReport(root: string): Promise<string> {
  await mkdir(dirname(fromRoot(root, hookStatusPath)), { recursive: true });
  const status = await getHookStatus(root);
  const markdown = [
    "# Hook Status",
    "",
    "## Installed",
    `- Claude Code: ${status.claudeInstalled && status.claudeHookFile ? "INSTALLED" : "NOT_INSTALLED"} / ${status.claudeLastSuccess ? "VERIFIED" : "NOT_VERIFIED"}`,
    `- Codex CLI: ${status.codexInstalled && status.codexHookFile ? "INSTALLED" : "NOT_INSTALLED"} / ${status.codexLastSuccess ? "VERIFIED" : "NOT_VERIFIED"}`,
    "",
    "## Files",
    `- ${claudeHookPath}: ${status.claudeHookFile ? "exists" : "missing"}`,
    `- ${codexHookPath}: ${status.codexHookFile ? "exists" : "missing"}`,
    `- ${claudeSettingsPath}: ${status.claudeInstalled ? "exists" : "missing"}`,
    `- ${codexHooksPath}: ${status.codexInstalled ? "exists" : "missing"}`,
    "",
    "## Last Hook Trigger",
    `- time: ${status.lastTrigger ?? "none"}`,
    `- success: ${status.lastSuccess === undefined ? "unknown" : status.lastSuccess ? "yes" : "no"}`,
    `- Claude Code time: ${status.claudeLastTrigger ?? "none"}`,
    `- Codex CLI time: ${status.codexLastTrigger ?? "none"}`
  ].join("\n") + "\n";
  await writeTextFile(fromRoot(root, hookStatusPath), markdown);
  return hookStatusPath;
}

function shellHook(kind: "claude" | "codex", logPath: string): string {
  return `#!/usr/bin/env bash
set +e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="$ROOT/${logPath}"
mkdir -p "$(dirname "$LOG")" "$ROOT/${devguardPaths.reportsDir}"

read_hook_input() {
  local line=""
  if IFS= read -r -t 1 line || [ -n "$line" ]; then
    hook_input="$line"
  else
    hook_input=""
  fi
}

hook_input=""
read_hook_input
if [ -z "$hook_input" ]; then
  hook_input="{}"
  hook_input_state="empty_or_timeout"
else
  hook_input_state="present"
fi
timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
hook_source="\${DEV_GUARD_HOOK_SOURCE:-agent_runtime}"
{
  echo "timestamp=$timestamp hook=${kind}.stop status=start source=$hook_source"
  if [ "$hook_input_state" = "empty_or_timeout" ]; then
    echo "timestamp=$timestamp hook=${kind}.stop stdin=empty_or_timeout"
  else
    echo "timestamp=$timestamp hook=${kind}.stop stdin_json_begin"
    printf '%s\\n' "$hook_input"
    echo "timestamp=$timestamp hook=${kind}.stop stdin_json_end"
  fi
  cd "$ROOT" || exit 1
  if [ -f package.json ] && grep -q '"cli"' package.json; then
    if command -v pnpm >/dev/null 2>&1; then
      echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=${kind}.stop command=pnpm_cli_done status=running"
      pnpm cli done
      done_status=$?
      echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=${kind}.stop command=pnpm_cli_done status=completed exit=$done_status"
      echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=${kind}.stop command=pnpm_cli_status status=running"
      pnpm cli status
      status_status=$?
      echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=${kind}.stop command=pnpm_cli_status status=completed exit=$status_status"
    else
      echo "dev-guard hook failed: pnpm was not found. Install pnpm or run dev-guard done/status manually."
      done_status=127
      status_status=127
    fi
  else
    if command -v dev-guard >/dev/null 2>&1; then
      echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=${kind}.stop command=dev-guard_done status=running"
      dev-guard done
      done_status=$?
      echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=${kind}.stop command=dev-guard_done status=completed exit=$done_status"
      echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=${kind}.stop command=dev-guard_status status=running"
      dev-guard status
      status_status=$?
      echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=${kind}.stop command=dev-guard_status status=completed exit=$status_status"
    else
      echo "dev-guard hook failed: dev-guard was not found on PATH. Install/link dev-guard or run the local CLI manually."
      done_status=127
      status_status=127
    fi
  fi
  if [ "$done_status" -eq 0 ] && [ "$status_status" -eq 0 ]; then
    echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=${kind}.stop status=success source=$hook_source done=$done_status status_cmd=$status_status"
  else
    echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=${kind}.stop status=failed source=$hook_source done=$done_status status_cmd=$status_status"
    if [ "$done_status" -ne 0 ]; then
      echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=${kind}.stop handoff=not_generated reason=done_failed"
    fi
  fi
} >> "$LOG" 2>&1

{
  printf '# Hook Status\\n\\n'
  printf '## Installed\\n'
  printf -- '- Claude Code: %s\\n' "$([ -f "$ROOT/${claudeSettingsPath}" ] && [ -f "$ROOT/${claudeHookPath}" ] && echo INSTALLED || echo NOT_INSTALLED)"
  printf -- '- Codex CLI: %s\\n\\n' "$([ -f "$ROOT/${codexHooksPath}" ] && [ -f "$ROOT/${codexHookPath}" ] && echo INSTALLED || echo NOT_INSTALLED)"
  printf '## Files\\n'
  printf -- '- ${claudeHookPath}: %s\\n' "$([ -f "$ROOT/${claudeHookPath}" ] && echo exists || echo missing)"
  printf -- '- ${codexHookPath}: %s\\n' "$([ -f "$ROOT/${codexHookPath}" ] && echo exists || echo missing)"
  printf -- '- ${claudeSettingsPath}: %s\\n' "$([ -f "$ROOT/${claudeSettingsPath}" ] && echo exists || echo missing)"
  printf -- '- ${codexHooksPath}: %s\\n\\n' "$([ -f "$ROOT/${codexHooksPath}" ] && echo exists || echo missing)"
  printf '## Last Hook Trigger\\n'
  printf -- '- time: %s\\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  printf -- '- success: %s\\n' "$([ "$done_status" -eq 0 ] && [ "$status_status" -eq 0 ] && echo yes || echo no)"
} > "$ROOT/${devguardPaths.hookStatus}"

if [ "${kind}" = "codex" ]; then
  printf '{}\\n'
fi

exit 0
`;
}

function codexEventListener(): string {
  return `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { appendFileSync, mkdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const root = resolve(__dirname, "../..");
const logPath = resolve(root, "${devguardPaths.codexLog}");
mkdirSync(dirname(logPath), { recursive: true });

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const lines = input.split(/\\r?\\n/).filter(Boolean);
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const type = event.type || event.event || event.name;
    if (type !== "turn.completed" && type !== "turn.failed") continue;
    appendFileSync(logPath, "timestamp=" + new Date().toISOString() + " hook=codex." + type + " status=start\\n");
    if (type === "turn.completed") {
      if (spawnSync("pnpm", ["--version"], { cwd: root, encoding: "utf8" }).status !== 0) {
        appendFileSync(logPath, "dev-guard codex JSONL listener failed: pnpm was not found. Install pnpm or run dev-guard done/status manually.\\n");
        appendFileSync(logPath, "timestamp=" + new Date().toISOString() + " hook=codex." + type + " status=failed done=127 status_cmd=127\\n");
        continue;
      }
      const done = spawnSync("pnpm", ["cli", "done"], { cwd: root, encoding: "utf8" });
      const status = spawnSync("pnpm", ["cli", "status"], { cwd: root, encoding: "utf8" });
      appendFileSync(logPath, done.stdout + done.stderr + status.stdout + status.stderr);
      appendFileSync(logPath, "timestamp=" + new Date().toISOString() + " hook=codex." + type + " status=" + (done.status === 0 && status.status === 0 ? "success" : "failed") + " done=" + done.status + " status_cmd=" + status.status + "\\n");
    } else {
      appendFileSync(logPath, "timestamp=" + new Date().toISOString() + " hook=codex." + type + " status=skipped_failed_turn\\n");
    }
  }
});
`;
}

async function installJsonHookConfig(
  root: string,
  path: string,
  createConfig: (current: JsonObject) => JsonObject,
  options: { force?: boolean; mergeExisting?: boolean },
  created: string[],
  skipped: string[]
): Promise<void> {
  const absolute = fromRoot(root, path);
  const existed = existsSync(absolute);
  let current: JsonObject = {};

  if (existed) {
    if (!options.force && !options.mergeExisting) {
      skipped.push(`${path} (exists; use --force to update)`);
      return;
    }
    const text = await readTextFile(absolute);
    try {
      current = parseJsonObject(text, path);
    } catch (error) {
      if (!options.force) {
        skipped.push(`${path} (${errorMessage(error)}; use --force to overwrite)`);
        return;
      }
      current = {};
    }
  }

  const next = createConfig(current);
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (!changed && existed) {
    skipped.push(`${path} (dev-guard hook already installed)`);
    return;
  }

  await writeTextFile(absolute, `${JSON.stringify(next, null, 2)}\n`);
  created.push(existed ? `${path} (updated)` : path);
}

function createClaudeHookConfig(current: JsonObject): JsonObject {
  return addCommandHook(current, "Stop", {
    type: "command",
    command: claudeHookCommand,
    statusMessage: "Running dev-guard done/status"
  });
}

function createCodexHookConfig(current: JsonObject): JsonObject {
  return addCommandHook(current, "Stop", {
    type: "command",
    command: codexHookCommand,
    timeout: 600,
    statusMessage: "Running dev-guard done/status"
  });
}

function addCommandHook(current: JsonObject, event: string, handler: JsonObject): JsonObject {
  const next = cloneJsonObject(current);
  const hooks = isJsonObject(next.hooks) ? next.hooks : {};
  const hookPath = typeof handler.command === "string" ? handler.command.replace(/^\$\{CLAUDE_PROJECT_DIR\}\//, "").replace(/^"?\$\(git rev-parse --show-toplevel\)\//, "").replace(/"$/, "") : "";
  const legacyHookPath = hookPath.replace(/^\.devguard\//, "devguard/");
  const groups = (Array.isArray(hooks[event]) ? hooks[event] : [])
    .filter(isJsonObject)
    .map((item) => {
      const handlers = Array.isArray(item.hooks)
        ? item.hooks.filter((candidate) => {
            if (!isJsonObject(candidate)) return true;
            return typeof candidate.command !== "string" || (!candidate.command.includes(hookPath) && !candidate.command.includes(legacyHookPath)) || candidate.command === handler.command;
          })
        : [];
      return { ...item, hooks: handlers };
    })
    .filter((item) => Array.isArray(item.hooks) && item.hooks.length > 0);
  const group = (groups.find((item) => !("matcher" in item) && Array.isArray(item.hooks)) ?? groups.find((item) => isJsonObject(item) && Array.isArray(item.hooks))) as JsonObject | undefined;

  if (group) {
    if (event === "Stop" && group.matcher === "") {
      delete group.matcher;
    }
    const handlers = Array.isArray(group.hooks) ? [...group.hooks] : [];
    if (!handlers.some((item) => isJsonObject(item) && item.command === handler.command)) {
      group.hooks = [...handlers, handler];
    }
  } else {
    groups.push({ hooks: [handler] });
  }

  hooks[event] = groups;
  next.hooks = hooks;
  return next;
}

function parseJsonObject(text: string, path: string): JsonObject {
  const parsed = text.trim() ? JSON.parse(text) : {};
  if (!isJsonObject(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return parsed;
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractLogValue(line: string, key: string): string | undefined {
  const match = new RegExp(`${key}=([^\\s]+)`).exec(line);
  return match?.[1];
}

function latestTimestampedLine(lines: string[]): string | undefined {
  return lines
    .map((line) => ({ line, timestamp: extractLogValue(line, "timestamp") }))
    .filter((entry): entry is { line: string; timestamp: string } => Boolean(entry.timestamp))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .at(-1)?.line;
}

function latestFinalHookLine(lines: string[]): string | undefined {
  return latestTimestampedLine(lines.filter((line) => /hook=[a-z]+\.stop status=(success|failed)\b/.test(line)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readAgentOption(args: string[]): InstallAgent {
  const index = args.indexOf("--agent");
  if (index < 0) return "auto";
  const value = args[index + 1] as InstallAgent | undefined;
  if (value === "claude" || value === "codex" || value === "codex-notify" || value === "all") {
    return value;
  }
  throw new Error("--agent must be one of claude, codex, codex-notify, all.");
}

function commandAvailable(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).status === 0;
}
