# Release Checklist

[English](../README.md) | [한국어](../README.ko.md)

Use this before a GitHub Alpha release.

## Required Checks

```bash
pnpm run build
pnpm cli status
pnpm cli done
pnpm cli self-check
npm pack --dry-run --cache /private/tmp/dev-guard-npm-cache
git status --short
```

## Manual Review

- Git baseline exists or initial-commit noise is understood.
- README, Korean README, docs, and wiki links are consistent.
- npm install/update usage is covered in `docs/npm-setup.md`, `docs/npm-setup.ko.md`, and `packages/cli/README.md`.
- Provider setup is optional and API keys are documented as environment variables.
- `.devguard/` runtime files are ignored.
- `update` is preview-only unless `--write` is passed.
- `watch` does not edit source or docs by default.

## Package Hygiene

- Repository URL points to `https://github.com/projectbom/dev-guard.git`.
- Package versions are consistent.
- License is MIT.
- CLI package keeps `bin.dev-guard`.
- Publish package contents stay dist-only.
- `dist/index.js` keeps the Node shebang.
