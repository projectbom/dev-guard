<!-- dev-guard-section-start -->

## DevGuard Instructions for Claude

DevGuard is a CLI context guard for AI coding sessions. It keeps project context, pending changes, quality checks, and next-session handoff files under `.devguard/`.

Before changing code:

1. Read `.devguard/reports/read-map.md` — what to read first.
2. Read `.devguard/reports/code-map.md` — where to read inside changed files.
3. Read `.devguard/context/agent-brief.md` — compact current-task brief.
4. Read `.devguard/reports/working-context.md` — current work structure.
5. Read `.devguard/reports/project-handoff.md` — next-session work instructions.
6. Read `.devguard/reports/quality-report.md` — QA result and remaining verification.
7. Read `.devguard/context/agent-context.md` when agent-specific rules or current state are needed.
8. Read `.devguard/project/project-knowledge.json` before broad repository exploration.
9. Run `dev-guard status` when the current state is unclear.

Common commands:

- `dev-guard --help`
- `dev-guard doctor`
- `dev-guard init`
- `dev-guard install-agent-instructions`
- `dev-guard install-hooks`
- `dev-guard watch`
- `dev-guard status`
- `dev-guard done`
- `dev-guard handoff`
- `dev-guard knowledge`
- `dev-guard prompt`
- `dev-guard self-check`

Session workflow:

- Start: read the Read Map and Code Map first, then inspect only the targeted file regions needed for the task.
- During work: keep `dev-guard watch` running in another terminal when continuous change tracking is wanted.
- Finish: run the relevant project checks, then run `dev-guard done` and `dev-guard status` so handoff/status files are current.
- Next Claude session: use `.devguard/reports/read-map.md`, `.devguard/reports/code-map.md`, `.devguard/context/agent-brief.md`, `.devguard/reports/working-context.md`, or `.devguard/prompts/next-claude-prompt.md` to resume without rediscovering the repo.

Rules:

- Use DevGuard artifacts as the primary source of current project state.
- Start from `.devguard/reports/read-map.md` and `.devguard/reports/code-map.md`; do not scan the full repository first.
- Use `.devguard/context/agent-brief.md` as the compact before-agent task brief.
- Use `.devguard/reports/working-context.md` for the current work structure.
- Use `.devguard/reports/project-handoff.md` as the next work instruction.
- Use `.devguard/reports/quality-report.md` only for QA results and verification status.
- Treat `.devguard/project/project-knowledge.json` as the primary source of project structure before broad repository exploration.
- Do not perform repository-wide scans before reading the current DevGuard context.
- Do not make broad unrelated changes.
- Do not invent unsupported DevGuard commands; verify commands with `dev-guard --help` or the current CLI source.
<!-- dev-guard-section-end -->
