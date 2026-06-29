# DevGuard v0.6.0 Release Notes Draft

## Highlights

- Dashboard now guides the next action instead of only showing status.
- Review Workflow helps users resolve quality warnings without knowing CLI internals.
- Smart Handoff gives the next AI session a compact project context.
- Project Knowledge is summarized in handoff and dashboard.
- Next Prompt is shorter and focused on the smallest executable next step.

## Changed

- Dashboard action priority and recommendation reasons.
- Review Complete flow for browser-based review.
- Session summary and architecture impact wording.
- Smart handoff compression with quality-state ordering.
- Next prompt compression for Codex sessions.
- Handoff quality self-check: coverage, redundancy, readability.

## Validation

- `pnpm run build`
- `pnpm cli self-check`
- `npm pack --dry-run`

## Release Notes

- `NEEDS_REVIEW` means review is recommended, not that DevGuard failed.
- Runtime artifacts under `.devguard/` remain ignored and should not be committed.
- `dev-guard done` still does not run build/test automatically; it records what should be verified.
