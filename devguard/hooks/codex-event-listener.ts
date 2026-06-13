#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { appendFileSync, mkdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const root = resolve(__dirname, "../..");
const logPath = resolve(root, "devguard/logs/codex-hook.log");
mkdirSync(dirname(logPath), { recursive: true });

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const lines = input.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const type = event.type || event.event || event.name;
    if (type !== "turn.completed" && type !== "turn.failed") continue;
    appendFileSync(logPath, "timestamp=" + new Date().toISOString() + " hook=codex." + type + " status=start\n");
    if (type === "turn.completed") {
      if (spawnSync("pnpm", ["--version"], { cwd: root, encoding: "utf8" }).status !== 0) {
        appendFileSync(logPath, "dev-guard codex JSONL listener failed: pnpm was not found. Install pnpm or run dev-guard done/status manually.\n");
        appendFileSync(logPath, "timestamp=" + new Date().toISOString() + " hook=codex." + type + " status=failed done=127 status_cmd=127\n");
        continue;
      }
      const done = spawnSync("pnpm", ["cli", "done"], { cwd: root, encoding: "utf8" });
      const status = spawnSync("pnpm", ["cli", "status"], { cwd: root, encoding: "utf8" });
      appendFileSync(logPath, done.stdout + done.stderr + status.stdout + status.stderr);
      appendFileSync(logPath, "timestamp=" + new Date().toISOString() + " hook=codex." + type + " status=" + (done.status === 0 && status.status === 0 ? "success" : "failed") + " done=" + done.status + " status_cmd=" + status.status + "\n");
    } else {
      appendFileSync(logPath, "timestamp=" + new Date().toISOString() + " hook=codex." + type + " status=skipped_failed_turn\n");
    }
  }
});
