// Large-repo contracts: per-category Knowledge budgets (pages never crowded
// out by API routes), framework-aware HTTP handler sampling, two-tier task
// routing (files outside the bounded deep Code Index are still found by
// path, never persisted), call-scope-only caching, and the stat-cached
// working-tree hash. Throughput is measured by a separate scratch benchmark.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { generateProjectKnowledge, ensureProjectKnowledge } from "../dist/knowledge.js";
import { ensureCodeIndex, prepareTaskContext, recordValidationEvidence } from "../dist/runtime-state.js";
import { rankShallowCandidates } from "../dist/shallow-index.js";
import { computeWorkingTreeContentHash } from "../dist/git.js";

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
  return (await execFileAsync("git", ["-c", "user.email=t@e.st", "-c", "user.name=T", ...args], { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout;
}
async function commitAll(root) {
  await git(root, "init", "-q");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "init");
}

// An app-router monorepo with far more API routes than pages, the shape that
// used to leave `pages` empty: `app/api/**` sorts first and took every slot.
async function makeRouteHeavyApp(root, { pages, routes, offset = 0 }) {
  for (let i = offset; i < offset + routes; i += 1) await put(root, `apps/web/app/api/area${i % 20}/r${i}/route.ts`, "export async function GET() { return Response.json([]); }\n");
  for (let i = offset; i < offset + pages; i += 1) await put(root, `apps/web/app/section${i % 10}/p${i}/page.tsx`, `export default function P${i}() { return null; }\n`);
}

test("A/B/C/D: pages, Next API routes and HTTP handlers have independent budgets; pages survive large route counts", async () => {
  const root = await tempRoot("devguard-kn-budget-");
  await put(root, "package.json", JSON.stringify({ name: "mono", workspaces: ["apps/*"] }));
  await put(root, "apps/web/package.json", JSON.stringify({ name: "web", dependencies: { next: "14.0.0" } }));
  await put(root, "apps/web/pages/api/legacy.ts", "export default function handler() {}\n");
  await makeRouteHeavyApp(root, { pages: 40, routes: 450 });
  // ~5K files: noise so the repository is "large", not just route-heavy.
  for (let i = 0; i < 4500; i += 1) await put(root, `packages/lib${i % 15}/src/m${i}.ts`, `export const m${i} = ${i};\n`);

  let knowledge = await generateProjectKnowledge(root);
  const pages = knowledge.pages.filter((page) => page.type === "page");
  assert.equal(pages.length, 40, "every page is kept when pages fit their own budget");
  assert.ok(!knowledge.pages.some((page) => page.type === "api"), "API routes no longer share the page list");
  assert.deepEqual(knowledge.coverage.pages, { detected: 40, kept: 40 });
  const nextRoutes = knowledge.apis.filter((api) => api.kind === "next-route");
  assert.equal(nextRoutes.length + knowledge.apis.filter((api) => api.kind === "pages-api").length, 200, "Next API routes (app + pages/api) are bounded by their own budget");
  assert.ok(nextRoutes.every((api) => api.methods?.includes("GET")), "route methods are still detected");
  assert.ok(knowledge.apis.some((api) => api.kind === "pages-api" && api.route === "/api/legacy"));
  assert.deepEqual(knowledge.coverage.nextRoutes, { detected: 451, kept: 200 });
  assert.ok(new Set(nextRoutes.map((api) => api.route.split("/")[2])).size === 20, "the route sample spreads across route sections");

  // ~10K files and more pages than their budget: still a bounded, spread sample.
  await makeRouteHeavyApp(root, { pages: 360, routes: 600, offset: 1000 });
  for (let i = 4500; i < 9000; i += 1) await put(root, `packages/lib${i % 15}/src/m${i}.ts`, `export const m${i} = ${i};\n`);
  knowledge = await generateProjectKnowledge(root);
  const bigPages = knowledge.pages.filter((page) => page.type === "page");
  assert.equal(bigPages.length, 200);
  assert.equal(new Set(bigPages.map((page) => page.route.split("/")[1])).size, 10, "pages come from every section, not the first N alphabetically");
  assert.deepEqual(knowledge.coverage.pages, { detected: 400, kept: 200 });
});

test("E: HTTP handlers are sampled where the framework and route-shaped paths are, within a bounded read budget", async () => {
  const root = await tempRoot("devguard-kn-http-");
  await put(root, "package.json", JSON.stringify({ name: "mono", workspaces: ["apps/*", "packages/*"] }));
  await put(root, "apps/api/package.json", JSON.stringify({ name: "api", dependencies: { express: "4.21.0" } }));
  // 300 handler files (600 routes) in one root among 20 source roots of noise.
  for (let i = 0; i < 300; i += 1) {
    await put(root, `apps/api/src/routes/area${i % 30}/h${i}.ts`, `export function register${i}(app) { app.get("/v1/h${i}", () => {}); app.post("/v1/h${i}", () => {}); }\n`);
  }
  for (let i = 0; i < 300; i += 1) await put(root, `apps/api/src/services/s${i}.ts`, `export class S${i} {}\n`);
  for (let p = 0; p < 20; p += 1) {
    await put(root, `packages/p${p}/package.json`, JSON.stringify({ name: `p${p}` }));
    for (let i = 0; i < 150; i += 1) await put(root, `packages/p${p}/src/u${i}.ts`, `export const u${i} = new Map(); u${i}.get("not-a-route");\n`);
  }
  // A client calling `api.get(...)` is not a server route.
  await put(root, "packages/p0/src/client.ts", "export const load = (api) => api.get('/v1/users');\n");
  const knowledge = await generateProjectKnowledge(root);
  assert.equal(knowledge.coverage.httpRoutes.detected, 600, "every handler in the framework package is found (was ~36 of ~800 with an even per-root quota)");
  assert.equal(knowledge.coverage.httpRoutes.kept, 600, "300 route entries, each carrying both handlers");
  const http = knowledge.apis.filter((api) => api.kind === "express");
  assert.equal(http.length, 300);
  assert.ok(http.every((api) => api.file.startsWith("apps/api/src/routes/")));
  assert.ok(http.every((api) => api.methods.join(",") === "GET,POST"), "GET and POST on one path are merged into one entry");
  assert.ok(!http.some((api) => api.route === "/v1/users"), "client calls are not routes");
});

// A workspace repo with more indexable files than the deep Code Index holds
// (1,200), where the "needle" files sort late inside large directories and
// therefore stay outside the deep index.
async function makeOverflowRepo() {
  const root = await tempRoot("devguard-overflow-");
  await put(root, "package.json", JSON.stringify({ name: "mono", workspaces: ["packages/*"] }));
  for (const pkg of ["billing", "charts", "core", "sdk", "forms", "ui"]) {
    await put(root, `packages/${pkg}/package.json`, JSON.stringify({ name: pkg }));
    for (let area = 0; area < 10; area += 1) {
      for (let i = 0; i < 30; i += 1) await put(root, `packages/${pkg}/src/area${area}/file${i}.ts`, `export function ${pkg}Area${area}Fn${i}(x: number) { return x + ${i}; }\n`);
    }
  }
  await put(root, "packages/billing/src/area9/invoice-reconcile.ts", "export function reconcileInvoices(totals: number[]) { return totals.reduce((a, b) => a + b, 0); }\n");
  await put(root, "packages/charts/src/area9/axis-ticks.ts", "export function computeTicks(min: number, max: number) { return [min, max]; }\n");
  await put(root, "packages/core/src/area9/session-store.ts", "export function readSession(id: string) { return id; }\n");
  await commitAll(root);
  await ensureCodeIndex(root);
  return root;
}

test("F/G/H/I/J: out-of-index files are found by path, unrelated ones are not, explicit inputs stay first, deep-index routing is unchanged", async () => {
  const root = await makeOverflowRepo();
  const indexPath = join(root, ".devguard/memory/code-index.json");
  const indexedBefore = Object.keys(JSON.parse(await readFile(indexPath, "utf8")).files);
  assert.ok(indexedBefore.length <= 1200);
  for (const needle of ["packages/billing/src/area9/invoice-reconcile.ts", "packages/charts/src/area9/axis-ticks.ts"]) {
    assert.ok(!indexedBefore.includes(needle), `precondition: ${needle} is outside the deep index`);
  }

  // F: strong filename term.
  const strong = await prepareTaskContext({ root, task: "Fix the invoice reconcile step that double-counts partial refunds" });
  assert.equal(strong.files[0]?.path, "packages/billing/src/area9/invoice-reconcile.ts");
  assert.equal(strong.files[0].role, "TARGET");
  // G: filename + directory terms.
  const pathTerms = await prepareTaskContext({ root, task: "Chart y-axis labels overlap when values are large" });
  assert.ok(pathTerms.files.some((file) => file.path === "packages/charts/src/area9/axis-ticks.ts" && file.role === "TARGET"), pathTerms.files.map((f) => `${f.path}:${f.role}`).join(", "));
  // H: an unrelated task promotes none of them.
  const unrelated = await prepareTaskContext({ root, task: "Add a dark mode toggle to the account settings page" });
  assert.ok(!unrelated.files.some((file) => /invoice-reconcile|axis-ticks|session-store/.test(file.path)));
  // I: a user-named input stays first even when the task text points elsewhere.
  const explicit = await prepareTaskContext({ root, task: "Fix the invoice reconcile step", explicitInputs: ["packages/core/src/area9/session-store.ts"] });
  assert.equal(explicit.files[0].path, "packages/core/src/area9/session-store.ts");
  assert.equal(explicit.files[0].role, "TARGET");
  // J: a deep-indexed target routes as before, and nothing was persisted into the deep index.
  const deep = indexedBefore.find((file) => /packages\/sdk\/src\/area1\/file\d+\.ts$/.test(file));
  const symbol = `sdkArea1Fn${deep.match(/file(\d+)\.ts$/)[1]}`;
  const deepTask = await prepareTaskContext({ root, task: `Make ${symbol} reject negative input` });
  assert.equal(deepTask.files[0].path, deep);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(indexPath, "utf8")).files).sort(), [...indexedBefore].sort(), "lazily read files are never written into the deep index");
});

test("shallow ranking ignores common and numbered filename terms", () => {
  const files = [
    ...Array.from({ length: 300 }, (_, i) => `apps/web/app/s${i}/page.tsx`),
    ...Array.from({ length: 300 }, (_, i) => `packages/ui/src/Widget${i}.tsx`),
    "packages/billing/src/invoice-reconcile.ts"
  ];
  const skip = () => false;
  assert.deepEqual(rankShallowCandidates(files, ["page", "widget", "components"], { skip, limit: 6 }), []);
  assert.deepEqual(rankShallowCandidates(files, ["widget42"], { skip, limit: 6 }).map((c) => c.path), ["packages/ui/src/Widget42.tsx"]);
  assert.deepEqual(rankShallowCandidates(files, ["reconciliation", "invoices"], { skip, limit: 6 }).map((c) => c.path), ["packages/billing/src/invoice-reconcile.ts"]);
});

test("K/L/M: index, knowledge and task state are re-read every call — nothing is cached across calls", async () => {
  const root = await makeOverflowRepo();
  // K: a changed deep-indexed file is re-read and re-tokenized on the next call.
  const index = JSON.parse(await readFile(join(root, ".devguard/memory/code-index.json"), "utf8"));
  const deep = Object.keys(index.files).find((file) => /packages\/ui\/src\/area2\/file\d+\.ts$/.test(file));
  await prepareTaskContext({ root, task: "Rename the ui area helpers" });
  await put(root, deep, "export function computeLoyaltyMultiplier(points: number) { return points * 2; }\n");
  const afterEdit = await prepareTaskContext({ root, task: "Fix computeLoyaltyMultiplier for zero points" });
  assert.equal(afterEdit.files[0].path, deep);

  // L: Knowledge regenerates when the project structure changes.
  await put(root, "packages/ui/app/rewards/page.tsx", "export default function Rewards() { return null; }\n");
  await generateProjectKnowledge(root);
  await put(root, "packages/ui/app/referrals/page.tsx", "export default function Referrals() { return null; }\n");
  const refreshed = await ensureProjectKnowledge(root);
  assert.equal(refreshed.generated, true);
  const knowledge = JSON.parse(await readFile(join(root, ".devguard/project/project-knowledge.json"), "utf8"));
  assert.ok(knowledge.pages.some((page) => page.route === "/referrals"));

  // M: task and validation state are never served from an earlier call.
  await recordValidationEvidence({ root, kind: "TEST", status: "PASS", command: "pnpm test" });
  const fresh = await prepareTaskContext({ root, task: "Second task on the same code", continueCurrentTask: true });
  assert.equal(fresh.validation.freshCount, 1, "evidence for the unchanged tree is fresh");
  await put(root, deep, "export function computeLoyaltyMultiplier(points: number) { return points * 3; }\n");
  const stale = await prepareTaskContext({ root, task: "Second task on the same code", continueCurrentTask: true });
  assert.equal(stale.validation.freshCount, 0, "a code change since the evidence makes it stale on the very next call");
  const state = JSON.parse(await readFile(join(root, ".devguard/context/task-context.json"), "utf8"));
  assert.equal(state.task, "Second task on the same code");
});

test("working-tree hash seeded from the real index equals the HEAD-seeded hash in every tree state", async () => {
  const root = await tempRoot("devguard-hash-");
  for (let i = 0; i < 50; i += 1) await put(root, `src/f${i}.ts`, `export const f${i} = ${i};\n`);
  await put(root, ".gitignore", "ignored/\n");
  await commitAll(root);
  const headSeeded = async () => {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmpdir(), `devguard-test-idx-${randomUUID()}`) };
    try {
      await execFileAsync("git", ["read-tree", "HEAD"], { cwd: root, env });
      await execFileAsync("git", ["add", "-A", "--", "."], { cwd: root, env });
      await execFileAsync("git", ["rm", "--cached", "-r", "--ignore-unmatch", "-q", "--", ".devguard", "node_modules", ".next", "dist", "build", "coverage", ".turbo", "*.tsbuildinfo"], { cwd: root, env });
      return (await execFileAsync("git", ["write-tree"], { cwd: root, env })).stdout.trim();
    } finally {
      await rm(env.GIT_INDEX_FILE, { force: true });
    }
  };
  const states = [
    async () => {},
    async () => put(root, "src/f1.ts", "export const f1 = 'changed';\n"),
    async () => { await git(root, "add", "src/f1.ts"); await put(root, "src/f1.ts", "export const f1 = 'changed again';\n"); },
    async () => put(root, "src/new.ts", "export const n = 1;\n"),
    async () => rm(join(root, "src/f2.ts")),
    async () => put(root, "ignored/secret.ts", "x\n"),
    async () => put(root, ".devguard/runtime.json", "{}\n")
  ];
  for (const [step, apply] of states.entries()) {
    await apply();
    assert.equal(await computeWorkingTreeContentHash(root), await headSeeded(), `state ${step}`);
  }
});
