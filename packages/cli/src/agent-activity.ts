import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
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
  kind: "command" | "mcp" | "file_change" | "compaction" | "web" | "other_tool" | "context_usage";
  category: ContextCostCategory;
  mode: WorkMode;
  /** ESTIMATED context tokens (chars/4 of the text that entered context). Not provider-billed. */
  estTokens: number;
  /** Repo-relative paths read/edited (reads, edits only; never search queries). */
  paths?: string[];
  /** Repository-wide search (repository root scope). */
  broadSearch?: boolean;
  /** Scope of each search in the command; "external" (outside the repo) is not a repository search. */
  searchScopes?: SearchScope[];
  /** Observed provider-reported context usage from the agent's own local log (kind "context_usage" only). */
  inputTokens?: number;
  contextWindow?: number;
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
//
// Evidence hierarchy: (1) structured path fields, (2) the agent's full
// command argv, (3) a conservative shell parser over that full command,
// (4) OTHER. Codex's `parsed_cmd[].cmd` is a TRUNCATED display string (it
// cut path arguments off, which made targeted searches look repository-
// wide), so it is never used to decide scope; only its `path` field is used,
// and only when it is a real relative/absolute path (not a bare basename).

const FALLBACK_DOC_PATTERN = /\.devguard\/(?:reports|context|prompts)\/[\w.-]+|\.devguard\/(?:task|rules|mistakes|project|architecture|decisions|tasks)\.md/;
const VALIDATION_PATTERN = /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+|--filter\s+\S+\s+|-r\s+|-w\s+)*(?:test|lint|typecheck|type-check|build|check|verify)\b|\bnode\s+--test\b|\b(?:tsc|vitest|jest|pytest|eslint|playwright|cargo\s+test|go\s+test)\b|\bcurl\b|\bdev-guard\s+self-check\b/;
const ADMIN_PATTERN = /(?:^|[\s/;&|])dev-guard(?:\s+(?!self-check)|$)|\bnpx\s+(?:--no-install\s+)?dev-guard\b/;
const SEARCH_COMMANDS = new Set(["rg", "grep", "egrep", "fgrep", "find", "fd", "ag", "ack"]);
const READ_COMMANDS = new Set(["cat", "sed", "head", "tail", "nl", "less", "more", "bat", "wc", "jq", "awk"]);
const NOOP_COMMANDS = new Set(["cd", "pwd", "set", "export", "echo", "printf", "true", "ulimit", "clear", "mkdir", "test", "["]);
/** Option flags that consume the following word, per search/read command. */
const OPTIONS_WITH_VALUE: Record<string, Set<string>> = {
  rg: new Set(["-e", "-f", "-g", "--glob", "-t", "--type", "-T", "--type-not", "-A", "-B", "-C", "-m", "--max-count", "--max-depth", "-M", "--max-columns", "-r", "--replace", "--iglob", "-j", "--threads", "--sort", "--sortr"]),
  grep: new Set(["-e", "-f", "-A", "-B", "-C", "-m", "--include", "--exclude", "--exclude-dir"]),
  head: new Set(["-n", "-c"]),
  tail: new Set(["-n", "-c"]),
  sed: new Set(["-e", "-f"]),
  awk: new Set(["-F", "-v", "-f"]),
  jq: new Set(["--arg", "--argjson", "-f"]),
  nl: new Set(["-b", "-s", "-w", "-v", "-i"])
};
const PATH_LITERAL = /['"]((?:\.{1,2}\/|\/)?[A-Za-z0-9_@.()[\]-]+(?:\/[A-Za-z0-9_@.()[\]-]+)*\.[A-Za-z0-9]{1,8})['"]/g;

export type SearchScope = "broad" | "targeted" | "external" | "unknown";

export interface CommandClassification {
  category: ContextCostCategory;
  mode: WorkMode;
  /** Repository files read (repo-relative, de-duplicated). */
  paths: string[];
  broadSearch: boolean;
  /** Scope of each search segment in the command (empty when none). */
  searchScopes: SearchScope[];
  otherLabel?: string;
}

interface ParsedCommandPart {
  type?: string;
  cmd?: string;
  path?: string;
}

/**
 * Classifies one executed shell command from its COMPLETE text. `parsed` is
 * the agent's own structured parse (Codex), used only for real path fields.
 * Paths outside the repository never count as repository reads; searches
 * outside it are "external", never repository searches; an unparseable
 * scope is "unknown", never "broad".
 */
export function classifyCommand(command: string, parsed: ParsedCommandPart[], cwd: string, root: string, fileExists: (absolutePath: string) => boolean = existsSync): CommandClassification {
  const text = command.trim();
  const reads = new Set<string>();
  const fallbackDocs = new Set<string>();
  for (const match of text.matchAll(new RegExp(FALLBACK_DOC_PATTERN.source, "g"))) fallbackDocs.add(match[0]);
  if (fallbackDocs.size > 0) {
    return { category: "FALLBACK_DOCS", mode: "CONTEXT_ADMIN", paths: [...fallbackDocs], broadSearch: false, searchScopes: [] };
  }
  if (ADMIN_PATTERN.test(text)) return { category: "ADMIN", mode: "CONTEXT_ADMIN", paths: [], broadSearch: false, searchScopes: [] };
  if (VALIDATION_PATTERN.test(text)) return { category: "VALIDATION", mode: "VALIDATION", paths: [], broadSearch: false, searchScopes: [] };

  const searchScopes: SearchScope[] = [];
  let workingDir = cwd;
  let writes = false;
  const isScript = /^(?:python3?|node)\b[^\n]*(?:<<|\s-c\s|\s-e\s)/.test(text);
  if (isScript) {
    // Inline script: repository files it names in string literals and that
    // exist on disk. Anything it cannot prove stays unknown (OTHER).
    for (const match of text.matchAll(PATH_LITERAL)) addRead(reads, match[1], workingDir, root, fileExists);
    writes = /open\([^)]*['"][wa]\+?['"]|\.write_text\(|\.write_bytes\(|writeFileSync|\.write\(/.test(text);
  } else {
    for (const statement of splitStatements(text)) {
      const pipeline = splitPipeline(statement);
      for (const [position, segment] of pipeline.entries()) {
        const words = shellWords(segment);
        if (words.length === 0) continue;
        const head = words[0];
        if (head === "cd" && words[1]) {
          workingDir = isAbsolute(words[1]) ? words[1] : join(workingDir, words[1]);
          continue;
        }
        if (NOOP_COMMANDS.has(head)) continue;
        const loop = /^for\s+(\w+)\s+in\s+(.+?)\s*$/.exec(segment);
        if (loop) {
          for (const word of shellWords(loop[2])) addRead(reads, word, workingDir, root, fileExists);
          continue;
        }
        if (head === "git") {
          const sub = words[1];
          if (sub === "grep" || sub === "ls-files") {
            const args = words.slice(2).filter((word) => !word.startsWith("-") && word !== "--");
            searchScopes.push(scopeOf(sub === "grep" ? args.slice(1) : args, workingDir, root));
          } else if (sub === "show") {
            for (const word of words.slice(2)) if (/^[^:-][^:]*:./.test(word)) addRead(reads, word.slice(word.indexOf(":") + 1), root, root, fileExists);
          } else if (sub === "diff" && words.includes("--")) {
            for (const word of words.slice(words.indexOf("--") + 1)) addRead(reads, word, workingDir, root, fileExists);
          }
          // git status/log/blame without paths read no specific file.
          continue;
        }
        if (SEARCH_COMMANDS.has(head) || (head === "ls" && words.some((w) => /^-\w*R/.test(w) || w === "--recursive"))) {
          if (position > 0 && (head === "grep" || head === "rg" || head === "egrep" || head === "fgrep")) continue; // filter in a pipeline
          searchScopes.push(searchScope(head, words, workingDir, root));
          continue;
        }
        if (READ_COMMANDS.has(head)) {
          if (position > 0) continue; // e.g. `... | head -20` reads stdin, not a file
          for (const path of readArguments(head, words)) addRead(reads, path, workingDir, root, fileExists);
          if (head === "sed" && words.includes("-i")) writes = true;
        }
      }
    }
  }
  for (const part of parsed) {
    if (part.type === "read" && part.path && part.path.includes("/")) addRead(reads, part.path, cwd, root, fileExists);
  }
  const repoSearches = searchScopes.filter((scope) => scope !== "external");
  if (repoSearches.length > 0) {
    return { category: "SEARCH", mode: "EXPLORATION", paths: [...reads], broadSearch: repoSearches.includes("broad"), searchScopes };
  }
  if (writes) return { category: "CODE_EDITS", mode: "IMPLEMENTATION", paths: [], broadSearch: false, searchScopes };
  if (reads.size > 0) return { category: "CODE_READS", mode: "EXPLORATION", paths: [...reads], broadSearch: false, searchScopes };
  if (searchScopes.length > 0) return { category: "OTHER", mode: "OTHER", paths: [], broadSearch: false, searchScopes, otherLabel: "external search" };
  if (/^git\b/.test(text)) return { category: "CODE_READS", mode: "EXPLORATION", paths: [], broadSearch: false, searchScopes };
  return { category: "OTHER", mode: "OTHER", paths: [], broadSearch: false, searchScopes, otherLabel: isScript ? "inline script" : "shell" };
}

function addRead(reads: Set<string>, path: string, cwd: string, root: string, fileExists: (absolutePath: string) => boolean): void {
  if (!path || path.startsWith("-") || /[*?$`{}]/.test(path)) return;
  const absolute = isAbsolute(path) ? path : join(cwd, path);
  const relativePath = toRepoRelative(absolute, root, root);
  if (!relativePath || /^(?:\.git|node_modules)\//.test(relativePath)) return;
  if (!fileExists(absolute)) return;
  reads.add(relativePath);
}

function readArguments(head: string, words: string[]): string[] {
  const takesValue = OPTIONS_WITH_VALUE[head] ?? new Set<string>();
  const positionals: string[] = [];
  let scriptConsumed = !(head === "sed" || head === "awk") || words.includes("-e") || words.includes("-f");
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (takesValue.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith("-") && word !== "-") continue;
    if (!scriptConsumed) {
      scriptConsumed = true; // sed/awk program text
      continue;
    }
    if (word === ">" || word === ">>" || word === "<") break;
    positionals.push(word);
  }
  return positionals;
}

function searchScope(head: string, words: string[], cwd: string, root: string): SearchScope {
  const takesValue = OPTIONS_WITH_VALUE[head === "egrep" || head === "fgrep" ? "grep" : head] ?? new Set<string>();
  const positionals: string[] = [];
  let patternGiven = words.includes("-e") || words.includes("-f") || words.includes("--files") || head === "find" || head === "fd" || head === "ls";
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (takesValue.has(word)) {
      index += 1;
      continue;
    }
    if (word === "--") continue;
    if (head === "find" && (word.startsWith("-") || word === "(" || word === "!")) break; // expression starts
    if (word.startsWith("-")) continue;
    if (word === ">" || word === ">>" || word === "2>") break;
    positionals.push(word);
  }
  // rg/grep: first positional is the pattern unless -e/-f/--files supplied it.
  // fd: first positional is the pattern; the rest are paths.
  const paths = head === "fd" ? positionals.slice(1) : patternGiven ? positionals : positionals.slice(1);
  if (!patternGiven && head !== "fd" && positionals.length === 0) return "unknown";
  return scopeOf(paths, cwd, root);
}

function scopeOf(paths: string[], cwd: string, root: string): SearchScope {
  const targets = paths.length > 0 ? paths : ["."];
  let anyInside = false;
  for (const target of targets) {
    if (/[$`]/.test(target)) return "unknown";
    const absolute = normalizeDir(isAbsolute(target) ? target : join(cwd, target));
    const relativePath = relative(root, absolute);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) continue;
    anyInside = true;
    if (relativePath === "" || relativePath === ".") return "broad";
  }
  return anyInside ? "targeted" : "external";
}

function splitStatements(command: string): string[] {
  // Top-level split on && || ; and newlines, ignoring separators inside quotes.
  const statements: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const two = command.slice(index, index + 2);
    if (two === "&&" || two === "||") {
      statements.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (char === ";" || char === "\n") {
      statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  statements.push(current);
  return statements.map((statement) => statement.trim().replace(/^do\s+/, "").replace(/^then\s+/, "")).filter((statement) => statement && statement !== "done" && statement !== "fi");
}

function splitPipeline(statement: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of statement) {
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "|") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

function normalizeDir(path: string): string {
  return path.replace(/\/+$/, "").replace(/\/\.$/, "");
}

function shellWords(cmd: string): string[] {
  const words: string[] = [];
  for (const match of cmd.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g)) words.push(match[1] ?? match[2] ?? match[3]);
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
  lastUsage?: number;
  matches?: boolean;
  thread?: ThreadInfo;
  events: ActivityEvent[];
  partial: string;
}

const MAX_EVENTS_PER_THREAD = 8000;
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
    } else if (!line.includes('"item_completed"') && !line.includes('"token_count"')) {
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
    if (!state.matches || !state.thread) return;
    if (payload.type === "token_count") {
      const usage = codexContextUsage(payload, entry.timestamp ?? "", state.thread.thread);
      const previous = state.lastUsage;
      if (usage && (!previous || Math.abs(usage.inputTokens! - previous) / Math.max(1, previous) >= 0.02)) {
        state.lastUsage = usage.inputTokens;
        state.events.push(usage);
      }
      return;
    }
    if (payload.type !== "item_completed") return;
    const item = (payload.item ?? {}) as Record<string, unknown>;
    const event = codexItemToEvent(item, entry.timestamp ?? "", state.thread.thread, root);
    if (event) state.events.push(event);
  }
}

/**
 * Provider-reported context usage exactly as the agent logged it locally
 * (Codex `token_count`: last turn's input tokens and the model context
 * window). OBSERVED metadata only — never estimated or extrapolated.
 */
export function codexContextUsage(payload: Record<string, unknown>, ts: string, thread: string): ActivityEvent | undefined {
  const info = (payload.info ?? {}) as { last_token_usage?: { input_tokens?: number }; model_context_window?: number };
  const inputTokens = info.last_token_usage?.input_tokens;
  const contextWindow = info.model_context_window;
  if (typeof inputTokens !== "number" || typeof contextWindow !== "number" || contextWindow <= 0) return undefined;
  return { ts, provider: "codex", thread, kind: "context_usage", category: "OTHER", mode: "OTHER", estTokens: 0, inputTokens, contextWindow };
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
        ...(classified.paths.length ? { paths: classified.paths.slice(0, 16) } : {}),
        ...(classified.broadSearch ? { broadSearch: true } : {}),
        ...(classified.searchScopes.length ? { searchScopes: classified.searchScopes } : {}),
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
