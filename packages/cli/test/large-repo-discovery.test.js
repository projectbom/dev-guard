// Large-repo first-run contract: one git-aware enumeration (`.gitignore`
// honored, deleted files excluded, odd filenames verbatim) with a walk
// fallback outside git, and budgeted content reads sampled across workspace
// packages instead of the first N files of one subtree. Small fixtures only
// — throughput is measured by a separate scratch benchmark, not here.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, unlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { enumerateProjectFiles, spreadAcross, groupByRoots } from "../dist/project-files.js";
import { generateProjectKnowledge, getProjectKnowledgeRefreshStatus } from "../dist/knowledge.js";
import { ensureCodeIndex, prepareTaskContext } from "../dist/runtime-state.js";
import { prepareProject } from "../dist/prepare.js";

const execFileAsync = promisify(execFile);
const cleanupRoots = [];
after(async () => {
  await Promise.all(cleanupRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function put(root, path, content = "x\n") {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
async function tempRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanupRoots.push(root);
  return root;
}
async function git(root, ...args) {
  await execFileAsync("git", ["-c", "user.email=t@e.st", "-c", "user.name=T", ...args], { cwd: root });
}

test("git discovery: tracked + untracked, never ignored or deleted; spaces and unicode verbatim", async () => {
  const root = await tempRoot("devguard-gitls-");
  await put(root, ".gitignore", "secrets/\n*.log\nout/\n");
  await put(root, "src/tracked.ts", "export const a = 1;\n");
  await put(root, "src/to-delete.ts", "export const d = 1;\n");
  await put(root, "src/with space.ts", "export const s = 1;\n");
  await put(root, "src/한글-파일.ts", "export const k = 1;\n");
  await git(root, "init", "-q");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "init");
  await put(root, "src/untracked.ts", "export const u = 1;\n");
  await put(root, "secrets/key.json", "{\"k\":1}\n");
  await put(root, "out/bundle.js", "x\n");
  await put(root, "debug.log", "x\n");
  await put(root, "node_modules/dep/index.js", "x\n");
  await unlink(join(root, "src/to-delete.ts"));

  const { files, source } = await enumerateProjectFiles(root);
  assert.equal(source, "git");
  for (const expected of ["src/tracked.ts", "src/untracked.ts", "src/with space.ts", "src/한글-파일.ts", ".gitignore"]) {
    assert.ok(files.includes(expected), `missing ${expected}`);
  }
  for (const excluded of ["src/to-delete.ts", "secrets/key.json", "out/bundle.js", "debug.log", "node_modules/dep/index.js"]) {
    assert.ok(!files.includes(excluded), `should exclude ${excluded}`);
  }
});

test("non-git fallback: the walk finds the same project files and still excludes generated paths", async () => {
  const root = await tempRoot("devguard-walk-");
  await put(root, "src/a.ts");
  await put(root, "src/deep/b with space.tsx");
  await put(root, "dist/out.js");
  await put(root, "node_modules/dep/index.js");
  await put(root, ".devguard/runtime.json", "{}");
  const { files, source } = await enumerateProjectFiles(root);
  assert.equal(source, "walk");
  assert.deepEqual(files, ["src/a.ts", "src/deep/b with space.tsx"]);

  // Same tree under git gives the same set (no .gitignore → nothing extra hidden).
  await git(root, "init", "-q");
  const viaGit = await enumerateProjectFiles(root);
  assert.equal(viaGit.source, "git");
  assert.deepEqual(viaGit.files, files);

  const prepared = await prepareProject(await (async () => {
    const plain = await tempRoot("devguard-walk-prepare-");
    await put(plain, "package.json", JSON.stringify({ name: "plain" }));
    await put(plain, "src/index.ts", "export function main() {}\n");
    return plain;
  })());
  assert.ok(prepared.steps.every((step) => step.key !== "knowledge" || step.changed));
});

test("spreadAcross samples round-robin across groups and keeps each group's order", () => {
  const items = ["a/1", "a/2", "a/3", "a/4", "b/1", "c/1", "c/2"];
  assert.deepEqual(spreadAcross(items, 4, (item) => item[0]), ["a/1", "b/1", "c/1", "a/2"]);
  assert.deepEqual(spreadAcross(items, 99, (item) => item[0]), items);
  const groupOf = groupByRoots(["packages", "packages/ui"]);
  assert.equal(groupOf("packages/ui/src/x.ts"), "packages/ui");
  assert.equal(groupOf("packages/core/x.ts"), "packages");
  assert.equal(groupOf("docs/x.md"), "docs");
});

// A monorepo where the first workspace alone exceeds every content budget —
// the shape that used to leave every other package out of Knowledge and the
// Code Index.
async function makeLopsidedMonorepo() {
  const root = await tempRoot("devguard-lopsided-");
  await put(root, "package.json", JSON.stringify({ name: "mono", packageManager: "pnpm@9.0.0", scripts: { build: "turbo build" } }));
  await put(root, "apps/aaa-giant/package.json", JSON.stringify({ name: "@m/giant" }));
  for (let i = 0; i < 2600; i += 1) await put(root, `apps/aaa-giant/src/gen/m${i}.ts`, `export const m${i} = ${i};\n`);
  await put(root, "apps/web/package.json", JSON.stringify({ name: "@m/web", dependencies: { next: "14.0.0" } }));
  await put(root, "apps/web/app/orders/page.tsx", "export default function OrdersPage() { return null; }\n");
  await put(root, "apps/web/app/api/orders/route.ts", "export async function GET() { return Response.json([]); }\n");
  await put(root, "packages/ui/package.json", JSON.stringify({ name: "@m/ui" }));
  await put(root, "packages/ui/src/components/Button.tsx", "export function Button() { return null; }\n");
  await put(root, "supabase/migrations/20260101_orders.sql", "create table orders (id int);\n");
  await git(root, "init", "-q");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "init");
  return root;
}

test("Knowledge and Code Index represent every workspace even when one package is huge", async () => {
  const root = await makeLopsidedMonorepo();
  const knowledge = await generateProjectKnowledge(root);
  assert.equal(knowledge.summary.filesIndexed > 2000, true, "no 2000-file enumeration cap");
  assert.ok(knowledge.summary.sourceRoots.includes("apps/web"));
  assert.ok(knowledge.summary.sourceRoots.includes("packages/ui"));
  assert.ok(knowledge.pages.some((page) => page.file === "apps/web/app/orders/page.tsx" && page.route === "/orders"), "workspace app pages are detected");
  assert.ok(knowledge.apis.some((api) => api.kind === "next-route" && api.route === "/api/orders" && api.methods?.includes("GET")));
  assert.ok(knowledge.components.some((component) => component.name === "Button"));
  assert.ok(knowledge.database.some((entry) => entry.path === "supabase/migrations/20260101_orders.sql" && entry.tables?.includes("orders")));

  await ensureCodeIndex(root);
  const index = JSON.parse(await readFile(join(root, ".devguard/memory/code-index.json"), "utf8"));
  const indexed = Object.keys(index.files);
  assert.ok(indexed.length <= 1200);
  for (const expected of ["apps/web/app/orders/page.tsx", "apps/web/app/api/orders/route.ts", "packages/ui/src/components/Button.tsx"]) {
    assert.ok(indexed.includes(expected), `Code Index misses ${expected}`);
  }

  // Structural freshness now sees changes anywhere, not just in the first 2000 files.
  assert.equal((await getProjectKnowledgeRefreshStatus(root)).reason, "fresh");
  await put(root, "packages/ui/src/components/Card.tsx", "export function Card() { return null; }\n");
  assert.equal((await getProjectKnowledgeRefreshStatus(root)).reason, "stale");

  const payload = await prepareTaskContext({ root, task: "Add pagination to the orders page in apps/web/app/orders/page.tsx" });
  assert.ok(payload.files.some((file) => file.path === "apps/web/app/orders/page.tsx"));
});

test("watch preparation re-verifies the MCP server only when its config changes; setup always verifies", async () => {
  const root = await tempRoot("devguard-mcp-verify-");
  await put(root, "package.json", JSON.stringify({ name: "v" }));
  const first = await prepareProject(root);
  assert.equal(first.facts.mcp.verification, "pass");
  const second = await prepareProject(root);
  assert.equal(second.facts.mcp.verification, "skipped");
  const explicit = await prepareProject(root, { verifyMcp: "always" });
  assert.equal(explicit.facts.mcp.verification, "pass");
});
