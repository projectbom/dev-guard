import { chmod, copyFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readTextFile, writeTextFile } from "./fs.js";

export interface CodexNotifyConfigStatus {
  configPath: string;
  dispatcherPath: string;
  dispatcherInstalled: boolean;
  notify?: string[];
  notifyConfigured: boolean;
  notifyIsDispatcher: boolean;
  existingNotifyDetected: boolean;
}

export interface InstallCodexNotifyDispatcherResult {
  changed: boolean;
  backupPath?: string;
  dispatcherPath: string;
  message: string;
}

export const codexNotifyConfigPath = join(homedir(), ".codex", "config.toml");
export const codexNotifyDispatcherPath = join(homedir(), ".codex", "dev-guard-notify-dispatcher.sh");
export const codexNotifyDispatcherLogPath = join(homedir(), ".codex", "dev-guard-notify-dispatcher.log");

export async function getCodexNotifyConfigStatus(): Promise<CodexNotifyConfigStatus> {
  const text = await readTextFile(codexNotifyConfigPath);
  const notify = parseTopLevelNotify(text);
  const notifyIsDispatcher = Boolean(notify?.[0] === codexNotifyDispatcherPath);
  return {
    configPath: codexNotifyConfigPath,
    dispatcherPath: codexNotifyDispatcherPath,
    dispatcherInstalled: existsSync(codexNotifyDispatcherPath),
    notify,
    notifyConfigured: Boolean(notify),
    notifyIsDispatcher,
    existingNotifyDetected: Boolean(notify && !notifyIsDispatcher)
  };
}

export async function installCodexNotifyDispatcher(options: { force?: boolean } = {}): Promise<InstallCodexNotifyDispatcherResult> {
  const text = await readTextFile(codexNotifyConfigPath);
  const notify = parseTopLevelNotify(text);
  const notifyIsDispatcher = Boolean(notify?.[0] === codexNotifyDispatcherPath);
  const originalNotify = notifyIsDispatcher ? readOriginalNotifyFromDispatcher() ?? [] : notify ?? [];

  if (notifyIsDispatcher && existsSync(codexNotifyDispatcherPath) && !options.force) {
    return {
      changed: false,
      dispatcherPath: codexNotifyDispatcherPath,
      message: "Codex notify dispatcher already installed"
    };
  }

  await writeTextFile(codexNotifyDispatcherPath, dispatcherScript(originalNotify));
  await chmod(codexNotifyDispatcherPath, 0o755);

  const backupPath = `${codexNotifyConfigPath}.devguard-backup-${timestampForFile()}`;
  if (existsSync(codexNotifyConfigPath)) {
    await copyFile(codexNotifyConfigPath, backupPath);
  }

  const nextText = replaceTopLevelNotify(text, [codexNotifyDispatcherPath]);
  await writeTextFile(codexNotifyConfigPath, nextText);
  return {
    changed: true,
    backupPath,
    dispatcherPath: codexNotifyDispatcherPath,
    message: originalNotify.length > 0 ? "Codex notify dispatcher installed and existing notify preserved" : "Codex notify dispatcher installed"
  };
}

export function formatNotifyCommand(command: string[] | undefined): string {
  return command && command.length > 0 ? command.map((part) => JSON.stringify(part)).join(" ") : "none";
}

function readOriginalNotifyFromDispatcher(): string[] | undefined {
  const text = existsSync(codexNotifyDispatcherPath) ? readFileSync(codexNotifyDispatcherPath, "utf8") : "";
  const match = /^ORIGINAL_NOTIFY=\((.*)\)$/m.exec(text);
  return match ? parseShellArray(match[1]) : undefined;
}

function parseTopLevelNotify(text: string): string[] | undefined {
  const match = /^notify\s*=\s*\[([^\n]*)\]\s*$/m.exec(text);
  if (!match) return undefined;
  return parseTomlStringArray(match[1]);
}

function parseTomlStringArray(value: string): string[] {
  const result: string[] = [];
  const pattern = /"((?:\\"|\\\\|[^"])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    result.push(match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }
  return result;
}

function replaceTopLevelNotify(text: string, notify: string[]): string {
  const line = `notify = [${notify.map((item) => JSON.stringify(item)).join(", ")}]`;
  if (/^notify\s*=/m.test(text)) {
    return text.replace(/^notify\s*=\s*\[[^\n]*\]\s*$/m, line);
  }
  return `${line}\n${text}`;
}

function dispatcherScript(originalNotify: string[]): string {
  return `#!/usr/bin/env bash
set +e

LOG="${codexNotifyDispatcherLogPath}"
ORIGINAL_NOTIFY=(${originalNotify.map(shellQuote).join(" ")})

mkdir -p "$(dirname "$LOG")"
timestamp() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { printf 'timestamp=%s dispatcher=codex.notify %s\\n' "$(timestamp)" "$*" >> "$LOG"; }

log "status=start argc=$#"

if [ "\${#ORIGINAL_NOTIFY[@]}" -gt 0 ]; then
  log "original_notify=status_running command=\${ORIGINAL_NOTIFY[0]}"
  "\${ORIGINAL_NOTIFY[@]}" "$@"
  original_status=$?
  log "original_notify=status_completed exit=$original_status"
else
  original_status=0
  log "original_notify=none"
fi

payload="$*"
json_root="$(printf '%s\\n' "$payload" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)"
if [ -z "$json_root" ]; then
  json_root="$(printf '%s\\n' "$payload" | sed -n 's/.*"project_root"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)"
fi
if [ -z "$json_root" ]; then
  json_root="$(printf '%s\\n' "$payload" | sed -n 's/.*"workspace_root"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)"
fi

for candidate in "$json_root" "\${CODEX_WORKSPACE_ROOT:-}" "\${CODEX_PROJECT_DIR:-}" "\${INIT_CWD:-}" "$PWD"; do
  [ -z "$candidate" ] && continue
  if [ -x "$candidate/.devguard/hooks/codex-notify.sh" ]; then
    log "devguard_notify=status_running root=$candidate"
    DEV_GUARD_HOOK_SOURCE=agent_runtime "$candidate/.devguard/hooks/codex-notify.sh" "$@"
    devguard_status=$?
    log "devguard_notify=status_completed exit=$devguard_status root=$candidate"
    log "status=completed original=$original_status devguard=$devguard_status"
    exit 0
  fi
done

log "devguard_notify=skipped reason=no_project_hook"
log "status=completed original=$original_status devguard=skipped"
exit 0
`;
}

function parseShellArray(value: string): string[] {
  const result: string[] = [];
  const pattern = /'((?:'\\''|[^'])*)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    result.push(match[1].replace(/'\\''/g, "'"));
  }
  return result;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function timestampForFile(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
