import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Provider thread identity — "which agent thread started this DevGuard
 * task". DevGuard's own task/session lineage (RuntimeState.sessionId) says
 * nothing about which provider thread owns it, and a fresh-thread rollover
 * makes two threads alive in the same project at once: the old thread's
 * late Stop hook used to finalize the task the new thread had just
 * prepared. Only a hash of the provider's thread id is ever stored.
 *
 * Every identity here is OBSERVED, never synthesized:
 * - Claude Code: the MCP server process inherits CLAUDE_CODE_SESSION_ID; the
 *   Stop hook's stdin carries the same session_id.
 * - Codex: the MCP server gets no thread id (its environment is sanitized),
 *   but Codex records every tool call in its per-thread rollout file
 *   (~/.codex/sessions/.../rollout-<ts>-<threadId>.jsonl), and the Stop /
 *   notify hook payloads carry the thread id. The owner is the thread whose
 *   rollout holds the prepare_task_context call that created the task.
 * When none of that is observable the identity is simply unknown.
 */
export type ProviderName = "codex" | "claude";

export interface ProviderThreadOwner {
  provider: ProviderName;
  threadIdHash: string;
  source: "mcp-env" | "mcp-meta" | "codex-rollout";
}

export interface ObservedThreadIdentity {
  provider: ProviderName;
  /** Raw provider id — kept in memory only, never persisted. */
  threadId: string;
  source: ProviderThreadOwner["source"];
}

export function hashThreadId(provider: ProviderName, threadId: string): string {
  return createHash("sha256").update(`${provider}:${threadId}`).digest("hex").slice(0, 16);
}

export function toOwner(identity: ObservedThreadIdentity): ProviderThreadOwner {
  return { provider: identity.provider, threadIdHash: hashThreadId(identity.provider, identity.threadId), source: identity.source };
}

const THREAD_KEY = /^(?:thread[_-]?id|threadId|conversation[_-]?id)$/i;

/**
 * Identity of the agent thread calling the MCP server, from what the
 * server can actually observe: Claude Code's inherited session env, or a
 * thread id a client chose to put in the request `_meta`.
 */
export function identityFromMcpContext(env: NodeJS.ProcessEnv, meta: unknown): ObservedThreadIdentity | undefined {
  const claudeSession = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (claudeSession) return { provider: "claude", threadId: claudeSession, source: "mcp-env" };
  const fromMeta = findThreadIdInMeta(meta, 0);
  return fromMeta ? { provider: "codex", threadId: fromMeta, source: "mcp-meta" } : undefined;
}

function findThreadIdInMeta(value: unknown, depth: number): string | undefined {
  if (depth > 3 || !value || typeof value !== "object") {
    if (typeof value === "string" && depth > 0 && value.trim().startsWith("{")) {
      try {
        return findThreadIdInMeta(JSON.parse(value), depth);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (THREAD_KEY.test(key) && typeof entry === "string" && entry.trim()) return entry.trim();
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const nested = findThreadIdInMeta(entry, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

// --- Codex rollout observation -------------------------------------------

const ROLLOUT_NAME = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** prepare_task_context calls this long before the task's createdAt still count as its creator. */
const OWNER_CALL_LOOKBACK_MS = 120_000;
/** Clock/flush slack after createdAt. */
const OWNER_CALL_SLACK_MS = 5_000;
/** Two threads whose latest prepare calls are closer than this cannot be told apart. */
const OWNER_AMBIGUITY_MS = 2_000;

export function codexSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "sessions");
}

interface RolloutFile {
  path: string;
  threadId: string;
  mtimeMs: number;
}

function localDayDir(base: string, date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return join(base, String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()));
}

/** Rollout files modified at or after `sinceMs`, from the local-date day folders Codex writes into. */
async function recentRolloutFiles(sessionsDir: string, sinceMs: number, nowMs = Date.now()): Promise<RolloutFile[]> {
  const days = new Set<string>();
  for (let t = sinceMs - 86_400_000; t <= nowMs + 86_400_000; t += 86_400_000) days.add(localDayDir(sessionsDir, new Date(t)));
  const files: RolloutFile[] = [];
  for (const dir of days) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const match = ROLLOUT_NAME.exec(name);
      if (!match) continue;
      const path = join(dir, name);
      const info = await stat(path).catch(() => undefined);
      if (info && info.mtimeMs >= sinceMs) files.push({ path, threadId: match[1].toLowerCase(), mtimeMs: info.mtimeMs });
    }
  }
  return files;
}

async function sameDirectory(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([realpath(a).catch(() => a), realpath(b).catch(() => b)]);
  return left === right;
}

/** The working directory Codex recorded for this thread (first line, session_meta). */
async function rolloutCwd(text: string): Promise<string | undefined> {
  const firstLine = text.slice(0, text.indexOf("\n") >= 0 ? text.indexOf("\n") : text.length);
  try {
    const parsed = JSON.parse(firstLine) as { payload?: { cwd?: unknown } };
    return typeof parsed.payload?.cwd === "string" ? parsed.payload.cwd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Timestamps of actual prepare_task_context invocations in one rollout.
 * Only tool-CALL items count (a function/custom/MCP call whose name is the
 * tool, or code-mode source that calls it) — instructions or delegation
 * text merely mentioning the tool name do not.
 */
function prepareCallTimes(text: string): number[] {
  const times: number[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("prepare_task_context")) continue;
    let parsed: { timestamp?: string; payload?: Record<string, unknown> };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = parsed.payload ?? {};
    const type = String(payload.type ?? "");
    if (!/call/.test(type) || /output|result|end/.test(type)) continue;
    const name = String(payload.name ?? payload.tool ?? "");
    const body = String(payload.input ?? payload.arguments ?? "");
    if (!/prepare_task_context$/.test(name) && !/prepare_task_context\s*\(/.test(body)) continue;
    const ts = Date.parse(parsed.timestamp ?? "");
    if (Number.isFinite(ts)) times.push(ts);
  }
  return times;
}

export type CodexOwnerResolution =
  | { status: "found"; threadId: string }
  | { status: "ambiguous" | "none" };

/**
 * Which Codex thread created the task prepared at `taskCreatedAt` in
 * `root`: the thread (with the same working directory) whose latest
 * prepare_task_context call precedes the creation most closely. "none" when
 * no rollout shows such a call (e.g. the task came from the CLI or another
 * provider); "ambiguous" when two threads called it within the same couple
 * of seconds.
 */
export async function resolveCodexTaskOwner(root: string, taskCreatedAt: string, options: { sessionsDir?: string; nowMs?: number } = {}): Promise<CodexOwnerResolution> {
  const createdMs = Date.parse(taskCreatedAt);
  if (!Number.isFinite(createdMs)) return { status: "none" };
  const from = createdMs - OWNER_CALL_LOOKBACK_MS;
  const to = createdMs + OWNER_CALL_SLACK_MS;
  const files = await recentRolloutFiles(options.sessionsDir ?? codexSessionsDir(), from, options.nowMs);
  const latestByThread: Array<{ threadId: string; at: number }> = [];
  for (const file of files) {
    const text = await readFile(file.path, "utf8").catch(() => "");
    if (!text.includes("prepare_task_context")) continue;
    const cwd = await rolloutCwd(text);
    if (!cwd || !(await sameDirectory(cwd, root))) continue;
    const inWindow = prepareCallTimes(text).filter((ts) => ts >= from && ts <= to);
    if (inWindow.length > 0) latestByThread.push({ threadId: file.threadId, at: Math.max(...inWindow) });
  }
  if (latestByThread.length === 0) return { status: "none" };
  latestByThread.sort((a, b) => b.at - a.at);
  const [first, second] = latestByThread;
  if (second && first.at - second.at < OWNER_AMBIGUITY_MS) return { status: "ambiguous" };
  return { status: "found", threadId: first.threadId };
}

// --- Thread pressure ------------------------------------------------------

/**
 * How heavy the provider thread itself is — strictly from what the provider
 * recorded (input tokens of the latest request, its context window size,
 * compaction events). Distinct from DevGuard's resume cost, which measures
 * DevGuard's own artifacts and says nothing about the thread.
 */
export type ThreadPressureStatus = "LOW" | "SOON" | "NEW_THREAD" | "UNKNOWN";

export interface ThreadPressure {
  status: ThreadPressureStatus;
  reason: string;
  observedInputTokens?: number;
  contextWindow?: number;
  compactions?: number;
}

const PRESSURE_SOON_RATIO = 0.5;
const PRESSURE_NEW_THREAD_RATIO = 0.75;

export function unknownThreadPressure(reason = "Provider thread usage is not observable here."): ThreadPressure {
  return { status: "UNKNOWN", reason };
}

export function classifyThreadPressure(observed: { inputTokens?: number; contextWindow?: number; compactions: number }): ThreadPressure {
  const { inputTokens, contextWindow, compactions } = observed;
  if (compactions > 0) {
    return { status: "NEW_THREAD", reason: `Thread was already compacted ${compactions} time(s).`, observedInputTokens: inputTokens, contextWindow, compactions };
  }
  if (!inputTokens || !contextWindow) return { ...unknownThreadPressure("No provider-recorded context window for this thread."), observedInputTokens: inputTokens, compactions };
  const ratio = inputTokens / contextWindow;
  const pct = Math.round(ratio * 100);
  const reason = `Observed input reached ${pct}% of the provider window (${inputTokens}/${contextWindow}).`;
  const status: ThreadPressureStatus = ratio >= PRESSURE_NEW_THREAD_RATIO ? "NEW_THREAD" : ratio >= PRESSURE_SOON_RATIO ? "SOON" : "LOW";
  return { status, reason, observedInputTokens: inputTokens, contextWindow, compactions };
}

/** Pressure from one Codex rollout: last token_count event + compaction count. */
export function codexRolloutPressure(text: string): ThreadPressure {
  let inputTokens: number | undefined;
  let contextWindow: number | undefined;
  let compactions = 0;
  for (const line of text.split("\n")) {
    if (line.includes('"type":"compacted"')) {
      compactions += 1;
      continue;
    }
    if (!line.includes('"token_count"')) continue;
    try {
      const info = (JSON.parse(line) as { payload?: { info?: { last_token_usage?: { input_tokens?: number }; model_context_window?: number } } }).payload?.info;
      if (info?.last_token_usage?.input_tokens) inputTokens = info.last_token_usage.input_tokens;
      if (info?.model_context_window) contextWindow = info.model_context_window;
    } catch {
      // A partially flushed trailing line is expected; skip it.
    }
  }
  return classifyThreadPressure({ inputTokens, contextWindow, compactions });
}

/** Pressure of the Codex thread whose id hashes to `threadIdHash` (searched among rollouts touched in the last day). */
export async function codexThreadPressureByHash(threadIdHash: string, options: { sessionsDir?: string; nowMs?: number } = {}): Promise<ThreadPressure> {
  const nowMs = options.nowMs ?? Date.now();
  const files = await recentRolloutFiles(options.sessionsDir ?? codexSessionsDir(), nowMs - 86_400_000, nowMs);
  const file = files.find((candidate) => hashThreadId("codex", candidate.threadId) === threadIdHash);
  if (!file) return unknownThreadPressure("The owning Codex thread's rollout was not found.");
  return codexRolloutPressure(await readFile(file.path, "utf8").catch(() => ""));
}

/**
 * Claude Code transcripts record per-request usage and compaction
 * boundaries but not the model's window size, so only compaction can be
 * judged; otherwise the status stays UNKNOWN (never an estimated %).
 */
export async function claudeThreadPressure(sessionId: string, options: { projectsDir?: string } = {}): Promise<ThreadPressure> {
  const projectsDir = options.projectsDir ?? join(homedir(), ".claude", "projects");
  const dirs = await readdir(projectsDir).catch(() => [] as string[]);
  for (const dir of dirs) {
    const text = await readFile(join(projectsDir, dir, `${sessionId}.jsonl`), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const compactions = (text.match(/"subtype":"compact_boundary"/g) ?? []).length;
    if (compactions > 0) return classifyThreadPressure({ compactions });
    return unknownThreadPressure("Claude Code does not record the context window size; only compaction is observable.");
  }
  return unknownThreadPressure("The Claude Code transcript for this session was not found.");
}

/**
 * The one-line, user-facing recommendation an agent appends to its FINAL
 * reply of a task when its own thread is getting heavy. Undefined for
 * LOW / UNKNOWN: no thread talk then.
 */
export function threadUserNotice(status: ThreadPressureStatus, locale: string): string | undefined {
  const ko = locale === "ko-KR";
  if (status === "NEW_THREAD") {
    return ko
      ? "현재 스레드는 컨텍스트 사용량이 높습니다. 다음 작업을 계속하기 전에 새 스레드로 전환하는 것을 권장합니다."
      : "This thread's context usage is high. Switch to a fresh thread before continuing with the next task.";
  }
  if (status === "SOON") {
    return ko
      ? "현재 스레드의 컨텍스트 사용량이 높아지고 있습니다. 다음 큰 작업이나 별도 단계는 새 스레드에서 시작하는 것을 권장합니다."
      : "This thread's context usage is rising. Start the next large task or separate step in a fresh thread.";
  }
  return undefined;
}

/** Identity of the agent thread a CLI process runs inside (an agent's shell tool), when the provider exposes it. */
export function identityFromShellEnv(env: NodeJS.ProcessEnv): ObservedThreadIdentity | undefined {
  const codex = env.CODEX_THREAD_ID?.trim();
  if (codex) return { provider: "codex", threadId: codex, source: "mcp-env" };
  const claude = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (claude) return { provider: "claude", threadId: claude, source: "mcp-env" };
  return undefined;
}

/** Thread pressure for whichever thread identity is observable in this process. */
export async function observeThreadPressure(input: { identity?: ObservedThreadIdentity; owner?: ProviderThreadOwner }): Promise<ThreadPressure> {
  try {
    if (input.identity?.provider === "claude") return await claudeThreadPressure(input.identity.threadId);
    if (input.identity?.provider === "codex") return await codexThreadPressureByHash(hashThreadId("codex", input.identity.threadId));
    if (input.owner?.provider === "codex") return await codexThreadPressureByHash(input.owner.threadIdHash);
  } catch {
    // Observation is best-effort; never fail the caller over it.
  }
  return unknownThreadPressure();
}

/**
 * Task-boundary headroom: whether the NEXT separate task fits in this
 * thread, from its current usage plus the growth DevGuard actually observed
 * for recent tasks (provider-reported input at prepare vs at done). Not a
 * prediction of the provider's future usage — a headroom risk. Separate from
 * the in-task 50/75 thresholds, which stay as they are: in real use tasks
 * ended at 42–49% (LOW, no notice), the next task started in the same
 * thread and ended at 67–88%.
 */
export type BoundaryStatus = "CONTINUE" | "SOON" | "NEW_THREAD" | "UNKNOWN";

export interface BoundaryHeadroom {
  status: BoundaryStatus;
  /** Current usage + typical (hint-scaled) growth, as a share of the window. */
  projected?: number;
  /** Median observed per-task growth (share of the window), when known. */
  typicalGrowth?: number;
  samples: number;
  reason: string;
}

const BOUNDARY_SOON_PROJECTED = 0.75;
const BOUNDARY_NEW_THREAD_PROJECTED = 0.9;
const BOUNDARY_MIN_SAMPLES = 2;
/** With no growth history, a thread this full is already a risk for a medium task. */
const BOUNDARY_CONSERVATIVE_RATIO = 0.4;
const HEAVY_TASK_HINT = /\b(?:execute|execution|preflight|production|full audit|audit|migration|re-?run|rollout|deploy|forensics)\b|실행|프로덕션|감사|마이그레이션|배포|재실행/i;
const LIGHT_TASK_HINT = /\b(?:small|tiny|typo|rename|single file|one-line|wording|follow-?up fix|minor)\b|오타|문구|작은|한 줄|간단/i;

export function taskBoundaryHeadroom(input: { ratio?: number; recentGrowth: number[]; nextTaskText?: string }): BoundaryHeadroom {
  const { ratio, recentGrowth } = input;
  if (ratio === undefined) return { status: "UNKNOWN", samples: recentGrowth.length, reason: "Thread usage is not observable." };
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  if (ratio >= PRESSURE_NEW_THREAD_RATIO) return { status: "NEW_THREAD", samples: recentGrowth.length, reason: `Thread is already at ${pct(ratio)}.` };
  const growth = [...recentGrowth].filter((value) => value > 0).sort((a, b) => a - b);
  if (growth.length < BOUNDARY_MIN_SAMPLES) {
    return ratio >= BOUNDARY_CONSERVATIVE_RATIO
      ? { status: "SOON", samples: growth.length, reason: `Thread is at ${pct(ratio)} and DevGuard has too little task-growth history to show a typical next task fits; start a separate task in a fresh thread.` }
      : { status: "UNKNOWN", samples: growth.length, reason: `Thread is at ${pct(ratio)}; not enough task-growth history yet.` };
  }
  const typical = growth[Math.floor((growth.length - 1) / 2)];
  const scale = input.nextTaskText ? (HEAVY_TASK_HINT.test(input.nextTaskText) ? 1.25 : LIGHT_TASK_HINT.test(input.nextTaskText) ? 0.4 : 1) : 1;
  const projected = ratio + typical * scale;
  const basis = `${pct(ratio)} now + typical task growth ${pct(typical)}${scale !== 1 ? ` ×${scale} (${scale > 1 ? "heavy" : "light"} task)` : ""} ≈ ${pct(projected)}`;
  const status: BoundaryStatus = projected >= BOUNDARY_NEW_THREAD_PROJECTED ? "NEW_THREAD" : projected >= BOUNDARY_SOON_PROJECTED ? "SOON" : "CONTINUE";
  return { status, projected, typicalGrowth: typical, samples: growth.length, reason: `${basis} of the window.` };
}
