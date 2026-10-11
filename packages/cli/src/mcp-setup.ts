import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

/**
 * Adds/refreshes only DevGuard's own `dev-guard` server entry: other
 * `.mcp.json` servers and other `.codex/config.toml` tables are preserved.
 * `dryRun` reports what would change without writing or spawning anything.
 */
export async function ensureMcpSetup(root: string, options: { dryRun?: boolean; verify?: "always" | "on-change" } = {}): Promise<McpSetupResult> {
  const warnings: string[] = [];
  const dryRun = Boolean(options.dryRun);
  const [claude, codex] = await Promise.all([
    ensureClaudeMcp(root, dryRun).catch((error) => {
      warnings.push(`Claude MCP not configured: ${errorMessage(error)} Claude Code will not see prepare_task_context until this is fixed.`);
      return "warning" as const;
    }),
    ensureCodexMcp(root, dryRun).catch((error) => {
      warnings.push(`Codex MCP not configured: ${errorMessage(error)} Codex will not see prepare_task_context until this is fixed.`);
      return "warning" as const;
    })
  ]);
  if (dryRun) return { claude, codex, verification: "skipped", warnings };
  const changed = [claude, codex].some((state) => state === "created" || state === "updated");
  if (options.verify === "on-change" && !changed) return { claude, codex, verification: "skipped", warnings };
  const verification = await verifyMcpServer(root).catch((error) => {
    warnings.push(`MCP server check failed: ${errorMessage(error)}. Agents may not be able to call prepare_task_context; run \`dev-guard doctor\` to diagnose.`);
    return "warning" as const;
  });
  return { claude, codex, verification, warnings };
}

async function ensureClaudeMcp(root: string, dryRun: boolean): Promise<McpSetupResult["claude"]> {
  const path = join(root, ".mcp.json");
  const exists = await fileExists(path);
  const config = exists ? await readExistingJson(path) : {};
  const servers = isPlainObject(config.mcpServers) ? { ...config.mcpServers } : {};
  const entry = {
    command: MCP_COMMAND,
    args: MCP_ARGS
  };
  if (JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(entry)) {
    return "already_configured";
  }
  servers[SERVER_NAME] = entry;
  if (!dryRun) await writeJson(path, { ...config, mcpServers: servers });
  return exists ? "updated" : "created";
}

async function ensureCodexMcp(root: string, dryRun: boolean): Promise<McpSetupResult["codex"]> {
  const path = join(root, ".codex", "config.toml");
  const exists = await fileExists(path);
  const current = exists ? await readFile(path, "utf8") : "";
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = "${MCP_COMMAND}"`,
    `args = ${JSON.stringify(MCP_ARGS)}`,
    ""
  ].join("\n");
  const replaced = replaceTomlTable(current, `[mcp_servers.${SERVER_NAME}]`, block.trimEnd().split("\n"));
  if (replaced !== undefined) {
    if (replaced === current) return "already_configured";
    if (!dryRun) await writeText(path, replaced.endsWith("\n") ? replaced : `${replaced}\n`);
    return "updated";
  }
  const separator = current.trim() ? (current.endsWith("\n") ? "\n" : "\n\n") : "";
  if (!dryRun) await writeText(path, `${current}${separator}${block}`);
  return exists ? "updated" : "created";
}

async function verifyMcpServer(root: string): Promise<McpSetupResult["verification"]> {
  // The CLI entry that ships next to this module — not process.argv[1],
  // which is whatever script happens to be running (a test runner, a
  // wrapper) and must never be re-spawned as an MCP server.
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  if (!(await fileExists(entry))) return "skipped";
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

/**
 * A user-owned config file that exists but does not parse is left exactly
 * as it is (warning) — never replaced by a DevGuard-only object, which
 * would drop the user's other MCP servers.
 */
async function readExistingJson(path: string): Promise<ClaudeMcpConfig> {
  const text = await readFile(path, "utf8");
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON; left unchanged. Add the "dev-guard" server by hand or fix the file and rerun dev-guard setup.`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${path} is not a JSON object; left unchanged.`);
  return parsed as ClaudeMcpConfig;
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

/**
 * Replaces exactly one TOML table — from its `[header]` line up to (not
 * including) the next table header at column 0 — with `lines`. Comment and
 * blank lines directly above the next header stay with that next table, and
 * nested tables such as `[mcp_servers.dev-guard.env]` are separate headers,
 * so every other table in the user's config is preserved byte-for-byte.
 * Returns undefined when the header is absent.
 */
export function replaceTomlTable(text: string, header: string, lines: string[]): string | undefined {
  const all = text.split("\n");
  const start = all.findIndex((line) => line.trim() === header);
  if (start < 0) return undefined;
  let end = all.findIndex((line, index) => index > start && line.startsWith("["));
  if (end < 0) end = all.length;
  let bodyEnd = end;
  while (bodyEnd > start + 1 && (all[bodyEnd - 1].trim() === "" || all[bodyEnd - 1].trim().startsWith("#"))) bodyEnd -= 1;
  const currentBody = all.slice(start, bodyEnd).map((line) => line.trim()).filter(Boolean);
  if (currentBody.join("\n") === lines.join("\n")) return text;
  return [...all.slice(0, start), ...lines, ...all.slice(bodyEnd)].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
