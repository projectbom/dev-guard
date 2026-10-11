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

Run these commands from the project root:

```bash
cd your-project
dev-guard init
dev-guard install-agent-instructions
dev-guard install-hooks
dev-guard status
```

Command roles:

- `init`: creates initial `.devguard/` files without overwriting existing files.
- `install-agent-instructions`: adds the DevGuard workflow section (MCP `prepare_task_context` first) to `AGENTS.md` and `CLAUDE.md`.
- `install-hooks`: installs Claude Code / Codex completion strategy files.
- `status`: checks pending changes, last work, quality verdict, and hook state.

On first run, `dev-guard watch` also registers the DevGuard MCP server for Claude Code (`.mcp.json`) and Codex (`.codex/config.toml`); `prepare_task_context` and `record_validation_result` come from it.

If hooks cannot be trusted or run yet, start in Manual Mode:

```bash
dev-guard watch --manual
# after the work is complete
dev-guard done
dev-guard status
```

## 3. GPT Setup

The default `watch`, `done`, `status`, and MCP flow works without GPT/API setup.
Configure a provider only for AI-assisted commands such as `review` and `task-ai`.

OpenAI provider setup:

```bash
export DEV_GUARD_OPENAI_API_KEY="your_api_key"
# or:
export OPENAI_API_KEY="your_api_key"
dev-guard configure ai --provider openai --model gpt-4o-mini
dev-guard doctor
```

Change only the model:

```bash
dev-guard config set model gpt-5
dev-guard config show
```

OpenAI API keys are optional. DevGuard checks `.devguard/config.json`, `DEV_GUARD_OPENAI_API_KEY`, then `OPENAI_API_KEY`. Environment variables are recommended for shared machines; if you store a key with `dev-guard config set openaiApiKey <key>`, keep `.devguard/config.json` out of git.

To disable the AI provider and use local heuristics only:

```bash
dev-guard configure ai --provider none --model gpt-4o-mini
```

## 4. AGENTS.md / CLAUDE.md Text

`dev-guard install-agent-instructions` writes a marked section (`<!-- dev-guard-section-start -->` … `<!-- dev-guard-section-end -->`) into `AGENTS.md` (Codex) and `CLAUDE.md` (Claude Code). Prefer the command over pasting by hand, so the text always matches the installed version. The section describes exactly one workflow:

- **MCP available:** for every new task, call `prepare_task_context` first → read the TARGET ranges → open a CANDIDATE only for a concrete gap → targeted search only for what neither covers. Do not also read `.devguard` markdown.
- **MCP unavailable:** fall back to `.devguard/context/agent-brief.md`, then `.devguard/reports/read-map.md`, then `.devguard/reports/code-map.md`.
- `project-handoff.md` / `quality-report.md` are read only on explicit request (resume previous work, QA investigation).
- Start each distinct task in a fresh agent thread; report checks with `record_validation_result`; finish with `dev-guard done` or the Stop hook.

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

Recommended daily flow:

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

Next task in a new Codex/Claude thread: give it the concrete task (and the files it must read). The agent calls `prepare_task_context`, reads the TARGET ranges of the returned read plan, and does not open `.devguard` markdown. When a task ends with a `SOON` / `NEW_THREAD` thread notice, start the next task in a fresh thread.

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

After an npm update, check each project once:

```bash
dev-guard --help
dev-guard status
dev-guard doctor --agents
dev-guard doctor --hooks --dry-run
dev-guard install-agent-instructions --force
```

If the updated version changed hook scripts, reinstall them in the relevant project:

```bash
dev-guard install-hooks
```

Use `--force` only when you intentionally need to refresh existing hook config:

```bash
dev-guard install-hooks --force
```
