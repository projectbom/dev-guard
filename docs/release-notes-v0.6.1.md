# DevGuard v0.6.1

> **Historical record.** This document describes DevGuard as of v0.6.1 and is kept unchanged as release history. Some workflows here are superseded; for current usage see the [README](../README.md) and the [npm guide](./npm-setup.md).

## Fixed

- Dashboard could render blank due to invalid client regex escaping.
- Dashboard now renders fallback UI when state fields are missing.
- `dev-guard watch` now learns the project before starting when Project Knowledge is missing or stale.
- Watch startup avoids duplicate root/subdirectory watcher registration to reduce `EMFILE` risk.

## Validation

- `pnpm exec tsc -p packages/cli/tsconfig.json --noEmit`
- `pnpm run build`
- `pnpm cli self-check`
- `pnpm cli status`
- `pnpm cli handoff`
- `npm pack --dry-run`
