import { execFile } from "node:child_process";
import { access, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fromRoot } from "./fs.js";
import { devguardPaths } from "./paths.js";
import { prepareTaskContext, recordValidationEvidence, threadStateForAgent, toAgentContextPayload } from "./runtime-state.js";
import { identityFromMcpContext } from "./thread-ownership.js";

/**
 * DevGuard's own installed version — read from the CLI package's own
 * package.json (next to dist/, resolved from this module's own location,
 * not the consumer project root `fromRoot` uses) so the MCP server never
 * reports a version string that drifts from the actual published package.
 * Falls back to "unknown" rather than crashing the MCP server if this
 * (non-critical, informational) read ever fails.
 */
async function readOwnPackageVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(here, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const execFileAsync = promisify(execFile);

const toolInputSchema = {
  task: z.string().min(1).describe("Current coding task. Call before searching or reading project source files. Keep any file paths the user named."),
  explicitInputs: z
    .array(z.string().min(1))
    .max(60)
    .optional()
    .describe(
      "Repository-relative files the user explicitly told you to read or use for this task (e.g. a \"read first\" / \"반드시 먼저 읽기\" list), copied verbatim — one path per entry, combining a listed directory with each file listed under it. DevGuard returns them as TARGETs with fitting ranges and folds its own suggestions around them into one read plan. Paths only, never the prompt text."
    ),
  continueCurrentTask: z
    .boolean()
    .optional()
    .describe(
      "Set true ONLY to re-fetch context for the SAME task you already called this tool for in this conversation (e.g. resuming after an interruption) — this keeps validation evidence and the task goal tied to that same task. Omit or set false (the default) every time you are starting a genuinely new task, even if its wording happens to repeat an earlier one: each new task gets its own clean lineage, so evidence/goals from a previous task never leak into it."
    ),
  projectRoot: z.string().optional().describe("Optional project root. Defaults to the MCP server working directory.")
};

const validationKindEnum = z.enum(["BUILD", "TYPECHECK", "TEST", "LINT", "MANUAL_QA", "RUNTIME_SMOKE", "CUSTOM"]);
const validationStatusEnum = z.enum(["PASS", "FAIL", "UNKNOWN"]);

const recordValidationInputSchema = {
  kind: validationKindEnum.describe("Category of validation evidence being recorded."),
  status: validationStatusEnum.describe(
    "PASS if you observed the check succeed, FAIL if you observed it fail, UNKNOWN only if you attempted it but could not determine the outcome. Do not call this tool at all if the check was not attempted."
  ),
  name: z.string().optional().describe("Short identifier for this evidence, e.g. 'product-api' or 'attribution'. Defaults to the kind name. Use distinct names to record multiple RUNTIME_SMOKE checks in one session."),
  command: z.string().optional().describe("The command or action actually executed, e.g. 'pnpm build' or 'curl /unit/render'."),
  exitCode: z.number().int().optional().describe("The process exit code you actually observed, if any. Do not guess or infer one — omit it if you didn't see it."),
  summary: z.string().optional().describe("One-line factual result, e.g. 'clicks 404 rows, ads/impression-click 145 rows'. No secrets or raw credentials/URLs."),
  reason: z.string().optional().describe("Root cause for FAIL/UNKNOWN, only if actually known/observed — do not guess."),
  projectRoot: z.string().optional().describe("Optional project root. Defaults to the MCP server working directory.")
};

export async function runMcpServer(root: string): Promise<void> {
  const server = new McpServer({
    name: "dev-guard",
    version: await readOwnPackageVersion()
  });

  server.registerTool(
    "prepare_task_context",
    {
      title: "Prepare DevGuard task context",
      description:
        "Call this once at the start of every new coding task, before searching or reading project source files — this is DevGuard's only signal that a new task has begun, so a bare call always starts a clean task lineage (see continueCurrentTask for the one exception). Pass any files the user named in `explicitInputs`. It uses the local DevGuard Code Index to return TARGET files to read first (CANDIDATE files only if the targets are not enough — never batch-read them all), source-tagged constraints, a next action, unresolved validation from the previous task, and rollover advice. Read the returned ranges before any repository-wide search, and do not also read DevGuard's markdown reports when this result is sufficient. Follow the returned rollover advice: a small related follow-up may continue in this thread while thread pressure is low; start a separate or large task in a fresh agent thread. After you run a build/test/manual check for this task, report it with record_validation_result so Quality Report/Handoff reflect real evidence.",
      inputSchema: toolInputSchema
    },
    async ({ task, explicitInputs, continueCurrentTask, projectRoot }, extra) => {
      try {
        const project = await resolveMcpProjectRoot(root, projectRoot);
        const result = await prepareTaskContext({
          root: project,
          task,
          explicitInputs,
          continueCurrentTask,
          persistTask: true,
          caller: identityFromMcpContext(process.env, extra?._meta),
          observeCodexOwner: true
        });
        // Compact, de-duplicated agent payload (see toAgentContextPayload):
        // this text is what lands in the agent's context on every task start.
        // Delivered ONCE, as text. No outputSchema is declared, so MCP does
        // not require structuredContent, and every client (Claude Code,
        // Codex) reads `content`; sending both made clients that surface
        // the whole result (Codex) receive the payload twice.
        const payload = toAgentContextPayload(result);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(mcpErrorPayload(error), null, 2) }]
        };
      }
    }
  );

  server.registerTool(
    "record_validation_result",
    {
      title: "Record DevGuard validation evidence",
      description:
        "Call this after you actually run a build, typecheck, test, lint, manual QA step, or runtime smoke check (e.g. a real API call, DB check, or browser check) outside of DevGuard. It records the real PASS/FAIL/UNKNOWN result so the next Quality Report and Handoff reflect actual evidence instead of showing 'not recorded'. Only call this for checks you actually ran — never to report work you did not verify. Call prepare_task_context before recording validation for a new task: results are bound to the currently active DevGuard task (see the returned `taskBinding` field). A check run right after `dev-guard done` in the same thread binds to the task just closed — no need to call prepare_task_context again for it. Otherwise, if there is no active task, the evidence is recorded as UNBOUND and will not be used as current-task PASS/FAIL verification, even once a task is later declared — call prepare_task_context first, then record again.",
      inputSchema: recordValidationInputSchema
    },
    async ({ kind, status, name, command, exitCode, summary, reason, projectRoot }, extra) => {
      try {
        const project = await resolveMcpProjectRoot(root, projectRoot);
        const caller = identityFromMcpContext(process.env, extra?._meta);
        const result = await recordValidationEvidence({
          root: project,
          kind,
          status,
          name,
          command,
          exitCode,
          summary,
          reason,
          source: "mcp-agent",
          caller
        });
        // During-task rollover: the thread's observed pressure rides along
        // with every validation, so the agent learns it is getting heavy
        // without any extra call. UNKNOWN when not observable.
        const thread = await threadStateForAgent(project, caller).catch(() => undefined);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                recorded: result,
                ...(thread ? { thread } : {})
              }, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(mcpErrorPayload(error), null, 2) }]
        };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export interface McpRootDiagnostics {
  requestedRoot: string;
  mcpRoot: string;
  mcpRootGitToplevel?: string;
  requestedGitToplevel?: string;
  /** Short machine-readable findings, e.g. "mcp-root-not-git", "mcp-root-empty". */
  findings: string[];
}

/**
 * Wrong-root rejection with enough identity to self-diagnose (Codex opening
 * an empty sibling checkout once cost a full manual handoff). Still
 * fail-closed: DevGuard never switches to the requested root on its own.
 */
/** Root errors carry their own identity diagnostics and fix; never environment variables. */
export function mcpErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof McpRootError) return { error: error.message, diagnostics: error.diagnostics, next: error.fix };
  return {
    error: error instanceof Error ? error.message : String(error),
    next: "Run the MCP server from the project root or pass a projectRoot inside the configured working directory. Ensure .devguard exists and dev-guard done has generated a Code Index before relying on routed context."
  };
}

export class McpRootError extends Error {
  constructor(message: string, readonly diagnostics: McpRootDiagnostics, readonly fix: string) {
    super(message);
    this.name = "McpRootError";
  }
}

export async function resolveMcpProjectRoot(serverRoot: string, requestedRoot?: string): Promise<string> {
  const configuredRoot = resolve(serverRoot);
  const candidate = resolve(configuredRoot, requestedRoot?.trim() || ".");
  const [configuredRealRoot, candidateRealRoot] = await Promise.all([
    realpath(configuredRoot).catch(() => undefined),
    realpath(candidate).catch(() => undefined)
  ]);
  if (!configuredRealRoot || !candidateRealRoot) {
    const missing = !configuredRealRoot ? configuredRoot : candidate;
    throw await rootError(
      `${!configuredRealRoot ? "The DevGuard MCP working directory" : "The requested project"} does not exist: ${missing}`,
      configuredRealRoot ?? configuredRoot,
      candidateRealRoot ?? candidate,
      "Reopen the intended project workspace, or re-register the DevGuard MCP server from that project root."
    );
  }
  const relativePath = relative(configuredRealRoot, candidateRealRoot);
  if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\") || isAbsolute(relativePath)) {
    throw await rootError(
      "The requested project is outside this MCP root.",
      configuredRealRoot,
      candidateRealRoot,
      "Start or re-register DevGuard MCP from the intended project root, or reopen the correct workspace. DevGuard does not switch roots automatically."
    );
  }
  if (!(await access(fromRoot(candidateRealRoot, devguardPaths.runtime)).then(() => true, () => false))) {
    throw await rootError(
      `DevGuard is not set up in ${candidateRealRoot} (no ${devguardPaths.runtime}).`,
      configuredRealRoot,
      candidateRealRoot,
      "Run `dev-guard watch` (or `dev-guard setup`) in the intended project root, or reopen the correct workspace."
    );
  }
  await access(fromRoot(candidateRealRoot, devguardPaths.codeIndex)).catch(() => undefined);
  return candidateRealRoot;
}

async function rootError(reason: string, mcpRoot: string, requestedRoot: string, fix: string): Promise<McpRootError> {
  const [mcpRootGitToplevel, requestedGitToplevel, mcpRootEntries] = await Promise.all([
    gitToplevel(mcpRoot),
    gitToplevel(requestedRoot),
    readdir(mcpRoot).catch(() => undefined)
  ]);
  const findings: string[] = [];
  if (!mcpRootGitToplevel) findings.push("mcp-root-not-git");
  if (mcpRootEntries && mcpRootEntries.filter((entry) => entry !== ".DS_Store").length === 0) findings.push("mcp-root-empty");
  else if (mcpRootEntries && !mcpRootEntries.includes(".devguard")) findings.push("mcp-root-has-no-devguard");
  if (mcpRootGitToplevel && requestedGitToplevel && mcpRootGitToplevel !== requestedGitToplevel) findings.push("different-git-repositories");
  if (mcpRoot !== requestedRoot && basename(mcpRoot) === basename(requestedRoot)) findings.push("same-name-sibling-checkout");
  const diagnostics: McpRootDiagnostics = {
    requestedRoot,
    mcpRoot,
    ...(mcpRootGitToplevel ? { mcpRootGitToplevel } : {}),
    ...(requestedGitToplevel ? { requestedGitToplevel } : {}),
    findings
  };
  const lines = [
    reason,
    `DevGuard MCP is bound to: ${mcpRoot}${mcpRootGitToplevel ? ` (git toplevel ${mcpRootGitToplevel})` : " (not a git repository)"}`,
    `Requested project: ${requestedRoot}${requestedGitToplevel ? ` (git toplevel ${requestedGitToplevel})` : ""}`
  ];
  if (findings.includes("mcp-root-empty")) lines.push("The MCP root directory is empty — likely a wrong or empty checkout opened as the workspace.");
  else if (findings.includes("same-name-sibling-checkout")) lines.push("The MCP root and the requested project share a name — likely a sibling checkout opened as the workspace.");
  lines.push(`Fix: ${fix}`);
  return new McpRootError(lines.join("\n"), diagnostics, fix);
}

/** Read-only `git rev-parse --show-toplevel`; undefined when not a repo or git is unavailable. */
async function gitToplevel(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeout: 3000 });
    const top = stdout.trim();
    return top ? await realpath(top).catch(() => top) : undefined;
  } catch {
    return undefined;
  }
}
