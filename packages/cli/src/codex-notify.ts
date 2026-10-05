import { chmod, copyFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readTextFile, writeTextFile } from "./fs.js";
import { HOOK_LOG_GENERATIONS, HOOK_LOG_ROTATE_BYTES } from "./hook-log-policy.js";

export interface CodexNotifyConfigStatus {
  configPath: string;
  dispatcherPath: string;
  dispatcherInstalled: boolean;
  notify?: string[];
  notifyConfigured: boolean;
  notifyIsDispatcher: boolean;
  /**
   * notify is another program (e.g. Codex Computer Use's SkyComputerUseClient
   * `--previous-notify [...]`) that itself chains to our dispatcher — the
   * dispatcher is still reached on every turn, so this counts as installed.
   */
  notifyWrapsDispatcher: boolean;
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
  const notifyWrapsDispatcher = !notifyIsDispatcher && referencesDispatcher(notify);
  return {
    configPath: codexNotifyConfigPath,
    dispatcherPath: codexNotifyDispatcherPath,
    dispatcherInstalled: existsSync(codexNotifyDispatcherPath),
    notify,
    notifyConfigured: Boolean(notify),
    notifyIsDispatcher,
    notifyWrapsDispatcher,
    existingNotifyDetected: Boolean(notify && !notifyIsDispatcher && !notifyWrapsDispatcher)
  };
}

export async function installCodexNotifyDispatcher(options: { force?: boolean } = {}): Promise<InstallCodexNotifyDispatcherResult> {
  const text = await readTextFile(codexNotifyConfigPath);
  const notify = parseTopLevelNotify(text);
  const notifyIsDispatcher = Boolean(notify?.[0] === codexNotifyDispatcherPath);
  const notifyWrapsDispatcher = !notifyIsDispatcher && referencesDispatcher(notify);
  const existingDispatcherText = existsSync(codexNotifyDispatcherPath) ? readFileSync(codexNotifyDispatcherPath, "utf8") : "";
  const existingOriginal = readOriginalNotifyFromDispatcher(existingDispatcherText);

  if (notifyWrapsDispatcher) {
    // Another notify program already calls our dispatcher (via
    // --previous-notify). Rewriting config.toml would fight that program,
    // and chaining it again from the dispatcher is exactly the infinite
    // loop seen in the wild (Codex -> Sky -> dispatcher -> Sky -> ...):
    // keep config.toml as is and make the dispatcher a leaf.
    const originalNotify = withoutRedundantWrapper(stripDispatcherSelfReference(existingOriginal ?? []), notify ?? []);
    const nextScript = dispatcherScript(originalNotify);
    if (existingDispatcherText === nextScript) {
      return { changed: false, dispatcherPath: codexNotifyDispatcherPath, message: "Codex notify dispatcher already installed (reached via an existing notify wrapper)" };
    }
    const backupPath = existingDispatcherText ? `${codexNotifyDispatcherPath}.devguard-backup-${timestampForFile()}` : undefined;
    if (backupPath) await copyFile(codexNotifyDispatcherPath, backupPath);
    await writeTextFile(codexNotifyDispatcherPath, nextScript);
    await chmod(codexNotifyDispatcherPath, 0o755);
    return {
      changed: true,
      backupPath,
      dispatcherPath: codexNotifyDispatcherPath,
      message: "Codex notify dispatcher regenerated; config.toml left unchanged (existing notify already chains to the dispatcher)"
    };
  }

  const originalNotify = stripDispatcherSelfReference(notifyIsDispatcher ? existingOriginal ?? [] : notify ?? []);

  if (notifyIsDispatcher && existingDispatcherText && !options.force) {
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

/**
 * The dispatcher must never (directly or via a wrapper's
 * `--previous-notify`) call itself: drop any `--previous-notify <value>`
 * pair whose value references the dispatcher, and if the dispatcher is
 * still referenced anywhere after that, drop the whole original command.
 */
export function stripDispatcherSelfReference(command: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] === "--previous-notify" && index + 1 < command.length && referencesDispatcher([command[index + 1]])) {
      index += 1;
      continue;
    }
    result.push(command[index]);
  }
  return referencesDispatcher(result) ? [] : result;
}

// When config.toml's notify is a wrapper that already runs before the
// dispatcher, re-running that same program from the dispatcher would fire
// it twice per turn.
function withoutRedundantWrapper(original: string[], configNotify: string[]): string[] {
  const wrapper = stripDispatcherSelfReference(configNotify);
  return original.length > 0 && original[0] === wrapper[0] ? [] : original;
}

function referencesDispatcher(command: string[] | undefined): boolean {
  return Boolean(command?.some((part) => part.replace(/\\\//g, "/").includes(codexNotifyDispatcherPath)));
}

export function formatNotifyCommand(command: string[] | undefined): string {
  return command && command.length > 0 ? command.map((part) => JSON.stringify(part)).join(" ") : "none";
}

function readOriginalNotifyFromDispatcher(text: string): string[] | undefined {
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

export function dispatcherScript(originalNotify: string[]): string {
  return `#!/usr/bin/env bash
set +e

LOG="${codexNotifyDispatcherLogPath}"
ORIGINAL_NOTIFY=(${originalNotify.map(shellQuote).join(" ")})
LOG_MAX_BYTES="\${DEV_GUARD_HOOK_LOG_MAX_BYTES:-${HOOK_LOG_ROTATE_BYTES}}"
LOG_GENERATIONS=${HOOK_LOG_GENERATIONS}

mkdir -p "$(dirname "$LOG")"
timestamp() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { printf 'timestamp=%s dispatcher=codex.notify %s\\n' "$(timestamp)" "$*" >> "$LOG"; }
file_size() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || echo 0; }
rotate_log() {
  [ -f "$LOG" ] || return 0
  size="$(file_size "$LOG")"
  case "$size" in ''|*[!0-9]*) return 0 ;; esac
  [ "$size" -lt "$LOG_MAX_BYTES" ] && return 0
  gen=$LOG_GENERATIONS
  while [ "$gen" -gt 1 ]; do
    prev=$((gen - 1))
    [ -f "$LOG.$prev" ] && mv -f "$LOG.$prev" "$LOG.$gen"
    gen=$prev
  done
  mv -f "$LOG" "$LOG.1"
}

rotate_log
# Re-entry guard: if ORIGINAL_NOTIFY (or anything it runs) ever calls this
# dispatcher again, stop instead of recursing (a real notify loop reached
# 8000+ nested processes and exhausted the user's process limit).
if [ -n "\${DEV_GUARD_NOTIFY_DISPATCHER_ACTIVE:-}" ]; then
  log "status=skipped reason=reentrant argc=$#"
  exit 0
fi
export DEV_GUARD_NOTIFY_DISPATCHER_ACTIVE=1

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
