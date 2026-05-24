# Bugfix Example

## Requirement

```bash
dev-guard "Fix loading flicker on the dashboard"
```

## Compact Prompt Shape

```txt
TASK: Fix loading flicker on the dashboard
TYPE: bugfix / ui_rendering
FILES: app/dashboard/*, components/dashboard/*
PROTECT: preserve_behavior=true, protect_data=true
SUCCESS: flicker is gone; existing loading/data behavior stays intact
VERIFY: pnpm run build
```

## Recommended Flow

```bash
dev-guard init
dev-guard status
dev-guard "Fix loading flicker on the dashboard"
# paste prompt into Codex
dev-guard done
```
