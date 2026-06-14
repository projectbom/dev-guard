# Completion Quality

[English](../README.md) | [한국어](../README.ko.md)

`dev-guard done` creates:

```text
.devguard/reports/quality-report.md
```

This report answers: is the completed AI-agent work ready for commit, or does it need review first?

dev-guard does not run build or tests automatically. It only determines which verification commands should be run.

## Verdicts

### PASS

The work looks ready for final human review or commit.

Criteria:

- no blocking item
- no high-risk area signal
- verification command exists
- next task is clear

### NEEDS_REVIEW

The work may be fine, but should be reviewed before commit.

Common triggers:

- drift candidate exists
- 10 or more changed files
- auth/database/api/config area changed
- CLI command router changed
- watch/runtime/history/prompt generation logic changed
- `package.json` changed

### BLOCKED

The work should not be committed until the blocking item is resolved.

Triggers:

- generated/runtime files are in git changes
- `package.json` changed but lockfile state looks inconsistent
- build script exists but no build verification command can be suggested

## Docs Changes Are Not Always Required

Source changes without docs changes are recorded as a documentation update candidate, but this alone does not make the verdict `NEEDS_REVIEW`.

This keeps quality checks useful without making every small code change noisy.

## Report Structure

`quality-report.md` includes:

- `Verdict`
- `Why`
- `Required Verification`
- `Blocked Items`
- `Warnings`
- `Risk Checklist`
- `Before Commit`
- `Next Recommended Action`

## Status Integration

`dev-guard status` shows the last quality verdict:

```txt
Quality: NEEDS_REVIEW
Next recommended action: run pnpm run build, then review .devguard/reports/quality-report.md
```
