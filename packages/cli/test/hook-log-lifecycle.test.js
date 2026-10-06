// Regression tests for hook log lifecycle / verification. Real PartnerFlow
// symptom: .devguard/logs/codex-notify.log reached 15.3MB (raw Codex notify
// payloads + captured `dev-guard done/status` stdout on every turn, and a
// Codex notify chain that looped back into the dispatcher ~1200 times for a
// single turn). Hook verification scanned the whole log on every dashboard
// poll: the unbounded read pulled ~16MB per /api/state call, the capped read
// hit the 10MB cap, printed the same warning every second, and reported
// codex-notify as unverified despite 1334 successful runs.
//
// Contract under test: hook logs are diagnostic-only and rotated;
// verification comes from bounded .devguard/hook-state/* files written by
// the hook scripts; nothing on the polling path reads a hook log.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile, readdir, stat, chmod, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

import { installHooks, readHookStates, refreshGeneratedHookScripts, getHookStatus } from "../dist/hooks.js";
import { getAgentStrategyReport } from "../dist/agent-strategies.js";
import { startDashboardServer } from "../dist/dashboard.js";
import { stripDispatcherSelfReference } from "../dist/codex-notify.js";
import { devguardPaths } from "../dist/paths.js";

const execFileAsync = promisify(execFile);
const cleanupRoots = [];
const distDir = new URL("../dist/", import.meta.url).pathname;

after(async () => {
  for (const dir of cleanupRoots) {
    await chmodTree(dir).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

async function chmodTree(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    await chmod(join(entry.parentPath ?? entry.path, entry.name), entry.isDirectory() ? 0o755 : 0o644).catch(() => undefined);
  }
}

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupRoots.push(dir);
  return dir;
}

// Project with DevGuard hook scripts installed and a fake `dev-guard` on
// PATH that records each `done` call and emits status-sized output.
async function makeProject() {
  const root = await tempDir("devguard-hook-log-");
  await mkdir(join(root, ".devguard"), { recursive: true });
  await writeFile(join(root, ".devguard", "config.json"), "{}\n");
  await installHooks(root, { agent: "all" });
  const bin = join(root, "fake-bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "dev-guard"),
    `#!/usr/bin/env bash
if [ "$1" = "done" ]; then echo done >> "${root}/done-calls.txt"; fi
for i in $(seq 1 120); do echo "Status line $i: lorem ipsum dolor sit amet"; done
exit "\${FAKE_DEVGUARD_EXIT:-0}"
`
  );
  await chmod(join(bin, "dev-guard"), 0o755);
  return { root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

function runHook(project, script, { arg, stdin = "", env = {} } = {}) {
  const result = spawnSync(join(project.root, script), arg === undefined ? [] : [arg], {
    cwd: project.root,
    input: stdin,
    encoding: "utf8",
    env: { ...project.env, ...env }
  });
  assert.equal(result.status, 0, `${script} exited ${result.status}: ${result.stderr}`);
  return result;
}

function notifyPayload(turnId, extra = {}) {
  return JSON.stringify({ type: "agent-turn-complete", "thread-id": "thread-1", "turn-id": turnId, cwd: "/x", ...extra });
}

async function doneCalls(root) {
  return existsSync(join(root, "done-calls.txt")) ? (await readFile(join(root, "done-calls.txt"), "utf8")).trim().split("\n").length : 0;
}

async function strategyVerified(root) {
  const report = await getAgentStrategyReport(root);
  return Object.fromEntries(report.strategies.map((strategy) => [strategy.name, strategy.runtimeVerified]));
}

// Captures console.error lines produced during fn (e.g. oversized-file warnings).
async function captureErrors(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = original;
  }
}

// Writes an old-format (pre-hook-state) log of ~sizeBytes, with success
// lines spread throughout like the real PartnerFlow log.
async function writeLegacyNotifyLog(path, sizeBytes) {
  const payload = JSON.stringify({ type: "agent-turn-complete", "turn-id": "t", "input-messages": ["x".repeat(7600)] });
  const event = [
    "timestamp=2026-10-05T00:30:37Z hook=codex.notify status=start source=agent_runtime event=agent-turn-complete",
    "timestamp=2026-10-05T00:30:37Z hook=codex.notify payload_begin",
    payload,
    "timestamp=2026-10-05T00:30:37Z hook=codex.notify payload_end",
    ..."Status: idle\n".repeat(300).split("\n"),
    "timestamp=2026-10-05T00:30:40Z hook=codex.notify status=success source=agent_runtime done=0 status_cmd=0"
  ].join("\n") + "\n";
  const handle = await open(path, "w");
  let written = 0;
  while (written < sizeBytes) {
    await handle.write(event);
    written += Buffer.byteLength(event);
  }
  await handle.close();
}

test("A: a successful Claude Stop hook marks runtimeVerified from hook-state, not from the log", async () => {
  const project = await makeProject();
  assert.equal((await strategyVerified(project.root))["claude-stop-hook"], false);

  runHook(project, devguardPaths.claudeHook, { stdin: '{"session_id":"s-1","hook_event_name":"Stop"}\n' });

  const state = await readHookStates(project.root);
  assert.equal(state["claude.stop"].source, "state");
  assert.match(state["claude.stop"].success, /hook=claude\.stop status=success /);
  // Logs are diagnostic-only: making the log unreadable must not matter.
  await chmod(join(project.root, devguardPaths.claudeLog), 0o000);
  assert.equal((await strategyVerified(project.root))["claude-stop-hook"], true);
  const status = await getHookStatus(project.root);
  assert.equal(status.claudeLastSuccess, true);
  assert.ok(status.claudeLastTrigger);
});

test("B: a 16MB hook log neither breaks verification nor warns nor is loaded into memory", async () => {
  const project = await makeProject();
  const logPath = join(project.root, devguardPaths.codexNotifyLog);
  await mkdir(join(project.root, devguardPaths.logsDir), { recursive: true });
  await writeLegacyNotifyLog(logPath, 16 * 1024 * 1024);
  assert.ok((await stat(logPath)).size > 15 * 1024 * 1024);

  // Legacy project (old scripts, no hook-state yet): bounded tail fallback.
  const rss0 = process.memoryUsage().rss;
  const { value, lines } = await captureErrors(async () => {
    const results = [];
    for (let i = 0; i < 20; i += 1) results.push(await strategyVerified(project.root));
    return results;
  });
  assert.ok(value.every((verified) => verified["codex-notify"] === true), "legacy success evidence must be found in the bounded tail");
  assert.deepEqual(lines.filter((line) => line.includes("safety limit")), []);
  assert.ok(process.memoryUsage().rss - rss0 < 64 * 1024 * 1024, "20 polls must not load the 16MB log repeatedly");

  // Once the refreshed hook has run, hook-state takes over and the log is
  // not even opened (unreadable log must not matter).
  runHook(project, devguardPaths.codexNotifyHook, { arg: notifyPayload("turn-b") });
  await chmod(logPath + ".1", 0o000);
  await chmod(logPath, 0o000);
  const after = await captureErrors(() => strategyVerified(project.root));
  assert.equal(after.value["codex-notify"], true);
  assert.deepEqual(after.lines, []);
});

test("C/D: logs rotate at the threshold with bounded generations, and verification survives rotation", async () => {
  const project = await makeProject();
  const env = { DEV_GUARD_HOOK_LOG_MAX_BYTES: "3000" };
  for (let i = 0; i < 12; i += 1) {
    runHook(project, devguardPaths.codexNotifyHook, { arg: notifyPayload(`turn-${i}`), env });
  }
  const logsDir = join(project.root, devguardPaths.logsDir);
  const files = (await readdir(logsDir)).filter((name) => name.startsWith("codex-notify.log")).sort();
  assert.deepEqual(files, ["codex-notify.log", "codex-notify.log.1", "codex-notify.log.2"]);
  for (const name of files) {
    assert.ok((await stat(join(logsDir, name))).size < 3000 + 4096, `${name} must stay near the threshold`);
  }
  const current = await readFile(join(logsDir, "codex-notify.log"), "utf8");
  assert.match(current, /turn=turn-11$/m, "the latest event is always in the current log");

  // D: delete every log generation — verification is state-based.
  await Promise.all(files.map((name) => rm(join(logsDir, name))));
  assert.equal((await strategyVerified(project.root))["codex-notify"], true);
});

test("E: duplicate notify deliveries for one turn run done exactly once and keep verification", async () => {
  const project = await makeProject();
  for (let i = 0; i < 5; i += 1) runHook(project, devguardPaths.codexNotifyHook, { arg: notifyPayload("same-turn") });
  assert.equal(await doneCalls(project.root), 1);
  const log = await readFile(join(project.root, devguardPaths.codexNotifyLog), "utf8");
  assert.equal(log.match(/reason=duplicate_turn/g)?.length, 4);
  assert.equal((await strategyVerified(project.root))["codex-notify"], true);

  runHook(project, devguardPaths.codexNotifyHook, { arg: notifyPayload("next-turn") });
  assert.equal(await doneCalls(project.root), 2);

  // A failed done does not mark the turn as handled, so a retry still runs.
  runHook(project, devguardPaths.codexNotifyHook, { arg: notifyPayload("failing-turn"), env: { FAKE_DEVGUARD_EXIT: "1" } });
  runHook(project, devguardPaths.codexNotifyHook, { arg: notifyPayload("failing-turn") });
  assert.equal(await doneCalls(project.root), 4);
  assert.equal((await strategyVerified(project.root))["codex-notify"], true, "a later failure must not erase earlier success evidence");
});

test("F: huge Codex notify payloads are summarized; raw payload only bounded under DEV_GUARD_HOOK_DEBUG", async () => {
  const project = await makeProject();
  const logPath = join(project.root, devguardPaths.codexNotifyLog);
  const huge = notifyPayload("big-1", { "input-messages": ["SECRET-" + "y".repeat(200_000)] });
  runHook(project, devguardPaths.codexNotifyHook, { arg: huge });
  const size1 = (await stat(logPath)).size;
  assert.ok(size1 < 2048, `summary event must be small, got ${size1} bytes`);
  const text = await readFile(logPath, "utf8");
  assert.ok(!text.includes("SECRET-"), "raw payload must not be logged by default");
  assert.ok(!text.includes("Status line"), "successful command output must not be logged by default");
  assert.match(text, /payload_bytes=\d{6} thread=thread-1 turn=big-1/);

  runHook(project, devguardPaths.codexNotifyHook, { arg: notifyPayload("big-2", { "input-messages": ["SECRET-" + "y".repeat(200_000)] }), env: { DEV_GUARD_HOOK_DEBUG: "1" } });
  const growth = (await stat(logPath)).size - size1;
  assert.ok(growth < 4096 + 8192, `debug event must be bounded, grew ${growth} bytes`);
  assert.ok((await readFile(logPath, "utf8")).includes("SECRET-"));

  // Failed commands keep a bounded output tail for diagnosis.
  runHook(project, devguardPaths.codexNotifyHook, { arg: notifyPayload("fail-1"), env: { FAKE_DEVGUARD_EXIT: "3" } });
  const failed = await readFile(logPath, "utf8");
  assert.match(failed, /Status line 120/);
  assert.ok(!failed.includes("Status line 80:"), "only the output tail is kept");
  assert.match(failed, /hook=codex\.notify status=failed .*done=3/);
});

test("G: repeated dashboard /api/state polls never read a large hook log", async () => {
  const project = await makeProject();
  runHook(project, devguardPaths.codexNotifyHook, { arg: notifyPayload("turn-g") });
  const logPath = join(project.root, devguardPaths.codexNotifyLog);
  await writeLegacyNotifyLog(logPath, 16 * 1024 * 1024);
  // Any read of the log on the polling path would now fail.
  await chmod(logPath, 0o000);

  const port = 47000 + Math.floor(Math.random() * 2000);
  const server = await startDashboardServer(project.root, { port });
  assert.equal(server.started, true);
  try {
    const { lines } = await captureErrors(async () => {
      for (let i = 0; i < 10; i += 1) {
        const response = await fetch(`${server.url}/api/state`);
        assert.equal(response.status, 200);
        await response.json();
      }
    });
    assert.deepEqual(lines.filter((line) => line.includes("codex-notify.log")), []);
  } finally {
    await server.close();
  }
  assert.equal((await strategyVerified(project.root))["codex-notify"], true);
});

test("H: Claude stop, Codex stop and Codex notify states are independent; direct_test runs never count as runtime evidence", async () => {
  const project = await makeProject();
  runHook(project, devguardPaths.claudeHook, { stdin: "{}\n" });
  let verified = await strategyVerified(project.root);
  assert.equal(verified["claude-stop-hook"], true);
  assert.equal(verified["codex-stop-hook"], false);
  assert.equal(verified["codex-notify"], false);

  // doctor --hooks style direct execution.
  runHook(project, devguardPaths.codexHook, { stdin: "{}\n", env: { DEV_GUARD_HOOK_SOURCE: "direct_test" } });
  runHook(project, devguardPaths.codexNotifyHook, { arg: notifyPayload("direct"), env: { DEV_GUARD_HOOK_SOURCE: "direct_test" } });
  verified = await strategyVerified(project.root);
  assert.equal(verified["codex-stop-hook"], false);
  assert.equal(verified["codex-notify"], false);

  runHook(project, devguardPaths.codexHook, { stdin: "{}\n" });
  runHook(project, devguardPaths.codexHook, { stdin: "{}\n", env: { DEV_GUARD_HOOK_SOURCE: "direct_test" } });
  verified = await strategyVerified(project.root);
  assert.equal(verified["codex-stop-hook"], true, "a later direct_test run must not erase agent_runtime evidence");
  assert.equal(verified["codex-notify"], false);

  const states = await readHookStates(project.root);
  assert.match(states["claude.stop"].last, /hook=claude\.stop /);
  assert.match(states["codex.stop"].last, /hook=codex\.stop .*source=direct_test/);
  assert.match(states["codex.notify"].last, /hook=codex\.notify /);
});

test("outdated generated hook scripts are refreshed in place; current or foreign scripts are left alone", async () => {
  const project = await makeProject();
  const notifyPath = join(project.root, devguardPaths.codexNotifyHook);
  const claudePath = join(project.root, devguardPaths.claudeHook);
  await writeFile(notifyPath, '#!/usr/bin/env bash\necho "timestamp=x hook=codex.notify payload_begin" >> log\n');
  await writeFile(claudePath, "#!/usr/bin/env bash\necho my own hook\n");
  const refreshed = await refreshGeneratedHookScripts(project.root);
  assert.deepEqual(refreshed, [devguardPaths.codexNotifyHook]);
  assert.match(await readFile(notifyPath, "utf8"), /dev-guard-hook-script: v3/);
  assert.equal(await readFile(claudePath, "utf8"), "#!/usr/bin/env bash\necho my own hook\n");
  assert.deepEqual(await refreshGeneratedHookScripts(project.root), []);
});

test("Codex notify dispatcher: self-references are stripped and re-entry is stopped", async () => {
  const home = await tempDir("devguard-notify-home-");
  const dispatcher = join(home, ".codex", "dev-guard-notify-dispatcher.sh");
  const sky = "/Apps/Sky.app/SkyComputerUseClient";
  const wrapped = [sky, "turn-ended", "--previous-notify", JSON.stringify([dispatcher]).replace(/\//g, "\\/")];

  // Runs in a child with HOME pointed at a temp dir so ~/.codex is never touched.
  const child = async (code) => {
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, HOME: home } });
    return stdout;
  };

  // The real-world loop: config wraps the dispatcher, and the dispatcher's
  // ORIGINAL_NOTIFY is that same wrapper.
  await mkdir(join(home, ".codex"), { recursive: true });
  const configText = `model = "x"\nnotify = [${wrapped.map((part) => JSON.stringify(part)).join(", ")}]\n`;
  await writeFile(join(home, ".codex", "config.toml"), configText);
  await child(`
    import { dispatcherScript } from ${JSON.stringify(join(distDir, "codex-notify.js"))};
    import { writeFileSync, chmodSync } from "node:fs";
    writeFileSync(${JSON.stringify(dispatcher)}, dispatcherScript(${JSON.stringify(wrapped)}));
    chmodSync(${JSON.stringify(dispatcher)}, 0o755);
  `);
  const out = await child(`
    import { installCodexNotifyDispatcher, getCodexNotifyConfigStatus } from ${JSON.stringify(join(distDir, "codex-notify.js"))};
    const result = await installCodexNotifyDispatcher({ force: true });
    const status = await getCodexNotifyConfigStatus();
    console.log(JSON.stringify({ result, status }));
  `);
  const { result, status } = JSON.parse(out);
  assert.equal(result.changed, true);
  assert.ok(result.backupPath && existsSync(result.backupPath));
  assert.equal(status.notifyWrapsDispatcher, true);
  assert.equal(status.existingNotifyDetected, false);
  assert.equal(await readFile(join(home, ".codex", "config.toml"), "utf8"), configText, "config.toml must be left unchanged");
  assert.match(await readFile(dispatcher, "utf8"), /^ORIGINAL_NOTIFY=\(\)$/m, "the wrapper already runs before the dispatcher; it must not be re-run");

  // Pure unit behavior of the strip.
  assert.deepEqual(stripDispatcherSelfReference(wrapped.map((part) => part.replace(home, "/Users/x"))), wrapped.map((part) => part.replace(home, "/Users/x")), "unrelated paths are kept");

  // Re-entry guard: a dispatcher whose ORIGINAL_NOTIFY is itself terminates.
  const loop = join(home, "loop-dispatcher.sh");
  await child(`
    import { dispatcherScript } from ${JSON.stringify(join(distDir, "codex-notify.js"))};
    import { writeFileSync, chmodSync } from "node:fs";
    writeFileSync(${JSON.stringify(loop)}, dispatcherScript([${JSON.stringify(loop)}]));
    chmodSync(${JSON.stringify(loop)}, 0o755);
  `);
  // cwd + env must not point at any real project: the dispatcher falls back
  // to $PWD / INIT_CWD / CODEX_* to find a project hook and would run it.
  const isolatedEnv = { ...process.env, HOME: home };
  for (const key of ["CODEX_WORKSPACE_ROOT", "CODEX_PROJECT_DIR", "INIT_CWD"]) delete isolatedEnv[key];
  const run = spawnSync(loop, ['{"type":"agent-turn-complete","cwd":"/nonexistent"}'], { cwd: home, encoding: "utf8", timeout: 10_000, env: isolatedEnv });
  assert.equal(run.status, 0);
  const dispatcherLog = await readFile(join(home, ".codex", "dev-guard-notify-dispatcher.log"), "utf8");
  assert.equal(dispatcherLog.match(/status=start /g)?.length, 1);
  assert.equal(dispatcherLog.match(/reason=reentrant/g)?.length, 1);
});
