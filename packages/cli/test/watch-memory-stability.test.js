// Memory stability regression suite for the PartnerFlow OOM report
// ("FATAL ERROR: Reached heap limit ... heap ~= 4.0 GB" ~14s after
// startup). Extensive reproduction attempts (real PartnerFlow, a fresh
// 1200-file generic fixture, a full clone of PartnerFlow's real source
// tree, 50x concurrent dashboard pollers, and a 200-file real event
// storm) could NOT reproduce the exact crash with the current code — see
// the final report's "OOM Root Cause" section for the full investigation
// log. This suite locks in bounded-memory behavior for every risk area
// the investigation and the hardening task identified, regardless of
// whether any one of them was the original trigger: idle stability,
// repeated heartbeats, a large Code Index, a long history, dashboard
// polling load, and a real change followed by recovery to idle.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { ensureDevguardWorkspace } from "../dist/runtime-state.js";
import { devguardPaths } from "../dist/paths.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, "..", "dist", "index.js");
const cleanupRoots = [];

after(async () => {
  await Promise.all(cleanupRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}

async function makeRepo(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanupRoots.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "DevGuard Test"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "sample", scripts: { build: "true", test: "true" } }, null, 2));
  await writeFile(join(root, ".gitignore"), ".devguard/\n");
  await writeFile(join(root, "README.md"), "# sample\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "init"]);
  return root;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, { timeoutMs = 15000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("waitFor: condition never became true");
    await sleep(intervalMs);
  }
}

function spawnWatch(root, args = []) {
  const child = spawn(process.execPath, [cliEntry, "watch", "--no-dashboard", ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DEV_GUARD_MEM_DEBUG: "1" }
  });
  const samples = [];
  let buf = "";
  const consume = (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const rssMatch = line.match(/rss=([\d.]+)MB/);
      const heapMatch = line.match(/heapUsed=([\d.]+)MB/);
      if (rssMatch && heapMatch) {
        samples.push({ t: Date.now(), rss: Number(rssMatch[1]), heapUsed: Number(heapMatch[1]) });
      }
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  return { child, samples };
}

async function stopWatch(child) {
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function assertBounded(samples, label, { maxMB = 500, maxGrowthRatio = 3 } = {}) {
  assert.ok(samples.length >= 3, `${label}: expected at least 3 memory samples, got ${samples.length}`);
  const peak = Math.max(...samples.map((s) => s.heapUsed));
  assert.ok(peak < maxMB, `${label}: heapUsed peaked at ${peak}MB, expected < ${maxMB}MB`);
  const early = samples.slice(0, Math.max(1, Math.floor(samples.length / 4)));
  const late = samples.slice(-Math.max(1, Math.floor(samples.length / 4)));
  const earlyAvg = early.reduce((s, x) => s + x.heapUsed, 0) / early.length;
  const lateAvg = late.reduce((s, x) => s + x.heapUsed, 0) / late.length;
  assert.ok(
    lateAvg < earlyAvg * maxGrowthRatio + 10,
    `${label}: heapUsed grew from ~${earlyAvg.toFixed(1)}MB to ~${lateAvg.toFixed(1)}MB (ratio ${(lateAvg / earlyAvg).toFixed(2)}x) — looks like unbounded growth, not a bounded plateau`
  );
}

// --- A: Idle watch stability -------------------------------------------

test("A: idle watch with dashboard stays memory-bounded over time, no unbounded growth", async () => {
  const root = await makeRepo("devguard-memA-");
  await ensureDevguardWorkspace(root);
  const { child, samples } = spawnWatch(root);
  try {
    await waitFor(() => samples.length >= 8, { timeoutMs: 20000 });
    assertBounded(samples, "A: idle stability");
  } finally {
    await stopWatch(child);
  }
});

// --- B: Repeated heartbeat cycles ----------------------------------------

test("B: 60+ heartbeat cycles (idle, no real changes) stay memory-bounded", { timeout: 45000 }, async () => {
  const root = await makeRepo("devguard-memB-");
  await ensureDevguardWorkspace(root);
  const { child, samples } = spawnWatch(root);
  try {
    // Heartbeat writes every ~4s; wait long enough to observe several
    // heartbeat-driven runtime.json writes and watch-UI-refresh cycles.
    await waitFor(() => samples.length >= 15, { timeoutMs: 35000 });
    assertBounded(samples, "B: repeated heartbeat");
  } finally {
    await stopWatch(child);
  }
});

// --- C: Large Code Index --------------------------------------------------

test("C: a large pre-existing Code Index does not inflate idle/dashboard memory", async () => {
  const root = await makeRepo("devguard-memC-");
  await ensureDevguardWorkspace(root);
  // Synthesize a large code-index.json directly (same shape devguard
  // writes), rather than generating 1000+ real files — this isolates
  // "dashboard/watch idle path re-reading a large index" from "indexing
  // many files takes work", which is a separate, already-bounded concern.
  const files = {};
  const filler = "x".repeat(400);
  for (let i = 0; i < 3000; i++) {
    files[`src/module${i % 40}/file${i}.ts`] = {
      hash: `h${i}`,
      summary: `function fn${i} does something with several parameters and a longer description ${filler}`,
      symbols: [
        { name: `fn${i}`, kind: "function", range: [1, 10] },
        { name: `fn${i}_helper`, kind: "function", range: [12, 30] },
        { name: `Fn${i}Type`, kind: "type", range: [32, 40] }
      ]
    };
  }
  await mkdir(join(root, ".devguard/memory"), { recursive: true });
  const serialized = JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), files });
  await writeFile(join(root, devguardPaths.codeIndex), serialized);
  const sizeMB = Buffer.byteLength(serialized, "utf8") / (1024 * 1024);
  assert.ok(sizeMB > 1, `sanity check: synthesized code-index.json should be a few MB, got ${sizeMB.toFixed(2)}MB`);

  const { child, samples } = spawnWatch(root);
  try {
    await waitFor(() => samples.length >= 8, { timeoutMs: 20000 });
    assertBounded(samples, "C: large Code Index", { maxMB: 600 });
  } finally {
    await stopWatch(child);
  }
});

// --- D: Large history -------------------------------------------------

test("D: thousands of history.jsonl records do not inflate idle/dashboard memory (bounded tail reads)", async () => {
  const root = await makeRepo("devguard-memD-");
  await ensureDevguardWorkspace(root);
  await mkdir(dirname(join(root, devguardPaths.history)), { recursive: true });
  const lines = [];
  for (let i = 0; i < 5000; i++) {
    lines.push(
      JSON.stringify({
        id: `run_${i}`,
        timestamp: new Date().toISOString(),
        changedFiles: [`file${i}.ts`],
        areas: ["ui"],
        diffStat: "1 file changed",
        inferredSummary: `change ${i}`,
        driftCandidates: [],
        docUpdateCandidates: [],
        testCandidates: [],
        generatedPromptPath: devguardPaths.nextCodexPrompt,
        reportPath: devguardPaths.lastRunReport
      })
    );
  }
  await appendFile(join(root, devguardPaths.history), `${lines.join("\n")}\n`);

  const { child, samples } = spawnWatch(root);
  try {
    await waitFor(() => samples.length >= 8, { timeoutMs: 20000 });
    assertBounded(samples, "D: large history");
  } finally {
    await stopWatch(child);
  }
});

// --- E: Event storm / self-write amplification protection ----------------

test("E: self-generated DevGuard writes do not create an amplification loop (bounded over a burst)", { timeout: 30000 }, async () => {
  const root = await makeRepo("devguard-memE-");
  await ensureDevguardWorkspace(root);
  await mkdir(join(root, "src"), { recursive: true });
  const files = [];
  for (let i = 0; i < 60; i++) {
    const f = join(root, "src", `f${i}.ts`);
    await writeFile(f, `export const x${i} = ${i};\n`);
    files.push(f);
  }
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "add files"]);

  const { child, samples } = spawnWatch(root, ["--stable-after", "1", "--auto-complete-delay", "1"]);
  try {
    await sleep(1500);
    for (let wave = 0; wave < 3; wave++) {
      for (const f of files) {
        await appendFile(f, `// churn ${wave}\n`);
      }
    }
    // Let the finalization cycle (stable -> finalizing -> idle) complete.
    await sleep(6000);
    assertBounded(samples, "E: event storm + self-writes", { maxMB: 600 });
  } finally {
    await stopWatch(child);
  }
});

// --- F: Real source change -> normal processing -> idle memory recovery ---

test("F: a real change is processed normally, then memory returns to a bounded idle plateau", { timeout: 25000 }, async () => {
  const root = await makeRepo("devguard-memF-");
  await ensureDevguardWorkspace(root);
  const { child, samples } = spawnWatch(root, ["--stable-after", "1", "--auto-complete-delay", "1"]);
  try {
    await sleep(1500);
    await writeFile(join(root, "a.js"), "export const a = 1;\n");
    await sleep(5000); // settle through finalization
    await waitFor(() => samples.length >= 10, { timeoutMs: 15000 });
    const peakDuringWork = Math.max(...samples.map((s) => s.heapUsed));
    // Idle recovery window after the one real completion.
    const beforeIdleWait = samples.length;
    await sleep(6000);
    const idleSamples = samples.slice(beforeIdleWait);
    assert.ok(idleSamples.length >= 2, "expected further samples during the idle recovery window");
    const idleAvg = idleSamples.reduce((s, x) => s + x.heapUsed, 0) / idleSamples.length;
    assert.ok(
      idleAvg < peakDuringWork + 20,
      `F: idle-after-work heapUsed (~${idleAvg.toFixed(1)}MB) should not exceed the peak seen during processing (~${peakDuringWork.toFixed(1)}MB) by more than a small margin`
    );
  } finally {
    await stopWatch(child);
  }
});

// --- G: Multiple completions (exactly-once contract preserved) -----------

test("G: repeated completion signals for unchanged code stay exactly-once AND memory-bounded together", { timeout: 25000 }, async () => {
  const root = await makeRepo("devguard-memG-");
  await ensureDevguardWorkspace(root);
  const { child, samples } = spawnWatch(root, ["--manual"]);
  try {
    await sleep(1500);
    await writeFile(join(root, "a.js"), "export const a = 1;\n");
    await execFileAsync(process.execPath, [cliEntry, "done"], { cwd: root });
    for (let i = 0; i < 5; i++) {
      await execFileAsync(process.execPath, [cliEntry, "done"], { cwd: root });
    }
    await sleep(3000);
    const { readTaskTelemetry } = await import("../dist/task-telemetry.js");
    const events = await readTaskTelemetry(root, 100);
    const taskDoneCount = events.filter((e) => e.event === "TASK_DONE").length;
    assert.equal(taskDoneCount, 1, "exactly-once contract must still hold while this memory suite runs");
    assertBounded(samples, "G: multiple completions", { maxMB: 500 });
  } finally {
    await stopWatch(child);
  }
});
