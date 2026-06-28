# dev-guard CLI

`dev-guard` is a CLI context guard for Codex / Claude coding sessions. It keeps project context, changed files, quality checks, and next-session handoff prompts under `.devguard/`.

## Install Or Update

```bash
npm install -g @dev-guard/cli@latest
dev-guard --help
dev-guard doctor
```

Run without a global install:

```bash
npx @dev-guard/cli --help
```

## Initial Setup

Run from your project root:

```bash
dev-guard init
dev-guard install-agent-instructions
dev-guard install-hooks
dev-guard watch
dev-guard status
```

## GPT Setup

The default `watch`, `done`, `status`, and `handoff` workflow does not require GPT/API setup. Configure an OpenAI provider only for AI-assisted commands such as `review` and `task-ai`.

```bash
export DEV_GUARD_OPENAI_API_KEY="your_api_key"
# or:
export OPENAI_API_KEY="your_api_key"
dev-guard configure ai --provider openai --model gpt-4o-mini
dev-guard doctor
```

Do not store API keys in project files, `.env`, markdown, or git-tracked secret files.

## Agent Instruction Files

`dev-guard install-agent-instructions` creates or updates `AGENTS.md` and `CLAUDE.md` with instructions to read:

- `.devguard/context/agent-context.md`
- `.devguard/reports/project-handoff.md`
- `.devguard/reports/quality-report.md`

This keeps new Codex / Claude sessions aligned with the latest dev-guard state before broad repository exploration.

## Daily CLI Flow

```bash
dev-guard watch
# Codex/Claude edits files; verified hook/notify runs dev-guard done
dev-guard status
```

Keep `dev-guard watch` running in another terminal during the AI coding session when you want continuous change tracking. It observes changes; completion is handled by hooks/notify or by manual `dev-guard done`.

Manual fallback:

```bash
dev-guard watch --manual
dev-guard done
dev-guard status
```

Resume a new session:

```bash
dev-guard handoff
cat .devguard/reports/project-handoff.md
```

## Local Dashboard

Run the optional dashboard when you want a browser view of the current DevGuard watch/status state:

```bash
dev-guard watch
dev-guard dashboard --open
```

It binds to `127.0.0.1` only, defaults to `http://127.0.0.1:3737`, and refreshes `/api/state` every second. The page shows status, stage, waiting reason, next transition, watch elapsed time, last activity, idle countdown, recent files, and whether the handoff, quality, and agent-context reports exist.

The dashboard does not expose arbitrary file browsing, environment variables, or shell execution.

Full documentation:

- Korean npm guide: https://github.com/projectbom/dev-guard/blob/main/docs/npm-setup.ko.md
- English npm guide: https://github.com/projectbom/dev-guard/blob/main/docs/npm-setup.md
- Repository README: https://github.com/projectbom/dev-guard
