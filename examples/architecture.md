# Architecture Example

## Requirement

```bash
dev-guard "Introduce a shared provider layer for API clients"
```

## Compact Prompt Shape

```txt
TASK: Introduce a shared provider layer for API clients
TYPE: architecture; requires_phasing=true
FILES: lib/*, provider/config entry points
PROTECT: preserve_public_api=true, no_unrelated_refactor=true
SUCCESS: first migration step is isolated; rollback/verification path is clear
VERIFY: pnpm run build
```

## Recommended Flow

```bash
dev-guard status
dev-guard "Introduce a shared provider layer for API clients"
# Review phasing before giving it to Codex
dev-guard done
```
