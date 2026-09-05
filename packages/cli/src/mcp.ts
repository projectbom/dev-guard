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
        "Call this before searching or reading project source files for a new coding task. It uses the local DevGuard Code Index to return relevant files, line ranges, constraints, freshness, coverage, and generated context artifact paths.",
      inputSchema: toolInputSchema
    },
    async ({ task, projectRoot }) => {
      try {
        const project = await resolveMcpProjectRoot(root, projectRoot);
        const result = await prepareTaskContext({
          root: project,
          task,
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
    async ({ kind, status, name, command, summary, reason, projectRoot }) => {
      try {
        const project = await resolveMcpProjectRoot(root, projectRoot);
        const result = await recordValidationEvidence({
          root: project,
          kind,
          status,
          name,
          command,
          summary,
          reason
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
