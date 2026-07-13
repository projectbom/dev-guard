import { access, realpath } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fromRoot } from "./fs.js";
import { devguardPaths } from "./paths.js";
import { prepareTaskContext } from "./runtime-state.js";

const toolInputSchema = {
  task: z.string().min(1).describe("Current coding task. Call before searching or reading project source files."),
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
