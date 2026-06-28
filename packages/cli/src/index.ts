#!/usr/bin/env node
import { access } from "node:fs/promises";
import { runCheck } from "./check.js";
import { runConfigure } from "./configure.js";
import { runDashboard } from "./dashboard.js";
import { runDoctor } from "./doctor.js";
import { runInferTask } from "./infer-task.js";
import { getHookStatus, runInstallHooks, writeHookStatusReport } from "./hooks.js";
import { runInit } from "./init.js";
import { legacyDevguardWarning } from "./migration.js";
import { devguardPaths } from "./paths.js";
import { parsePromptOptions, runPrompt } from "./prompt.js";
import { runRefresh } from "./refresh.js";
import { runReport } from "./report.js";
import { runFixPrompt, runReview } from "./review.js";
import { runScan } from "./scan.js";
import { runSelf, runSelfCheck } from "./self.js";
import { runTaskAI } from "./task-ai.js";
import { runTelemetry } from "./telemetry.js";
import { runUpdate } from "./update.js";
import { runWatch } from "./watch.js";
import { fromRoot } from "./fs.js";
import { generateAgentContext, generateNextClaudePrompt, generateProjectHandoff, processDoneEvent, readHistoryRecords, readProjectState, readRuntimeState, resetRuntimeState } from "./runtime-state.js";
import { runInstallAgentInstructions } from "./install-agent-instructions.js";
import { formatStrategyFlag, getAgentStrategyReport } from "./agent-strategies.js";
import { formatWatchDashboard } from "./watch-format.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  const root = process.env.INIT_CWD || process.cwd();

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "help") {
    if (process.argv[3] === "advanced") {
      printAdvancedHelp();
    } else {
      printHelp();
    }
    return;
  }

  if (command === "init") {
    await runInit(root);
    return;
  }

  if (command === "done") {
    await runDone(root);
    return;
  }

  if (command === "handoff") {
    await runHandoff(root);
    return;
  }

  if (command === "install-hooks") {
    await runInstallHooks(root, process.argv.slice(3));
    return;
  }

  if (command === "install-agent-instructions") {
    await runInstallAgentInstructions(root, process.argv.slice(3));
    return;
  }

  if (command === "infer-task") {
    await runInferTask(root, process.argv.slice(3));
    return;
  }

  if (command === "status") {
    await runStatus(root);
    return;
  }

  if (command === "reset") {
    await runReset(root);
    return;
  }

  if (command === "check") {
    await runCheck(root, {
      includeContextFiles: process.argv.includes("--include-context-files"),
      local: process.argv.includes("--local")
    });
    return;
  }

  if (command === "configure" || command === "config") {
    await runConfigure(root, process.argv.slice(3));
    return;
  }

  if (command === "scan") {
    await runScan(root, process.argv.slice(3));
    return;
  }

  if (command === "refresh") {
    await runRefresh(root, process.argv.slice(3));
    return;
  }

  if (command === "watch") {
    await runWatch(root, process.argv.slice(3));
    return;
  }

  if (command === "dashboard") {
    await runDashboard(root, process.argv.slice(3));
    return;
  }

  if (command === "doctor") {
    await runDoctor(root, process.argv.slice(3));
    return;
  }

  if (command === "telemetry") {
    await runTelemetry(root);
    return;
  }

  if (command === "report") {
    await runReport(root, process.argv.slice(3));
    return;
  }

  if (command === "review") {
    await runReview(root, process.argv.slice(3));
    return;
  }

  if (command === "fix-prompt") {
    await runFixPrompt(root, process.argv.slice(3));
    return;
  }

  if (command === "update") {
    await runUpdate(root, {
      write: process.argv.includes("--write"),
      includeContextFiles: process.argv.includes("--include-context-files")
    });
    return;
  }

  if (command === "prompt") {
    await runPrompt(root, parsePromptOptions(process.argv.slice(3)));
    return;
  }

  if (command === "task-ai") {
    await runTaskAI(root, process.argv.slice(3));
    return;
  }

  if (command === "self") {
    await runSelf(root, process.argv.slice(3));
    return;
  }

  if (command === "self-check") {
    await runSelfCheck(root);
    return;
  }

  if (!command.startsWith("-")) {
    await runSelf(root, process.argv.slice(2));
    return;
  }

  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  console.log(`dev-guard

Quick start:
  dev-guard init
  dev-guard install-agent-instructions
  dev-guard watch
  (edit with Claude/Codex — DevGuard auto-finalizes after changes settle)

Normal workflow:
  1. dev-guard watch
  2. Edit files with Claude/Codex
  3. DevGuard detects changes, waits for filesystem to settle, then
     automatically generates reports and returns to monitoring.
  4. No additional commands required.

New session resume:
  Read .devguard/context/agent-context.md and continue.

Manual recovery (advanced):
  dev-guard done    — use only when watch crashed, hooks failed, or debugging
  dev-guard status  — check current state and hook status
  dev-guard reset   — clear pending buffer without deleting project state

More:
  dev-guard help advanced
`);
}

function printAdvancedHelp(): void {
  console.log(`dev-guard advanced

Usage:
  dev-guard init
  dev-guard "requirement"
  dev-guard done
  dev-guard handoff
  dev-guard install-hooks [--force] [--agent <claude|codex|codex-notify|all>] [--install-dispatcher]
  dev-guard status
  dev-guard reset
  dev-guard check [--local] [--include-context-files]
  dev-guard configure ai --provider openai --model gpt-4o-mini
  dev-guard config set <provider|model|temperature|maxTokens|reasoningEffort|baseURL> <value>
  dev-guard config show
  dev-guard scan [--full] [--ai]
  dev-guard refresh [--full] [--ai] [--dry-run]
  dev-guard watch [--manual|--no-auto] [--no-auto-complete] [--auto-complete-delay <sec>] [--no-dashboard] [--stable-after <sec>] [--depth <n>] [--poll] [--include-lockfiles] [--compact|--ultra]
  dev-guard dashboard [--port <port>] [--no-open]
  dev-guard doctor [--hooks] [--agents] [--dry-run]
  dev-guard telemetry
  dev-guard report [--compact] [--copy] [--json] [--since <ref>]
  dev-guard review [--heuristic] [--fix-prompt] [--copy] [--output <file>] [--copy-fix] [--include-context-files] [--staged] [--commit <ref>] [--run <id|latest>] [--no-run] [--task] [--from-diff]
  dev-guard fix-prompt [--copy] [--output <file>] [--include-context-files] [--staged] [--commit <ref>] [--run <id|latest>] [--no-run]
  dev-guard update [--write] [--include-context-files]
  dev-guard prompt [--compact] [--ultra-compact] [--density <ultra|compact|verbose>] [--max-prompt-tokens <n>] [--copy] [--output <file>] [--include-context-files] [--save-run]
  dev-guard infer-task [--write]
  dev-guard task-ai "<requirement>" [--write] [--prompt] [--copy] [--save-run] [--context-files <n>] [--no-code-context] [--no-cache|--fresh] [--debug-context]
  dev-guard self "<requirement>" [--copy] [--check]
  dev-guard self-check

Commands:
  init   Create .devguard and docs guard files
  "requirement" Generate task.md and a compact Codex prompt
  done   Manual session finalization. Normally NOT required — watch auto-finalizes. Use only when watch crashed, hooks failed, or for debugging.
  handoff Regenerate project-handoff.md and agent-context.md from current .devguard/ artifacts
  install-hooks Install agent completion strategy scripts/config
  install-agent-instructions Create or update AGENTS.md / CLAUDE.md with dev-guard context guidance
  status Show pending watch state, recommended mode, and last processed task
  reset  Clear watch runtime state without deleting project state
  check  Analyze current git diff with rule-based checks
  configure Configure dev-guard settings
  scan   Cache project structure and file summaries into .devguard
  refresh Incrementally update project memory cache
  watch  Start DevGuard monitoring; auto-finalizes after filesystem settles (no manual done needed)
  dashboard Reconnect to an existing dashboard session or inspect current watch state
  doctor Print config/provider/git diagnostics, hook diagnostics with --hooks, and agent strategy diagnostics with --agents
  telemetry Print privacy-safe drift telemetry summary
  report Print a compact current-work summary for ChatGPT/Codex handoff
  review AI-review current changes against task/rules/mistakes
  fix-prompt Generate a Codex-ready fix prompt from AI review
  update Generate project docs update candidates from current git diff
  prompt Generate a Codex-ready task prompt from project context
  infer-task Preview (or write) a task.md inferred from the current git diff
  task-ai Generate .devguard/task.md from natural language with an AI provider
  self   Dogfood dev-guard on this repo and print an ultra-compact Codex prompt
  self-check Run build, local check, heuristic review, and doctor sequentially
`);
}

async function runDone(root: string): Promise<void> {
  try {
    const result = await processDoneEvent(root);
    console.log("dev-guard done (manual finalization)");
    console.log("Note: dev-guard watch auto-finalizes sessions normally. Use done only for manual recovery.");
    console.log("");
    console.log("변경 파일:");
    for (const file of result.changedFiles.slice(0, 20)) {
      console.log(`- ${file}`);
    }
    if (result.changedFiles.length > 20) {
      console.log(`- ... +${result.changedFiles.length - 20} files`);
    }
    console.log("");
    console.log("감지된 영역:");
    for (const area of result.areas) {
      console.log(`- ${area}`);
    }
    console.log("");
    console.log("판단:");
    for (const judgment of result.judgments) {
      console.log(`- ${judgment}`);
    }
    console.log("");
    console.log("생성됨:");
    console.log(`- ${result.reportPath}`);
    console.log(`- ${result.promptPath}`);
    console.log(`- ${result.historySummaryPath}`);
    console.log(`- ${result.decisionCandidatesPath}`);
    console.log(`- ${result.qualityReportPath}`);
    console.log(`- ${result.projectHandoffPath}`);
    console.log(`- ${result.agentContextPath}`);
    console.log(`- ${result.nextClaudePromptPath}`);
    console.log("");
    console.log(`Quality: ${result.qualityVerdict}`);
    console.log("");
    console.log("새 세션 시작 시:");
    console.log(`  Read ${result.agentContextPath} and continue.`);
    console.log("");
    console.log("다음 작업:");
    console.log(`${result.promptPath} 확인 후 필요한 수정 진행`);
  } catch (error) {
    console.error(`dev-guard done failed: ${errorMessage(error)}`);
    console.error("recovery: run dev-guard status, then dev-guard reset if the pending buffer is wrong");
    process.exitCode = 1;
  }
}

async function runHandoff(root: string): Promise<void> {
  try {
    const [handoffPath, agentContextPath, nextClaudePromptPath] = await Promise.all([
      generateProjectHandoff(root),
      generateAgentContext(root),
      generateNextClaudePrompt(root)
    ]);
    console.log("dev-guard handoff");
    console.log("generated:");
    console.log(`- ${handoffPath}`);
    console.log(`- ${agentContextPath}`);
    console.log(`- ${nextClaudePromptPath}`);
    console.log("");
    console.log("Resume prompt for new session:");
    console.log(`  Read ${devguardPaths.agentContext} and continue.`);
  } catch (error) {
    console.error(`dev-guard handoff failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function runStatus(root: string): Promise<void> {
  console.log("dev-guard status");
  const initialized = await isDevGuardInitialized(root);
  const [runtime, state, history, hookStatus] = await Promise.all([
    readRuntimeState(root),
    readProjectState(root),
    readHistoryRecords(root, 3),
    getHookStatus(root)
  ]);
  const strategyReport = await getAgentStrategyReport(root);
  const runtimeVerified = strategyReport.strategies.some((strategy) => strategy.name !== "manual" && strategy.runtimeVerified);
  await writeHookStatusReport(root);
  console.log(`Pending files: ${runtime.pendingChangedFiles.length}`);
  for (const file of runtime.pendingChangedFiles.slice(0, 12)) {
    console.log(`- ${file}`);
  }
  if (runtime.pendingChangedFiles.length > 12) {
    console.log(`- ... +${runtime.pendingChangedFiles.length - 12} files`);
  }
  console.log(`Runtime status: ${runtime.lastStatus ?? "idle"}`);
  printWatchRuntimeExplanation(runtime, runtimeVerified);
  if (runtime.pendingChangedFiles.length === 0) {
    console.log("State: 대기 중");
  }
  console.log(`Last changed: ${runtime.lastChangedAt ?? "none"}`);
  console.log(`Last processed: ${state.lastProcessedAt ?? "none"}`);
  console.log(`Last summary: ${state.lastSummary ?? "none"}`);
  console.log(`Drift: ${state.lastDrift ?? "unknown"}`);
  console.log(`Quality: ${state.lastQualityVerdict ?? "unknown"}`);
  console.log("");
  const claudeHook = hookStatus.claudeInstalled && hookStatus.claudeHookFile ? "INSTALLED" : "NOT_INSTALLED";
  const codexHook = hookStatus.codexInstalled && hookStatus.codexHookFile ? "INSTALLED" : "NOT_INSTALLED";
  const claudeVerified = claudeHook === "INSTALLED" && hookStatus.claudeLastSuccess === true;
  const codexVerified = codexHook === "INSTALLED" && hookStatus.codexLastSuccess === true;
  const hooksInstalled = claudeHook === "INSTALLED" || codexHook === "INSTALLED";
  const hooksVerified = claudeVerified || codexVerified;
  console.log(`Mode: ${runtimeVerified ? "Auto completion runtime verified" : hooksInstalled ? "Auto completion installed, runtime not verified" : "Manual Mode fallback"}`);
  console.log(`Hooks: Claude ${claudeHook} / ${claudeVerified ? "SCRIPT_VERIFIED" : "NOT_SCRIPT_VERIFIED"}; Codex ${codexHook} / ${codexVerified ? "SCRIPT_VERIFIED" : "NOT_SCRIPT_VERIFIED"}`);
  console.log("");
  console.log("Agent Strategies");
  console.log("Claude Code");
  console.log(`- strategy: ${strategyReport.claude.name}`);
  console.log(`- installed: ${formatStrategyFlag(strategyReport.claude.installed)}`);
  console.log(`- script verified: ${formatStrategyFlag(strategyReport.claude.scriptVerified)}`);
  console.log(`- runtime verified: ${formatStrategyFlag(strategyReport.claude.runtimeVerified)}`);
  console.log(`- next: ${strategyReport.claude.next}`);
  console.log("");
  console.log("Codex");
  console.log(`- recommended strategy: ${strategyReport.codexNotify.name}`);
  console.log(`- notify installed: ${formatStrategyFlag(strategyReport.codexNotify.installed)}`);
  console.log(`- notify runtime verified: ${formatStrategyFlag(strategyReport.codexNotify.runtimeVerified)}`);
  console.log(`- stop hook installed: ${formatStrategyFlag(strategyReport.codexStopHook.installed)}`);
  console.log(`- stop hook requires trust: ${formatStrategyFlag(strategyReport.codexStopHook.requiresUserTrust)}`);
  console.log(`- stop hook runtime verified: ${formatStrategyFlag(strategyReport.codexStopHook.runtimeVerified)}`);
  console.log(`- jsonl listener installed: ${formatStrategyFlag(strategyReport.codexJsonlListener.installed)}`);
  console.log(`- next: ${strategyReport.codexNotify.runtimeVerified ? "Codex notify runtime verified." : strategyReport.codexNotify.next}`);
  console.log("");
  console.log("Hooks");
  console.log(`Claude Code: ${claudeHook} / ${claudeVerified ? "SCRIPT_VERIFIED" : "NOT_SCRIPT_VERIFIED"}`);
  console.log(`Codex CLI: ${codexHook} / ${codexVerified ? "SCRIPT_VERIFIED" : "NOT_SCRIPT_VERIFIED"}`);
  console.log(`Last Hook Trigger: ${hookStatus.lastTrigger ?? "none"}`);
  console.log(`Last Hook Success: ${hookStatus.lastSuccess === undefined ? "unknown" : hookStatus.lastSuccess ? "yes" : "no"}`);
  console.log("");
  console.log("Auto Mode:");
  console.log(hooksInstalled ? (runtimeVerified ? "Installed and runtime verified" : "Installed but runtime not verified") : "Not installed");
  if (hooksInstalled && !runtimeVerified) {
    console.log("");
    console.log("Next:");
    console.log("Run dev-guard doctor --agents");
    console.log("If Codex is used, open Codex TUI and run /hooks to trust the dev-guard Stop hook.");
    console.log("Fallback:");
    console.log("dev-guard done");
  }
  console.log("");
  console.log("Handoff:");
  console.log(devguardPaths.projectHandoff);
  console.log("");
  console.log("Agent Context:");
  console.log(devguardPaths.agentContext);
  console.log("");
  console.log("Resume prompt for new session:");
  console.log(`  Read ${devguardPaths.agentContext} and continue.`);
  if (!initialized) {
    console.log("");
    console.log("Setup:");
    console.log("  DevGuard project files are not initialized yet.");
    console.log("  Run dev-guard init, then dev-guard install-agent-instructions.");
    console.log("  Optional Auto Mode: dev-guard install-hooks");
  }
  const legacyWarning = legacyDevguardWarning(root);
  if (legacyWarning) {
    console.log("");
    console.log("Warning:");
    console.log(legacyWarning);
  }
  if (history.length > 0) {
    console.log("");
    console.log("Recent history:");
    for (const record of history.slice().reverse()) {
      console.log(`- ${record.timestamp}: ${record.inferredSummary}`);
      if (record.driftCandidates.length > 0) {
        console.log(`  drift: ${record.driftCandidates.slice(0, 2).join("; ")}`);
      }
    }
  }
  console.log("");
  console.log(`Next recommended action: ${initialized ? nextRecommendedAction(runtime.pendingChangedFiles.length, state.lastDrift, state.lastQualityVerdict, state.lastQualityNextAction) : "run dev-guard init"}`);
  console.log("Next:");
  console.log(!initialized ? "  dev-guard init" : runtime.pendingChangedFiles.length > 0 ? "  dev-guard watch  (auto-finalizes pending changes; or: dev-guard done for manual recovery)" : "  dev-guard watch");
}

async function runReset(root: string): Promise<void> {
  await resetRuntimeState(root);
  console.log("dev-guard reset");
  console.log("- runtime pending changes cleared");
  console.log(`- ${devguardPaths.state} preserved`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nextRecommendedAction(pendingCount: number, drift?: "low" | "medium" | "high", quality?: string, qualityAction?: string): string {
  if (pendingCount > 0) {
    return "run dev-guard watch (auto-finalizes) or dev-guard done (manual recovery)";
  }
  if (quality === "BLOCKED") {
    return "fix blocked quality items before commit";
  }
  if (quality === "NEEDS_REVIEW") {
    return qualityAction ?? `run verification, then review ${devguardPaths.qualityReport}`;
  }
  if (quality === "PASS") {
    return "ready for final review or commit";
  }
  if (drift && drift !== "low") {
    return `review ${devguardPaths.nextCodexPrompt}`;
  }
  return "대기 중";
}

function printWatchRuntimeExplanation(runtime: Awaited<ReturnType<typeof readRuntimeState>>, runtimeVerified: boolean): void {
  const dashboard = formatWatchDashboard(runtime, {
    autoMode: runtimeVerified,
    manual: false,
    runtimeVerified
  });
  console.log("");
  console.log(dashboard.lines.join("\n"));
  console.log("");
}

async function isDevGuardInitialized(root: string): Promise<boolean> {
  const [config, task, projectState] = await Promise.all([
    fileExists(fromRoot(root, devguardPaths.config)),
    fileExists(fromRoot(root, devguardPaths.task)),
    fileExists(fromRoot(root, "docs/PROJECT_STATE.md"))
  ]);
  return config || task || projectState;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function captureConsole(run: () => Promise<unknown>): Promise<string[]> {
  const originalLog = console.log;
  const originalError = console.error;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(...args.map(String).join(" ").split(/\r?\n/));
  };
  console.error = (...args: unknown[]) => {
    lines.push(...args.map(String).join(" ").split(/\r?\n/));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines;
}

function summarizeStepOutput(name: string, lines: string[]): string[] {
  if (name === "refresh") {
    return pickLines(lines, ["updated summaries:", "removed summaries:", "unchanged files skipped:", "writes:", "next:"]);
  }

  if (name === "check --local") {
    const warnings = countMatching(lines, "[warning]");
    const info = countMatching(lines, "[info]");
    const docs = lines.find((line) => line.startsWith("Docs update needed:"));
    return [`findings: ${warnings} warning(s), ${info} info`, docs].filter(Boolean) as string[];
  }

  if (name === "review --heuristic") {
    return summarizeReviewOutput(lines);
  }

  if (name === "report --compact") {
    return lines.filter((line) => /^(Task|Changed|Check|Review|Next):/.test(line));
  }

  if (name === "update preview") {
    return summarizeUpdatePreviewOutput(lines);
  }

  return lines.slice(0, 5);
}

function pickLines(lines: string[], patterns: string[]): string[] {
  const selected: string[] = [];
  for (const pattern of patterns) {
    const line = lines.find((candidate) => candidate.includes(pattern));
    if (line) {
      selected.push(line);
    }
  }
  return selected.length > 0 ? selected : ["completed"];
}

function countMatching(lines: string[], pattern: string): number {
  return lines.filter((line) => line.includes(pattern)).length;
}

function summarizeStatusOutput(doctorOutput: string[], reportOutput: string[]): string[] {
  const provider = valueAfter(doctorOutput, "Provider:") ?? "unknown";
  const model = valueAfter(doctorOutput, "Model:") ?? "unknown";
  const apiKey = valueAfter(doctorOutput, "API Key:") ?? "unknown";
  const baseline = valueAfter(doctorOutput, "Git Baseline:") ?? "unknown";
  const framework = valueAfter(doctorOutput, "Framework:") ?? "(unknown)";
  const runtime = valueAfter(doctorOutput, "Runtime:") ?? "(unknown)";
  const packageManager = valueAfter(doctorOutput, "Package Manager:") ?? "(unknown)";
  const memory = valueAfter(doctorOutput, "Project Memory:") ?? "unknown";
  const task = valueAfter(reportOutput, "Task:") ?? "현재 task 없음";
  const changed = valueAfter(reportOutput, "Changed:") ?? "none";
  const check = valueAfter(reportOutput, "Check:") ?? "none";
  const review = valueAfter(reportOutput, "Review:") ?? "none";
  const next = valueAfter(reportOutput, "Next:") ?? valueAfter(doctorOutput, "Next:") ?? "dev-guard \"describe the next change\"";
  const lines = [
    `Project: ${framework}; runtime=${runtime}; package_manager=${packageManager}`,
    `Provider: ${provider}; model=${model}; api_key=${apiKey}`,
    `Git baseline: ${baseline}`,
    `Memory: ${memory}`,
    `Task: ${task}`,
    `Changed: ${changed}`,
    `Check: ${check}`,
    `Review: ${review}`
  ];
  if (baseline === "missing") {
    lines.push('Warning: initial git baseline missing; run `git add . && git commit -m "initial commit"` to reduce noise.');
  }
  lines.push("");
  lines.push("Next:");
  lines.push(`  ${next}`);
  return lines;
}

function summarizeReviewOutput(lines: string[]): string[] {
  const status = valueAfter(lines, "status:") ?? "unknown";
  const alignment = valueAfter(lines, "- Requirement Alignment Score:") ?? valueAfter(lines, "Requirement Alignment Score:");
  const drift = valueAfter(lines, "- Drift Risk:") ?? valueAfter(lines, "Drift Risk:");
  const scope = valueAfter(lines, "- Scope Safety:") ?? valueAfter(lines, "Scope Safety:");
  const commitIndex = lines.findIndex((line) => line.includes("커밋 가능 여부"));
  const commit = commitIndex >= 0 ? lines.slice(commitIndex + 1).find((line) => line.trim().startsWith("- "))?.trim() : undefined;
  return [
    `status: ${status}`,
    alignment ? `requirement alignment: ${alignment}` : undefined,
    drift ? `drift risk: ${drift}` : undefined,
    scope ? `scope safety: ${scope}` : undefined,
    commit ? `commit: ${commit.replace(/^- /, "")}` : undefined
  ].filter((line): line is string => Boolean(line));
}

function summarizeUpdatePreviewOutput(lines: string[]): string[] {
  const summary = pickLines(lines, ["Mode:", "Summary:"]);
  const docsIndex = lines.findIndex((line) => line.includes("Docs Update Preview:"));
  const docLines =
    docsIndex >= 0
      ? lines
          .slice(docsIndex + 1)
          .filter((line) => /^- docs\//.test(line.trim()) || /^  - /.test(line))
          .slice(0, 8)
      : [];
  const modified = lines.find((line) => line.includes("No files were modified."));
  const applyIndex = lines.findIndex((line) => line.trim() === "Apply:");
  const apply = applyIndex >= 0 ? lines[applyIndex + 1]?.trim() : undefined;
  return [...summary, "Docs Update Preview:", ...docLines, modified, apply ? `Apply: ${apply}` : undefined].filter(
    (line): line is string => Boolean(line)
  );
}

function valueAfter(lines: string[], prefix: string): string | undefined {
  const line = lines.find((candidate) => candidate.trim().startsWith(prefix));
  if (!line) {
    return undefined;
  }
  return line.trim().slice(prefix.length).trim();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`dev-guard error: ${message}`);
  process.exitCode = 1;
});
