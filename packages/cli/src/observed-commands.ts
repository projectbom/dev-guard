/**
 * Observed command executions — the OBSERVED half of validation provenance.
 *
 * An agent's `record_validation_result` is AGENT_REPORTED: DevGuard cannot
 * prove it. The agent's own local transcript can: Codex rollouts record
 * every `CommandExecution` with its `exit_code`, and Claude Code transcripts
 * record each Bash `tool_use` with a `tool_result` (`is_error`, "Exit code N").
 * This module reads those records for one thread and time window, reduces
 * each command to a normalized identity plus exit code (no output is kept),
 * and matches a reported validation against them.
 *
 * Matching is deliberately strict: a reported command is OBSERVED only when
 * the transcript holds the same normalized command (or the same command as
 * one `&&` step) with an exit code that decides the reported result. A
 * pipeline into `tail`/`head`/`grep` reports the filter's exit code, not the
 * command's, so it can never confirm a result on its own.
 */
import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { hashThreadId, type ObservedThreadIdentity } from "./thread-ownership.js";

export interface ObservedCommand {
  /** Normalized command text (bounded) — see normalizeCommand. */
  command: string;
  /** Stable identity of the normalized command. */
  key: string;
  exitCode?: number;
  /** ISO timestamp the provider logged for the completed command. */
  at: string;
  provider: "codex" | "claude";
  /** Owner hash of the thread (thread-ownership.ts). */
  thread: string;
  /** The exit code belongs to an output filter (`| tail`), not the command. */
  filtered?: boolean;
}

export type Verification = "MATCHED" | "MISMATCH" | "UNVERIFIED";
export type CommandProvenance = "OBSERVED" | "AGENT_REPORTED";

export interface ValidationMatch {
  provenance: CommandProvenance;
  verification: Verification;
  /** Why it is UNVERIFIED/MISMATCH — a short code, see matchReportedValidation. */
  note?: "no-command" | "transcript-unavailable" | "not-observed" | "exit-inconclusive" | "status-disagrees" | "exit-code-disagrees" | "unknown-reported" | "fail-judged-from-output";
  observed?: { key: string; exitCode?: number; at: string };
}

const MAX_COMMAND_CHARS = 200;
const FILTER_COMMANDS = /^(?:tail|head|grep|egrep|rg|tee|sed|awk|cut|sort|uniq|wc|less|more|cat|jq|column)\b/;

/**
 * Normalized command identity: whitespace collapsed, quotes dropped, leading
 * `cd …&&` steps, env assignments and `env`, trailing `2>&1` / `; echo $?`
 * and output filters (`| tail -n 40`) removed. Two spellings of the same
 * run normalize to the same text; the exit-code effect of a removed filter
 * is reported separately (see splitCommand).
 */
export function normalizeCommand(command: string): string {
  return splitCommand(command).core;
}

export function commandKey(command: string): string {
  const normalized = normalizeCommand(command);
  return normalized ? createHash("sha256").update(normalized).digest("hex").slice(0, 12) : "";
}

interface SplitCommand {
  core: string;
  /** `&&`-joined steps of core (each normalized). */
  steps: string[];
  /** A `;`-joined last step decides the exit code: true when core had `;` joins. */
  sequential: boolean;
  /** An output filter was removed: the observed exit code is the filter's. */
  filtered: boolean;
}

function splitCommand(raw: string): SplitCommand {
  let text = raw.replace(/\\\r?\n/g, " ").replace(/\s+/g, " ").trim();
  const pipefail = /set -o pipefail|pipefail/.test(text);
  // Trailing exit-code echoes and redirections never change what ran.
  text = text.replace(/(?:\s*;\s*echo\s+["']?[^;|&]*\$\?["']?)+$/i, "").replace(/\s+2>&1/g, "").replace(/\s+>\s*\/dev\/null/g, "").trim();
  let filtered = false;
  // Output filters at the end of a pipeline.
  for (;;) {
    const index = text.lastIndexOf(" | ");
    if (index < 0) break;
    const tail = text.slice(index + 3).trim();
    if (!FILTER_COMMANDS.test(tail)) break;
    text = text.slice(0, index).trim();
    if (!pipefail) filtered = true;
  }
  const sequential = /\s;\s|;\s/.test(text.replace(/set -o pipefail;?/g, ""));
  const steps = text
    .split(/\s*&&\s*|\s*;\s*/)
    .map((step) => normalizeStep(step))
    .filter((step) => step && !/^cd\b/.test(step) && !/^set\b/.test(step) && !/^export\b/.test(step));
  const core = steps.join(" && ").slice(0, MAX_COMMAND_CHARS);
  return { core, steps, sequential, filtered };
}

function normalizeStep(step: string): string {
  let text = step.trim().replace(/["']/g, "");
  // `env A=1 B=2 cmd`, `A=1 cmd`
  text = text.replace(/^env\s+(?:-\S+\s+)*/, "");
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(text)) text = text.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Match one reported validation against observed commands (latest first
 * wins). Cases (the release contract):
 *   reported PASS + observed exit 0      → OBSERVED / MATCHED
 *   reported FAIL + observed non-zero    → OBSERVED / MATCHED
 *   reported PASS + observed non-zero    → AGENT_REPORTED / MISMATCH
 *   reported exit code ≠ observed one    → AGENT_REPORTED / MISMATCH
 *   reported FAIL + observed exit 0      → AGENT_REPORTED / UNVERIFIED (a
 *     script that exits 0 and prints a failing verdict: plausible, not proven)
 *   no observed command / inconclusive   → AGENT_REPORTED / UNVERIFIED
 * Nothing is ever invented: without transcript evidence the agent's report
 * stays AGENT_REPORTED.
 */
export function matchReportedValidation(
  reported: { command?: string; status: "PASS" | "FAIL" | "UNKNOWN"; exitCode?: number },
  observed: ObservedCommand[] | undefined
): ValidationMatch {
  const command = reported.command?.trim();
  if (!command) return { provenance: "AGENT_REPORTED", verification: "UNVERIFIED", note: "no-command" };
  if (!observed) return { provenance: "AGENT_REPORTED", verification: "UNVERIFIED", note: "transcript-unavailable" };
  const wanted = splitCommand(command);
  if (!wanted.core) return { provenance: "AGENT_REPORTED", verification: "UNVERIFIED", note: "no-command" };
  const candidates = [...observed].sort((a, b) => b.at.localeCompare(a.at));
  for (const candidate of candidates) {
    const seen = splitCommand(candidate.command);
    const exact = seen.core === wanted.core;
    const asStep = !exact && wanted.steps.length === 1 && seen.steps.includes(wanted.core);
    if (!exact && !asStep) continue;
    const ref = { key: candidate.key, ...(candidate.exitCode !== undefined ? { exitCode: candidate.exitCode } : {}), at: candidate.at };
    if (candidate.exitCode === undefined || candidate.filtered) return { provenance: "AGENT_REPORTED", verification: "UNVERIFIED", note: "exit-inconclusive", observed: ref };
    // One `&&` step of a longer chain: exit 0 proves every step passed; a
    // failure could be any step (only the first step's failure is decisive).
    // `;`-joined chains report the last step only.
    if (asStep) {
      const position = seen.steps.indexOf(wanted.core);
      const decisive = seen.sequential
        ? position === seen.steps.length - 1
        : candidate.exitCode === 0 || position === 0;
      if (!decisive) return { provenance: "AGENT_REPORTED", verification: "UNVERIFIED", note: "exit-inconclusive", observed: ref };
    }
    if (reported.exitCode !== undefined && reported.exitCode !== candidate.exitCode) {
      return { provenance: "AGENT_REPORTED", verification: "MISMATCH", note: "exit-code-disagrees", observed: ref };
    }
    if (reported.status === "UNKNOWN") return { provenance: "AGENT_REPORTED", verification: "UNVERIFIED", note: "unknown-reported", observed: ref };
    const observedPass = candidate.exitCode === 0;
    if ((reported.status === "PASS") === observedPass) return { provenance: "OBSERVED", verification: "MATCHED", observed: ref };
    if (reported.status === "FAIL") return { provenance: "AGENT_REPORTED", verification: "UNVERIFIED", note: "fail-judged-from-output", observed: ref };
    return { provenance: "AGENT_REPORTED", verification: "MISMATCH", note: "status-disagrees", observed: ref };
  }
  return { provenance: "AGENT_REPORTED", verification: "UNVERIFIED", note: "not-observed" };
}

// --- transcript readers -------------------------------------------------

export interface ObserveCommandsInput {
  root: string;
  /** Only commands completed at/after this instant (task start). */
  sinceIso: string;
  /** The calling thread, when observable (MCP env/meta). */
  caller?: ObservedThreadIdentity;
  /** The task owner's thread hash (thread-ownership.ts), when known. */
  ownerThreadHash?: string;
  /** The owner's provider; a Claude owner is found by hash among this project's own transcripts. */
  ownerProvider?: "codex" | "claude";
  codexSessionsDir?: string;
  claudeProjectsDir?: string;
}

/**
 * Commands the task's own thread executed since `sinceIso`, or undefined
 * when no transcript for that thread can be found (unobservable — never an
 * empty "nothing ran"). Codex is located by owner hash; Claude Code by the
 * session id the MCP server sees in its environment.
 */
export async function observeCommands(input: ObserveCommandsInput): Promise<ObservedCommand[] | undefined> {
  const sinceMs = Date.parse(input.sinceIso);
  if (!Number.isFinite(sinceMs)) return undefined;
  if (input.caller?.provider === "claude") {
    return readClaudeCommands(input.caller.threadId, sinceMs, input.claudeProjectsDir);
  }
  if (!input.caller && input.ownerProvider === "claude" && input.ownerThreadHash) {
    const sessionId = await claudeSessionByHash(input.root, input.ownerThreadHash, input.claudeProjectsDir);
    return sessionId ? readClaudeCommands(sessionId, sinceMs, input.claudeProjectsDir) : undefined;
  }
  const ownerHash = input.caller?.provider === "codex" ? hashThreadId("codex", input.caller.threadId) : input.ownerThreadHash;
  if (!ownerHash) return undefined;
  return readCodexCommands(input.root, ownerHash, sinceMs, input.codexSessionsDir);
}

/** Per-file incremental read state, so a long-lived MCP server parses only new bytes. */
interface TranscriptCache {
  offset: number;
  size: number;
  partial: string;
  matches?: boolean;
  owner?: string;
  commands: ObservedCommand[];
  /** Claude only: pending tool_use ids → command. */
  pending?: Map<string, { command: string; at: string }>;
}

const transcriptCache = new Map<string, TranscriptCache>();
const MAX_COMMANDS_PER_FILE = 4000;
const READ_CHUNK = 4 * 1024 * 1024;

async function readIncrementally(path: string, onLine: (line: string, state: TranscriptCache) => void): Promise<TranscriptCache | undefined> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  let state = transcriptCache.get(path);
  if (!state || info.size < state.size) {
    state = { offset: 0, size: 0, partial: "", commands: [] };
    transcriptCache.set(path, state);
  }
  if (state.matches === false || info.size === state.offset) return state;
  const handle = await open(path, "r");
  try {
    while (state.offset < info.size) {
      const length = Math.min(READ_CHUNK, info.size - state.offset);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, state.offset);
      state.offset += length;
      const lines = (state.partial + buffer.toString("utf8")).split("\n");
      state.partial = lines.pop() ?? "";
      for (const line of lines) {
        onLine(line, state);
        if ((state.matches as boolean | undefined) === false) {
          state.offset = info.size;
          state.partial = "";
          break;
        }
      }
    }
  } finally {
    await handle.close();
  }
  state.size = info.size;
  if (state.commands.length > MAX_COMMANDS_PER_FILE) state.commands.splice(0, state.commands.length - MAX_COMMANDS_PER_FILE);
  return state;
}

function normalizeDir(path: string): string {
  return path.replace(/\/+$/, "");
}

/** Codex rollouts for `root` whose thread hashes to `ownerHash`, from the last two days of session folders. */
async function readCodexCommands(root: string, ownerHash: string, sinceMs: number, sessionsDir?: string): Promise<ObservedCommand[] | undefined> {
  const base = sessionsDir ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  const files = await listCodexRollouts(base, sinceMs);
  let found = false;
  const commands: ObservedCommand[] = [];
  for (const file of files) {
    const state = await readIncrementally(file, (line, current) => ingestCodexLine(line, current, root)).catch(() => undefined);
    if (!state?.matches || state.owner !== ownerHash) continue;
    found = true;
    for (const command of state.commands) if (Date.parse(command.at) >= sinceMs) commands.push(command);
  }
  return found ? commands : undefined;
}

export async function listCodexRollouts(base: string, sinceMs: number, nowMs = Date.now()): Promise<string[]> {
  const days = new Set<string>();
  for (let time = sinceMs - 86_400_000; time <= nowMs + 86_400_000; time += 86_400_000) {
    const date = new Date(time);
    days.add(join(base, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")));
  }
  const files: string[] = [];
  for (const dir of days) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const modified = await stat(join(dir, name)).then((info) => info.mtimeMs, () => 0);
      if (modified >= sinceMs) files.push(join(dir, name));
    }
  }
  return files;
}

function ingestCodexLine(line: string, state: TranscriptCache, root: string): void {
  if (state.matches === undefined) {
    if (!line.includes('"session_meta"')) return;
  } else if (!line.includes('"CommandExecution"') || !line.includes('"item_completed"')) {
    return;
  }
  let entry: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const payload = entry.payload ?? {};
  if (entry.type === "session_meta") {
    const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
    state.matches = normalizeDir(cwd) === normalizeDir(root);
    if (state.matches) state.owner = hashThreadId("codex", String(payload.id ?? payload.session_id ?? ""));
    return;
  }
  if (!state.matches || payload.type !== "item_completed") return;
  const command = codexCommandFromItem((payload.item ?? {}) as Record<string, unknown>, entry.timestamp ?? "", state.owner ?? "");
  if (command) state.commands.push(command);
}

/** Pure mapping of a Codex `item_completed.item` CommandExecution to an observed command. */
export function codexCommandFromItem(item: Record<string, unknown>, at: string, thread: string): ObservedCommand | undefined {
  if (item.type !== "CommandExecution") return undefined;
  const argv = Array.isArray(item.command) ? item.command.map(String) : typeof item.command === "string" ? [item.command] : [];
  const text = argv.length >= 3 && /sh$/.test(argv[0]) && argv[1].startsWith("-") ? argv[2] : argv.join(" ");
  const split = splitCommand(text);
  if (!split.core) return undefined;
  const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
  return {
    command: split.core,
    key: commandKey(text),
    ...(exitCode !== undefined ? { exitCode } : {}),
    at,
    provider: "codex",
    thread,
    ...(split.filtered ? { filtered: true } : {})
  };
}

/** Claude Code keeps a project's sessions in projects/<root with "/" and "." as "-">/<session>.jsonl. */
async function claudeSessionByHash(root: string, ownerHash: string, projectsDir?: string): Promise<string | undefined> {
  const base = projectsDir ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  const names = await readdir(join(base, root.replace(/[/.]/g, "-"))).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    if (hashThreadId("claude", sessionId) === ownerHash) return sessionId;
  }
  return undefined;
}

async function readClaudeCommands(sessionId: string, sinceMs: number, projectsDir?: string): Promise<ObservedCommand[] | undefined> {
  const base = projectsDir ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  const thread = hashThreadId("claude", sessionId);
  for (const dir of await readdir(base).catch(() => [] as string[])) {
    const path = join(base, dir, `${sessionId}.jsonl`);
    const state = await readIncrementally(path, (line, current) => ingestClaudeLine(line, current, thread)).catch(() => undefined);
    if (!state) continue;
    return state.commands.filter((command) => Date.parse(command.at) >= sinceMs);
  }
  return undefined;
}

function ingestClaudeLine(line: string, state: TranscriptCache, thread: string): void {
  state.matches = true;
  const isUse = line.includes('"tool_use"') && line.includes('"Bash"');
  const isResult = line.includes('"tool_result"');
  if (!isUse && !isResult) return;
  let entry: { timestamp?: string; message?: { content?: unknown } };
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const content = Array.isArray(entry.message?.content) ? (entry.message?.content as Array<Record<string, unknown>>) : [];
  state.pending ??= new Map();
  for (const part of content) {
    if (part.type === "tool_use" && part.name === "Bash") {
      const input = (part.input ?? {}) as { command?: unknown };
      if (typeof input.command === "string" && typeof part.id === "string") state.pending.set(part.id, { command: input.command, at: entry.timestamp ?? "" });
    } else if (part.type === "tool_result" && typeof part.tool_use_id === "string") {
      const use = state.pending.get(part.tool_use_id);
      if (!use) continue;
      state.pending.delete(part.tool_use_id);
      const command = claudeCommandFromResult(use.command, part, entry.timestamp ?? use.at, thread);
      if (command) state.commands.push(command);
    }
  }
  // Unanswered tool uses never grow without bound.
  if (state.pending.size > 200) state.pending.clear();
}

/** A Claude Bash tool_result → observed command. Background starts and interrupted calls carry no exit code. */
export function claudeCommandFromResult(command: string, result: Record<string, unknown>, at: string, thread: string): ObservedCommand | undefined {
  const split = splitCommand(command);
  if (!split.core) return undefined;
  const text = typeof result.content === "string"
    ? result.content
    : Array.isArray(result.content)
      ? (result.content as Array<{ text?: unknown }>).map((part) => (typeof part.text === "string" ? part.text : "")).join("\n")
      : "";
  let exitCode: number | undefined;
  if (result.is_error === true) {
    const match = /^Exit code (\d+)/.exec(text.trimStart());
    exitCode = match ? Number(match[1]) : undefined;
  } else if (!/running in (?:the )?background|Command running in background/i.test(text)) {
    exitCode = 0;
  }
  return {
    command: split.core,
    key: commandKey(command),
    ...(exitCode !== undefined ? { exitCode } : {}),
    at,
    provider: "claude",
    thread,
    ...(split.filtered ? { filtered: true } : {})
  };
}

/** Test seam: forget incremental transcript state. */
export function resetObservedCommandCache(): void {
  transcriptCache.clear();
}
