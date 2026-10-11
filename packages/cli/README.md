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

```bash
npm install -g @dev-guard/cli   # installs the CLI only; no project is scanned
```

Recommended — from your project root, prepare once, then watch:

```bash
cd my-project
dev-guard setup
dev-guard watch
```

Zero-config — `watch` alone runs the same preparation when setup is missing or stale:

```bash
cd my-project
dev-guard watch
```

`dev-guard setup` creates the `.devguard/` configuration, builds the Code Index, generates Project Knowledge, adds the DevGuard section to `AGENTS.md` / `CLAUDE.md`, registers the DevGuard MCP server for Claude Code (`.mcp.json`) and Codex (`.codex/config.toml`), installs completion hooks best-effort, checks the MCP server, prints a summary, and exits. It is non-interactive, needs no API key, and is idempotent; `--dry-run` previews changes without writing. `watch` uses the same engine and then starts the dashboard and watcher.

Then work with your agent as usual. Each task runs through the MCP tool:

1. The agent calls `prepare_task_context` with the task (and any files you told it to read as `explicitInputs`).
2. It reads the returned **TARGET** ranges first, opens a **CANDIDATE** only for a concrete gap, and searches only for what neither covers.
3. It reports real build/test/manual checks with `record_validation_result`.
4. The Stop hook (or `dev-guard done`) closes the task.

Thread policy is hybrid: a small, closely related follow-up may continue in the same thread while thread pressure is low; a separate or large task, a `SOON` / `NEW_THREAD` notice, or a compacted thread moves to a fresh agent thread — DevGuard makes that start cheap instead of letting one long thread be compacted.

## How `prepare_task_context` Plans Reads

The result is one read plan (`readPlan`) with estimated sizes (characters / 4, never provider tokens):

- **Explicit inputs** — files the user named, passed as `explicitInputs`, become TARGETs first.
- **TARGET / CANDIDATE / REFERENCE** — read targets first; candidates only when targets leave a gap; references are background.
- **Ranges** — Markdown sections, JSON key blocks and top-level script functions instead of whole files; small files are one `WHOLE_FILE` read.
- **Execution lineage** — in the same workstream, the scripts the previous task ran, read and wrote (and, after a step that ran no script, those of the last step that did) are planned as candidates, within a bounded size budget.
- **Constraints and validation** — source-tagged constraints, carried-over dirty work, and unresolved validation from the previous task.

## Thread Pressure And Rollover

`record_validation_result` and the agent's own `dev-guard done` report the calling thread's state from the provider's own usage records: `LOW`, `SOON` (≥50% observed), `NEW_THREAD` (≥75% observed, or a compaction), or `UNKNOWN`. At a task boundary, a thread still under 50% can be raised to `SOON` when typical observed task growth would not fit. On `SOON` / `NEW_THREAD` the agent ends its final reply with a one-line notice recommending a fresh thread. DevGuard never estimates a context percentage it did not observe; Claude Code records no window size, so only compaction is observable there.

## Optional AI (OpenAI)

No API key is needed. `setup`, `watch`, `done`, `status`, `doctor`, MCP, reports, the dashboard, and hooks are deterministic and make no OpenAI calls; the context broker is deterministic. AI is an explicit opt-in used only by `task-ai`, `review` (without `--heuristic`) / `fix-prompt`, and an optional AI summary on the `done` Quality Report.

```bash
dev-guard configure ai --provider openai --model gpt-4o-mini
dev-guard config set openaiApiKey "your_api_key"
# or: export DEV_GUARD_OPENAI_API_KEY="your_api_key"
dev-guard doctor
```

DevGuard checks `.devguard/config.json`, then `DEV_GUARD_OPENAI_API_KEY`, then `OPENAI_API_KEY`. A shell-wide `OPENAI_API_KEY` alone does not enable the `done` AI summary. It never prints the key or returns it from the dashboard API. If you store the key in `.devguard/config.json`, keep that file out of git.

## Agent Instruction Files

`dev-guard setup` (and `watch`) create or refresh the DevGuard-managed section of `AGENTS.md` and `CLAUDE.md`; text outside the DevGuard markers is never changed. `dev-guard install-agent-instructions --force` refreshes the section. It describes one workflow:

- **MCP available (normal):** `prepare_task_context` first, then the returned ranges. Agents do not also read `.devguard` markdown.
- **MCP unavailable:** fall back to `.devguard/context/agent-brief.md`, then `.devguard/reports/read-map.md`, then `.devguard/reports/code-map.md`.
- `.devguard/reports/project-handoff.md` and `.devguard/reports/quality-report.md` are for explicit requests only — resuming earlier work, debugging DevGuard output, or a QA investigation.

DevGuard never edits user-level files such as `~/.codex/AGENTS.md`. If yours still has an older "read `project-handoff.md` / `quality-report.md` first" block, remove it by hand; `dev-guard doctor --agents` reports it.

## Daily CLI Flow

```bash
dev-guard watch
# Codex/Claude works through prepare_task_context; the Stop hook/notify runs dev-guard done
dev-guard status
```

Keep `dev-guard watch` running in another terminal during the AI coding session when you want continuous change tracking. It starts the local dashboard automatically; completion is handled by hooks/notify or by manual `dev-guard done`.

Manual fallback:

```bash
dev-guard watch --manual
dev-guard done
dev-guard status
```

Next task: give the agent the task — it calls `prepare_task_context` (in a fresh agent thread for a separate or large task, or after a `SOON` / `NEW_THREAD` notice). Only for manual recovery when MCP is unavailable, or to explicitly resume earlier work:

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

Advanced setup/recovery commands (normally `dev-guard setup` covers all of these):

```bash
dev-guard init                        # .devguard config/templates only, no project analysis
dev-guard install-agent-instructions
dev-guard install-hooks
dev-guard dashboard
```

Full documentation:

- Korean npm guide: https://github.com/projectbom/dev-guard/blob/main/docs/npm-setup.ko.md
- English npm guide: https://github.com/projectbom/dev-guard/blob/main/docs/npm-setup.md
- Repository README: https://github.com/projectbom/dev-guard
