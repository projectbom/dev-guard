#!/usr/bin/env node
import { runCheck } from "./check.js";
import { runConfigure } from "./configure.js";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";
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

  if (command === "status") {
    await runStatus(root);
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

  if (command === "doctor") {
    await runDoctor(root);
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

Quick commands:
  dev-guard init
  dev-guard "fix the login redirect bug"
  dev-guard done
  dev-guard status
  dev-guard watch

Common flow:
  1. dev-guard init
  2. dev-guard "describe the change"
  3. Run Codex / edit files
  4. dev-guard done

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
  dev-guard status
  dev-guard check [--local] [--include-context-files]
  dev-guard configure ai --provider openai --model gpt-4o-mini
  dev-guard config set <provider|model|temperature|maxTokens|reasoningEffort|baseURL> <value>
  dev-guard config show
  dev-guard scan [--full] [--ai]
  dev-guard refresh [--full] [--ai] [--dry-run]
  dev-guard watch [--check] [--review] [--debounce <ms>] [--once]
  dev-guard doctor
  dev-guard telemetry
  dev-guard report [--compact] [--copy] [--json] [--since <ref>]
  dev-guard review [--heuristic] [--fix-prompt] [--copy] [--output <file>] [--copy-fix] [--include-context-files] [--staged] [--commit <ref>] [--run <id|latest>] [--no-run]
  dev-guard fix-prompt [--copy] [--output <file>] [--include-context-files] [--staged] [--commit <ref>] [--run <id|latest>] [--no-run]
  dev-guard update [--write] [--include-context-files]
  dev-guard prompt [--compact] [--ultra-compact] [--density <ultra|compact|verbose>] [--max-prompt-tokens <n>] [--copy] [--output <file>] [--include-context-files] [--save-run]
  dev-guard task-ai "<requirement>" [--write] [--prompt] [--copy] [--save-run] [--context-files <n>] [--no-code-context] [--no-cache|--fresh] [--debug-context]
  dev-guard self "<requirement>" [--copy] [--check]
  dev-guard self-check

Commands:
  init   Create .devguard and docs guard files
  "requirement" Generate task.md and a compact Codex prompt
  done   Refresh, run local checks/review, print report, and preview docs updates
  status Show project/provider/git/task status
  check  Analyze current git diff with rule-based checks
  configure Configure dev-guard settings
  scan   Cache project structure and file summaries into .devguard
  refresh Incrementally update project memory cache
  watch  Refresh project memory automatically when source files change
  doctor Print config, provider, git, memory, and telemetry diagnostics
  telemetry Print privacy-safe drift telemetry summary
  report Print a compact current-work summary for ChatGPT/Codex handoff
  review AI-review current changes against task/rules/mistakes
  fix-prompt Generate a Codex-ready fix prompt from AI review
  update Generate project docs update candidates from current git diff
  prompt Generate a Codex-ready task prompt from project context
  task-ai Generate .devguard/task.md from natural language with an AI provider
  self   Dogfood dev-guard on this repo and print an ultra-compact Codex prompt
  self-check Run build, local check, heuristic review, and doctor sequentially
`);
}

async function runDone(root: string): Promise<void> {
  const results: Array<{ name: string; ok: boolean; reason?: string; output: string[] }> = [];
  console.log("dev-guard done");
  console.log("policy: preview only; docs are not modified unless you run dev-guard update --write");

  for (const step of [
    { name: "refresh", run: () => runRefresh(root, []) },
    { name: "check --local", run: () => runCheck(root, { includeContextFiles: false, local: true }) },
    { name: "review --heuristic", run: () => runReview(root, ["--heuristic"]) },
    { name: "report --compact", run: () => runReport(root, ["--compact"]) },
    { name: "update preview", run: () => runUpdate(root, { write: false, includeContextFiles: false }) }
  ]) {
    console.log(`\n[done] running ${step.name}`);
    try {
      const output = await captureConsole(step.run);
      results.push({ name: step.name, ok: true, output });
      for (const line of summarizeStepOutput(step.name, output)) {
        console.log(`  ${line}`);
      }
    } catch (error) {
      const reason = errorMessage(error);
      console.error(`[done] ${step.name} failed: ${reason}`);
      results.push({ name: step.name, ok: false, reason, output: [] });
    }
  }

  console.log("\ndev-guard done summary");
  for (const result of results) {
    console.log(`- ${result.ok ? "pass" : "fail"}: ${result.name}${result.reason ? ` (${result.reason})` : ""}`);
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`Next: ${failed.length > 0 ? "fix failed checks, then rerun dev-guard done" : "review warnings, then commit or run dev-guard update --write if docs should be updated"}`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

async function runStatus(root: string): Promise<void> {
  console.log("dev-guard status");
  await runDoctor(root);
  console.log("");
  await runReport(root, ["--compact"]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    return pickLines(lines, ["status:", "Requirement Alignment Score:", "Drift Risk:", "Scope Safety:", "커밋 가능 여부"]);
  }

  if (name === "report --compact") {
    return lines.filter((line) => /^(Task|Changed|Check|Review|Next):/.test(line));
  }

  if (name === "update preview") {
    return pickLines(lines, ["Mode:", "Summary:", "No files were modified."]);
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`dev-guard error: ${message}`);
  process.exitCode = 1;
});
