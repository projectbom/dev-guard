// Real end-to-end reproduction of the reported bug and proof of the fix:
// a real `dev-guard watch` child process (not a direct function call) is
// spawned against a disposable repo, a real file change is made, and the
// watch process is left running while something that behaves exactly like
// a Claude/Codex Stop hook (an external `dev-guard done` invocation) fires
// repeatedly with NO further file changes in between — the actual reported
// shape: "Completion processed. Quality: BLOCKED" repeating forever at
// idle. Success is measured from the filesystem (history.jsonl,
// telemetry.jsonl, state.json), not by trusting the child's stdout alone.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { ensureDevguardWorkspace, readProjectState } from "../dist/runtime-state.js";
import { readTaskTelemetry } from "../dist/task-telemetry.js";
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
  await ensureDevguardWorkspace(root);
  return root;
}

async function historyCount(root) {
  const text = await readFile(join(root, devguardPaths.history), "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.trim()).length;
}

async function telemetryCountOf(root, eventType) {
  const events = await readTaskTelemetry(root, 1000);
  return events.filter((event) => event.event === eventType).length;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, { timeoutMs = 15000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("waitFor: condition never became true");
    await sleep(intervalMs);
  }
}

function spawnWatch(root, extraArgs = []) {
  // --manual: these tests specifically target the EXTERNAL-completion path
  // (refreshExternalDoneState / "Completion processed") — i.e. a Stop hook
  // or a manual `dev-guard done` run in another terminal while watch
  // itself just tracks. Watch's OWN inactivity-based fallback auto-complete
  // is a different code path with a different message ("auto: done") and
  // is covered separately; mixing the two into one test would not isolate
  // which path actually produced which message.
  //
  // Dashboard left at its default (true, matching the real report and
  // section 19's "dashboard=true must be tested too" requirement) — the
  // exact "Completion processed. Quality: X" string this suite reproduces
  // only exists in that code path (see refreshExternalDoneState); the
  // --no-dashboard compact path prints "done: quality=..." instead.
  // BROWSER=echo prevents the dashboard's real browser-open side effect.
  const child = spawn(process.execPath, [cliEntry, "watch", "--manual", ...extraArgs], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "echo" }
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  return { child, getStdout: () => stdout };
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

// --- A: one real change -> exactly one effective completion, then stable idle ---

test("E2E A: one real external completion (hook stand-in) is detected and displayed exactly once, then stays idle", async () => {
  const root = await makeRepo("wsoak-a-");
  const { child, getStdout } = spawnWatch(root);
  try {
    await sleep(1500); // let startup/preparation settle
    await writeFile(join(root, "a.js"), "export const a = 1;\n");
    await sleep(500);
    // The completion SIGNAL in this model is external (a Stop hook / a
    // human running `dev-guard done`) — watch (--manual here) never
    // triggers this itself.
    await execFileAsync(process.execPath, [cliEntry, "done"], { cwd: root });

    await waitFor(async () => (getStdout().includes("Completion processed")), { timeoutMs: 10000 });
    await sleep(1000); // let watch's 1s refresh interval settle

    assert.equal(await historyCount(root), 1, "exactly one history record for one real change");
    assert.equal(await telemetryCountOf(root, "TASK_DONE"), 1);

    // Idle window: nothing touches the repo. This is the DIRECT
    // reproduction target — the original bug repeated "Completion
    // processed" forever here with zero further input.
    const historyBefore = await historyCount(root);
    const doneBefore = await telemetryCountOf(root, "TASK_DONE");
    const processedAtBefore = (await readProjectState(root)).lastProcessedAt;
    await sleep(6000);
    assert.equal(await historyCount(root), historyBefore, "idle must not grow history");
    assert.equal(await telemetryCountOf(root, "TASK_DONE"), doneBefore, "idle must not add another effective finalization");
    assert.equal((await readProjectState(root)).lastProcessedAt, processedAtBefore, "idle must not touch lastProcessedAt");

    const processedCount = (getStdout().match(/Completion processed/g) ?? []).length;
    assert.equal(processedCount, 1, `"Completion processed" must print exactly once for one real completion, got ${processedCount}`);
  } finally {
    await stopWatch(child);
  }
});

// --- C/D (process-level): repeated external `dev-guard done` while watch is running ---

test("E2E C/D: this IS the reported bug's exact shape — a hook-equivalent calling `dev-guard done` repeatedly with no file changes must show 'Completion processed' exactly once, never repeating at idle", async () => {
  const root = await makeRepo("wsoak-hook-");
  const { child, getStdout } = spawnWatch(root);
  try {
    await sleep(1500);
    await writeFile(join(root, "a.js"), "export const a = 1;\n");
    await sleep(500);

    // This is the exact reported shape: something external calls
    // `dev-guard done` repeatedly (a Claude/Codex Stop hook firing once per
    // agent turn, independent of whether files changed) with NO new edits
    // in between. Before the Idempotent Finalization Boundary fix, EVERY
    // one of these 7 calls produced a genuinely new lastProcessedAt, and
    // watch (correctly, by its own existing logic) reported each one as
    // "Completion processed" — forever, at idle, exactly as reported.
    for (let i = 0; i < 7; i += 1) {
      await execFileAsync(process.execPath, [cliEntry, "done"], { cwd: root });
    }
    // Give watch's 1s refresh interval a couple of cycles to observe
    // whatever state these calls may have produced.
    await sleep(3000);

    assert.equal(await historyCount(root), 1, "7 `done` calls with one real change must produce exactly one history record");
    assert.equal(await telemetryCountOf(root, "TASK_DONE"), 1, "7 `done` calls with one real change must be exactly one effective finalization");
    assert.equal(await telemetryCountOf(root, "COMPLETION_SIGNAL_RECEIVED"), 7, "every raw signal is still counted, even the 6 that were no-ops");

    const processedCount = (getStdout().match(/Completion processed/g) ?? []).length;
    assert.equal(processedCount, 1, `watch must display "Completion processed" exactly once despite 7 total done calls, got ${processedCount}`);

    // And now the actual idle-soak shape from the report: wait, confirm
    // nothing repeats with zero further input.
    await sleep(5000);
    const processedCountAfterIdle = (getStdout().match(/Completion processed/g) ?? []).length;
    assert.equal(processedCountAfterIdle, 1, "idle must not add further repeats of the message");
  } finally {
    await stopWatch(child);
  }
});

// --- Dashboard mode: same idle-stability guarantee with dashboard=true ---

test("E2E (dashboard mode): idle stability holds with the default dashboard enabled, using watch's own fallback auto-complete", async () => {
  const root = await makeRepo("wsoak-dashboard-");
  // No --manual here: this specifically exercises watch's OWN
  // inactivity-fallback auto-complete (completionOwner === "inactivity-fallback",
  // since no verified hook exists in a fresh temp repo) under the default
  // dashboard=true UX, with fast timers so the test stays quick.
  const spawned = spawn(
    process.execPath,
    [cliEntry, "watch", "--stable-after", "1", "--auto-complete-delay", "1"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BROWSER: "echo" } }
  );
  try {
    await sleep(1500);
    await writeFile(join(root, "a.js"), "export const a = 1;\n");
    await waitFor(async () => (await telemetryCountOf(root, "TASK_DONE")) >= 1, { timeoutMs: 20000 });
    const doneBefore = await telemetryCountOf(root, "TASK_DONE");
    const historyBefore = await historyCount(root);
    await sleep(6000);
    assert.equal(await telemetryCountOf(root, "TASK_DONE"), doneBefore, "dashboard mode: idle must not add a finalization");
    assert.equal(await historyCount(root), historyBefore, "dashboard mode: idle must not grow history");
  } finally {
    await stopWatch(spawned);
  }
});
