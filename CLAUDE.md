<!-- dev-guard-section-start -->

## DevGuard Instructions for Claude

DevGuard is an AI Coding Context Provider. It prepares context before AI work and preserves context after AI work in local `.devguard/` files.

## DevGuard Task Context

For every new coding or code-analysis task, before broad repository search or reading unrelated source files:

1. Call the DevGuard MCP tool `prepare_task_context` with the user's current concrete request.
2. Start with the highest-priority files and line ranges returned by DevGuard.
3. Expand to additional callers, dependencies, routes, schemas, or tests only when needed to verify data flow or impact.
4. Do not begin with broad repository-wide search when DevGuard returns relevant candidates.
5. Use `.devguard/context/agent-brief.md`, `.devguard/reports/read-map.md`, and `.devguard/reports/code-map.md` only when MCP is unavailable or its result is insufficient.
6. Do not treat `.devguard/reports/project-handoff.md` as the source of truth for a new task.

For explicitly resumed work:

1. Read `.devguard/reports/project-handoff.md`.
2. Convert the next action into a concrete task.
3. Call `prepare_task_context` with that concrete task.
4. Continue from the returned files and ranges.

MCP fallback order:

1. `.devguard/context/agent-brief.md` — compact current-task brief.
2. `.devguard/reports/read-map.md` — file priority.
3. `.devguard/reports/code-map.md` — file-internal ranges.
4. `.devguard/reports/working-context.md` — structural background only when needed.

Read only when needed:

- `.devguard/reports/project-handoff.md` — previous-session resume instruction, not the default entry for a new task.
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

- Start new work: call `prepare_task_context`, then inspect only the returned file ranges needed for the task.
- Resume previous work: read the handoff, turn its next action into a concrete task, then call `prepare_task_context`.
- During work: keep `dev-guard watch` running in another terminal when continuous change tracking is wanted.
- Finish: run the relevant project checks, then run `dev-guard done` and `dev-guard status` so handoff/status files are current.
- Next Claude session: use `.devguard/reports/read-map.md`, `.devguard/reports/code-map.md`, `.devguard/context/agent-brief.md`, `.devguard/reports/working-context.md`, or `.devguard/prompts/next-claude-prompt.md` to resume without rediscovering the repo.

Rules:

- Use the DevGuard MCP result as the primary source for where to read first on new tasks.
- Do not perform repository-wide scans before calling DevGuard MCP when it is available.
- Use `.devguard/context/agent-brief.md`, `.devguard/reports/read-map.md`, and `.devguard/reports/code-map.md` as fallback when MCP is unavailable or insufficient.
- Use `.devguard/reports/project-handoff.md` only for explicitly resumed work and `.devguard/reports/quality-report.md` only for QA status.
- Treat `.devguard/project/project-knowledge.json` as long-term structure memory, not a task instruction.
- Do not manually edit `.devguard/context/*`, `.devguard/reports/*`, `.devguard/prompts/*`, or `.devguard/runtime.json`; they are generated artifacts.
- Do not make broad unrelated changes.
- Do not invent unsupported DevGuard commands; verify commands with `dev-guard --help` or the current CLI source.
<!-- dev-guard-section-end -->
