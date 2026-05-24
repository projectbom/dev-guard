# dev-guard

[English](./README.md) | [한국어](./README.ko.md)

dev-guard is an Alpha CLI guardrail for AI-assisted coding workflows. It helps you turn a natural-language task into a compact Codex prompt, then checks whether the resulting git changes stayed inside the requested scope.

It is designed for teams that want a lightweight loop:

```bash
dev-guard init
dev-guard status
dev-guard "Fix loading flicker"
dev-guard done
```

dev-guard supports Korean and English natural-language requirements. The public CLI/docs are English-first, and a Korean guide is available in [README.ko.md](./README.ko.md).

## What It Does

- Creates project-local guard files under `.devguard/`.
- Detects project type, package manager, runtime, git baseline, and pending changes.
- Builds lightweight project memory, including import/reverse-dependency impact hints.
- Generates compact Codex-ready prompts from your current requirement.
- Runs local heuristic checks and review without requiring an API provider.
- Optionally uses an AI provider for richer task generation and review.
- Keeps docs updates safe: `update` previews, and only `update --write` modifies managed blocks.

## Install

For local development:

```bash
pnpm install
pnpm run build
```

Link the CLI locally:

```bash
cd packages/cli
pnpm build
pnpm link --global
dev-guard --help
```

## Quick Start

The basic loop should be understandable in under a minute:

```bash
dev-guard init
dev-guard status
dev-guard "Fix loading flicker"
# paste the generated prompt into Codex, then let Codex edit files
dev-guard done
```

If you are running inside this monorepo before linking:

```bash
pnpm cli init
pnpm cli status
pnpm cli "Fix loading flicker"
pnpm cli done
```

## Recommended Workflow

1. Initialize the project
   - command:
     ```bash
     dev-guard init
     ```
   - purpose:
     Create `.devguard` and docs guard files without overwriting existing content.

2. Check current status
   - command:
     ```bash
     dev-guard status
     ```
   - purpose:
     Confirm provider/model, API key state, git baseline, project detection, pending changes, and the next recommended action.

3. Generate a task prompt
   - command:
     ```bash
     dev-guard "Describe the change you want"
     ```
   - purpose:
     Analyze the requirement, write `.devguard/task.md`, and print a compact Codex prompt.

4. Give the prompt to Codex
   - purpose:
     Codex edits the code using the generated `TASK`, `TYPE`, `FILES`, `PROTECT`, `SUCCESS`, and `VERIFY` sections.

5. Check the finished work
   - command:
     ```bash
     dev-guard done
     ```
   - purpose:
     Refresh project memory, run local scope checks, run heuristic review, print a compact report, and preview docs updates.

6. Preview docs updates when needed
   - command:
     ```bash
     dev-guard update
     ```
   - purpose:
     Preview candidate updates for project state, current task, decisions, and do-not-repeat notes.

7. Write docs updates explicitly
   - command:
     ```bash
     dev-guard update --write
     ```
   - purpose:
     Update only dev-guard managed blocks. User-written sections are preserved.

8. Repeat with the next task
   - command:
     ```bash
     dev-guard "Next change"
     ```
   - purpose:
     Generate the next compact Codex prompt.

## Common Commands

```bash
dev-guard init
dev-guard status
dev-guard "Fix the bug described here"
dev-guard done
dev-guard update
dev-guard update --write
dev-guard watch
dev-guard help advanced
```

`watch` is optional. It refreshes project memory while you edit, but does not auto-fix code or write docs by default.

## Examples

- [Bugfix workflow](./examples/bugfix.md)
- [i18n workflow](./examples/i18n.md)
- [Architecture workflow](./examples/architecture.md)

## AI Provider Setup

dev-guard works without an API key by using local heuristics. AI features are optional.

Configure OpenAI when you want AI-backed task generation or review:

```bash
dev-guard configure ai --provider openai --model gpt-4o-mini
export OPENAI_API_KEY="your_api_key"
```

Do not store API keys in project files. Prefer environment variables such as `OPENAI_API_KEY`.

You can change settings later:

```bash
dev-guard config set provider openai
dev-guard config set model gpt-5
dev-guard config set temperature 0.2
dev-guard config show
```

## Safety Model

- Default mode is local and preview-first.
- `dev-guard done` does not modify docs.
- `dev-guard update` does not modify files.
- `dev-guard update --write` only updates managed blocks.
- Context/cache files are excluded from normal changed-file summaries.
- `.devguard/` runtime files are local-only by default; see [configuration docs](./docs/configuration.md) for examples.
- Provider/API configuration is optional.
- Watch mode auto-refreshes memory only; it does not apply source edits.

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
- AI review quality depends on provider configuration.
- Local heuristic review is useful but not a full semantic code review.
- Initial repositories without a git baseline can produce noisy untracked-file warnings.
- Watch mode is intentionally conservative.

## Advanced Docs

- [Command reference](./docs/commands.md)
- [Configuration and tracking policy](./docs/configuration.md)
- [Release checklist](./docs/release-checklist.md)
- [Architecture notes](./docs/architecture.md)
- [Task AI and prompt generation](./docs/task-ai.md)
- [Review, drift, and local heuristics](./docs/review-and-drift.md)
- [Watch mode](./docs/watch.md)
- [Docs update safety](./docs/update.md)
