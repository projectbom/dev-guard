import { chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fromRoot, readTextFile, writeTextFile } from "./fs.js";

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

const claudeHookPath = "devguard/hooks/claude-stop.sh";
const codexHookPath = "devguard/hooks/codex-stop.sh";
const codexListenerPath = "devguard/hooks/codex-event-listener.ts";
const claudeSettingsPath = ".claude/settings.json";
const codexHooksPath = ".codex/hooks.json";
const hookStatusPath = "devguard/reports/hook-status.md";
const claudeLogPath = "devguard/logs/claude-hook.log";
const codexLogPath = "devguard/logs/codex-hook.log";

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
  const created: string[] = [];
  const skipped: string[] = [];
  const files: Array<{ path: string; content: string; executable?: boolean }> = [
    { path: claudeHookPath, content: shellHook("claude", claudeLogPath), executable: true },
    { path: codexHookPath, content: shellHook("codex", codexLogPath), executable: true },
    { path: codexListenerPath, content: codexEventListener() },
    { path: claudeSettingsPath, content: claudeSettings() },
    { path: codexHooksPath, content: codexHooks() }
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
mkdir -p "$(dirname "$LOG")" "$ROOT/devguard/reports"

timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
{
  echo "timestamp=$timestamp hook=${kind}.stop status=start"
  cd "$ROOT" || exit 1
  if [ -f package.json ] && grep -q '"cli"' package.json; then
    pnpm cli done
    done_status=$?
    pnpm cli status
    status_status=$?
  else
    dev-guard done
    done_status=$?
    dev-guard status
    status_status=$?
  fi
  if [ "$done_status" -eq 0 ] && [ "$status_status" -eq 0 ]; then
    echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=${kind}.stop status=success done=$done_status status_cmd=$status_status"
  else
    echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=${kind}.stop status=failed done=$done_status status_cmd=$status_status"
  fi
} >> "$LOG" 2>&1

cat > "$ROOT/devguard/reports/hook-status.md" <<EOF
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

exit 0
`;
}

function claudeSettings(): string {
  return `${JSON.stringify(
    {
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "devguard/hooks/claude-stop.sh" }]
          }
        ]
      }
    },
    null,
    2
  )}\n`;
}

function codexHooks(): string {
  return `${JSON.stringify(
    {
      hooks: [
        { event: "Stop", command: "devguard/hooks/codex-stop.sh" },
        { event: "turn.completed", command: "devguard/hooks/codex-stop.sh" }
      ],
      jsonl: {
        events: ["turn.completed", "turn.failed"],
        listener: "devguard/hooks/codex-event-listener.ts"
      }
    },
    null,
    2
  )}\n`;
}

function codexEventListener(): string {
  return `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { appendFileSync, mkdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const root = resolve(__dirname, "../..");
const logPath = resolve(root, "devguard/logs/codex-hook.log");
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

function extractLogValue(line: string, key: string): string | undefined {
  const match = new RegExp(`${key}=([^\\s]+)`).exec(line);
  return match?.[1];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
