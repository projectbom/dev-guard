# DevGuard v0.9.0

`@dev-guard/cli` 0.9.0 and `@dev-guard/core` 0.9.0 (both packages changed; install them together).

## Highlights

- **MCP-first context broker.** `prepare_task_context` is the primary context source for every new task. It returns one deterministic read plan (`readPlan`): TARGET files first, CANDIDATEs only for a concrete gap, REFERENCE files as background, with estimated sizes (characters / 4, never provider tokens). DevGuard's markdown reports are fallback and diagnostic artifacts only.
- **Explicit inputs.** Files the user names are passed as `explicitInputs` and planned as TARGETs ahead of DevGuard's own suggestions. One-hop references from structured target documents are added to the same plan.
- **Structured ranges.** Markdown sections, JSON key blocks and top-level script functions instead of whole files; small files are a single `WHOLE_FILE` read.
- **Execution lineage.** At `done` DevGuard records, paths only and bounded, which scripts a task ran, read and wrote. The next task in the same workstream gets them as candidates: up to 4 always, up to 8 while the lineage fits an estimated 12K-token budget. Tests, validation helpers and disposable probes rank last. After a step that ran no script, the last execution step's scripts are still offered. A different workstream inherits nothing.
- **Thread ownership.** A task is bound to the provider thread that prepared it. A Stop hook from a different thread (for example the previous thread after a rollover) is ignored and leaves the task untouched.
- **Post-done safety.** Edits after `done` are finalized as that task's follow-up, measured against the task's own completion baseline — never as the whole dirty tree. A validation recorded right after `done` binds to the task just closed. Ephemeral bytecode caches (`__pycache__/`, `*.pyc`, `*.pyo`) are no longer treated as changes.
- **Rollover notices.** `record_validation_result` and the agent's own `dev-guard done` report the thread's observed state (`LOW` / `SOON` / `NEW_THREAD` / `UNKNOWN`) from the provider's own usage records, with a one-line `userNotice` for the agent's final reply on `SOON` / `NEW_THREAD`. No context percentage is ever estimated. At a task boundary, observed per-task growth can raise a thread that is still under 50% to `SOON`. The next `prepare_task_context` refines this with the new task's text.
- **Context Efficiency dashboard.** A problem-first view: one issue, why, one action, and thread advice. `MISSING_EXECUTION_CONTEXT` now names its cause: the previous run's scripts exceeded the lineage budget, an older executor was beyond the look-back, or no task had recorded the scripts.
- **Performance.** Code index hydration and prepare-path resolution are measured and bounded. Hook logs rotate.

## Fixed In This Release

- Task-growth samples are paired per task. A lineage re-opened with `continueCurrentTask` is no longer measured from an earlier task's start, which had inflated typical growth.
- At `done` the boundary check is a headroom risk, not a forecast. It no longer escalates a mid-usage thread straight to `NEW_THREAD` before the next task is known.
- The same-workstream gate result now reaches the lineage planner. Before, lineage was offered only when a planned file sat next to it.
- A deleted `__pycache__/*.pyc` no longer produces a false `TASK_FOLLOWUP_FINALIZED`.

## Compatibility

- MCP tools are unchanged in shape. `prepare_task_context` still requires `task`; `explicitInputs` and `continueCurrentTask` stay optional. `serverInfo.version` reports the installed CLI version.
- State is backward compatible. New fields are optional; history and runtime written by 0.8.x load as before. Records without the new workstream link fall back to no older-executor look-back.
- Global instruction files such as `~/.codex/AGENTS.md` are never edited. If yours still has the legacy "read `project-handoff.md` / `quality-report.md` first" block, remove it by hand; `dev-guard doctor --agents` reports it.

## Upgrade

```bash
npm install -g @dev-guard/cli@0.9.0
dev-guard --help
dev-guard install-agent-instructions --force
dev-guard doctor --agents
```

## Validation

- Clean build (`rm -rf packages/*/dist && pnpm -r build`) and `node --test packages/cli/test/*.test.js`: 280/280 pass.
- `npm pack` of both packages and a scratch install of the two tarballs: CLI help, MCP startup, `serverInfo.version` 0.9.0, `prepare_task_context` schema.
- Internal lineage replay on one downstream project's recorded history (9 task pairs): offered-lineage precision 37% → 41% and recall 22% → 30% against the scripts the next task actually ran or read. These are internal measurements, not a guarantee of reduced total context.
