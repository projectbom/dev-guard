<!-- dev-guard-section-start -->

## DevGuard Instructions for Claude

DevGuard is a CLI context guard for AI coding sessions. It keeps project context, pending changes, quality checks, and next-session handoff files under `.devguard/`.

Before changing code:

1. Read `.devguard/project/project-knowledge.json` before broad repository exploration.
2. Read `.devguard/context/agent-context.md`
3. Read `.devguard/reports/project-handoff.md`
4. Read `.devguard/reports/quality-report.md`
5. Run `dev-guard status` when the current state is unclear.

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

- Start: read the DevGuard Project Knowledge file and context files above, then inspect only the files needed for the task.
- During work: keep `dev-guard watch` running in another terminal when continuous change tracking is wanted.
- Finish: run the relevant project checks, then run `dev-guard done` and `dev-guard status` so handoff/status files are current.
- Next Claude session: use `.devguard/context/agent-context.md`, `.devguard/reports/project-handoff.md`, or `.devguard/prompts/next-claude-prompt.md` to resume without rediscovering the repo.

Rules:

- Use DevGuard artifacts as the primary source of current project state.
- Treat `.devguard/project/project-knowledge.json` as the primary source of project structure before broad repository exploration.
- Do not perform repository-wide scans before reading the current DevGuard context.
- Do not make broad unrelated changes.
- Do not invent unsupported DevGuard commands; verify commands with `dev-guard --help` or the current CLI source.
<!-- dev-guard-section-end -->
