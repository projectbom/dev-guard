# dev-guard

[English](./README.md) | [한국어](./README.ko.md)

dev-guard is an **AI Coding Context Provider**.

It is not an IDE, wrapper, or autonomous coding agent. Its job is narrower:

- before AI work: prepare the smallest useful context for the agent
- after AI work: preserve what changed, what was checked, and where the next agent should continue

DevGuard keeps this context in local `.devguard/` files so Codex/Claude work can resume without rediscovering the repository.

The default workflow requires only one command after installation:

```bash
dev-guard watch
# let Claude/Codex edit files
# DevGuard automatically finalizes after changes settle — no done required
# if a session overflows, start a new thread with:
dev-guard handoff
```

Use it when an AI coding session spans multiple prompts, multiple agents, or a context window reset.

## Product Boundary

DevGuard provides context around an AI coding agent. It does not replace the agent.

```text
Before AI
  -> Prepare Context
  -> Read Map / Code Map / Agent Brief

AI Work
  -> Claude / Codex / GPT edits code

After AI
  -> Preserve Context
  -> Quality Report / Handoff / Working Context / Memory
```

DevGuard does not implement a vector database, background full-project indexer, cloud sync, IDE integration, or automatic code interception. Those are roadmap-level ideas, not part of the current product.

## Context Pipeline

The official DevGuard pipeline is:

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

One Change Intelligence summary is generated after `done`; downstream documents reuse it instead of creating competing summaries.

## Artifact Roles

| Artifact | Role |
| --- | --- |
| Project Knowledge | Long-term project structure memory. |
| Read Map | What the next agent should read first. |
| Code Map | Where to read inside the relevant files. |
| Agent Brief | Compact summary for the next coding agent. |
| Quality Report | QA result and remaining verification. |
| Project Handoff | Next-session work instruction. |
| Working Context | Current work structure and boundaries. |
| Agent Context | Agent rules and current operating constraints. |
| Next Prompt | Ready-to-paste execution prompt for a new AI session. |
| Dashboard | Human overview of status and next action. |

## Feature Classification

**Core**

- `.devguard/` local context store
- `watch`, `done`, `status`, `handoff`
- Project Knowledge
- Read Map, Code Map, Agent Brief
- Change Intelligence
- Quality Report
- Project Handoff
- Working Context and Agent Context
- memory files: `.devguard/memory/code-index.json`, `.devguard/memory/change-log.jsonl`

**Keep**

- Dashboard
- `install-agent-instructions`
- `install-hooks`
- `knowledge`
- OpenAI-assisted Quality Report summary
- `self-check`, `doctor`
- locale-aware user-facing reports

**Experimental**

- `scan`, `refresh`
- `review`, `task-ai`, natural-language task helpers
- `update --write`
- Codex JSONL listener helper
- advanced hook/notify strategies beyond the default watch flow

## Problem

AI coding agents often finish a task without preserving enough context for the next step. Teams then paste long chat logs into the next Codex/Claude session, miss drift risks, or forget why a file changed.

dev-guard keeps this workflow local and explicit:

- watch file changes while an AI agent works
- automatically finalize after the filesystem settles — no manual commands needed
- keep `done` available as a manual recovery command for crashes and debugging
- keep append-only history
- produce quality verdicts and handoff prompts
- avoid automatic source edits or document writes

Common use cases:

- Continue a Codex/Claude task after context overflow.
- Hand off from one agent session to another with current project state.
- Keep a compact local history of what changed and what should be checked next.
- Generate a next-session prompt from the current task, rules, docs, and git diff.

## Quick Start

Install the CLI:

```bash
npm install -g @dev-guard/cli
```

Start using it in a project:

```bash
cd my-project
dev-guard watch
```

On first launch, `watch` automatically prepares the project, creates default `.devguard/` configuration, installs DevGuard-managed AI instruction files when safe, installs completion hooks best-effort, generates Project Knowledge, starts the dashboard, and opens the browser.

Daily loop:

```bash
dev-guard watch
# work with an AI agent
# DevGuard detects changes, waits for filesystem to settle,
# then automatically generates reports and returns to monitoring
dev-guard status  # optional: check quality verdict
```

Resume a new session:

```bash
dev-guard handoff
cat .devguard/reports/project-handoff.md
```

Developing this monorepo locally:

```bash
pnpm install
pnpm run build
pnpm cli status
```

For npm install/update, initial setup, GPT setup, `AGENTS.md` / `CLAUDE.md` text, and ongoing CLI commands, see the [npm install and update guide](./docs/npm-setup.md).

## OpenAI GPT Setup

Most DevGuard session-continuity commands work without an API key: `init`, `watch`, `done`, `status`, `handoff`, and local heuristic checks. Without a key, Quality Reports use local rule-based guidance. With a key, `done` can add an OpenAI-assisted Quality Report summary.

DevGuard reads OpenAI API keys in this order:

1. `.devguard/config.json` (`dev-guard config set openaiApiKey <key>` or Dashboard settings)
2. `DEV_GUARD_OPENAI_API_KEY`
3. `OPENAI_API_KEY`
4. no key, local rule-based fallback

```bash
dev-guard config set openaiApiKey "your_api_key_here"
# or:
export DEV_GUARD_OPENAI_API_KEY="your_api_key_here"
# or:
export OPENAI_API_KEY="your_api_key_here"
```

Configure the provider/model when you want AI-backed commands:

```bash
dev-guard configure ai --provider openai --model gpt-4o-mini
dev-guard doctor
```

DevGuard does not print the key or return it from the dashboard API. If you store the key in `.devguard/config.json`, keep that file out of git.

## Recommended Workflow

1. Start the watcher
   ```bash
   dev-guard watch
   ```
   On first run, this prepares `.devguard/`, safe AI instruction files, completion hooks, Project Knowledge, and the local dashboard. On later runs, it starts immediately. After filesystem inactivity (default: 20s settle + 8s grace), DevGuard **automatically** runs the equivalent of `done` — writing quality-report, next-codex-prompt, and project-handoff — then returns to monitoring. No additional commands required.

2. Optional advanced recovery: reinstall agent completion hooks
   ```bash
   dev-guard install-hooks
   ```
   Normal users do not need this. `watch` installs available completion strategy files automatically when missing. Run this manually only for recovery or troubleshooting.

3. Manual fallback when automatic completion is unavailable
   ```bash
   dev-guard watch --manual
   dev-guard done
   ```
   `--manual` or `--no-auto-complete` disables auto-finalization. Use the dashboard Review Complete button when reviewing in the browser. In terminal-only workflows, run `dev-guard done` after review is complete to close the current session and regenerate reports. Also use `done` for recovery when watch crashed or hooks failed.

4. Check status
   ```bash
   dev-guard status
   ```
   Shows pending changes, last run summary, quality verdict, recent history, hook state, the handoff path, and the next recommended action.

5. Resume after context overflow
   ```bash
   dev-guard handoff
   ```
   Regenerates `.devguard/reports/project-handoff.md` from current `.devguard/` artifacts only. Start a new Claude/Codex thread and ask it to read that file.

6. Reset only runtime state when needed
   ```bash
   dev-guard reset
   ```
   Clears the pending watch buffer. It does not delete history or project state.

## Watch Mode In Practice

Run `watch` at the start of an AI coding session:

```bash
dev-guard watch
```

Keep it running in a separate terminal while Codex/Claude edits files. `watch` starts the local dashboard automatically, observes file changes, and keeps the pending file buffer current.

**Automatic finalization flow:**

1. File changes are detected.
2. Filesystem settles (no new changes for 20s by default).
3. After an 8-second grace period, DevGuard auto-finalizes the session.
4. Quality report, next-session prompt, and project handoff are generated.
5. `watch` returns to monitoring — no user action required.

If you edit during the grace period, the timer resets and the cycle starts again.

After finalization, DevGuard writes quality and handoff artifacts:
- `.devguard/reports/quality-report.md`
- `.devguard/reports/project-handoff.md`
- `.devguard/reports/read-map.md`
- `.devguard/reports/code-map.md`
- `.devguard/context/agent-brief.md`
- `.devguard/prompts/next-codex-prompt.md`

User-facing artifacts such as the dashboard, quality report, and project handoff follow the detected locale. DevGuard checks `.devguard/config.json` `locale`, then OS locale (`LANG`, `LC_ALL`, `LC_MESSAGES`), then falls back to `en-US`. The dashboard language toggle writes the same project locale setting. AI-facing artifacts such as `next-codex-prompt.md` stay in English.

Use those files to continue in the next session without rediscovering the repository.

### `dev-guard done` — manual recovery only

`done` is no longer needed in the normal workflow. Use it only when:

- `watch` crashed or was interrupted
- Hooks failed to fire
- You need to manually trigger finalization for debugging

```bash
dev-guard done
```

### Tuning auto-finalization

```bash
# Custom grace period (default: 8s)
dev-guard watch --auto-complete-delay 15

# Disable auto-finalization entirely (manual mode)
dev-guard watch --manual
# or:
dev-guard watch --no-auto-complete
```

## Project Knowledge

DevGuard generates `.devguard/project/project-knowledge.json` as a static project structure file for AI sessions. It is not a search index or semantic code index. It summarizes framework, package manager, entry points, pages, components, APIs, database hints, commands, important files, and architecture modules so agents can understand the project before broad repository exploration.

The file is refreshed after session completion and can be regenerated manually:

```bash
dev-guard knowledge
```

Generated `AGENTS.md` and `CLAUDE.md` instructions tell agents to start with Read Map, Code Map, Agent Brief, and Working Context before opening source files broadly.

## Local Dashboard

The local dashboard starts automatically when `dev-guard watch` runs. It binds to `127.0.0.1` only, defaults to `http://127.0.0.1:3737`, and polls `/api/state` once per second. It explains what DevGuard is doing now, why it is waiting, what happens next, recent file changes, and whether next-session, project-health, and project-context information is ready.

The UI follows the browser language automatically and includes an English/Korean language toggle.

It does not expose arbitrary file browsing, environment variables, or shell execution. If DevGuard is not monitoring the project, it tells the user to run `dev-guard watch`.

The dashboard is the normal user workflow: it recommends the next action based on quality state and session changes, shows the evidence behind each recommendation, and provides Review Complete when review is done. The CLI remains available for automation, terminal-only workflows, and recovery.

Advanced terminal-only mode:

```bash
dev-guard watch --no-dashboard
```

## Core Commands

```bash
dev-guard init
dev-guard install-hooks [--force]
dev-guard install-hooks --agent claude
dev-guard install-hooks --agent codex
dev-guard install-hooks --agent codex-notify
dev-guard install-hooks --agent codex-notify --install-dispatcher
dev-guard install-hooks --agent all
dev-guard watch [--depth 8] [--poll] [--stable-after 20]
dev-guard watch --no-dashboard
dev-guard watch --manual
dev-guard knowledge
dev-guard dashboard [--port 3737]
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
  memory/
    code-index.json
    change-log.jsonl
  context/
    agent-brief.md
    agent-context.md
  prompts/
    next-codex-prompt.md
    next-claude-prompt.md
  reports/
    last-run.md
    history-summary.md
    decision-candidates.md
    quality-report.md
    project-handoff.md
    read-map.md
    code-map.md
    working-context.md
```

The same `.devguard/` directory also stores guard config and task files.

Generated runtime/cache files are local-only by default and should not be committed unless a project intentionally changes its tracking policy. See [docs/configuration.md](./docs/configuration.md).

## Handoff Flow

`dev-guard done` creates:

- `.devguard/reports/last-run.md`: current completed-work report
- `.devguard/history.jsonl`: append-only run history
- `.devguard/reports/history-summary.md`: recent 5-run summary
- `.devguard/reports/decision-candidates.md`: decisions worth manually recording
- `.devguard/memory/code-index.json`: local code range index without source code
- `.devguard/memory/change-log.jsonl`: compact session change history
- `.devguard/reports/read-map.md`: what to read first
- `.devguard/reports/code-map.md`: where to read inside changed files
- `.devguard/context/agent-brief.md`: compact before-agent brief
- `.devguard/reports/quality-report.md`: QA result and remaining verification
- `.devguard/reports/project-handoff.md`: next-session work instruction
- `.devguard/reports/working-context.md`: current work structure and boundaries
- `.devguard/context/agent-context.md`: agent rules and current constraints
- `.devguard/prompts/next-codex-prompt.md`: ready-to-paste Codex prompt

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
- .devguard/reports/read-map.md
- .devguard/reports/code-map.md
- .devguard/context/agent-brief.md
```

Read more in [docs/handoff.md](./docs/handoff.md).

## Agent Completion Strategies

dev-guard does not treat Claude Code and Codex as the same runtime.

- Claude Code: Stop Hook through `.claude/settings.json` and `.devguard/hooks/claude-stop.sh`
- Codex recommended: `notify` in user-level `~/.codex/config.toml` calling `.devguard/hooks/codex-notify.sh`
- Codex advanced: Stop Hook through `.codex/hooks.json` and `.devguard/hooks/codex-stop.sh`; requires `/hooks` trust
- Optional JSONL helper: `.devguard/hooks/codex-event-listener.ts`

Codex notify is user-level configuration. Official Codex config ignores `notify` in project-local `.codex/config.toml`, so `dev-guard install-hooks --agent codex-notify` creates the notify script and inspects the user config without overwriting it.

Codex currently has a single user-level `notify` command. If an existing notify is present, for example the Codex Computer Use `turn-ended` notifier, dev-guard preserves it through a dispatcher:

```bash
dev-guard install-hooks --agent codex-notify --install-dispatcher
```

This writes `~/.codex/dev-guard-notify-dispatcher.sh`, backs up `~/.codex/config.toml` to `~/.codex/config.toml.devguard-backup-YYYYMMDD-HHmmss`, and changes `notify` to the dispatcher. The dispatcher runs the original notify command and then runs `.devguard/hooks/codex-notify.sh` when the current project has one. Failures are isolated so one notify target does not block the other.

To uninstall the dispatcher, restore the backup:

```bash
cp ~/.codex/config.toml.devguard-backup-YYYYMMDD-HHmmss ~/.codex/config.toml
```

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

If `watch` appears to stay at `ready_for_done`, run `dev-guard status` to confirm whether pending files are already cleared. The watcher observes external `done` results but never triggers `done` by itself.

### Manual Mode Fallback

```bash
dev-guard watch --manual
dev-guard done
```

Use Manual Mode when hooks are unavailable, untrusted, or failed. `watch` only accumulates pending changes. After you review the result and run the app, use `dev-guard done` to close the current session and regenerate quality/handoff files.

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

In the new thread, attach or ask the agent to read `.devguard/reports/project-handoff.md`. It is a compact resume organized around `Goal`, `Outstanding`, `Quality`, `Next`, `Changed`, `History`, and `Project` so the next agent can continue without reading a long chat history.

## Multi-Agent Workflow

`dev-guard done` (or Auto Mode) generates context files for new agent sessions. Start with the Before-AI files, then read the after-work files only when needed.

### Recommended session handoff order

1. `dev-guard watch` — start the watcher
2. Claude/Codex edits files; Stop Hooks run `done` automatically
3. `dev-guard done` — generates Read Map, Code Map, Agent Brief, QA, handoff, context, and memory artifacts
4. Start a new agent session
5. Read `.devguard/reports/read-map.md`, `.devguard/reports/code-map.md`, and `.devguard/context/agent-brief.md`

### When switching between Codex and Claude (or any agent)

Paste this as the opening prompt in the new session:

```txt
Read .devguard/reports/read-map.md, .devguard/reports/code-map.md, and .devguard/context/agent-brief.md; then continue from the targeted file ranges.
```

For the full next-session instruction, also read `.devguard/reports/project-handoff.md`. For QA state, read `.devguard/reports/quality-report.md`.

### Generated agent context files

`dev-guard done` and `dev-guard handoff` produce:

- `.devguard/reports/working-context.md` — code structure map for AI agents to start from the right files
- `.devguard/context/agent-context.md` — agent rules and current operating constraints
- `.devguard/prompts/next-claude-prompt.md` — structured startup prompt for Claude sessions
- `.devguard/prompts/next-codex-prompt.md` — compact execution prompt for Codex sessions

### AGENTS.md and CLAUDE.md

`dev-guard watch` creates DevGuard-managed `AGENTS.md` and `CLAUDE.md` files automatically when they are missing. If those files already exist without DevGuard markers, DevGuard treats them as user-managed and leaves them unchanged. The advanced `install-agent-instructions` command is for recovery or explicit updates.

```bash
dev-guard install-agent-instructions
# or to update an existing section:
dev-guard install-agent-instructions --force
```

These files are project-level guidance for:

- Claude Code (reads `CLAUDE.md` on startup)
- Codex (reads `AGENTS.md`)
- Other agents that honor project-level instruction files

The files contain suggestions, not enforced rules. They recommend reading Read Map, Code Map, Agent Brief, and Working Context before repository-wide scans so agents can start from the right ranges and avoid rebuilding context. Existing content is preserved; dev-guard only appends or updates its own section (marked with HTML comment markers).

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
- API keys are never printed. If stored in `.devguard/config.json`, that file must stay out of git.

## Watch Notes

If your environment hits file descriptor limits:

```bash
dev-guard watch --poll
dev-guard watch --depth 4
```

Watch excludes common heavy/generated paths such as `node_modules`, `.git`, `.next`, `dist`, `build`, `coverage`, and dev-guard runtime report/prompt files.

## AI Provider Setup

The event-based workflow works without an AI provider. Configure one only for OpenAI-assisted Quality Report summaries or advanced task/review flows:

```bash
dev-guard configure ai --provider openai --model gpt-4o-mini
dev-guard config set openaiApiKey "your_api_key"
# or:
export OPENAI_API_KEY="your_api_key"
```

If you store a key in `.devguard/config.json`, keep that file out of git.

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

- [npm install and update guide](./docs/npm-setup.md)
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
