import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readJsonFile } from "./fs.js";

const SERVER_NAME = "dev-guard";
const MCP_COMMAND = "npx";
const MCP_ARGS = ["--no-install", "dev-guard", "mcp"];

interface ClaudeMcpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpSetupResult {
  claude: "created" | "updated" | "already_configured" | "warning";
  codex: "created" | "updated" | "already_configured" | "warning";
  verification: "pass" | "warning" | "skipped";
  warnings: string[];
}

export async function ensureMcpSetup(root: string): Promise<McpSetupResult> {
  const warnings: string[] = [];
  const [claude, codex] = await Promise.all([
    ensureClaudeMcp(root).catch((error) => {
      warnings.push(`Claude MCP warning: ${errorMessage(error)}`);
      return "warning" as const;
    }),
    ensureCodexMcp(root).catch((error) => {
      warnings.push(`Codex MCP warning: ${errorMessage(error)}`);
      return "warning" as const;
    })
  ]);
  const verification = await verifyMcpServer(root).catch((error) => {
    warnings.push(`MCP verification warning: ${errorMessage(error)}`);
    return "warning" as const;
  });
  return { claude, codex, verification, warnings };
}

async function ensureClaudeMcp(root: string): Promise<McpSetupResult["claude"]> {
  const path = join(root, ".mcp.json");
  const exists = await fileExists(path);
  const config = await readJsonFile<ClaudeMcpConfig>(path, {});
  const servers = isPlainObject(config.mcpServers) ? { ...config.mcpServers } : {};
  const entry = {
    command: MCP_COMMAND,
    args: MCP_ARGS
  };
  if (JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(entry)) {
    return "already_configured";
  }
  servers[SERVER_NAME] = entry;
  await writeJson(path, { ...config, mcpServers: servers });
  return exists ? "updated" : "created";
}

async function ensureCodexMcp(root: string): Promise<McpSetupResult["codex"]> {
  const path = join(root, ".codex", "config.toml");
  const exists = await fileExists(path);
  const current = exists ? await readFile(path, "utf8") : "";
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = "${MCP_COMMAND}"`,
    `args = ${JSON.stringify(MCP_ARGS)}`,
    ""
  ].join("\n");
  const blockPattern = new RegExp(`(^|\\n)\\[mcp_servers\\.${escapeRegExp(SERVER_NAME)}\\]\\n(?:[^\\[]|\\[(?!mcp_servers\\.))*`, "m");
  if (blockPattern.test(current)) {
    const next = current.replace(blockPattern, (match, prefix: string) => `${prefix}${block}`);
    if (next === current) return "already_configured";
    await writeText(path, next.endsWith("\n") ? next : `${next}\n`);
    return "updated";
  }
  const separator = current.trim() ? (current.endsWith("\n") ? "\n" : "\n\n") : "";
  await writeText(path, `${current}${separator}${block}`);
  return exists ? "updated" : "created";
}

async function verifyMcpServer(root: string): Promise<McpSetupResult["verification"]> {
  const entry = process.argv[1];
  if (!entry) return "skipped";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "mcp"],
    cwd: root,
    stderr: "pipe"
  });
  const client = new Client({ name: "dev-guard-setup-verifier", version: "0.0.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    return tools.tools.some((tool) => tool.name === "prepare_task_context") ? "pass" : "warning";
  } finally {
    await client.close();
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
