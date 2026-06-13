# Docs Update Safety

[English](../README.md) | [한국어](../README.ko.md)

`dev-guard update` is an advanced docs-maintenance command. The main event-based workflow uses `dev-guard done`, which writes docs update candidates into `devguard/reports/*` but does not modify source docs.

Use `update` when you explicitly want to preview or write managed documentation blocks.

## Preview First

```bash
dev-guard update
```

This prints update candidates and does not modify files.

## Explicit Write

```bash
dev-guard update --write
```

This updates managed blocks only:

```md
<!-- dev-guard:update:start -->
...
<!-- dev-guard:update:end -->
```

User-written content outside the markers is preserved.

## Target Docs

The default managed docs are:

- `docs/PROJECT_STATE.md`
- `docs/CURRENT_TASK.md`
- `docs/DECISIONS.md`
- `docs/DO_NOT_REPEAT.md`

If a file is missing, write mode creates it. If marker pairs are broken, dev-guard reports the issue instead of guessing how to rewrite the file.

## What Update Looks For

- changed files
- new commands or CLI usage
- new guard rules
- new completion criteria
- new limitations
- watch/review/check behavior changes
- repeat-prevention rules

Context/cache files are excluded from normal changed-file summaries unless explicitly included.
