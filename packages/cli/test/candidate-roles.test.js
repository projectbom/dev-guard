// TARGET vs CANDIDATE vs REFERENCE: generic fixtures (no downstream naming).
// The real failure this guards: an agent batch-read every suggested range,
// so generic READMEs / unrelated UI tests that were merely word-overlap
// candidates cost real initial context. Only high-confidence files may be
// TARGET; low-signal file types need a strong signal to get there; recall of
// the files that matter must not drop.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ensureCodeIndex, ensureDevguardWorkspace, prepareTaskContext, processDoneEvent, toAgentContextPayload } from "../dist/runtime-state.js";

process.env.LC_ALL = "en-US";
process.env.LANG = "en-US";

const execFileAsync = promisify(execFile);
const cleanup = [];
after(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

let shared;
async function fixture() {
  if (shared) return shared;
  const root = await mkdtemp(join(tmpdir(), "devguard-roles-"));
  cleanup.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "t@example.com"]);
  await git(root, ["config", "user.name", "t"]);
  await put(root, "package.json", JSON.stringify({ name: "fixture" }));
  await put(root, "packages/config/src/env.ts", "export const STANDBY_MODE = process.env.STANDBY_MODE === 'true';\nexport function isStandbyMode(): boolean { return STANDBY_MODE; }\nexport const databasePoolMax = Number(process.env.DATABASE_POOL_MAX ?? 10);\n");
  await put(root, "packages/db/src/client.ts", "import { databasePoolMax } from '@fixture/config';\nexport function createDbClient(connectionString: string) {\n  return { connectionString, pool: { max: databasePoolMax, connectionTimeoutMillis: 5000 } };\n}\n");
  await put(root, "apps/api/src/auth/session-guard.ts", "export function resolveSessionCustomer(sub: string, authProvider: string): string {\n  return `${authProvider}:${sub}`;\n}\n");
  await put(root, "packages/db/src/membership-repository.ts", "export function findMembershipByAuthSubject(authSubject: string) {\n  return authSubject ? { membership: true } : undefined;\n}\n");
  await put(root, "infra/cloud-run/worker-service.yaml", "service: worker\nregion: asia-northeast3\nreadinessProbe:\n  path: /ready\n");
  await put(root, "apps/admin/components/TemplateLiveEditor.tsx", "export function TemplateLiveEditor() {\n  return <div className='toolbar'><button>Save template</button></div>;\n}\n");
  await put(root, "apps/admin/components/TemplateLiveEditor.test.tsx", "// live editor budget connection standby audit capacity production database\nimport { TemplateLiveEditor } from './TemplateLiveEditor';\ntest('renders', () => TemplateLiveEditor());\n");
  // Generic, word-rich documentation that overlaps any infrastructure task.
  await put(root, "infra/legacy-mirror/README.md", "# Legacy mirror\n\nProduction database connection budget, standby capacity, audit, runtime admission, region, readiness, worker, deploy, rollout, credentials, roles, cloud run, service, pool, timeouts.\n");
  await put(root, "infra/standby/README.md", "# Standby\n\nStandby runtime admission design and connection budget notes.\n");
  for (let index = 0; index < 55; index += 1) await put(root, `packages/feature-${index}/src/module-${index}.ts`, `export function computeValue${index}(input: number): number {\n  return input * ${index + 1};\n}\n`);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "init"]);
  await ensureDevguardWorkspace(root);
  await ensureCodeIndex(root);
  shared = root;
  return root;
}

const roles = (result) => Object.fromEntries(result.files.map((file) => [file.path, file.role]));
const targets = (result) => result.files.filter((file) => file.role === "TARGET").map((file) => file.path);

test("A. DB budget / standby: code with the identifiers is TARGET; generic docs and unrelated UI tests are not", async () => {
  const root = await fixture();
  const result = await prepareTaskContext({ root, task: "Audit the production database connection budget and implement STANDBY_MODE runtime admission in the DB connection pool; add targeted tests.", persistTask: false });
  const role = roles(result);
  assert.equal(role["packages/config/src/env.ts"], "TARGET");
  assert.ok(targets(result).length >= 1 && targets(result).length <= 3);
  assert.notEqual(role["infra/legacy-mirror/README.md"], "TARGET", "word-rich generic doc is at most a candidate");
  assert.notEqual(role["apps/admin/components/TemplateLiveEditor.test.tsx"], "TARGET", "unrelated UI test is at most a candidate");
  assert.ok(role["packages/db/src/client.ts"], "recall: the DB client is still suggested");
});

test("B. Auth/DB: the auth and membership code are targets", async () => {
  const root = await fixture();
  const result = await prepareTaskContext({ root, task: "Fix resolveSessionCustomer so the JWT sub maps to authSubject via findMembershipByAuthSubject.", persistTask: false });
  const t = targets(result);
  assert.ok(t.includes("apps/api/src/auth/session-guard.ts"), t.join(", "));
  assert.ok(t.includes("packages/db/src/membership-repository.ts"), t.join(", "));
});

test("C. Infra: the service template is a target, the generic README is not", async () => {
  const root = await fixture();
  const result = await prepareTaskContext({ root, task: "Change the Cloud Run worker-service readinessProbe path and region in the worker service template.", persistTask: false });
  assert.equal(roles(result)["infra/cloud-run/worker-service.yaml"], "TARGET");
  assert.notEqual(roles(result)["infra/legacy-mirror/README.md"], "TARGET");
});

test("D. UI: for a UI task the component is a legitimate target", async () => {
  const root = await fixture();
  const result = await prepareTaskContext({ root, task: "Change the TemplateLiveEditor toolbar button label from 'Save template' to 'Publish'.", persistTask: false });
  assert.equal(roles(result)["apps/admin/components/TemplateLiveEditor.tsx"], "TARGET");
});

test("E. explicit one-file task: the named file is the first TARGET", async () => {
  const root = await fixture();
  const result = await prepareTaskContext({ root, task: "In packages/db/src/client.ts raise the pool connectionTimeoutMillis to 10000. Do not change any other file.", persistTask: false });
  assert.equal(result.files[0].path, "packages/db/src/client.ts");
  assert.equal(result.files[0].role, "TARGET");
});

test("F. negative intent: excluded scope is REFERENCE, never TARGET", async () => {
  const root = await fixture();
  const result = await prepareTaskContext({ root, task: "Implement STANDBY_MODE runtime admission for the connection pool without importing legacy-mirror changes.", persistTask: false });
  for (const file of result.files) if (/legacy-mirror/.test(file.path)) assert.equal(file.role, "REFERENCE");
});

test("docs task: a README may be TARGET when the task is about the docs", async () => {
  const root = await fixture();
  const result = await prepareTaskContext({ root, task: "Update the standby README documentation for runtime admission.", persistTask: false });
  assert.equal(roles(result)["infra/standby/README.md"], "TARGET");
});

test("payload: targets carry ranges, candidates one range, agent is told not to batch-read", async () => {
  const root = await fixture();
  const result = await prepareTaskContext({ root, task: "Audit the production database connection budget and implement STANDBY_MODE runtime admission in the DB connection pool.", persistTask: false });
  const payload = toAgentContextPayload(result);
  assert.ok(payload.files.every((file) => ["TARGET", "CANDIDATE", "REFERENCE"].includes(file.role)));
  assert.ok(payload.files.filter((file) => file.role !== "TARGET").every((file) => file.ranges.length <= 1));
  assert.match(payload.workflow, /Read TARGET ranges first.*do not batch-read every file listed/);
  assert.match(payload.nextAction, /TARGET/);
  const roleOrder = payload.files.map((file) => file.role);
  assert.deepEqual(roleOrder, [...roleOrder].sort((a, b) => ["TARGET", "CANDIDATE", "REFERENCE"].indexOf(a) - ["TARGET", "CANDIDATE", "REFERENCE"].indexOf(b)), "targets first");
});

test("same-workstream continuity: the previous task's own changed files become low-cost candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "devguard-roles-ws-"));
  cleanup.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "t@example.com"]);
  await git(root, ["config", "user.name", "t"]);
  await put(root, "package.json", JSON.stringify({ name: "fixture" }));
  await put(root, "packages/config/src/env.ts", "export const STANDBY_MODE = true;\n");
  for (let index = 0; index < 55; index += 1) await put(root, `packages/feature-${index}/src/module-${index}.ts`, `export const value${index} = ${index};\n`);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "init"]);
  await ensureDevguardWorkspace(root);
  await ensureCodeIndex(root);
  await prepareTaskContext({ root, task: "Standby capacity phase A: write the standby capacity evidence and admission proposal." });
  await put(root, "infra/standby/capacity-evidence.json", JSON.stringify({ standby: true, capacity: "proposal", admission: "draft" }) + "\n");
  await processDoneEvent(root);
  const next = await prepareTaskContext({ root, task: "Standby capacity phase B: close the admission blocker using the capacity evidence from phase A.", persistTask: false });
  const file = next.files.find((entry) => entry.path === "infra/standby/capacity-evidence.json");
  assert.ok(file, `previous task's evidence is suggested: ${next.files.map((entry) => entry.path).join(", ")}`);
  const unrelated = await prepareTaskContext({ root, task: "Rename computeValue helpers in the feature packages.", persistTask: false });
  assert.ok(!unrelated.files.some((entry) => entry.path === "infra/standby/capacity-evidence.json"), "no continuity prior for a different workstream");
});
