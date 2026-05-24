# Watch Mode

[English](../README.md) | [한국어](../README.ko.md)

Watch mode monitors the current git diff while you edit and prints a compact intent summary.

```bash
dev-guard watch
```

It polls git/worktree state instead of running as a background daemon.

## Behavior

- Runs diff intent inference and clustering.
- Prints only when the diff hash, inferred intent, or watch status changes.
- Uses a stable-after timer so formatter/prettier save bursts do not spam the terminal.
- Does not auto-apply source edits.
- Does not write docs by default.
- Does not run `done`, `update --write`, git commit, or any autonomous action.

Status flow:

```txt
idle -> active -> stable -> ready_for_done
                       -> mixed_warning
```

## Options

```bash
dev-guard watch --check
dev-guard watch --review
dev-guard watch --interval 1000
dev-guard watch --stable-after 30
dev-guard watch --ultra
dev-guard watch --once
```

`--check` and `--review` run only after the diff reaches a stable state. `--review` uses heuristic review here and does not auto-fix code.
