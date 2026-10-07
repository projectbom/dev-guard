<!-- dev-guard-section-start -->

## DevGuard Instructions for Claude

DevGuard is an AI Coding Context Provider. It does not shorten or speed up the AI provider's own context compaction; it makes starting a fresh agent thread cheap, so a long thread never has to be compacted.

## DevGuard Task Context

Primary context source — `prepare_task_context` (DevGuard MCP):

1. For every new coding or code-analysis task, call `prepare_task_context` with the user's concrete request before any repository search or unrelated file reads.
2. Read the TARGET files' ranges first. Open a CANDIDATE file only when the targets leave a concrete gap — do not batch-read every returned file. REFERENCE files are background only. The result also contains the task goal, source-tagged constraints, the carried-over dirty-work warning, unresolved validation from the previous task, and a next action.
3. Do not immediately run repository-wide `rg`/`grep`/`find`. Search only for a concrete gap the returned ranges do not cover, and keep that search targeted.
4. When `prepare_task_context` succeeds, do not also read DevGuard's markdown (`.devguard/reports/project-handoff.md`, `.devguard/reports/quality-report.md`, `.devguard/prompts/next-codex-prompt.md`, `.devguard/prompts/next-claude-prompt.md`, `.devguard/context/agent-brief.md`, `.devguard/reports/working-context.md`, `.devguard/context/agent-context.md`). They are fallback and human-diagnostic artifacts.

Fresh thread per task (rollover-first):

- When a task is done and the next request is a separate task, recommend continuing in a fresh agent thread and call `prepare_task_context` there.
- If this thread has already handled another task or has been compacted once, move the next task to a fresh thread instead of waiting for another compaction.
- Thread state: `record_validation_result` (and an agent-run `dev-guard done`) report this thread's freshly observed state as `thread.status` — `LOW`, `SOON`, `NEW_THREAD`, or `UNKNOWN` — read from the provider's own usage records. Only the latest one from this task and this thread counts.
- Tell the user at the task boundary: when the latest state is `SOON` or `NEW_THREAD`, end your FINAL reply for the task with the provided `userNotice` sentence (one or two sentences, in the user's language) — `SOON`: start the next large task or separate step in a fresh thread; `NEW_THREAD`: switch to a fresh thread before continuing. Put it after the results, never first.
- Say nothing about threads when the state is `LOW` or `UNKNOWN`, and do not warn in intermediate updates while you are still finishing the same task.

Only when MCP is unavailable or its result is insufficient, in this order:

1. `.devguard/context/agent-brief.md` — compact current-task brief.
2. `.devguard/reports/read-map.md` — file priority.
3. `.devguard/reports/code-map.md` — file-internal ranges.

Only on explicit request:

- `.devguard/reports/project-handoff.md` — when the user explicitly asks to resume previous work (then turn its next action into a concrete task and call `prepare_task_context`), or to debug DevGuard output.
- `.devguard/reports/quality-report.md` — when a person asks for quality details or an explicit QA investigation.

Validation and completion:

- After running a build/test/manual check for the task, report it with `record_validation_result`.
- Finish with `dev-guard done` (or let the installed Stop hook run it). Do not re-open the generated handoff or reports afterwards.

Rules:

- Do not manually edit `.devguard/context/*`, `.devguard/reports/*`, `.devguard/prompts/*`, or `.devguard/runtime.json`; they are generated artifacts.
- Do not make broad unrelated changes.
- Do not invent unsupported DevGuard commands; verify commands with `dev-guard --help`.
<!-- dev-guard-section-end -->
