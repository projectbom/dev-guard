import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens } from "@dev-guard/core";

/**
 * Agent activity observability — METADATA ONLY.
 *
 * Reads what an AI agent actually did (commands, MCP calls, file changes,
 * compactions) from logs the agent itself keeps locally, and reduces every
 * item, in memory, to a small classified record: category, work mode,
 * repo-relative path (reads/edits only), an ESTIMATED token count of the
 * text that entered the agent's context, and a few flags. Command text,
 * command output, prompts, responses and source content are never stored
 * or returned — they are only looked at transiently to classify.
 *
 * Sources: DevGuard's own telemetry is read elsewhere (context-efficiency);
 * this module adds provider-local logs behind one small interface.
 * Codex is implemented (its rollout JSONL `item_completed` events are a
 * structured, documented-by-shape local record); Claude is a stub on the
 * same interface until an adapter is needed.
 */

export type ContextCostCategory = "MCP" | "FALLBACK_DOCS" | "SEARCH" | "CODE_READS" | "CODE_EDITS" | "VALIDATION" | "ADMIN" | "OTHER";
export type WorkMode = "IMPLEMENTATION" | "EXPLORATION" | "VALIDATION" | "CONTEXT_ADMIN" | "RESUME_RECOVERY" | "OTHER";
export type EvidenceKind = "OBSERVED" | "ESTIMATED" | "INFERRED";

export interface ActivityEvent {
  /** ISO timestamp of the item (OBSERVED). */
  ts: string;
  provider: "codex" | "claude";
  /** sha256(thread id) prefix — never the raw id. */
  thread: string;
  kind: "command" | "mcp" | "file_change" | "compaction" | "web" | "other_tool";
  category: ContextCostCategory;
  mode: WorkMode;
  /** ESTIMATED context tokens (chars/4 of the text that entered context). Not provider-billed. */
  estTokens: number;
  /** Repo-relative paths read/edited (reads, edits only; never search queries). */
  paths?: string[];
  /** Repository-wide search (no narrowing path). */
  broadSearch?: boolean;
  /** MCP prepare_task_context result: the files it provided (repo-relative). */
  providedPaths?: string[];
  /** OTHER only: a non-sensitive label of what it was (MCP server/tool name, "web", "inline script", "shell"). */
  otherLabel?: string;
  durationMs?: number;
}

export interface ThreadInfo {
  thread: string;
  provider: "codex" | "claude";
  /** "user" = a real user thread; "subagent" = e.g. Codex guardian review. */
  source: "user" | "subagent";
  startedAt: string;
}

export interface ActivitySnapshot {
  provider: "codex" | "claude";
  available: boolean;
  /** Why the source is unavailable, when it is. */
  note?: string;
  threads: ThreadInfo[];
  events: ActivityEvent[];
}

export interface AgentActivitySource {
  readonly provider: "codex" | "claude";
  collect(root: string, sinceMs: number): Promise<ActivitySnapshot>;
}

export function hashThreadId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 10);
}

// --- classification (deterministic) ------------------------------------

const FALLBACK_DOC_PATTERN = /\.devguard\/(?:reports|context|prompts)\/[\w.-]+|\.devguard\/(?:task|rules|mistakes|project|architecture|decisions|tasks)\.md/;
const VALIDATION_PATTERN = /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+|--filter\s+\S+\s+|-r\s+)*(?:test|lint|typecheck|type-check|build|check|verify)\b|\bnode\s+--test\b|\b(?:tsc|vitest|jest|pytest|eslint|playwright|cargo\s+test|go\s+test)\b|\bcurl\b|\bdev-guard\s+self-check\b/;
const ADMIN_PATTERN = /(?:^|[\s/;&|])dev-guard(?:\s+|$)|\bnpx\s+(?:--no-install\s+)?dev-guard\b/;
const SEARCH_HEAD = /^(?:rg|grep|egrep|fgrep|find|fd|ag|ack|git\s+grep|git\s+ls-files)\b/;
const READ_HEAD = /^(?:cat|sed|head|tail|nl|less|more|bat|wc|jq)\b/;
const GIT_READ = /^git\s+(?:diff|status|log|show|blame)\b/;

export interface CommandClassification {
  category: ContextCostCategory;
  mode: WorkMode;
  paths: string[];
  broadSearch: boolean;
  otherLabel?: string;
}

interface ParsedCommandPart {
  type?: string;
  cmd?: string;
  path?: string;
}

/**
 * Classifies one executed shell command. `parsed` is the agent's own
 * structured parse when available (Codex: read/search/list_files/unknown);
 * otherwise the command string is used. `cwd` and `root` turn paths into
 * repo-relative form; paths outside the repository are dropped.
 */
export function classifyCommand(command: string, parsed: ParsedCommandPart[], cwd: string, root: string): CommandClassification {
  // `pwd && rg ...` / `cd x; sed -n ...`: classify by the first meaningful
  // segment, not by a leading no-op.
  const text = meaningfulSegment(command.trim());
  const paths = new Set<string>();
  if (FALLBACK_DOC_PATTERN.test(text)) {
    for (const match of text.matchAll(new RegExp(FALLBACK_DOC_PATTERN.source, "g"))) paths.add(match[0]);
    return { category: "FALLBACK_DOCS", mode: "CONTEXT_ADMIN", paths: [...paths], broadSearch: false };
  }
  if (ADMIN_PATTERN.test(text) && !/\bdev-guard\s+self-check\b/.test(text)) return { category: "ADMIN", mode: "CONTEXT_ADMIN", paths: [], broadSearch: false };
  if (VALIDATION_PATTERN.test(text)) return { category: "VALIDATION", mode: "VALIDATION", paths: [], broadSearch: false };

  const parts = parsed.length > 0 ? parsed : [{ type: "unknown", cmd: text }];
  let search = false;
  let broad = false;
  let read = false;
  for (const part of parts) {
    const cmd = (part.cmd ?? text).trim();
    if (part.type === "search" || part.type === "list_files" || SEARCH_HEAD.test(cmd) || /^ls\s+(?:-\w*R|--recursive)/.test(cmd)) {
      search = true;
      if (isBroadSearch(cmd, cwd, root)) broad = true;
    } else if (part.type === "read" || READ_HEAD.test(cmd) || GIT_READ.test(cmd)) {
      read = true;
      const path = part.path ?? lastPathArgument(cmd);
      const relative = path ? toRepoRelative(path, cwd, root) : undefined;
      if (relative) paths.add(relative);
    }
  }
  if (!search && !read && /^python3?\b/.test(text)) {
    if (/\bos\.walk\b|\bglob\(|\.rglob\(|\bsubprocess\b.*\b(?:rg|grep|find)\b/.test(text)) return { category: "SEARCH", mode: "EXPLORATION", paths: [], broadSearch: true };
    if (/open\([^)]*['"]w['"]|\.write_text\(|\.write\(/.test(text)) return { category: "CODE_EDITS", mode: "IMPLEMENTATION", paths: [], broadSearch: false };
  }
  if (search) return { category: "SEARCH", mode: "EXPLORATION", paths: [], broadSearch: broad };
  if (read) return { category: "CODE_READS", mode: "EXPLORATION", paths: [...paths], broadSearch: false };
  return { category: "OTHER", mode: "OTHER", paths: [], broadSearch: false, otherLabel: /^python3?\b|^node\s+-e/.test(text) ? "inline script" : "shell" };
}

const NOOP_SEGMENT = /^(?:cd|pwd|set|export|echo|printf|true|ulimit|clear)\b/;

function meaningfulSegment(command: string): string {
  if (/^python3?\b|<<|^node\s+-e/.test(command)) return command;
  const segments = command.split(/\s*(?:&&|\|\||;|\n)\s*/).map((part) => part.trim()).filter(Boolean);
  const meaningful = segments.filter((part) => !NOOP_SEGMENT.test(part));
  return meaningful.length > 0 ? meaningful.join(" && ") : command;
}

function isBroadSearch(cmd: string, cwd: string, root: string): boolean {
  const args = shellWords(cmd).slice(1).filter((arg) => !arg.startsWith("-"));
  // rg/grep PATTERN [PATH...]; find [PATH...]; ls -R [PATH]
  const isFind = /^(?:find|fd)\b/.test(cmd) || /^ls\b/.test(cmd) || /^git\s+ls-files\b/.test(cmd) || /--files\b/.test(cmd);
  const pathArgs = isFind ? args.filter((arg) => !/^git$|^ls-files$/.test(arg)).slice(0, 1) : args.slice(1);
  if (pathArgs.length === 0) return normalizeDir(cwd) === normalizeDir(root);
  return pathArgs.some((arg) => {
    const absolute = isAbsolute(arg) ? arg : join(cwd, arg);
    return normalizeDir(absolute) === normalizeDir(root);
  });
}

function normalizeDir(path: string): string {
  return path.replace(/\/+$/, "").replace(/\/\.$/, "");
}

function lastPathArgument(cmd: string): string | undefined {
  const args = shellWords(cmd).slice(1).filter((arg) => !arg.startsWith("-") && !/^\d+(,\d+)?p$/.test(arg) && !/^['"]?\d/.test(arg));
  return args.at(-1);
}

function shellWords(cmd: string): string[] {
  const words: string[] = [];
  for (const match of cmd.split(/[|;&]/)[0].matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g)) words.push(match[1] ?? match[2] ?? match[3]);
  return words;
}

export function toRepoRelative(path: string, cwd: string, root: string): string | undefined {
  const absolute = isAbsolute(path) ? path : join(cwd, path);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split("\\").join("/");
}

// --- Codex local rollout adapter ---------------------------------------

interface CodexFileState {
  size: number;
  offset: number;
  matches?: boolean;
  thread?: ThreadInfo;
  events: ActivityEvent[];
  partial: string;
}

const MAX_EVENTS_PER_THREAD = 5000;
const READ_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Codex keeps one JSONL "rollout" per thread under
 * `$CODEX_HOME/sessions/YYYY/MM/DD/`. The first line (`session_meta`)
 * carries the thread id, cwd and `thread_source` ("user" vs subagent such as
 * "guardian_review"); `event_msg/item_completed` lines describe each
 * executed command (with Codex's own read/search/list_files parse), MCP
 * call, file change and context compaction. Files are read incrementally
 * from the last offset, so repeated dashboard refreshes only parse new
 * bytes. Lines that do not match the expected shape are skipped.
 */
export class CodexLocalActivitySource implements AgentActivitySource {
  readonly provider = "codex" as const;
  private readonly files = new Map<string, CodexFileState>();

  constructor(private readonly sessionsDir = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions")) {}

  async collect(root: string, sinceMs: number): Promise<ActivitySnapshot> {
    const candidates = await this.listRollouts(sinceMs);
    if (candidates === undefined) {
      return { provider: "codex", available: false, note: "No Codex local session logs found.", threads: [], events: [] };
    }
    for (const file of candidates) await this.ingest(file, root);
    const threads: ThreadInfo[] = [];
    const events: ActivityEvent[] = [];
    for (const [path, state] of this.files) {
      if (!candidates.includes(path) || !state.matches || !state.thread) continue;
      threads.push(state.thread);
      events.push(...state.events);
    }
    events.sort((a, b) => a.ts.localeCompare(b.ts));
    return { provider: "codex", available: true, threads, events };
  }

  private async listRollouts(sinceMs: number): Promise<string[] | undefined> {
    try {
      await stat(this.sessionsDir);
    } catch {
      return undefined;
    }
    const days: string[] = [];
    for (let time = sinceMs - 86_400_000; time <= Date.now() + 86_400_000; time += 86_400_000) {
      const date = new Date(time);
      days.push(join(this.sessionsDir, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")));
    }
    const files: string[] = [];
    for (const dir of [...new Set(days)]) {
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names) if (name.startsWith("rollout-") && name.endsWith(".jsonl")) files.push(join(dir, name));
    }
    return files;
  }

  private async ingest(file: string, root: string): Promise<void> {
    let info;
    try {
      info = await stat(file);
    } catch {
      return;
    }
    let state = this.files.get(file);
    if (!state || info.size < state.size) {
      state = { size: 0, offset: 0, events: [], partial: "" };
      this.files.set(file, state);
    }
    if (state.matches === false || info.size === state.offset) {
      state.size = info.size;
      return;
    }
    const handle = await open(file, "r");
    try {
      while (state.offset < info.size) {
        const length = Math.min(READ_CHUNK_BYTES, info.size - state.offset);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, state.offset);
        state.offset += length;
        const text = state.partial + buffer.toString("utf8");
        const lines = text.split("\n");
        state.partial = lines.pop() ?? "";
        for (const line of lines) {
          this.ingestLine(line, state, root);
          if ((state.matches as boolean | undefined) === false) {
            state.partial = "";
            state.offset = info.size;
            break;
          }
        }
      }
    } finally {
      await handle.close();
    }
    state.size = info.size;
    if (state.events.length > MAX_EVENTS_PER_THREAD) state.events.splice(0, state.events.length - MAX_EVENTS_PER_THREAD);
  }

  private ingestLine(line: string, state: CodexFileState, root: string): void {
    // Cheap prefilter before JSON.parse: only three line types matter.
    if (state.matches === undefined) {
      if (!line.includes('"session_meta"')) return;
    } else if (!line.includes('"item_completed"')) {
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
      if (state.matches) {
        const id = String(payload.id ?? payload.session_id ?? "");
        state.thread = {
          thread: hashThreadId(id),
          provider: "codex",
          source: payload.thread_source === "user" || !payload.parent_thread_id ? "user" : "subagent",
          startedAt: String(payload.timestamp ?? entry.timestamp ?? "")
        };
      }
      return;
    }
    if (!state.matches || !state.thread || payload.type !== "item_completed") return;
    const item = (payload.item ?? {}) as Record<string, unknown>;
    const event = codexItemToEvent(item, entry.timestamp ?? "", state.thread.thread, root);
    if (event) state.events.push(event);
  }
}

function durationMs(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { secs, nanos } = value as { secs?: number; nanos?: number };
  return typeof secs === "number" ? Math.round(secs * 1000 + (nanos ?? 0) / 1e6) : undefined;
}

function commandCwd(item: Record<string, unknown>, root: string): string {
  const cwd = typeof item.cwd === "string" ? item.cwd : root;
  return cwd.startsWith("file://") ? fileURLToPath(cwd) : cwd;
}

/** Pure mapping of one Codex `item_completed.item` to a metadata-only event. */
export function codexItemToEvent(item: Record<string, unknown>, ts: string, thread: string, root: string): ActivityEvent | undefined {
  const base = { ts, provider: "codex" as const, thread };
  switch (item.type) {
    case "CommandExecution": {
      const argv = Array.isArray(item.command) ? item.command.map(String) : [];
      const command = argv.length >= 3 && /sh$/.test(argv[0]) && argv[1].startsWith("-") ? argv[2] : argv.join(" ");
      const output = String(item.formatted_output ?? item.aggregated_output ?? "");
      const parsed = Array.isArray(item.parsed_cmd) ? (item.parsed_cmd as ParsedCommandPart[]) : [];
      const classified = classifyCommand(command, parsed, commandCwd(item, root), root);
      return {
        ...base,
        kind: "command",
        category: classified.category,
        mode: classified.mode,
        estTokens: estimateTokens(command) + estimateTokens(output),
        ...(classified.paths.length ? { paths: classified.paths.slice(0, 8) } : {}),
        ...(classified.broadSearch ? { broadSearch: true } : {}),
        ...(classified.otherLabel ? { otherLabel: classified.otherLabel } : {}),
        durationMs: durationMs(item.duration)
      };
    }
    case "McpToolCall": {
      const tool = String(item.tool ?? "");
      const resultText = JSON.stringify(item.result ?? "");
      const isDevGuard = String(item.server ?? "") === "dev-guard";
      const providedPaths = isDevGuard && tool === "prepare_task_context" ? extractProvidedPaths(item.result) : undefined;
      return {
        ...base,
        kind: "mcp",
        category: isDevGuard ? "MCP" : "OTHER",
        mode: isDevGuard ? (tool === "prepare_task_context" ? "RESUME_RECOVERY" : tool === "record_validation_result" ? "VALIDATION" : "CONTEXT_ADMIN") : "OTHER",
        estTokens: estimateTokens(JSON.stringify(item.arguments ?? "")) + estimateTokens(resultText),
        ...(providedPaths?.length ? { providedPaths } : {}),
        ...(isDevGuard ? {} : { otherLabel: `MCP ${String(item.server ?? "external")}` }),
        durationMs: durationMs(item.duration)
      };
    }
    case "FileChange": {
      const changes = item.changes && typeof item.changes === "object" ? (item.changes as Record<string, unknown>) : {};
      const paths = Object.keys(changes).map((path) => toRepoRelative(path, root, root)).filter((path): path is string => Boolean(path));
      return { ...base, kind: "file_change", category: "CODE_EDITS", mode: "IMPLEMENTATION", estTokens: estimateTokens(JSON.stringify(changes)), ...(paths.length ? { paths: paths.slice(0, 8) } : {}) };
    }
    case "ContextCompaction":
      return { ...base, kind: "compaction", category: "OTHER", mode: "OTHER", estTokens: 0 };
    case "Extension":
      return { ...base, kind: "web", category: "OTHER", mode: "OTHER", estTokens: estimateTokens(JSON.stringify(item.results ?? "")), otherLabel: "web" };
    case "ImageView":
      return { ...base, kind: "other_tool", category: "OTHER", mode: "OTHER", estTokens: 0, otherLabel: "image view" };
    default:
      return undefined;
  }
}

function extractProvidedPaths(result: unknown): string[] {
  try {
    const content = (result as { content?: Array<{ text?: string }>; structuredContent?: { files?: Array<{ path?: string }> } }) ?? {};
    const files = content.structuredContent?.files ?? (JSON.parse(content.content?.[0]?.text ?? "{}") as { files?: Array<{ path?: string }> }).files ?? [];
    return files.map((file) => String(file.path ?? "")).filter(Boolean).slice(0, 8);
  } catch {
    return [];
  }
}

/** Claude Code adapter foundation: same interface, not yet implemented. */
export class ClaudeLocalActivitySource implements AgentActivitySource {
  readonly provider = "claude" as const;
  async collect(): Promise<ActivitySnapshot> {
    return { provider: "claude", available: false, note: "Claude Code activity adapter is not implemented yet.", threads: [], events: [] };
  }
}
