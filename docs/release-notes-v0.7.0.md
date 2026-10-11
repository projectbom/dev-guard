# DevGuard v0.7.0 Release Notes Draft

> **Historical record.** This document describes DevGuard as of v0.7.0 and is kept unchanged as release history. Some workflows here are superseded; for current usage see the [README](../README.md) and the [npm guide](./npm-setup.md).

## Highlights

- Working Context is now part of the agent startup flow, so Claude/Codex can start from the relevant entry files instead of scanning broadly.
- Dashboard Quick Actions now include QA Report, Handoff, Working Context, Agent Context, Project Knowledge, and Settings.
- Dashboard preview panels preserve their open state across refreshes.
- Agent instruction files now tell agents to read Working Context, Handoff, and Quality Report first.

## Validation

- `pnpm run build`
- `pnpm cli self-check`
- `pnpm cli done`
- `pnpm cli handoff`

Do not publish from this draft alone. Run final package and browser checks before npm release.
