# Watch Mode

[English](../README.md) | [한국어](../README.ko.md)

`dev-guard watch` is the default watcher for AI-agent work. Automatic completion is agent-specific and must be runtime verified.

```bash
dev-guard install-hooks
dev-guard watch
```

It watches file changes, accumulates pending paths, and waits for a verified completion strategy to run `dev-guard done` when the agent turn ends.

Manual fallback:

```bash
dev-guard watch --manual
dev-guard done
```

## Behavior

- Uses chokidar when available.
- Accumulates changed files in `.devguard/runtime.json`.
- Prints a stable state after changes settle.
- Auto Mode waits for an agent-specific completion strategy.
- `watch` never runs `done` by itself; agent hook/notify or a manual `done` remains the completion actor.
- When another process runs `done`, `watch` refreshes from `.devguard/runtime.json`, `.devguard/state.json`, and `.devguard/history.jsonl`, then moves through processed/idle display state.
- Manual Mode only accumulates changes until the user runs `dev-guard done`.
- Does not use idle timeout or polling-based completion guessing.
- Does not run `update --write`.
- Does not run build/test.
- Does not edit source files.
- Does not commit.
- Does not call an AI provider.

Typical output:

```txt
dev-guard watch
Mode: Auto Mode
Auto completion strategy:
Claude: Stop Hook installed; runtime verified: no
Codex: Notify recommended (not installed); Stop Hook installed but requires /hooks trust
Runtime verified: no
Fallback: dev-guard done
Done trigger: verified agent strategy when runtime calls it

Watching for file changes...
Automatic completion is installed but runtime verification is still required.

watching: packages, docs, .devguard
excluded: node_modules/**, .git/**, dist/**, build/**, .next/**, coverage/**, .devguard/runtime.json, .devguard/state.json, .devguard/history.jsonl, .devguard/reports/**, .devguard/prompts/**, .devguard/logs/**, .devguard/hooks/**
depth: 8; poll: off; lockfiles: excluded; manual: off
mode: event-driven; no periodic refresh; no idle-time completion
stop: Ctrl+C

STATUS: idle
NEXT: keep editing; verify agent strategy with dev-guard doctor --agents or use dev-guard done
```

If hooks are installed but not yet verified, `ready_for_done` shows:

```txt
STATUS: ready_for_done
NEXT: automatic completion is not runtime verified yet. Run dev-guard doctor --agents or fallback: dev-guard done
```

Without hooks:

```txt
Mode: Manual Mode
Auto completion strategy:
Claude: Stop Hook not installed; runtime verified: no
Codex: Notify recommended (not installed); Stop Hook not installed but requires /hooks trust
Runtime verified: no
Fallback: dev-guard done
Done trigger: manual dev-guard done

Tip:
Run dev-guard install-hooks to enable Auto Mode.
```

## Auto Mode Recommended

Install hooks once per repository:

```bash
dev-guard install-hooks
dev-guard status
```

When a verified strategy fires, dev-guard runs:

```bash
dev-guard done
dev-guard status
```

`done` also writes:

- `.devguard/reports/quality-report.md`
- `.devguard/prompts/next-codex-prompt.md`
- `.devguard/reports/project-handoff.md`

Manual fallback:

```bash
dev-guard done
```

If only the overflow resume file needs to be refreshed:

```bash
dev-guard handoff
```

Codex strategy notes:

- Codex notify is preferred when you can configure user-level `~/.codex/config.toml`.
- Codex notify is a single user-level command. If another notify already exists, install the dev-guard dispatcher instead of overwriting it.
- Codex Stop Hook is available but requires `/hooks` trust.
- Codex JSONL listener is not a hook. It is a helper for piping `codex exec --json` JSONL events such as `turn.completed` and `turn.failed`.

Dispatcher install:

```bash
dev-guard install-hooks --agent codex-notify --install-dispatcher
```

The dispatcher lives at `~/.codex/dev-guard-notify-dispatcher.sh`. It runs the original notify command, such as Codex Computer Use `turn-ended`, and then runs `.devguard/hooks/codex-notify.sh` when present in the current project. The config backup is written to `~/.codex/config.toml.devguard-backup-YYYYMMDD-HHmmss`; restore that file to uninstall.

## Hook Verification

Installed hooks do not prove that the agent runtime has called them. Verify hook activation with:

```bash
dev-guard doctor --hooks --dry-run
dev-guard doctor --hooks
dev-guard doctor --agents
dev-guard status
```

`doctor --agents` shows Claude Stop Hook, Codex notify, Codex Stop Hook, Codex JSONL listener, and manual fallback status. `doctor --hooks --dry-run` checks files, permissions, config commands, command targets, and existing logs without running hooks. `doctor --hooks` directly executes the hook scripts and can run `dev-guard done` and `dev-guard status`.

Codex can require separate project trust and hook definition trust. If Auto Mode does not complete after `STATUS: ready_for_done`, open Codex TUI and run `/hooks` to review/trust the dev-guard Stop hook.

Claude Code hooks require Claude Code to be installed and the project `.claude/settings.json` to be loaded. Confirm actual execution through `.devguard/logs/claude-hook.log` and `dev-guard status`.

If hook runtime execution is not verified yet, use the manual fallback:

```bash
dev-guard done
```

If the terminal appears stuck at `ready_for_done`, run `dev-guard status`. Pending files may already be cleared by an external hook/notify or manual `done`; the watcher will refresh its display from runtime state.

## Context Overflow Recovery

If Claude/Codex stops because the context window is full:

```bash
dev-guard handoff
```

Start a new Claude/Codex thread and attach or ask it to read:

```txt
.devguard/reports/project-handoff.md
```

The resume file is intentionally compressed. It is meant to get the next agent oriented in 1-2 minutes, not to preserve the full history.

## Options

```bash
dev-guard watch --manual
dev-guard watch --stable-after 10
dev-guard watch --depth 4
dev-guard watch --poll
dev-guard watch --include-lockfiles
dev-guard watch --compact
```

- `--manual`: force Manual Mode even when hooks are installed.
- `--no-auto`: alias for `--manual`.
- `--stable-after <sec>`: wait time before reporting ready state.
- `--depth <n>`: limit watcher depth. Default is `8`.
- `--poll`: use polling, useful when native file watching hits `EMFILE`.
- `--include-lockfiles`: include lockfile changes in watch events.
- `--compact` / `--ultra`: keep output short.

## Excluded Paths

Watch excludes heavy/generated paths:

- `node_modules/**`
- `.git/**`
- `.next/**`
- `dist/**`
- `build/**`
- `coverage/**`
- `.devguard/runtime.json`
- `.devguard/state.json`
- `.devguard/history.jsonl`
- `.devguard/reports/**`
- `.devguard/prompts/**`
- `.devguard/logs/**`
- `.devguard/hooks/**`

Lockfiles are excluded by default from watch events, but git diff analysis in `done` can still see them.

## EMFILE Recovery

If you see `EMFILE: too many open files`, try:

```bash
dev-guard watch --poll
dev-guard watch --depth 4
```

You can also run from a narrower project path or increase the OS file descriptor limit.
