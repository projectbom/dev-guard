# Review, Drift, And Local Heuristics

[English](../README.md) | [한국어](../README.ko.md)

Direct review commands are advanced tools. The default workflow is:

```bash
dev-guard watch
dev-guard done
```

`done` records drift candidates in `last-run.md`, `quality-report.md`, and `next-codex-prompt.md`.

dev-guard also has two direct review modes:

- local heuristic review, available without an API key
- provider-backed review, when configured

## Local Review

```bash
dev-guard review --heuristic
dev-guard check --local
```

Local checks can detect:

- unrelated file changes
- broad diff scope
- untracked files
- duplicate markdown headings
- managed-marker corruption
- obvious i18n omissions
- generated diff drift signals
- high-impact dependency changes from the lightweight code graph

## Drift Review

Drift review compares the current requirement/task with the changed files and diff shape. It uses heuristic signals such as:

- task subtype mismatch
- semantic zone mismatch
- broad or unrelated diff
- suspicious file scope expansion
- destructive changes

Semantic zones include examples such as state logic, routing, UI copy, styling, architecture, config, auth, and data flow.

## Workflow Scores

Heuristic review may print:

```text
Requirement Alignment Score
Drift Risk
Scope Safety
Confidence
```

These scores come from drift severity, scope signals, diff size, and mismatch signals. They are not a replacement for human review.

## Telemetry

Privacy-safe telemetry stores summary-level drift information in `.devguard/drift-telemetry.json`. It does not store source code or full requirements.
