import { chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fromRoot, readTextFile, writeTextFile } from "./fs.js";
import { migrateLegacyDevguardDir } from "./migration.js";
import { devguardPaths } from "./paths.js";

interface InstallHooksResult {
  created: string[];
  skipped: string[];
  reportPath: string;
}

interface HookStatus {
  claudeInstalled: boolean;
  codexInstalled: boolean;
  claudeHookFile: boolean;
  codexHookFile: boolean;
  lastTrigger?: string;
  lastSuccess?: boolean;
}

const claudeHookPath = devguardPaths.claudeHook;
const codexHookPath = devguardPaths.codexHook;
const codexListenerPath = devguardPaths.codexEventListener;
const claudeSettingsPath = ".claude/settings.json";
const codexHooksPath = ".codex/hooks.json";
const hookStatusPath = devguardPaths.hookStatus;
const claudeLogPath = devguardPaths.claudeLog;
const codexLogPath = devguardPaths.codexLog;
const claudeHookCommand = '${CLAUDE_PROJECT_DIR}/.devguard/hooks/claude-stop.sh';
const codexHookCommand = '"$(git rev-parse --show-toplevel)/.devguard/hooks/codex-stop.sh"';

export async function runInstallHooks(root: string, args: string[]): Promise<void> {
  const force = args.includes("--force");
  const result = await installHooks(root, { force });
  console.log("dev-guard install-hooks");
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

export async function installHooks(root: string, options: { force?: boolean } = {}): Promise<InstallHooksResult> {
  const migration = await migrateLegacyDevguardDir(root, { force: options.force });
  const created: string[] = [];
  const skipped: string[] = migration.message ? [migration.message] : [];
  const files: Array<{ path: string; content: string; executable?: boolean }> = [
    { path: claudeHookPath, content: shellHook("claude", claudeLogPath), executable: true },
    { path: codexHookPath, content: shellHook("codex", codexLogPath), executable: true },
    { path: codexListenerPath, content: codexEventListener(), executable: true }
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
  await installJsonHookConfig(root, claudeSettingsPath, createClaudeHookConfig, { ...options, mergeExisting: true }, created, skipped);
  await installJsonHookConfig(root, codexHooksPath, createCodexHookConfig, { ...options, mergeExisting: false }, created, skipped);
  await writeHookStatusReport(root);
  return { created, skipped, reportPath: hookStatusPath };
}

export async function getHookStatus(root: string): Promise<HookStatus> {
  const [claudeLog, codexLog] = await Promise.all([
    readTextFile(fromRoot(root, claudeLogPath)),
    readTextFile(fromRoot(root, codexLogPath))
  ]);
  const logLines = [...claudeLog.split(/\r?\n/), ...codexLog.split(/\r?\n/)].filter(Boolean);
  const lastLine = logLines.at(-1);
  return {
    claudeInstalled: existsSync(fromRoot(root, claudeSettingsPath)),
    codexInstalled: existsSync(fromRoot(root, codexHooksPath)),
    claudeHookFile: existsSync(fromRoot(root, claudeHookPath)),
    codexHookFile: existsSync(fromRoot(root, codexHookPath)),
    lastTrigger: lastLine ? extractLogValue(lastLine, "timestamp") : undefined,
    lastSuccess: lastLine ? extractLogValue(lastLine, "status") === "success" : undefined
  };
}

export async function writeHookStatusReport(root: string): Promise<string> {
  await mkdir(dirname(fromRoot(root, hookStatusPath)), { recursive: true });
  const status = await getHookStatus(root);
  const markdown = [
    "# Hook Status",
    "",
    "## Installed",
    `- Claude Code: ${status.claudeInstalled && status.claudeHookFile ? "INSTALLED" : "NOT_INSTALLED"}`,
    `- Codex CLI: ${status.codexInstalled && status.codexHookFile ? "INSTALLED" : "NOT_INSTALLED"}`,
    "",
    "## Files",
    `- ${claudeHookPath}: ${status.claudeHookFile ? "exists" : "missing"}`,
    `- ${codexHookPath}: ${status.codexHookFile ? "exists" : "missing"}`,
    `- ${claudeSettingsPath}: ${status.claudeInstalled ? "exists" : "missing"}`,
    `- ${codexHooksPath}: ${status.codexInstalled ? "exists" : "missing"}`,
    "",
    "## Last Hook Trigger",
    `- time: ${status.lastTrigger ?? "none"}`,
    `- success: ${status.lastSuccess === undefined ? "unknown" : status.lastSuccess ? "yes" : "no"}`
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

hook_input="$(cat)"
timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
{
  echo "timestamp=$timestamp hook=${kind}.stop status=start"
  if [ -n "$hook_input" ]; then
    echo "timestamp=$timestamp hook=${kind}.stop stdin_json_begin"
    printf '%s\\n' "$hook_input"
    echo "timestamp=$timestamp hook=${kind}.stop stdin_json_end"
  fi
  cd "$ROOT" || exit 1
  if [ -f package.json ] && grep -q '"cli"' package.json; then
    if command -v pnpm >/dev/null 2>&1; then
      pnpm cli done
      done_status=$?
      pnpm cli status
      status_status=$?
    else
      echo "dev-guard hook failed: pnpm was not found. Install pnpm or run dev-guard done/status manually."
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
      echo "dev-guard hook failed: dev-guard was not found on PATH. Install/link dev-guard or run the local CLI manually."
      done_status=127
      status_status=127
    fi
  fi
  if [ "$done_status" -eq 0 ] && [ "$status_status" -eq 0 ]; then
    echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=${kind}.stop status=success done=$done_status status_cmd=$status_status"
  else
    echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=${kind}.stop status=failed done=$done_status status_cmd=$status_status"
    if [ "$done_status" -ne 0 ]; then
      echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=${kind}.stop handoff=not_generated reason=done_failed"
    fi
  fi
} >> "$LOG" 2>&1

cat > "$ROOT/${devguardPaths.hookStatus}" <<EOF
# Hook Status

## Installed
- Claude Code: $([ -f "$ROOT/${claudeSettingsPath}" ] && [ -f "$ROOT/${claudeHookPath}" ] && echo INSTALLED || echo NOT_INSTALLED)
- Codex CLI: $([ -f "$ROOT/${codexHooksPath}" ] && [ -f "$ROOT/${codexHookPath}" ] && echo INSTALLED || echo NOT_INSTALLED)

## Files
- ${claudeHookPath}: $([ -f "$ROOT/${claudeHookPath}" ] && echo exists || echo missing)
- ${codexHookPath}: $([ -f "$ROOT/${codexHookPath}" ] && echo exists || echo missing)
- ${claudeSettingsPath}: $([ -f "$ROOT/${claudeSettingsPath}" ] && echo exists || echo missing)
- ${codexHooksPath}: $([ -f "$ROOT/${codexHooksPath}" ] && echo exists || echo missing)

## Last Hook Trigger
- time: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
- success: $([ "$done_status" -eq 0 ] && [ "$status_status" -eq 0 ] && echo yes || echo no)
EOF

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
