# npm Install And Update Guide

[English](./npm-setup.md) | [한국어](./npm-setup.ko.md)

This guide covers the full path from installing or updating `dev-guard` through npm to using it in a project.

## 1. Install Or Update With npm

New install:

```bash
npm install -g @dev-guard/cli
dev-guard --help
dev-guard doctor
```

Update an existing global install to the latest npm release:

```bash
npm install -g @dev-guard/cli@latest
dev-guard --help
dev-guard doctor
```

If your team avoids global installs, run it on demand:

```bash
npx @dev-guard/cli --help
```

## 2. Initial Project Setup

Recommended — run once from the project root, then start watching:

```bash
cd your-project
dev-guard setup
dev-guard watch
```

Zero-config — `watch` alone runs the same preparation when setup is missing or stale:

```bash
cd your-project
dev-guard watch
```

`dev-guard setup` is deterministic and non-interactive (no prompts, no API key, no network). It:

1. validates the project root (refuses your home directory or `/`)
2. creates `.devguard/` config files that are missing (existing files are kept)
3. builds the Code Index (`.devguard/memory/code-index.json`)
4. generates Project Knowledge (`.devguard/project/project-knowledge.json`)
5. adds/refreshes the DevGuard section of `AGENTS.md` and `CLAUDE.md` (text outside the markers is kept)
6. registers the DevGuard MCP server for Claude Code (`.mcp.json`) and Codex (`.codex/config.toml`) — other servers are kept
7. installs completion hooks best-effort
8. checks that the MCP server starts and lists `prepare_task_context`
9. prints a summary (package manager, framework, commands, integrations, AI status) and exits

It does not start the watcher or the dashboard. Running it again only refreshes missing or stale parts (Project Knowledge is regenerated only when `package.json`, lockfiles, or framework config are newer than it). `dev-guard setup --dry-run` prints what would be created/updated without writing anything.

`npm install -g` itself never scans or changes a project — it does not know which project you mean.

Git: setup, the Code Index, Project Knowledge, and MCP context work without git; `done` needs git to detect changed files.

Advanced / recovery (normally not needed — setup and watch do all of this):

```bash
dev-guard init                        # only the .devguard config/templates, no project analysis
dev-guard install-agent-instructions  # only the AGENTS.md / CLAUDE.md section
dev-guard install-hooks               # only the completion hooks
```

If hooks cannot be trusted or run yet, start in Manual Mode:

```bash
dev-guard watch --manual
# after the work is complete
dev-guard done
dev-guard status
```

## 3. Optional AI (OpenAI)

No API key is needed. `setup`, `init`, `watch`, `status`, `doctor`, the Code Index, Project Knowledge, MCP (`prepare_task_context`, `record_validation_result`), validation recording, `done`, reports, the dashboard, telemetry, and hooks are fully deterministic and make no OpenAI calls. The context broker is deterministic; there is no AI reranker in the default path.

AI is an explicit opt-in. Only these use OpenAI (`scan --ai` / `refresh --ai` are reserved flags and stay rule-based):

- `dev-guard task-ai` — natural-language task generation
- `dev-guard review` (without `--heuristic`) and `dev-guard fix-prompt` — AI review
- the optional AI summary added to the Quality Report on `done` — only after you opt in

Opt in:

```bash
dev-guard configure ai --provider openai --model gpt-4o-mini
dev-guard config set openaiApiKey "your_api_key"   # or: export DEV_GUARD_OPENAI_API_KEY=...
dev-guard doctor
```

Keys are read from `.devguard/config.json`, `DEV_GUARD_OPENAI_API_KEY`, then `OPENAI_API_KEY`. A shell-wide `OPENAI_API_KEY` alone does not turn on the `done` AI summary — set `ai.provider` to `openai` or use `DEV_GUARD_OPENAI_API_KEY` for that. If you store a key in `.devguard/config.json`, keep that file out of git.

Without a key, `doctor` shows `OpenAI API: not configured (optional)`, and AI-only commands stop with: "OpenAI API is optional — DevGuard's core workflow does not need it. This command requires AI assistance."

Change only the model, or turn AI off again:

```bash
dev-guard config set model gpt-5
dev-guard configure ai --provider none --model gpt-4o-mini
```

## 4. AGENTS.md / CLAUDE.md Text

`dev-guard install-agent-instructions` writes a marked section (`<!-- dev-guard-section-start -->` … `<!-- dev-guard-section-end -->`) into `AGENTS.md` (Codex) and `CLAUDE.md` (Claude Code). Prefer the command over pasting by hand, so the text always matches the installed version. The section describes exactly one workflow:

- **MCP available:** for every new task, call `prepare_task_context` first → read the TARGET ranges → open a CANDIDATE only for a concrete gap → targeted search only for what neither covers. Do not also read `.devguard` markdown.
- **MCP unavailable:** fall back to `.devguard/context/agent-brief.md`, then `.devguard/reports/read-map.md`, then `.devguard/reports/code-map.md`.
- `project-handoff.md` / `quality-report.md` are read only on explicit request (resume previous work, QA investigation).
- Thread policy is hybrid: a small, closely related follow-up may continue in the same thread while thread pressure is low; a separate or large task, a `SOON` / `NEW_THREAD` notice, or a compacted thread means a fresh agent thread. Report checks with `record_validation_result`; finish with `dev-guard done` or the Stop hook.

To refresh an existing dev-guard section:

```bash
dev-guard install-agent-instructions --force
```

## 5. Global Agent Instructions

DevGuard never writes user-level instruction files such as `~/.codex/AGENTS.md` or `~/.claude/CLAUDE.md`. Older DevGuard guides suggested pasting a "Read `project-handoff.md` / `quality-report.md` first" block there; that block now contradicts the project section above (MCP first, no markdown reads). If your global file still contains it, remove that block by hand — `dev-guard doctor --agents` reports it when present.

## 6. Verify Codex / Claude Hooks

Inspect installed strategy state:

```bash
dev-guard doctor --agents
dev-guard doctor --hooks --dry-run
```

Run hook scripts directly:

```bash
dev-guard doctor --hooks
```

Note: `doctor --hooks` can run `dev-guard done` and `dev-guard status`.

For Codex, the recommended path is user-level `notify` in `~/.codex/config.toml`.

```bash
dev-guard install-hooks --agent codex-notify
```

If another Codex `notify` already exists, preserve it through the dispatcher:

```bash
dev-guard install-hooks --agent codex-notify --install-dispatcher
```

If you use the advanced Codex Stop Hook path, open `/hooks` in the Codex TUI and review/trust the dev-guard hook.

## 7. Ongoing CLI Flow

Recommended daily flow (after a one-time `dev-guard setup`):

```bash
dev-guard watch
# Codex/Claude edits files
# verified hook/notify runs dev-guard done
dev-guard status
```

When hooks fail or are not trusted yet:

```bash
dev-guard watch --manual
# after the work is complete
dev-guard done
dev-guard status
```

Next task: give the agent the concrete task (and the files it must read). The agent calls `prepare_task_context`, reads the TARGET ranges of the returned read plan, and does not open `.devguard` markdown. A small follow-up of the same work can stay in the current thread; start a separate or large task — or any task after a `SOON` / `NEW_THREAD` notice or a compaction — in a fresh thread.

Manual recovery only — MCP unavailable, explicitly resuming earlier work, or debugging DevGuard output:

```bash
dev-guard handoff
cat .devguard/reports/project-handoff.md
```

Without MCP, point the agent at `.devguard/context/agent-brief.md`, then `.devguard/reports/read-map.md` and `.devguard/reports/code-map.md`.

Diagnostics:

```bash
dev-guard status
dev-guard doctor --agents
dev-guard doctor --hooks --dry-run
```

Clear only the pending watch buffer:

```bash
dev-guard reset
```

## 8. Post-Update Checklist

After an npm update, check each project once (`setup` refreshes the managed instruction section, MCP entry, and outdated hook scripts in place):

```bash
dev-guard setup
dev-guard status
dev-guard doctor --agents
dev-guard doctor --hooks --dry-run
```

If the updated version changed hook scripts, reinstall them in the relevant project:

```bash
dev-guard install-hooks
```

Use `--force` only when you intentionally need to refresh existing hook config:

```bash
dev-guard install-hooks --force
```
