# dev-guard CLI

`dev-guard` is a local CLI guardrail for Codex / Claude coding workflows. It watches project changes, processes completed work, and generates quality reports plus handoff prompts under `.devguard/`.

## Install Or Update

```bash
npm install -g @dev-guard/cli@latest
dev-guard --help
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
dev-guard status
```

## GPT Setup

The default `watch`, `done`, `status`, and `handoff` workflow does not require GPT/API setup. Configure an OpenAI provider only for AI-assisted commands such as `review`, `task-ai`, and `prompt`.

```bash
export OPENAI_API_KEY="your_api_key"
dev-guard configure ai --provider openai --model gpt-4o-mini
dev-guard config show
```

Do not store API keys in project files.

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

Full documentation:

- Korean npm guide: https://github.com/projectbom/dev-guard/blob/main/docs/npm-setup.ko.md
- English npm guide: https://github.com/projectbom/dev-guard/blob/main/docs/npm-setup.md
- Repository README: https://github.com/projectbom/dev-guard

