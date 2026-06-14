# Watch Mode

[English](../README.md) | [한국어](../README.ko.md)

`dev-guard watch` is the default Auto Mode watcher for AI-agent work.

```bash
dev-guard install-hooks
dev-guard watch
```

It watches file changes, accumulates pending paths, and waits for trusted Claude Code / Codex Stop Hooks to run `dev-guard done` when the agent turn ends.

Manual fallback:

```bash
dev-guard watch --manual
dev-guard done
```

## Behavior

- Uses chokidar when available.
- Accumulates changed files in `.devguard/runtime.json`.
- Prints a stable state after changes settle.
- Auto Mode waits for Stop Hook based `dev-guard done`.
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
Claude Code Hook: INSTALLED
Codex Hook: INSTALLED
Done trigger: Agent Stop Hook

Watching for file changes...
When Claude/Codex finishes, dev-guard done will run automatically.

watching: packages, docs, devguard
excluded: node_modules/**, .git/**, dist/**, build/**, .next/**, coverage/**
depth: 8; poll: off; lockfiles: excluded; manual: off
mode: event-driven; no periodic refresh; no idle-time completion
stop: Ctrl+C

STATUS: idle
NEXT: keep editing; Stop Hook will run done when the AI task finishes
```

Without hooks:

```txt
Mode: Manual Mode
Claude Code Hook: NOT_INSTALLED
Codex Hook: NOT_INSTALLED
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

When Claude Code or Codex fires a `Stop` hook, dev-guard runs:

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

Codex JSONL note: `.devguard/hooks/codex-event-listener.ts` is not a hook. It is a helper for piping `codex exec --json` JSONL events such as `turn.completed` and `turn.failed`.

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
- `.devguard/reports/**`
- `.devguard/prompts/**`

Lockfiles are excluded by default from watch events, but git diff analysis in `done` can still see them.

## EMFILE Recovery

If you see `EMFILE: too many open files`, try:

```bash
dev-guard watch --poll
dev-guard watch --depth 4
```

You can also run from a narrower project path or increase the OS file descriptor limit.
