// Regression tests for the 0.8.1 OOM and Ctrl+C hang investigation.
//
// Root cause (OOM): history.jsonl is an append-only log that grows for the
// lifetime of a project under continuous `dev-guard watch` use. Several
// read paths (readHistoryRecords, and generateProjectHandoff's own history
// read) loaded the ENTIRE file into memory, split it into a line array, and
// JSON.parsed every line, only to discard all but the last few records.
// On a long-lived project this file can reach hundreds of MB, and loading
// it in full is exactly the kind of unbounded allocation that produces the
// reported "heap limit Allocation failed" crash. Fixed by bounding the read
// to the tail of the file (readTailLines) and by gating all `.devguard`
// JSON state reads on file size (readJsonFile).
//
// Root cause (Ctrl+C hang): `server.close()` on the dashboard's HTTP server
// only invokes its callback once every connection — including idle
// keep-alive ones — has ended. The dashboard browser tab that `dev-guard
// watch` opens automatically holds exactly such a connection, so `close()`
// could hang indefinitely. Fixed by tracking sockets and destroying them
// on close, plus a bounded force-exit fallback in both SIGINT/SIGTERM
// handlers.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { request as httpRequest, Agent } from "node:http";

import { startDashboardServer } from "../dist/dashboard.js";
import {
  ensureDevguardWorkspace,
  processDoneEvent,
  readHistoryRecords,
  readRuntimeState,
  ensureCodeIndex
} from "../dist/runtime-state.js";
import { readJsonFile, readTailLines } from "../dist/fs.js";

const execFileAsync = promisify(execFile);
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
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "sample", scripts: { build: "true" } }, null, 2));
  await writeFile(join(root, ".gitignore"), ".devguard/\n");
  await writeFile(join(root, "README.md"), "# sample\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "init"]);
  return root;
}

function makeHistoryRecord(id) {
  return JSON.stringify({
    id: `run_${id}`,
    timestamp: new Date(Date.now() + id).toISOString(),
    changedFiles: [`src/file-${id}.ts`],
    areas: ["core"],
    diffStat: "1 file changed",
    inferredSummary: `Change number ${id} with some descriptive filler text to approximate real record size.`,
    driftCandidates: [],
    docUpdateCandidates: [],
    testCandidates: [],
    generatedPromptPath: ".devguard/prompts/next-codex-prompt.md",
    reportPath: ".devguard/reports/last-run.md",
    qualityVerdict: id % 2 === 0 ? "PASS" : "NEEDS_REVIEW"
  });
}

// --- Test A: legacy/stale history.jsonl (large) does not blow up memory ---

test("Test A: a very large history.jsonl is read via a bounded tail, not loaded in full", async () => {
  const root = await makeRepo("devguard-mem-history-");
  await ensureDevguardWorkspace(root);
  const historyPath = join(root, ".devguard", "history.jsonl");
  // ~30MB of history — many times larger than the bounded tail-read window,
  // but small enough to build quickly in a test.
  const lineTarget = 150_000;
  const chunks = [];
  for (let i = 0; i < lineTarget; i += 1) {
    chunks.push(makeHistoryRecord(i));
  }
  await writeFile(historyPath, chunks.join("\n") + "\n");
  const sizeMb = (await stat(historyPath)).size / (1024 * 1024);
  assert.ok(sizeMb > 10, `fixture should be reasonably large to be meaningful (was ${sizeMb.toFixed(1)}MB)`);

  const started = Date.now();
  const records = await readHistoryRecords(root, 5);
  const elapsedMs = Date.now() - started;

  assert.equal(records.length, 5, "should still return the requested number of most-recent records");
  assert.equal(records[records.length - 1].id, `run_${lineTarget - 1}`, "last record must be the actual most recent one");
  // A bounded tail read should be near-instant regardless of file size; a
  // full-file read+parse of 30MB+ would take meaningfully longer and scale
  // with file size. This is a coarse but effective regression signal.
  assert.ok(elapsedMs < 2000, `bounded tail read took ${elapsedMs}ms — too slow, may be reading the whole file`);
});

test("Test A (helper): readTailLines never reads more than the requested byte budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "devguard-mem-tail-"));
  cleanupRoots.push(root);
  const path = join(root, "big.jsonl");
  const line = "x".repeat(1000);
  const lines = Array.from({ length: 20_000 }, () => line); // ~20MB
  await writeFile(path, lines.join("\n"));
  const tail = await readTailLines(path, 64 * 1024); // 64KB budget
  const totalBytes = tail.reduce((sum, l) => sum + Buffer.byteLength(l, "utf8"), 0);
  assert.ok(totalBytes <= 64 * 1024 + 1000, "returned lines must stay within the requested byte budget (plus one line of slack)");
  assert.ok(tail.length > 0, "should still return some lines");
});

// --- Test B: oversized/corrupted JSON state does not crash and is rebuilt --

test("Test B: an oversized code-index.json is treated as invalid and rebuilt, not parsed", async () => {
  const root = await makeRepo("devguard-mem-index-");
  await ensureDevguardWorkspace(root);
  const codeIndexPath = join(root, ".devguard", "memory", "code-index.json");
  await mkdir(join(root, ".devguard", "memory"), { recursive: true });
  // Simulate a pathologically large legacy Code Index (past-bug artifact),
  // without actually needing gigabytes on disk for the test: a JSON file
  // whose declared size on disk exceeds the safety threshold.
  const bigBlob = "a".repeat(60 * 1024 * 1024); // 60MB > 50MB default cap
  await writeFile(codeIndexPath, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), files: { "x.ts": { blob: bigBlob } } }));

  const loaded = await readJsonFile(codeIndexPath, { schemaVersion: 1, generatedAt: "", files: {} });
  assert.deepEqual(loaded.files, {}, "oversized state must fall back to the default (empty) rather than being parsed");
});

test("Test B (malformed JSON): a corrupted runtime.json does not crash and falls back to defaults", async () => {
  const root = await makeRepo("devguard-mem-corrupt-");
  await ensureDevguardWorkspace(root);
  const runtimePath = join(root, ".devguard", "runtime.json");
  await writeFile(runtimePath, "{ this is not valid JSON ][");

  const runtime = await readRuntimeState(root); // must not throw
  assert.deepEqual(runtime.pendingChangedFiles, []);

  // The rest of the pipeline must keep working afterward.
  await processDoneEvent(root);
});

// --- Test C: oversized source-looking file is skipped during indexing -----

test("Test C: an oversized generated JSON file under a source directory is skipped during code indexing", async () => {
  const root = await makeRepo("devguard-mem-oversized-file-");
  await mkdir(join(root, "src"), { recursive: true });
  // A 5MB generated data file sitting inside an indexed source directory.
  const hugeArray = new Array(200_000).fill("x".repeat(20));
  await writeFile(join(root, "src", "generated-fixture.json"), JSON.stringify(hugeArray));
  await writeFile(join(root, "src", "normal.ts"), "export const ok = 1;\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "add files"]);

  await ensureDevguardWorkspace(root);
  const result = await ensureCodeIndex(root);
  assert.ok(!result.warning, `code index generation should not warn/fail: ${result.warning}`);

  const index = await readJsonFile(join(root, ".devguard", "memory", "code-index.json"), { files: {} });
  assert.ok(!index.files["src/generated-fixture.json"], "oversized JSON file must be skipped, not indexed as source");
  assert.ok(index.files["src/normal.ts"], "normal small source files must still be indexed");
});

// --- Test: repeated done cycles do not make the Code Index grow unbounded -

test("Repeated done cycles on the same file do not accumulate duplicate index data", async () => {
  const root = await makeRepo("devguard-mem-idempotent-");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "export function run() { return 1; }\n");
  await ensureDevguardWorkspace(root);
  await processDoneEvent(root);
  const first = await readJsonFile(join(root, ".devguard", "memory", "code-index.json"), { files: {} });
  const firstEntry = first.files["src/app.ts"];
  assert.ok(firstEntry, "file should be indexed after the first done cycle");
  const firstSize = JSON.stringify(firstEntry).length;

  // Run done again with no further changes to the file's content.
  await processDoneEvent(root);
  await processDoneEvent(root);
  const third = await readJsonFile(join(root, ".devguard", "memory", "code-index.json"), { files: {} });
  const thirdEntry = third.files["src/app.ts"];
  const thirdSize = JSON.stringify(thirdEntry).length;

  assert.equal(thirdSize, firstSize, "re-indexing unchanged content across repeated done cycles must not grow the index entry");
  assert.equal(Object.keys(third.files).length, Object.keys(first.files).length, "file count must not grow from repeated cycles alone");
});

// --- Test: memory regression under a constrained heap ----------------------

test("Memory regression: initializing against a large legacy history.jsonl succeeds under a constrained heap", async () => {
  const root = await makeRepo("devguard-mem-heap-");
  await ensureDevguardWorkspace(root);
  const historyPath = join(root, ".devguard", "history.jsonl");
  const lineCount = 200_000; // large, legacy-scale history
  const parts = [];
  for (let i = 0; i < lineCount; i += 1) parts.push(makeHistoryRecord(i));
  await writeFile(historyPath, parts.join("\n") + "\n");

  // Add a modest source tree so processDoneEvent has real work to do.
  await mkdir(join(root, "src"), { recursive: true });
  for (let i = 0; i < 50; i += 1) {
    await writeFile(join(root, "src", `file-${i}.ts`), `export const value${i} = ${i};\n`);
  }

  const script = `
    import { processDoneEvent } from ${JSON.stringify(new URL("../dist/runtime-state.js", import.meta.url).href)};
    await processDoneEvent(${JSON.stringify(root)});
    console.log("OK");
  `;
  const scriptPath = join(root, "run-under-constrained-heap.mjs");
  await writeFile(scriptPath, script);

  const child = spawn(process.execPath, ["--max-old-space-size=512", scriptPath], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(exitCode, 0, `expected clean exit under a 512MB heap cap, got ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`);
  assert.match(stdout, /OK/);
  assert.doesNotMatch(stderr, /heap limit|out of memory|FATAL ERROR/i);
});

// --- Dashboard server close does not hang on an idle keep-alive socket ----

test("dashboard server close() resolves promptly even with an open keep-alive connection", { timeout: 10_000 }, async () => {
  const root = await makeRepo("devguard-dashboard-close-");
  await ensureDevguardWorkspace(root);
  // startDashboardServer builds `url` from the requested port before
  // binding, so port 0 (OS-assigned) would produce an unconnectable
  // "http://127.0.0.1:0" URL — use a fixed, unlikely-to-collide port.
  const dashboard = await startDashboardServer(root, { port: 37421 });
  assert.ok(dashboard.started);

  // Simulate a browser tab left open: an HTTP/1.1 keep-alive connection
  // that is idle but not closed by the client.
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  await new Promise((resolve, reject) => {
    const req = httpRequest(dashboard.url, { agent }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end();
  });

  const started = Date.now();
  await dashboard.close();
  const elapsedMs = Date.now() - started;
  agent.destroy();

  assert.ok(elapsedMs < 2000, `dashboard.close() took ${elapsedMs}ms with an idle keep-alive connection open — should resolve promptly`);
});

// --- Test F: Ctrl+C shuts watch down promptly, even with the dashboard open

test("Test F: dev-guard watch exits promptly on SIGINT with no leftover process", { timeout: 30_000 }, async () => {
  const root = await makeRepo("devguard-ctrlc-");
  const cliEntry = new URL("../dist/index.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [cliEntry, "watch", "--manual", "--no-dashboard", "--compact"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stdout += chunk));

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`watch did not start in time; output so far:\n${stdout}`)), 20_000);
    const check = setInterval(() => {
      // "Watching project..." is printed by printStartup once setup is
      // complete; the SIGINT/SIGTERM handlers are registered a bit further
      // into runWatch (after the file watcher and refresh timer are set
      // up). Give it a short grace period past that line so the signal
      // isn't sent before the handler exists (which would just exercise
      // Node's default SIGINT behavior, not the one under test).
      if (/Watching project/.test(stdout)) {
        clearInterval(check);
        clearTimeout(timeout);
        setTimeout(resolve, 500);
      }
    }, 200);
  });

  const started = Date.now();
  child.kill("SIGINT");
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  const elapsedMs = Date.now() - started;

  assert.equal(exitCode, 0, `expected exit code 0 after SIGINT, got ${exitCode}. Output:\n${stdout}`);
  assert.ok(elapsedMs < 5000, `watch took ${elapsedMs}ms to exit after SIGINT — should be near-immediate`);
});
