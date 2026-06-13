# Command Reference

[English](../README.md) | [한국어](../README.ko.md)

## Main Commands

```bash
dev-guard init
dev-guard watch
dev-guard done
dev-guard status
dev-guard reset
```

- `init`: create initial `.devguard` guard files. Existing files are not overwritten.
- `watch`: watch source/config/doc changes and accumulate pending paths in `devguard/runtime.json`.
- `done`: treat the current work as complete and generate history, reports, quality verdict, and handoff prompt.
- `status`: show pending changes, last processed task, recent history, quality verdict, and next action.
- `reset`: clear pending runtime state only. It preserves `devguard/state.json` and history.

## Watch Options

```bash
dev-guard watch --stable-after 20
dev-guard watch --depth 8
dev-guard watch --poll
dev-guard watch --include-lockfiles
dev-guard watch --compact
```

`watch` is event-driven. It does not run periodic refresh jobs and does not run `done` automatically.

## Completion Output

`dev-guard done` writes:

- `devguard/reports/last-run.md`
- `devguard/history.jsonl`
- `devguard/reports/history-summary.md`
- `devguard/reports/decision-candidates.md`
- `devguard/reports/quality-report.md`
- `devguard/prompts/next-codex-prompt.md`

## Advanced / Legacy Commands

These commands remain available but are no longer the main onboarding path:

- `dev-guard "<requirement>"`: generate a task and compact prompt through the older task flow.
- `dev-guard task-ai "<requirement>"`: AI-backed task generation.
- `dev-guard prompt`: generate a prompt from current project context.
- `dev-guard check --local`: run local scope checks directly.
- `dev-guard review --heuristic`: run local heuristic review directly.
- `dev-guard review`: provider-backed review when configured.
- `dev-guard fix-prompt`: generate a fix prompt from review output.
- `dev-guard report --compact`: print a compact handoff summary.
- `dev-guard scan`: build `.devguard` project memory cache.
- `dev-guard refresh`: incrementally update project memory cache.
- `dev-guard update`: preview managed docs update candidates.
- `dev-guard update --write`: write managed docs blocks only.
- `dev-guard doctor`: print config/provider/git/runtime diagnostics.
- `dev-guard telemetry`: print privacy-safe drift telemetry summary.
- `dev-guard configure ai`: configure provider/model.
- `dev-guard config set`: update config values.

## Development Helpers

These are mostly for developing dev-guard itself:

- `dev-guard self "<requirement>"`
- `dev-guard self-check`

## Help

```bash
dev-guard --help
dev-guard help advanced
```
