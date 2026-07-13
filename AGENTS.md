<!-- dev-guard-section-start -->

## DevGuard Instructions for Codex

DevGuard is an AI Coding Context Provider. It prepares context before AI work and preserves context after AI work in local `.devguard/` files.

Before changing code:

- If the DevGuard MCP server is available, call `prepare_task_context` with the current task before searching or reading source files.

1. Read `.devguard/reports/read-map.md` — what to read first.
2. Read `.devguard/reports/code-map.md` — where to read inside changed files.
3. Read `.devguard/context/agent-brief.md` — compact current-task brief.
4. Read `.devguard/reports/working-context.md` — current work structure.

Read only when needed:

- `.devguard/reports/project-handoff.md` — next-session work instruction.
- `.devguard/reports/quality-report.md` — QA result and remaining verification.
- `.devguard/context/agent-context.md` — agent rules and current constraints.
- `.devguard/project/project-knowledge.json` — long-term project structure before broad exploration.
- `dev-guard status` — current runtime state when unclear.

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
- Next Codex session: use `.devguard/reports/read-map.md`, `.devguard/reports/code-map.md`, `.devguard/context/agent-brief.md`, `.devguard/reports/working-context.md`, or `.devguard/prompts/next-codex-prompt.md` to resume without rediscovering the repo.

Rules:

- Use DevGuard artifacts as the primary source of current project state.
- Start from `.devguard/reports/read-map.md` and `.devguard/reports/code-map.md`; do not scan the full repository first.
- Use `.devguard/context/agent-brief.md` as the compact task brief and `.devguard/reports/working-context.md` for work structure.
- Use `.devguard/reports/project-handoff.md` for next-work instructions and `.devguard/reports/quality-report.md` only for QA status.
- Treat `.devguard/project/project-knowledge.json` as long-term structure memory, not a task instruction.
- Do not perform repository-wide scans before reading the current DevGuard context.
- Do not make broad unrelated changes.
- Do not invent unsupported DevGuard commands; verify commands with `dev-guard --help` or the current CLI source.
<!-- dev-guard-section-end -->
