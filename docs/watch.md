# Watch Mode

[English](../README.md) | [한국어](../README.ko.md)

Watch mode keeps project memory current while you edit.

```bash
dev-guard watch
```

It watches common source/config paths such as:

- `app`
- `components`
- `lib`
- `hooks`
- `utils`
- `constants`
- `styles`
- `supabase`
- `src`
- `packages`
- selected root/context files

It excludes generated or heavy paths such as:

- `node_modules`
- `.git`
- `.next`
- `dist`
- `build`
- `coverage`
- lockfiles
- binary/image/font files
- `.devguard` cache files

## Behavior

- Debounces change events.
- Merges burst events.
- Avoids concurrent refresh runs.
- Reloads provider config when config files change.
- Does not auto-apply source edits.
- Does not write docs by default.

## Options

```bash
dev-guard watch --check
dev-guard watch --review
dev-guard watch --debounce 1500
dev-guard watch --once
```

`--review` can call the configured AI provider and may incur API cost. Without provider configuration, review can fall back to heuristic behavior where available.
