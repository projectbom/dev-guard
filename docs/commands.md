# Command Reference

[English](../README.md) | [한국어](../README.ko.md)

## Main Commands

```bash
dev-guard init
dev-guard install-hooks
dev-guard install-hooks --agent claude
dev-guard install-hooks --agent codex
dev-guard install-hooks --agent codex-notify
dev-guard install-hooks --agent all
dev-guard watch
dev-guard done
dev-guard handoff
dev-guard status
dev-guard reset
dev-guard doctor --hooks --dry-run
dev-guard doctor --hooks
dev-guard doctor --agents
```

- `init`: create initial `.devguard` guard files. Existing files are not overwritten.
- `watch`: recommended watcher; watches changes and waits for a runtime-verified agent completion strategy.
- `install-hooks`: install Claude/Codex completion strategy scripts and supported config.
- `done`: manually process pending changes and generate history, reports, quality verdict, and handoff prompt.
- `handoff`: regenerate only `.devguard/reports/project-handoff.md` from current `.devguard/` artifacts.
- `status`: show pending changes, last processed task, recent history, quality verdict, and next action.
- `reset`: clear pending runtime state only. It preserves `.devguard/state.json` and history.
- `doctor --hooks --dry-run`: inspect hook files, permissions, config commands, and logs without executing hooks.
- `doctor --hooks`: execute hook scripts directly, then report whether logs and status were updated. This can run `done` and `status`.

## Watch Options

```bash
dev-guard watch --manual
dev-guard watch --stable-after 20
dev-guard watch --depth 8
dev-guard watch --poll
dev-guard watch --include-lockfiles
dev-guard watch --compact
```

`watch` is event-driven. It does not run periodic refresh jobs, idle-time completion, build/test, or git commit.

## Usage Modes

### Auto Mode Recommended

```bash
dev-guard install-hooks
dev-guard watch
```

Claude Code uses Stop Hook. Codex should prefer user-level notify when available; Codex Stop Hook remains available but requires `/hooks` trust. A strategy must be runtime verified before Auto Mode should be treated as working.

### Manual Mode Fallback

```bash
dev-guard watch --manual
dev-guard done
```

Use Manual Mode when hooks cannot be installed, trusted, or run. `watch` only accumulates pending changes; the user explicitly runs `done`.

## Hook Commands

```bash
dev-guard install-hooks
dev-guard install-hooks --force
dev-guard status
dev-guard done
dev-guard handoff
```

`install-hooks` creates or updates completion strategy files:

- `.claude/settings.json`
- `.codex/hooks.json`
- `.devguard/hooks/claude-stop.sh`
- `.devguard/hooks/codex-stop.sh`
- `.devguard/hooks/codex-notify.sh`
- `.devguard/hooks/codex-event-listener.ts`

It also checks for the legacy `devguard/` directory. If only the legacy directory exists, it is migrated to `.devguard/`. If both directories exist, dev-guard preserves user data and warns instead of merging automatically.

Claude Code Stop hooks use `.claude/settings.json` with `hooks.Stop[].hooks[]`. The dev-guard command handler uses `${CLAUDE_PROJECT_DIR}/.devguard/hooks/claude-stop.sh`.

Codex notify is the preferred Codex strategy when the user config can be updated. Official Codex config ignores `notify` in project-local `.codex/config.toml`, so dev-guard only creates `.devguard/hooks/codex-notify.sh` and reports the required user-level `~/.codex/config.toml` step.

Codex Stop hooks use `.codex/hooks.json` with `hooks.Stop[].hooks[]`. The dev-guard command handler resolves from the git root with `"$(git rev-parse --show-toplevel)/.devguard/hooks/codex-stop.sh"`. This strategy requires `/hooks` trust before runtime execution.

`turn.completed` is not a Codex hook event. It belongs to `codex exec --json` JSONL output. `.devguard/hooks/codex-event-listener.ts` is a separate helper for that stream and is not referenced from `.codex/hooks.json`.

Without `--force`, existing Claude settings are merged safely and existing Codex hook settings are left untouched. With `--force`, dev-guard regenerates its scripts and normalizes old dev-guard hook entries while preserving unrelated hook handlers.

Installed hooks still need runtime verification. Codex may require both project trust and hook definition trust. If `watch` reaches `ready_for_done` but no hook log or Last Hook Trigger appears, open Codex TUI and run `/hooks` to review/trust the dev-guard Stop hook. Claude Code hooks require a Claude Code runtime that loads the project `.claude/settings.json`; verify with `.devguard/logs/claude-hook.log` and `dev-guard status`.

Strategy and hook diagnostics:

```bash
dev-guard doctor --agents
dev-guard doctor --hooks --dry-run
dev-guard doctor --hooks
```

Use `doctor --agents` to see Claude Stop Hook, Codex notify, Codex Stop Hook, Codex JSONL listener, and manual fallback status. Use the dry run to inspect file paths and command targets. Use the active check to execute the hook scripts directly; it can run `dev-guard done` and `dev-guard status`. If runtime completion still does not fire, use the manual fallback:

```bash
dev-guard done
```

## Completion Output

`dev-guard done` writes:

- `.devguard/reports/last-run.md`
- `.devguard/history.jsonl`
- `.devguard/reports/history-summary.md`
- `.devguard/reports/decision-candidates.md`
- `.devguard/reports/quality-report.md`
- `.devguard/prompts/next-codex-prompt.md`
- `.devguard/reports/project-handoff.md`

## Handoff Command

```bash
dev-guard handoff
```

`handoff` does not analyze git changes, update history, call an LLM, run tests, or modify source files. It reads the current `.devguard/` artifacts and rewrites only:

- `.devguard/reports/project-handoff.md`

Use it when a Claude/Codex context window overflows and you need a compact resume file for a new thread. The file includes current state, active workflow, recent changes, important decisions, quality status, open risks, next best task, do-not-change constraints, and a short resume prompt.

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
