# Command Reference

[English](../README.md) | [한국어](../README.ko.md)

This page lists commands that are intentionally kept out of the main README.

## Main Flow

```bash
dev-guard init
dev-guard status
dev-guard "Describe the change"
dev-guard done
```

## Common Commands

- `dev-guard init`: create `.devguard` and docs guard files without overwriting existing content.
- `dev-guard status`: combine diagnostics and compact report.
- `dev-guard "<requirement>"`: generate `.devguard/task.md` and a compact Codex prompt.
- `dev-guard done`: run refresh, local check, heuristic review, compact report, and docs update preview.
- `dev-guard update`: preview docs update candidates.
- `dev-guard update --write`: update only dev-guard managed blocks.
- `dev-guard watch`: keep project memory current while editing.

## Advanced Commands

- `dev-guard task-ai "<requirement>"`: AI-backed task generation with options such as `--write`, `--prompt`, `--copy`, `--debug-context`, `--context-files`, and `--fresh`.
- `dev-guard prompt`: generate a Codex prompt from current context. Supports `--compact`, `--ultra-compact`, `--density`, `--copy`, and `--output`.
- `dev-guard check --local`: run rule-based scope checks against working tree, staged, and untracked changes.
- `dev-guard review --heuristic`: run local static review without an AI provider.
- `dev-guard review`: use configured AI provider when available.
- `dev-guard fix-prompt`: generate a Codex-ready correction prompt from review output.
- `dev-guard report --compact`: print a short handoff summary.
- `dev-guard scan`: build project memory cache.
- `dev-guard refresh`: incrementally update project memory.
- `dev-guard doctor`: inspect provider, config, git baseline, detected runtime, telemetry, and memory.
- `dev-guard telemetry`: show privacy-safe drift telemetry summary.
- `dev-guard configure ai`: configure provider/model.
- `dev-guard config set`: change provider/model/temperature/max token settings.

## Local Files

Generated `.devguard/` files are local-only by default. `task.md`, `runs/`, memory cache, `code-graph.json`, and telemetry are ignored. Keep examples in docs instead of committing local `.devguard` runtime files.

## Development Workflow

These commands are mainly for developing dev-guard itself:

- `dev-guard self "<requirement>"`: wrapper around task/prompt generation for this repo.
- `dev-guard self-check`: run build, local check, heuristic review, and doctor in sequence.

## Help

```bash
dev-guard --help
dev-guard help advanced
```
