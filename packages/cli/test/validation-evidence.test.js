import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ensureDevguardWorkspace,
  processDoneEvent,
  recordValidationEvidence,
  isIgnoredWatchPath
} from "../dist/runtime-state.js";

// These assertions check rendered prose against DevGuard's documented
// default locale (en-US). DevGuard's locale resolution intentionally reads
// LC_ALL/LC_MESSAGES/LANG when a project has no explicit `.devguard/config.json`
// locale (see src/locale.ts) — correct, deliberate behavior for a real ko-KR
// host, but it left these assertions accidentally dependent on whatever OS
// locale happens to run the test. Pin it so the suite is deterministic
// regardless of the host machine's locale.
process.env.LC_ALL = "en-US";
process.env.LC_MESSAGES = "en-US";
process.env.LANG = "en-US";

const execFileAsync = promisify(execFile);
const cleanupRoots = [];

after(async () => {
  await Promise.all(cleanupRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), "devguard-validation-"));
  cleanupRoots.push(root);
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "DevGuard Test"], { cwd: root });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "sample", scripts: { build: "true" } }, null, 2));
  await writeFile(join(root, "README.md"), "# sample\n");
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
  return root;
}

test("isIgnoredWatchPath excludes generated build artifacts (.next, dist, tsbuildinfo, turbo cache)", () => {
  assert.equal(isIgnoredWatchPath(".next/cache/x.pack"), true);
  assert.equal(isIgnoredWatchPath("dist/index.js"), true);
  assert.equal(isIgnoredWatchPath("tsconfig.tsbuildinfo"), true);
  assert.equal(isIgnoredWatchPath("packages/cli/tsconfig.tsbuildinfo"), true);
  assert.equal(isIgnoredWatchPath(".turbo/cache/abc"), true);
});

test("isIgnoredWatchPath does not exclude real source or migration files", () => {
  assert.equal(isIgnoredWatchPath("packages/cli/src/index.ts"), false);
  assert.equal(isIgnoredWatchPath("migrations/0001_init.sql"), false);
});

test("build FAIL evidence is reported distinctly from not-recorded", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await recordValidationEvidence({ root, kind: "BUILD", status: "FAIL", reason: "type error in route.ts" });
  await processDoneEvent(root);
  const quality = await readFile(join(root, ".devguard/reports/quality-report.md"), "utf8");
  assert.match(quality, /Build\s*\|\s*❌ FAIL/);
  assert.doesNotMatch(quality, /DevGuard에 결과가 기록되지 않음.*Build/s);
});

test("no recorded evidence at all yields Unknown confidence, not Low", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await processDoneEvent(root);
  const quality = await readFile(join(root, ".devguard/reports/quality-report.md"), "utf8");
  assert.match(quality, /##[^\n]*QA Confidence\s*\n\s*\nUnknown/);
  assert.doesNotMatch(quality, /##[^\n]*QA Confidence\s*\n\s*\nLow/);
});

test("recorded PASS evidence is not shown as not-recorded", async () => {
  const root = await makeRepo();
  await ensureDevguardWorkspace(root);
  await recordValidationEvidence({ root, kind: "BUILD", status: "PASS" });
  await processDoneEvent(root);
  const quality = await readFile(join(root, ".devguard/reports/quality-report.md"), "utf8");
  assert.match(quality, /Build\s*\|\s*✅ PASS/);
});

test("generic per-file AI/diff filler sentences are not repeated across multiple files", async () => {
  const root = await makeRepo();
  await mkdir(join(root, "components"), { recursive: true });
  await writeFile(join(root, "components", "A.jsx"), "export const A = () => <div className='x'/>;\n");
  await writeFile(join(root, "components", "B.jsx"), "export const B = () => <div className='y'/>;\n");
  await ensureDevguardWorkspace(root);
  await processDoneEvent(root);
  const quality = await readFile(join(root, ".devguard/reports/quality-report.md"), "utf8");
  const summarySection = quality.split(/##\s*3\./)[1]?.split(/##\s*4\./)[0] ?? "";
  const occurrences = summarySection.split("Adjusts UI rendering or interaction behavior.").length - 1;
  assert.ok(occurrences <= 1, `expected the generic UI filler sentence not to repeat, found ${occurrences} times`);
});
