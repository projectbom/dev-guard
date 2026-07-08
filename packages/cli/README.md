# dev-guard CLI

`dev-guard` is an AI Coding Context Provider for Codex / Claude coding sessions.

It is not an IDE, wrapper, or autonomous coding agent. It prepares context before AI work and preserves context after AI work under `.devguard/`.

## Install Or Update

```bash
npm install -g @dev-guard/cli@latest
```

Run without a global install:

```bash
npx @dev-guard/cli --help
```

## Quick Start

Run from your project root:

```bash
cd my-project
dev-guard watch
```

On first launch, `watch` automatically creates default `.devguard/` configuration, installs DevGuard-managed AI instruction files when safe, installs completion hooks best-effort, generates Project Knowledge, starts the local dashboard, and opens the browser.

## GPT Setup

The default `watch`, `done`, `status`, and `handoff` workflow does not require GPT/API setup. Without a key, `done` generates rule-based Quality Reports. With a key, DevGuard can add OpenAI-assisted Quality Report summaries and run AI-backed commands such as `review` and `task-ai`.

```bash
dev-guard config set openaiApiKey "your_api_key"
# or:
export DEV_GUARD_OPENAI_API_KEY="your_api_key"
# or:
export OPENAI_API_KEY="your_api_key"
dev-guard configure ai --provider openai --model gpt-4o-mini
dev-guard doctor
```

DevGuard checks `.devguard/config.json`, then `DEV_GUARD_OPENAI_API_KEY`, then `OPENAI_API_KEY`. It never prints the key or returns it from the dashboard API. If you store the key in `.devguard/config.json`, keep that file out of git.

## Agent Instruction Files

`dev-guard watch` creates DevGuard-managed `AGENTS.md` and `CLAUDE.md` instructions when those files are missing. It never overwrites user-managed files without a DevGuard marker. The advanced `dev-guard install-agent-instructions` command can be used for recovery.

The instructions tell agents to read:

- `.devguard/reports/read-map.md`
- `.devguard/reports/code-map.md`
- `.devguard/context/agent-brief.md`
- `.devguard/reports/working-context.md`

Then, when needed:

- `.devguard/reports/project-handoff.md`
- `.devguard/reports/quality-report.md`
- `.devguard/context/agent-context.md`
- `.devguard/project/project-knowledge.json`

This keeps new Codex / Claude sessions aligned with the latest dev-guard state before broad repository exploration.

## Context Pipeline

```text
Prepare
  -> Read Map
  -> Code Map
  -> Agent Brief
  -> Work
  -> Done
  -> Change Intelligence
  -> Quality Report
  -> Handoff
  -> Working Context
  -> Agent Context
  -> Memory Update
```

## Daily CLI Flow

```bash
dev-guard watch
# Codex/Claude edits files; verified hook/notify runs dev-guard done
dev-guard status
```

Keep `dev-guard watch` running in another terminal during the AI coding session when you want continuous change tracking. It starts the local dashboard automatically and observes changes; completion is handled by hooks/notify or by manual `dev-guard done`.

Manual fallback:

```bash
dev-guard watch --manual
dev-guard done
dev-guard status
```

Use `dev-guard done` in terminal-only workflows after you have reviewed the result and run the app. Dashboard users can use the Review Complete button instead.

Resume a new session:

```bash
dev-guard handoff
cat .devguard/reports/project-handoff.md
```

## Project Knowledge

DevGuard writes `.devguard/project/project-knowledge.json`, a static project structure file for AI sessions. It summarizes framework, package manager, entry points, pages, components, APIs, database hints, commands, important files, and architecture modules.

Regenerate it manually:

```bash
dev-guard knowledge
```

## Local Dashboard

The local dashboard starts automatically when `dev-guard watch` runs. It binds to `127.0.0.1` only, defaults to `http://127.0.0.1:3737`, and refreshes `/api/state` every second. The page explains what DevGuard is doing now, why it is waiting, what happens next, recent file changes, and whether next-session, project-health, and project-context information is ready.

The UI follows the project locale, then browser language, and includes an English/Korean language toggle. The toggle persists `.devguard/config.json` `locale`, so Quality Report and Project Handoff use the same language on the next generation.

The dashboard does not expose arbitrary file browsing, environment variables, or shell execution.

Use the dashboard for the normal review workflow: it recommends the next action based on quality state and session changes, shows the evidence behind each recommendation, opens the Quality Report, then lets you click Review Complete after validation. Use CLI commands for automation, terminal-only workflows, and recovery.

Advanced terminal-only mode:

```bash
dev-guard watch --no-dashboard
```

Advanced setup/recovery commands:

```bash
dev-guard init
dev-guard install-agent-instructions
dev-guard install-hooks
dev-guard dashboard
```

Normal users should not need these for first run.

Full documentation:

- Korean npm guide: https://github.com/projectbom/dev-guard/blob/main/docs/npm-setup.ko.md
- English npm guide: https://github.com/projectbom/dev-guard/blob/main/docs/npm-setup.md
- Repository README: https://github.com/projectbom/dev-guard
