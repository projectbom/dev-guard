# dev-guard

[English](./README.md) | [한국어](./README.ko.md)

dev-guard is an **AI Coding Context Provider**.

It is not an IDE, wrapper, or autonomous coding agent. Its job is narrower:

- before AI work: prepare the smallest useful context for the agent
- after AI work: preserve what changed, what was checked, and where the next agent should continue

DevGuard keeps this context in local `.devguard/` files so Codex/Claude work can resume without rediscovering the repository.

After installation, one command in your project is all it takes:

```bash
cd my-project
dev-guard watch   # first run prepares the project, then watches; Claude/Codex edit files
# for each task, the agent calls the DevGuard MCP tool prepare_task_context
```

No setup step and no OpenAI API key are needed; the context broker is deterministic.

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

## Verified Project State

DevGuard is not persistent AI memory. It is a local **verified project-state layer**: models plan and code; DevGuard records what actually happened, works out what is still valid, and hands the next agent the current verified state.

```text
small append-only structured events      .devguard/events/task-events.jsonl
        ↓ deterministic projection
current verified state                   .devguard/state/current.json (rebuildable cache)
        ↓
prepare_task_context `state` · Quality Report · Handoff · Dashboard
```

Every fact carries its provenance:

| Provenance | Meaning |
| --- | --- |
| `OBSERVED` | DevGuard saw it itself: the command and its exit code in the agent's own transcript (Codex rollout / Claude Code session), file fingerprints, its own self-check. |
| `AGENT_REPORTED` | An agent said so and DevGuard could not confirm it. Kept, never upgraded. |
| `USER_DECISION` | An explicit user decision carried through the agent (`record_user_decision`). Carried, not enforced. |
| `DERIVED` | Computed deterministically from other evidence (staleness, supersession, "resolve the blocker"). |

Task outcomes (`record_task_outcome`) distinguish `PASS`, `FAIL`, `STOPPED` (a designed safety gate stopped the run on purpose), `BLOCKED` (waiting on an external dependency or approval) and `UNKNOWN`. A deliberate stop is never shown as a failure.

Validation evidence is `CURRENT`, `STALE` (a file that supports it changed — only the files the task touched and the files the command names, so an unrelated change in a large dirty tree does not stale it) or `SUPERSEDED` (a later result for the same check, or a later outcome in the same continuation). An agent's PASS that the transcript contradicts is a `MISMATCH` and never counts as verified.

No vector database, no embeddings, no LLM and no network calls are involved; the state stays in `.devguard/`. Markdown reports are views of the projection, never its source. See [docs/verified-project-state.md](./docs/verified-project-state.md).

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
- `setup`, `watch`, `done`, `status`, `handoff`
- DevGuard MCP (`prepare_task_context`, `record_validation_result`, `record_task_outcome`, `record_user_decision`) — deterministic context broker, no API key
- Verified Project State: event ledger `.devguard/events/task-events.jsonl` → projection `.devguard/state/current.json`
- Code Index and Project Knowledge
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
- OpenAI-assisted Quality Report summary (optional, explicit opt-in)
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

Install the CLI (installing never scans or changes a project):

```bash
npm install -g @dev-guard/cli
```

Run it in your project:

```bash
cd my-project
dev-guard watch
```

The first `watch` prepares DevGuard automatically — creates the `.devguard/` config, indexes the project (Code Index), analyzes its structure (Project Knowledge), adds the DevGuard section to `AGENTS.md` / `CLAUDE.md`, registers the DevGuard MCP server for Claude Code and Codex, installs completion hooks best-effort — then opens the local dashboard and starts watching. Later runs find everything fresh and start immediately ("Project ready."); only missing or stale parts are refreshed.

In a Git repository, the first run also makes sure DevGuard's local state stays out of Git: it appends `.devguard/` and `devguard.backup-*/` to `.gitignore` (creating it if needed) unless Git already ignores them — existing lines are never changed or reordered. Project integration files (`AGENTS.md`, `CLAUDE.md`, `.mcp.json`, `.codex/config.toml`) are not ignored; commit or share them as you like. If `.devguard/` is already tracked, DevGuard warns and leaves the Git index alone (stop tracking it yourself with `git rm -r --cached .devguard`). Outside Git, no `.gitignore` is created.

DevGuard performs lightweight deterministic project discovery on first watch and reuses cached analysis on later runs. Inside git it lists files with `git ls-files`, so anything `.gitignore`d (local secrets, scratch folders, build output) is never analyzed; outside git it walks the tree. Content reads are budgeted and sampled across workspace packages, so large monorepos stay fast without losing packages. Validated on synthetic repositories up to 25K files (not a guarantee for every repository): first `watch` ready in about 1s at 25K files, and `prepare_task_context` around 0.4s at 10K files and 0.6s at 25K. The deep Code Index stays bounded (~1,200 representative files with symbols and tokens); for files outside it, `prepare_task_context` also ranks every project path by filename/path terms, reads only the few best matches for that call, and lets the normal ranking decide — nothing extra is written to the index. Project Knowledge keeps separate bounded lists for UI pages, Next.js API routes, and HTTP-framework handlers (Express, Fastify, Koa, Hono, …), records how many of each were found versus kept, and samples handler files where the framework dependency and route-shaped paths are.

Optional — `dev-guard setup` runs the same preparation without starting the watcher and prints a summary (useful for CI/scripts, inspecting what DevGuard detected, or `dev-guard setup --dry-run` to preview changes without writing). It is never required before `watch`.

Daily loop:

```bash
dev-guard watch
# work with an AI agent; for each new task the agent calls prepare_task_context
# DevGuard detects changes, waits for the filesystem to settle,
# then automatically generates reports and returns to monitoring
dev-guard status  # optional: check quality verdict
```

Advanced / recovery only: `dev-guard init` (only the `.devguard` config/templates, no project analysis), `dev-guard install-agent-instructions`, `dev-guard install-hooks` — `watch` already does all of this.

Developing this monorepo locally:

```bash
pnpm install
pnpm run build
pnpm cli status
```

For npm install/update, initial setup, optional AI setup, `AGENTS.md` / `CLAUDE.md` text, and ongoing CLI commands, see the [npm install and update guide](./docs/npm-setup.md).

## Optional AI (OpenAI)

DevGuard's product contract is API-keyless: `setup`, `init`, `watch`, `status`, `doctor`, the Code Index, Project Knowledge, MCP (`prepare_task_context`, `record_validation_result`), execution lineage, rollover advice, validation recording, `done`, Quality Report, Handoff, the dashboard, telemetry, and hooks all work without a key and make no OpenAI calls. The context broker is deterministic; no AI reranker runs in the default path.

AI is an explicit opt-in, used only by `task-ai`, `review` (without `--heuristic`) / `fix-prompt`, and an optional AI summary on the `done` Quality Report:

```bash
dev-guard configure ai --provider openai --model gpt-4o-mini
dev-guard config set openaiApiKey "your_api_key_here"
# or: export DEV_GUARD_OPENAI_API_KEY="your_api_key_here"
dev-guard doctor
```

Keys are read from `.devguard/config.json`, then `DEV_GUARD_OPENAI_API_KEY`, then `OPENAI_API_KEY`. A shell-wide `OPENAI_API_KEY` alone does not enable the `done` AI summary (it is often set for other tools); enable it with `ai.provider: "openai"` or `DEV_GUARD_OPENAI_API_KEY`. Without a key, `doctor` shows `OpenAI API: not configured (optional)`. DevGuard never prints the key or returns it from the dashboard API; if you store it in `.devguard/config.json`, keep that file out of git.

## Recommended Workflow

1. Start the watcher
   ```bash
   dev-guard watch
   ```
   On first run, this prepares `.devguard/`, the Code Index, Project Knowledge, AI instruction sections, MCP, completion hooks, and the local dashboard. On later runs, it starts immediately (only stale parts are refreshed). After filesystem inactivity (default: 20s settle + 8s grace), DevGuard **automatically** runs the equivalent of `done` — writing quality-report, next-codex-prompt, and project-handoff — then returns to monitoring. No additional commands required.

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

5. Next task / resume
   Give the agent the concrete task; it calls DevGuard MCP `prepare_task_context` and reads the returned ranges. Only to explicitly resume earlier work, or when MCP is unavailable:
   ```bash
   dev-guard handoff
   ```
   Regenerates `.devguard/reports/project-handoff.md`; turn its next action into a concrete task for `prepare_task_context`.

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

The local dashboard starts automatically when `dev-guard watch` runs. It binds to `127.0.0.1` only, defaults to `http://127.0.0.1:3737`, and polls `/api/overview` every two seconds. It shows the current task and context status — not a telemetry wall. The first screen answers five questions:

- **Now** — Health (is DevGuard set up, watching, and able to save its state?), Thread (Room to continue / Next large task: new thread / New thread recommended), the current task in one line, the single biggest context problem, and one recommended action.
- **This task** — at most five numbers: Context (the provider's observed usage only), Read plan (required / optional files), Suggestions used, Validation (recorded evidence), Files changed. Each is tagged observed, planned, inferred, or estimated.
- **Context flow** — one chart of where this task's context went (estimated from file sizes, shown as `~18K`, never as exact tokens).
- **Details** — collapsed: read plan, execution lineage, search activity, validation evidence, timeline, other issues, reports and prompts, setup and integration, project knowledge, raw telemetry.

Health is about DevGuard itself, never your project's build or tests. It shows **Needs attention** when watch is stopped or when DevGuard cannot write `.devguard/runtime.json` (for example "DevGuard cannot save state because the disk is full."); the state file is never corrupted, repeated failures are logged at most once a minute, and health returns to normal on the next successful write without restarting watch. It shows **Warning** when a user-level agent instruction file (`~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`) still contains an obsolete "read DevGuard markdown first" block; `prepare_task_context` returns the same warning to the agent. While that warning is active it is shown as the primary issue with the fix command (`dev-guard doctor --agents --fix`); the context issue it displaces stays in Details. The Dashboard only shows the command — it never edits the file itself.

The UI follows the browser language automatically and includes an English/Korean language toggle.

It does not expose arbitrary file browsing, environment variables, or shell execution. If DevGuard is not monitoring the project, it tells the user to run `dev-guard watch`.

The dashboard is the normal user workflow: it shows one next action (start watch, start a fresh thread, fix the primary issue, review the quality report, or keep going) and provides Review Complete when a blocked review is done. The CLI remains available for automation, terminal-only workflows, and recovery.

Advanced terminal-only mode:

```bash
dev-guard watch --no-dashboard
```

## Core Commands

```bash
dev-guard setup [--dry-run]   # optional: prepare/inspect without watching
dev-guard init                # advanced/recovery: .devguard config only, no analysis
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

Codex can require separate trust for the project and for each hook definition. If the Codex Stop Hook path is used, open Codex TUI in the repo and run `/hooks` to review/trust the dev-guard Stop Hook. Runtime verification is based on the small per-hook state files the hook scripts write under `.devguard/hook-state/` (shown by `dev-guard status`). The hook logs (`.devguard/logs/claude-hook.log`, `codex-hook.log`, `codex-notify.log`) are diagnostic only: each event is logged as a short summary (no raw payload, command output only on failure), and each log rotates at 2MB keeping 2 older generations (`.log.1`, `.log.2`). Set `DEV_GUARD_HOOK_DEBUG=1` to also log a bounded (4KB) raw payload and command output tail. Hook scripts generated by an older DevGuard are regenerated in place on the next `dev-guard watch`.

The Codex JSONL helper is not a Codex hook config. It is only for consuming `codex exec --json` event streams such as `turn.completed` and `turn.failed`.

## Usage Modes

### Auto Mode Recommended

```bash
dev-guard install-hooks
dev-guard watch
```

Auto Mode is the default recommendation only after a strategy is installed and runtime verified. Claude Code uses Stop Hook. Codex should prefer notify when the user-level Codex config is available; Codex Stop Hook is an advanced option requiring `/hooks` trust. `done` then writes `quality-report.md`, `next-codex-prompt.md`, and `project-handoff.md`.

Once a hook is **runtime verified** (not just installed), it becomes the completion signal and `watch` stops guessing from idle state — it only tracks files and observes whatever the hook finalizes. Before that point (hook installed but not yet verified, or no hook at all), `watch` finalizes itself after changes go quiet, so completion still works automatically with zero flags while you set the hook up. Finalization itself is idempotent either way: a hook firing again (or racing with a manual `dev-guard done`) with no new changes since the last completion is a no-op, not a repeated completion.

If `watch` appears to stay at `ready_for_done` with a verified hook installed, run `dev-guard status` to confirm whether pending files are already cleared, then check that the hook actually ran (`.devguard/reports/hook-status.md`) before falling back to a manual `dev-guard done`.

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

Do not wait for a long thread to be compacted, and do not paste long history into a new thread. The thread policy is hybrid: a small, closely related follow-up of the same work may stay in the current thread while thread pressure is low (`LOW`, or `UNKNOWN` with no compaction); a separate or large task, a `SOON` / `NEW_THREAD` notice, or a compacted thread means a fresh agent thread. Either way, call DevGuard MCP `prepare_task_context` with the concrete task — it returns the files/ranges to read, constraints, carried-over dirty work, and the previous task's unresolved validation. `record_validation_result` responses also report the current thread's observed pressure (when the provider records it) so an agent knows when to move on.

To explicitly resume earlier work (or when MCP is unavailable), regenerate and read the handoff:

```bash
dev-guard handoff
cat .devguard/reports/project-handoff.md
```

Turn its next action into a concrete task and call `prepare_task_context` with it in the new thread.

## Multi-Agent Workflow

### Recommended session handoff order

1. `dev-guard watch` — start the watcher
2. Claude/Codex edits files; Stop Hooks run `done` automatically (a Stop from a different thread than the one that prepared the task is ignored)
3. For the next task, call `prepare_task_context` with it (in a fresh agent thread when it is a separate or large task, or after a `SOON` / `NEW_THREAD` notice)
4. Read the TARGET ranges first

### When switching between Codex and Claude (or any agent)

Both read the same project section (`AGENTS.md` / `CLAUDE.md`), so the opening prompt is just the task. Only when MCP is unavailable:

```txt
Read .devguard/context/agent-brief.md, then .devguard/reports/read-map.md and .devguard/reports/code-map.md; continue from the targeted file ranges.
```

Read `.devguard/reports/project-handoff.md` / `.devguard/reports/quality-report.md` only when explicitly resuming or investigating QA.

### Generated agent context files

`dev-guard done` and `dev-guard handoff` produce:

- `.devguard/reports/working-context.md` — code structure map for AI agents to start from the right files
- `.devguard/context/agent-context.md` — agent rules and current operating constraints
- `.devguard/prompts/next-claude-prompt.md` — structured startup prompt for Claude sessions
- `.devguard/prompts/next-codex-prompt.md` — compact execution prompt for Codex sessions

### AGENTS.md and CLAUDE.md

`dev-guard watch` (and the optional `setup`) create `AGENTS.md` and `CLAUDE.md` when they are missing. When they already exist, DevGuard appends or refreshes only its own section between `<!-- dev-guard-section-start -->` and `<!-- dev-guard-section-end -->`; text outside the markers is never changed. The advanced `install-agent-instructions` command is for recovery or explicit updates.

```bash
dev-guard install-agent-instructions
# or to update an existing section:
dev-guard install-agent-instructions --force
```

These files are project-level guidance for:

- Claude Code (reads `CLAUDE.md` on startup)
- Codex (reads `AGENTS.md`)
- Other agents that honor project-level instruction files

User-level instruction files are yours: `watch`, `setup`, `prepare_task_context` and the Dashboard never edit `~/.codex/AGENTS.md` or `~/.claude/CLAUDE.md`. If one still contains an old "read `.devguard/reports/project-handoff.md` / `quality-report.md` / `next-codex-prompt.md` first" block, `dev-guard doctor --agents`, `prepare_task_context` warnings, and Dashboard health report it, because it makes agents pass stale handoff files instead of your real inputs. To remove it:

```bash
dev-guard doctor --agents                   # WARN with file + lines, or PASS
dev-guard doctor --agents --fix --dry-run   # preview: file, lines, the recognized block, what stays untouched
dev-guard doctor --agents --fix             # asks "Continue? [y/N]" (default No), backs up, removes only that block
```

The fix removes only text that matches a known obsolete DevGuard block; your other instructions, line endings and spacing are kept. It first writes a byte-identical backup next to the file (`AGENTS.md.devguard-backup-<timestamp>`, never overwriting an existing one) and does not touch the file if the backup fails. If any flagged line is not part of a recognized block, it refuses and lists the lines to review by hand. The warning clears on the next `prepare_task_context` call and Dashboard poll — no watch restart.

The files contain suggestions, not enforced rules. They tell agents to call `prepare_task_context` first and read its TARGET ranges before any repository-wide search, not to read `.devguard` markdown when MCP succeeds (Agent Brief → Read Map → Code Map are the no-MCP fallback; handoff / quality report only on explicit request), and the hybrid thread policy above.

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
- `watch`, `setup`, `prepare_task_context` and the Dashboard never edit user-level agent instruction files (`~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`); they only warn about obsolete DevGuard blocks. Only the explicit, confirmed `dev-guard doctor --agents --fix` removes such a block, after making a backup.
- The MCP server only serves the project it was started in (or a `projectRoot` inside it). A request for another project is rejected, never switched to; the error names the MCP root, the requested project, both git toplevels, and likely causes such as an empty or same-name sibling checkout opened as the workspace.

## Watch Notes

If your environment hits file descriptor limits:

```bash
dev-guard watch --poll
dev-guard watch --depth 4
```

Watch excludes common heavy/generated paths such as `node_modules`, `.git`, `.next`, `dist`, `build`, `coverage`, and dev-guard runtime report/prompt files.

## Artifact Lifecycle

| Class | Artifacts | Lifecycle |
| --- | --- | --- |
| Canonical current state | `.devguard/config.json`, `runtime.json`, `state.json`, `memory/code-index.json`, `project/project-knowledge.json`, `context/task-context.json`, `reports/quality-report-state.json`, `hook-state/*` | overwritten in place; one file each |
| Append-only history | `history.jsonl`, `memory/change-log.jsonl`, `telemetry.jsonl` | bounded: past 8 MB (telemetry 4 MB) the file is atomically renamed to `<file>.1` (one generation kept); readers merge both, so no record is lost under concurrent writers or a crash |
| Diagnostic logs | `logs/*.log` | rotated at 2 MB, 2 generations |
| Generated views (fallback / human) | `reports/*.md`, `prompts/*.md`, `context/agent-brief.md`, `context/agent-context.md` | singletons overwritten on every `done`; never read by agents when MCP succeeds |
| Legacy helper inputs | `.devguard/task.md`, `rules.md`, `mistakes.md`, `AI_CONTEXT.md` | used only by `check` / `review` / `prompt` / `infer-task` / `task-ai`; not read by MCP or `done` |
| Saved runs | `runs/*.json` | written only with `--save-run` |
| User/project files | `AGENTS.md`, `CLAUDE.md` (outside the markers), `.mcp.json` / `.codex/config.toml` (other entries), `docs/*`, source | never deleted; only DevGuard's own marked section / `dev-guard` entry is changed |

New projects no longer get `docs/PROJECT_STATE.md`, `docs/CURRENT_TASK.md`, `docs/DECISIONS.md`, or `docs/DO_NOT_REPEAT.md` templates: MCP and `done` do not read them. Existing copies are kept and still read by the legacy `prompt` / `review` / `task-ai` / `update` helpers. `dev-guard doctor` prints a storage summary.

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
