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
- `install-agent-instructions`: adds dev-guard startup guidance to `AGENTS.md` and `CLAUDE.md`.
- `install-hooks`: installs Claude Code / Codex completion strategy files.
- `status`: checks pending changes, last work, quality verdict, and hook state.

If hooks cannot be trusted or run yet, start in Manual Mode:

```bash
dev-guard watch --manual
# after the work is complete
dev-guard done
dev-guard status
```

## 3. GPT Setup

The default `watch`, `done`, `status`, and `handoff` flow works without GPT/API setup.
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

## 4. AGENTS.md Text

`dev-guard install-agent-instructions` adds this recommended section automatically. If you need to add it manually, paste this into `AGENTS.md`.

```md
<!-- dev-guard-section-start -->

## Agent Instructions

Before doing any work:

1. Read `.devguard/reports/working-context.md`
2. Read `.devguard/reports/project-handoff.md`
3. Read `.devguard/reports/quality-report.md`

Use dev-guard artifacts as the primary source of project context.
Do not perform repository-wide scans before reading them.
Start from the entry files and excluded areas in Working Context.
Only open additional files when required for the current task.
Continue from the latest dev-guard state.

<!-- dev-guard-section-end -->
```

To refresh an existing dev-guard section:

```bash
dev-guard install-agent-instructions --force
```

## 5. CLAUDE.md Text

Add the same startup guidance to `CLAUDE.md`.

```md
<!-- dev-guard-section-start -->

## Startup Instructions

Always read the latest dev-guard context before exploring the repository.

Required reading:

* `.devguard/context/agent-context.md`
* `.devguard/reports/working-context.md`
* `.devguard/reports/project-handoff.md`
* `.devguard/reports/quality-report.md`

Avoid repository-wide scans unless the dev-guard context is insufficient.
Start from the Working Context entry files and excluded areas.
Prefer continuing from dev-guard context rather than rediscovering project state.

<!-- dev-guard-section-end -->
```

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

Resume in a new Codex/Claude session:

```bash
dev-guard handoff
cat .devguard/reports/project-handoff.md
```

First prompt for the new session:

```txt
Read .devguard/context/agent-context.md and continue.
```

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
