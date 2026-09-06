import { access, realpath } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fromRoot } from "./fs.js";
import { devguardPaths } from "./paths.js";
import { prepareTaskContext, recordValidationEvidence } from "./runtime-state.js";

const toolInputSchema = {
  task: z.string().min(1).describe("Current coding task. Call before searching or reading project source files."),
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
    version: "0.7.0"
  });

  server.registerTool(
    "prepare_task_context",
    {
      title: "Prepare DevGuard task context",
      description:
        "Call this once at the start of every new coding task, before searching or reading project source files — this is DevGuard's only signal that a new task has begun, so a bare call always starts a clean task lineage (see continueCurrentTask for the one exception). It uses the local DevGuard Code Index to return relevant files, line ranges, constraints, freshness, coverage, and generated context artifact paths. After you run a build/test/manual check for this task, report it with record_validation_result so Quality Report/Handoff reflect real evidence.",
      inputSchema: toolInputSchema
    },
    async ({ task, continueCurrentTask, projectRoot }) => {
      try {
        const project = await resolveMcpProjectRoot(root, projectRoot);
        const result = await prepareTaskContext({
          root: project,
          task,
          continueCurrentTask,
          persistTask: true
        });
        return {
          structuredContent: result as unknown as Record<string, unknown>,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: message,
                next: "Run the MCP server from the project root or pass a projectRoot inside the configured working directory. Ensure .devguard exists and dev-guard done has generated a Code Index before relying on routed context."
              }, null, 2)
            }
          ]
        };
      }
    }
  );

  server.registerTool(
    "record_validation_result",
    {
      title: "Record DevGuard validation evidence",
      description:
        "Call this after you actually run a build, typecheck, test, lint, manual QA step, or runtime smoke check (e.g. a real API call, DB check, or browser check) outside of DevGuard. It records the real PASS/FAIL/UNKNOWN result so the next Quality Report and Handoff reflect actual evidence instead of showing 'not recorded'. Only call this for checks you actually ran — never to report work you did not verify.",
      inputSchema: recordValidationInputSchema
    },
    async ({ kind, status, name, command, exitCode, summary, reason, projectRoot }) => {
      try {
        const project = await resolveMcpProjectRoot(root, projectRoot);
        const result = await recordValidationEvidence({
          root: project,
          kind,
          status,
          name,
          command,
          exitCode,
          summary,
          reason,
          source: "mcp-agent"
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ recorded: result }, null, 2)
            }
          ]
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }]
        };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function resolveMcpProjectRoot(serverRoot: string, requestedRoot?: string): Promise<string> {
  const configuredRoot = resolve(serverRoot);
  const candidate = resolve(configuredRoot, requestedRoot?.trim() || ".");
  const [configuredRealRoot, candidateRealRoot] = await Promise.all([
    realpath(configuredRoot),
    realpath(candidate)
  ]);
  const relativePath = relative(configuredRealRoot, candidateRealRoot);
  if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\")) {
    throw new Error("projectRoot must stay inside the MCP server working directory.");
  }
  await access(fromRoot(candidateRealRoot, devguardPaths.runtime));
  await access(fromRoot(candidateRealRoot, devguardPaths.codeIndex)).catch(() => undefined);
  return candidateRealRoot;
}
