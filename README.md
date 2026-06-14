# dev-guard

[English](./README.md) | [한국어](./README.ko.md)

dev-guard is an Alpha CLI guardrail for AI-assisted coding workflows. It watches project changes, turns finished work into a compact handoff report, and generates the next Codex/Claude prompt with local quality checks.

The default workflow is agent-strategy Auto Mode:

```bash
dev-guard init
dev-guard install-hooks
dev-guard watch
# let Claude/Codex edit files; Stop Hooks run done automatically
dev-guard status
# if a session overflows, start a new thread with:
dev-guard handoff
```

dev-guard supports Korean and English project notes and prompts. The public docs are English-first; the Korean guide is in [README.ko.md](./README.ko.md).

## Problem

AI coding agents often finish a task without preserving enough context for the next step. Teams then paste long chat logs into the next Codex/Claude session, miss drift risks, or forget why a file changed.

dev-guard keeps this workflow local and explicit:

- watch file changes while an AI agent works
- process completion when a verified agent completion strategy runs
- keep `done` available as the manual fallback
- keep append-only history
- produce quality verdicts and handoff prompts
- avoid automatic source edits or document writes

## Quick Start

Install and build:

```bash
pnpm install
pnpm run build
```

Run from this monorepo:

```bash
pnpm cli init
pnpm cli install-hooks
pnpm cli watch
# edit files with Claude/Codex; verified strategy runs done
pnpm cli status
```

After linking globally:

```bash
cd packages/cli
pnpm build
pnpm link --global
dev-guard --help
```

Use it in another project:

```bash
dev-guard init
dev-guard install-hooks
dev-guard watch
# let Claude/Codex work; verified strategy runs done
dev-guard status
```

## Recommended Workflow

1. Initialize local guard files
   ```bash
   dev-guard init
   ```
   Creates the initial `.devguard` guard files. The event-based workflow also creates `.devguard/` runtime docs when needed.

2. Enable Auto Mode once
   ```bash
   dev-guard install-hooks
   ```
   Installs available agent completion strategy files. Claude Code uses a Stop Hook. Codex notify is the recommended Codex path when configured at user level; Codex Stop Hook remains available but requires `/hooks` trust.

3. Start the watcher
   ```bash
   dev-guard watch
   ```
   Watches project files, accumulates changed paths, and waits for a verified agent completion strategy. When the strategy fires, it runs `dev-guard done`, which writes quality-report, next-codex-prompt, and project-handoff.

4. Manual fallback when hooks are unavailable
   ```bash
   dev-guard watch --manual
   dev-guard done
   ```
   Manual Mode only accumulates pending changes until you explicitly run `done`.

5. Check status
   ```bash
   dev-guard status
   ```
   Shows pending changes, last run summary, quality verdict, recent history, hook state, the handoff path, and the next recommended action.

6. Resume after context overflow
   ```bash
   dev-guard handoff
   ```
   Regenerates `.devguard/reports/project-handoff.md` from current `.devguard/` artifacts only. Start a new Claude/Codex thread and ask it to read that file.

7. Reset only runtime state when needed
   ```bash
   dev-guard reset
   ```
   Clears the pending watch buffer. It does not delete history or project state.

## Core Commands

```bash
dev-guard init
dev-guard install-hooks [--force]
dev-guard install-hooks --agent claude
dev-guard install-hooks --agent codex
dev-guard install-hooks --agent codex-notify
dev-guard install-hooks --agent all
dev-guard watch [--depth 8] [--poll] [--stable-after 20]
dev-guard watch --manual
dev-guard done
dev-guard handoff
dev-guard status
dev-guard reset
```

Advanced and legacy commands still exist, but they are no longer the main workflow:

- `scan`, `refresh`: project memory/cache maintenance
- `check`, `review`, `report`: direct inspection commands
- `prompt`, `task-ai`, natural-language command: prompt/task generation
- `update`, `update --write`: managed docs update preview/write
- `doctor`, `telemetry`, `self`, `self-check`: diagnostics and development helpers

See [docs/commands.md](./docs/commands.md) for details.

## Generated File Structure

dev-guard keeps runtime artifacts under `.devguard/`:

```text
.devguard/
  project.md
  architecture.md
  decisions.md
  tasks.md
  state.json
  runtime.json
  history.jsonl
  prompts/
    next-codex-prompt.md
  reports/
    last-run.md
    history-summary.md
    decision-candidates.md
    quality-report.md
```

The same `.devguard/` directory also stores guard config, task files, runs, memory cache, and code graph data.

Generated runtime/cache files are local-only by default and should not be committed unless a project intentionally changes its tracking policy. See [docs/configuration.md](./docs/configuration.md).

## Handoff Flow

`dev-guard done` creates:

- `.devguard/reports/last-run.md`: current completed-work report
- `.devguard/history.jsonl`: append-only run history
- `.devguard/reports/history-summary.md`: recent 5-run summary
- `.devguard/reports/decision-candidates.md`: decisions worth manually recording
- `.devguard/reports/quality-report.md`: PASS / NEEDS_REVIEW / BLOCKED quality verdict
- `.devguard/prompts/next-codex-prompt.md`: ready-to-paste Codex/Claude handoff prompt
- `.devguard/reports/project-handoff.md`: compressed project resume file for a new Claude/Codex thread

Example:

```txt
Quality: NEEDS_REVIEW
Generated:
- .devguard/reports/last-run.md
- .devguard/prompts/next-codex-prompt.md
- .devguard/reports/history-summary.md
- .devguard/reports/decision-candidates.md
- .devguard/reports/quality-report.md
- .devguard/reports/project-handoff.md
```

Read more in [docs/handoff.md](./docs/handoff.md).

## Agent Completion Strategies

dev-guard does not treat Claude Code and Codex as the same runtime.

- Claude Code: Stop Hook through `.claude/settings.json` and `.devguard/hooks/claude-stop.sh`
- Codex recommended: `notify` in user-level `~/.codex/config.toml` calling `.devguard/hooks/codex-notify.sh`
- Codex advanced: Stop Hook through `.codex/hooks.json` and `.devguard/hooks/codex-stop.sh`; requires `/hooks` trust
- Optional JSONL helper: `.devguard/hooks/codex-event-listener.ts`

Codex notify is user-level configuration. Official Codex config ignores `notify` in project-local `.codex/config.toml`, so `dev-guard install-hooks` creates the notify script but does not silently edit or claim project-local notify installation.

Installed strategies are not the same as runtime-verified strategies. Use `dev-guard doctor --agents` to see Claude/Codex strategy state, `dev-guard doctor --hooks --dry-run` to check hook files and command paths, or `dev-guard doctor --hooks` to execute hook scripts directly. The active hook check can run `dev-guard done` and `dev-guard status`.

Codex can require separate trust for the project and for each hook definition. If the Codex Stop Hook path is used, open Codex TUI in the repo and run `/hooks` to review/trust the dev-guard Stop Hook. Runtime verification is based on `.devguard/logs/claude-hook.log`, `.devguard/logs/codex-hook.log`, `.devguard/logs/codex-notify.log`, and `dev-guard status`.

The Codex JSONL helper is not a Codex hook config. It is only for consuming `codex exec --json` event streams such as `turn.completed` and `turn.failed`.

## Usage Modes

### Auto Mode Recommended

```bash
dev-guard install-hooks
dev-guard watch
```

Auto Mode is the default recommendation only after a strategy is installed and runtime verified. Claude Code uses Stop Hook. Codex should prefer notify when the user-level Codex config is available; Codex Stop Hook is an advanced option requiring `/hooks` trust. `done` then writes `quality-report.md`, `next-codex-prompt.md`, and `project-handoff.md`.

Auto Mode does not use idle timeout, polling-based completion guessing, automatic build/test, or automatic git commit.

### Manual Mode Fallback

```bash
dev-guard watch --manual
dev-guard done
```

Use Manual Mode when hooks are unavailable, untrusted, or failed. `watch` only accumulates pending changes; you decide when to run `done`.

Useful commands:

```bash
dev-guard install-hooks
dev-guard install-hooks --force
dev-guard doctor --hooks --dry-run
dev-guard doctor --hooks
dev-guard status
dev-guard done
dev-guard handoff
```

## Context Overflow Recovery

When a Claude/Codex session hits the context window, do not paste long history into a new thread. Use the generated handoff:

```bash
dev-guard handoff
cat .devguard/reports/project-handoff.md
```

In the new thread, attach or ask the agent to read `.devguard/reports/project-handoff.md`. It summarizes current state, active workflow, recent changes, important decisions, quality status, open risks, the next best task, and a short resume prompt.

## Quality Flow

`done` does not run build/test automatically. It checks what should be verified.

Quality verdicts:

- `PASS`: small scope, no blocking/high-risk signal, verification command exists, next task is clear
- `NEEDS_REVIEW`: drift, broad change, risky area, CLI router/watch/runtime/prompt logic, or package manifest changed
- `BLOCKED`: generated runtime files are in git changes, package/lockfile state looks inconsistent, or build script exists but no build verification can be suggested

Example:

```txt
Quality: NEEDS_REVIEW
Next recommended action: run pnpm run build, then review .devguard/reports/quality-report.md
```

Read more in [docs/quality.md](./docs/quality.md).

## Safety Model

- No source edits are applied by `watch`, `done`, `status`, or `reset`.
- `watch` is event-driven and does not run periodic refresh loops.
- `done` writes only `.devguard/` runtime reports/prompts/history/state.
- `decisions.md` is not modified automatically; decision candidates are written to a report.
- `update` is preview-only; `update --write` is the only docs-write command and only touches managed blocks.
- API providers are optional. Local heuristic mode works without an API key.
- API keys must stay in environment variables, not config or markdown files.

## Watch Notes

If your environment hits file descriptor limits:

```bash
dev-guard watch --poll
dev-guard watch --depth 4
```

Watch excludes common heavy/generated paths such as `node_modules`, `.git`, `.next`, `dist`, `build`, `coverage`, and dev-guard runtime report/prompt files.

## AI Provider Setup

The event-based workflow works without an AI provider. Configure one only for advanced task/review flows:

```bash
dev-guard configure ai --provider openai --model gpt-4o-mini
export OPENAI_API_KEY="your_api_key"
```

Do not store API keys in project files.

## Alpha Status

Current release target: GitHub Alpha at `https://github.com/projectbom/dev-guard`.

Before release, inspect package contents:

```bash
npm pack --dry-run --cache /private/tmp/dev-guard-npm-cache
```

`npm publish` is deferred until npm account and package ownership are ready. The dry-run check is a packaging sanity check, not a required publish step for GitHub Alpha.

Alpha limitations:

- Optimized for TypeScript/Node projects.
- Heuristic-heavy by design; not a full AST semantic engine.
- Drift detection is probabilistic and should support, not replace, review.
- Local heuristic review is useful but not a full semantic code review.
- Watch mode is conservative and may need `--poll` or lower `--depth` in large repos.

## Advanced Docs

- [Command reference](./docs/commands.md)
- [Architecture](./docs/architecture.md)
- [Handoff prompt](./docs/handoff.md)
- [Quality verdicts](./docs/quality.md)
- [Watch mode](./docs/watch.md)
- [Configuration and tracking policy](./docs/configuration.md)
- [Docs update safety](./docs/update.md)
- [Review, drift, and local heuristics](./docs/review-and-drift.md)
- [Task AI and prompt generation](./docs/task-ai.md)
- [Release checklist](./docs/release-checklist.md)
