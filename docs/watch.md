# Watch Mode

[English](../README.md) | [한국어](../README.ko.md)

`dev-guard watch` is the default way to keep dev-guard aware of AI-agent work.

```bash
dev-guard watch
```

It watches file changes, accumulates pending paths, and waits for the user to run `dev-guard done`.

## Behavior

- Uses chokidar when available.
- Accumulates changed files in `devguard/runtime.json`.
- Prints a stable state after changes settle.
- Does not run `done` automatically.
- Does not run `update --write`.
- Does not edit source files.
- Does not commit.
- Does not call an AI provider.

Typical output:

```txt
dev-guard watch
watching: packages, docs, devguard
excluded: node_modules/**, .git/**, dist/**, build/**, .next/**, coverage/**
depth: 8; poll: off; lockfiles: excluded
mode: event-driven; no periodic refresh; no auto write
stop: Ctrl+C

STATUS: idle
NEXT: keep editing; run dev-guard done when the AI task is finished
```

## Options

```bash
dev-guard watch --stable-after 10
dev-guard watch --depth 4
dev-guard watch --poll
dev-guard watch --include-lockfiles
dev-guard watch --compact
```

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
- `devguard/runtime.json`
- `devguard/reports/**`
- `devguard/prompts/**`

Lockfiles are excluded by default from watch events, but git diff analysis in `done` can still see them.

## EMFILE Recovery

If you see `EMFILE: too many open files`, try:

```bash
dev-guard watch --poll
dev-guard watch --depth 4
```

You can also run from a narrower project path or increase the OS file descriptor limit.
