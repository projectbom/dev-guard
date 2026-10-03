// DG-01 regression tests: Code Index bootstrap must discover real
// workspace/monorepo source roots generically (via the same workspace-
// package discovery Project Knowledge already uses), not only a fixed,
// single-app-shaped root list — and an explicit, existing file path named
// in the task text must survive even when the Code Index does not (yet)
// cover it.
//
// All fixtures here are generic (no PartnerFlow naming) per the task's
// "PartnerFlow-only PASS is a FAIL" requirement.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ensureDevguardWorkspace, ensureCodeIndex, prepareTaskContext } from "../dist/runtime-state.js";

process.env.LC_ALL = "en-US";
process.env.LC_MESSAGES = "en-US";
process.env.LANG = "en-US";

const execFileAsync = promisify(execFile);
const cleanupRoots = [];

after(async () => {
  await Promise.all(cleanupRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRepo(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanupRoots.push(root);
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "DevGuard Test"], { cwd: root });
  return root;
}

async function writeFiles(root, entries) {
  for (const [relPath, content] of entries) {
    const full = join(root, relPath);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
}

async function commitAll(root) {
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
}

async function readCodeIndexPaths(root) {
  const raw = await readFile(join(root, ".devguard", "memory", "code-index.json"), "utf8");
  return Object.keys(JSON.parse(raw).files);
}

// --- Scenario A: plain root app (unchanged behavior) ------------------------

test("DG-01 Scenario A: a plain root-level app (src/, lib/) indexes as before", async () => {
  const root = await makeRepo("devguard-dgA-");
  await writeFiles(root, [
    ["package.json", JSON.stringify({ name: "generic-root-app" }, null, 2)],
    ["src/index.ts", "export function add(a, b) { return a + b; }\n"],
    ["lib/util.ts", "export function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }\n"]
  ]);
  await commitAll(root);
  await ensureDevguardWorkspace(root);
  await ensureCodeIndex(root);
  const indexed = await readCodeIndexPaths(root);
  assert.ok(indexed.includes("src/index.ts"), "src/index.ts should be indexed");
  assert.ok(indexed.includes("lib/util.ts"), "lib/util.ts should be indexed");
});

// --- Scenario B: apps/+packages/ monorepo -----------------------------------

test("DG-01 Scenario B: an apps/*+packages/* workspace monorepo indexes every workspace package, not just packages/*", async () => {
  const root = await makeRepo("devguard-dgB-");
  await writeFiles(root, [
    ["package.json", JSON.stringify({ name: "generic-monorepo-root", private: true }, null, 2)],
    ["pnpm-workspace.yaml", "packages:\n  - \"apps/*\"\n  - \"packages/*\"\n"],
    ["apps/admin/package.json", JSON.stringify({ name: "admin" }, null, 2)],
    ["apps/admin/lib/api-client.ts", "export function fetchThing() { return fetch('/api/thing'); }\n"],
    ["apps/api/package.json", JSON.stringify({ name: "api" }, null, 2)],
    ["apps/api/src/index.ts", "export function start() { return true; }\n"],
    ["packages/contracts/package.json", JSON.stringify({ name: "contracts" }, null, 2)],
    ["packages/contracts/src/index.ts", "export type Contract = { id: string };\n"]
  ]);
  await commitAll(root);
  await ensureDevguardWorkspace(root);
  await ensureCodeIndex(root);
  const indexed = await readCodeIndexPaths(root);
  assert.ok(indexed.includes("apps/admin/lib/api-client.ts"), `apps/admin/lib/api-client.ts missing from: ${indexed.join(", ")}`);
  assert.ok(indexed.includes("apps/api/src/index.ts"), "apps/api/src/index.ts should be indexed");
  assert.ok(indexed.includes("packages/contracts/src/index.ts"), "packages/contracts/src/index.ts should be indexed");
});

// --- Scenario C: arbitrary workspace names (not "apps") ---------------------

test("DG-01 Scenario C: arbitrary workspace directory names (services/*, modules/*) are discovered generically, not just a hardcoded 'apps' name", async () => {
  const root = await makeRepo("devguard-dgC-");
  await writeFiles(root, [
    ["package.json", JSON.stringify({ name: "generic-services-monorepo", private: true, workspaces: ["services/*", "modules/*"] }, null, 2)],
    ["services/api/package.json", JSON.stringify({ name: "svc-api" }, null, 2)],
    ["services/api/src/index.ts", "export function handler() { return 'ok'; }\n"],
    ["modules/auth/package.json", JSON.stringify({ name: "mod-auth" }, null, 2)],
    ["modules/auth/lib/token.ts", "export function signToken(payload) { return JSON.stringify(payload); }\n"]
  ]);
  await commitAll(root);
  await ensureDevguardWorkspace(root);
  await ensureCodeIndex(root);
  const indexed = await readCodeIndexPaths(root);
  assert.ok(indexed.includes("services/api/src/index.ts"), `services/api/src/index.ts missing from: ${indexed.join(", ")}`);
  assert.ok(indexed.includes("modules/auth/lib/token.ts"), `modules/auth/lib/token.ts missing from: ${indexed.join(", ")}`);
});

// --- Scenario D: exclusion of generated/vendor output -----------------------

test("DG-01 Scenario D: generated/build/vendor output inside a discovered workspace package is still excluded", async () => {
  const root = await makeRepo("devguard-dgD-");
  await writeFiles(root, [
    ["package.json", JSON.stringify({ name: "generic-monorepo-root", private: true }, null, 2)],
    ["pnpm-workspace.yaml", "packages:\n  - \"apps/*\"\n  - \"packages/*\"\n"],
    ["apps/admin/package.json", JSON.stringify({ name: "admin" }, null, 2)],
    ["apps/admin/lib/real-source.ts", "export const real = true;\n"],
    ["apps/admin/.next/server/chunk.js", "// build output, must never be indexed\n"],
    ["apps/admin/node_modules/some-dep/index.js", "// vendor code, must never be indexed\n"],
    ["packages/foo/package.json", JSON.stringify({ name: "foo" }, null, 2)],
    ["packages/foo/dist/index.js", "// build output, must never be indexed\n"]
  ]);
  await commitAll(root);
  await ensureDevguardWorkspace(root);
  await ensureCodeIndex(root);
  const indexed = await readCodeIndexPaths(root);
  assert.ok(indexed.includes("apps/admin/lib/real-source.ts"), "real source must still be indexed");
  assert.ok(!indexed.some((file) => file.includes(".next/")), "generated .next output must never be indexed");
  assert.ok(!indexed.some((file) => file.includes("node_modules/")), "vendored node_modules must never be indexed");
  assert.ok(!indexed.some((file) => file.includes("packages/foo/dist/")), "build output (dist/) must never be indexed");
});

// --- Scenario E: explicit path task survives even without the index -------

test("DG-01 Scenario E: a task that explicitly names an existing repository-relative file path gets that file as a top candidate with a usable range", async () => {
  const root = await makeRepo("devguard-dgE-");
  await writeFiles(root, [
    ["package.json", JSON.stringify({ name: "generic-monorepo-root", private: true }, null, 2)],
    ["pnpm-workspace.yaml", "packages:\n  - \"apps/*\"\n  - \"packages/*\"\n"],
    ["apps/admin/package.json", JSON.stringify({ name: "admin" }, null, 2)],
    [
      "apps/admin/lib/api-client.ts",
      [
        "export function fetchWidgets() {",
        "  return fetch('/api/widgets');",
        "}",
        "",
        "import { WidgetSchema } from '@generic/contracts';",
        ""
      ].join("\n")
    ],
    ["packages/contracts/package.json", JSON.stringify({ name: "contracts" }, null, 2)],
    ["packages/contracts/src/index.ts", "export type Widget = { id: string };\n"]
  ]);
  await commitAll(root);
  await ensureDevguardWorkspace(root);
  // Deliberately do NOT run ensureCodeIndex first — this reproduces the
  // exact PartnerFlow failure mode: an explicit-path task arriving before
  // (or despite) the Code Index covering the named file.
  const result = await prepareTaskContext({
    root,
    task: "In apps/admin/lib/api-client.ts, move the WidgetSchema import to the top of the file."
  });
  const target = result.files.find((file) => file.path === "apps/admin/lib/api-client.ts");
  assert.ok(target, `apps/admin/lib/api-client.ts must be a candidate; got: ${result.files.map((f) => f.path).join(", ")}`);
  assert.ok(target.ranges.length > 0, "the explicitly named file must have at least one usable range");
  assert.equal(target.relevance, "Targeted");
});
