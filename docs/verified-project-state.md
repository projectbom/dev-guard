# Verified Project State

DevGuard is not persistent AI memory. It is a local **verified project-state layer** for coding agents:

> Models plan and code. DevGuard records what actually happened, determines what is still valid, and gives the next agent the current verified state.

No vector database, no embeddings, no LLM and no network calls are involved. Everything stays in `.devguard/`.

## Storage

```text
.devguard/events/task-events.jsonl   append-only structured events (canonical history, bounded)
        ↓  fold (pure) + freshness against the current files
.devguard/state/current.json         the current-state projection (a cache)
        ↓
prepare_task_context `state` · Quality Report · Project Handoff · Dashboard
```

- The **ledger** holds small structured events — never a conversation, a prompt, a diff, an output dump or a summary.
- The **projection** is deterministic. `current.json` can be deleted at any time; the next call rebuilds it from the ledger and the working tree.
- **Markdown** (`quality-report.md`, `project-handoff.md`) renders the projection. It is a view, not the source of truth.
- Every surface reads the same projection, so prepare, the reports and the dashboard cannot disagree about outcome, blockers, decisions or validation state.

### Event types

| Event | Provenance | Carries |
| --- | --- | --- |
| `TASK_STARTED` | OBSERVED | task text (bounded), the task it continues, user-named input paths |
| `VALIDATION_RECORDED` | OBSERVED or AGENT_REPORTED | check identity, status, normalized command, reported/observed exit code, verification, file scope |
| `TASK_OUTCOME_RECORDED` | AGENT_REPORTED | `PASS`/`FAIL`/`STOPPED`/`BLOCKED`/`UNKNOWN`, one-sentence reason, blockedOn, nextIntent, explicit supersedes |
| `USER_DECISION_RECORDED` | USER_DECISION | decision, scope (`TASK`/`LINEAGE`/`PROJECT`), decisions it supersedes |
| `TASK_CLOSED` | OBSERVED | task-owned changed files (≤40 listed, count, fingerprints), carried dirty work as a count + hash |
| `COMMAND_OBSERVED` | OBSERVED | validation-like commands the task ran but never reported, with exit code |
| `STATE_CHECKPOINT` | DERIVED | live state carried into the new file when the ledger rotates (2 MB) |

Staleness and supersession are not events: they are derived from the events and the current files every time the projection is computed.

## Provenance

| | |
| --- | --- |
| `OBSERVED` | DevGuard saw it: the command and its exit code in the agent's own transcript (Codex `CommandExecution`, Claude Code Bash `tool_result`), file fingerprints, DevGuard's own self-check. |
| `AGENT_REPORTED` | The agent said so; DevGuard could not confirm it. Kept as evidence, never upgraded. |
| `USER_DECISION` | An explicit user decision passed through the agent. |
| `DERIVED` | Computed deterministically from other evidence. |

### Matching a reported validation

`record_validation_result` looks up the commands the task's own thread executed since the task began and compares normalized commands (whitespace, quotes, `cd …&&`, env assignments, `2>&1` removed):

| Reported | Transcript | Result |
| --- | --- | --- |
| PASS | same command, exit 0 | `OBSERVED` / `MATCHED` |
| FAIL | same command, non-zero | `OBSERVED` / `MATCHED` |
| PASS | same command, non-zero | `AGENT_REPORTED` / `MISMATCH` |
| any exit code | a different exit code | `AGENT_REPORTED` / `MISMATCH` |
| FAIL | same command, exit 0 | `AGENT_REPORTED` / `UNVERIFIED` (a script that prints a failing verdict but exits 0) |
| anything | piped into `tail`/`head`/`grep` | `AGENT_REPORTED` / `UNVERIFIED` (the exit code is the filter's) |
| anything | not found, or no transcript | `AGENT_REPORTED` / `UNVERIFIED` |

Nothing is invented: without transcript evidence a result stays `AGENT_REPORTED`. A `MISMATCH` is never shown as verified anywhere.

## Task outcomes

| | |
| --- | --- |
| `PASS` | The task objective was completed. |
| `FAIL` | The intended work was attempted and did not meet the expected result ("expected 200, got 500"). |
| `STOPPED` | Execution stopped on purpose because a designed safety/gate condition was reached ("baseline drift detected, stopped before mutation"). |
| `BLOCKED` | Work cannot continue until an external dependency, approval or prerequisite changes ("production mutation needs approval"). |
| `UNKNOWN` | The outcome cannot be established reliably. |

`STOPPED` and `BLOCKED` are not defects. The next task's next action names them as a deliberate stop instead of "unresolved failure".

## Supersession (deterministic, conservative)

- A validation is superseded by a later bound result for the **same check** (`kind::name`) or the **same normalized command**.
- Within one task, its latest outcome is the task's outcome.
- An outcome recorded by a task supersedes the outcome of every task it **continues** (same workstream, or a bare "continue" request), and of tasks it names in `supersedes`.
- A user decision is superseded only when a later decision names it in `supersedes`.
- A later, unrelated task never supersedes anything on its own.

`nextIntent` comes only from the outcome currently in force (or, for a `BLOCKED` outcome with `blockedOn`, the DERIVED "resolve the blocker first"). Otherwise it is `null`; DevGuard does not invent a next task.

## Validation freshness

A validation is bound to the files that support it: the files the task itself touched (new dirty files plus baseline files whose content changed) and the files or directories its command names. It becomes `STALE` when one of those fingerprints changes, or when the task changed more files after the check. An unrelated change elsewhere in a large dirty tree does not stale it. When no safe scope exists (nothing identifiable, or more than 400 files), the check falls back to the whole-working-tree fingerprint — never a false `CURRENT`.

## User decisions

`record_user_decision` stores what the user explicitly said (`Do not deploy to production.`), with a scope: `TASK` (this task and its continuations), `LINEAGE` (default: this line of continued work) or `PROJECT`. A decision is `CURRENT` until a later decision supersedes it (`SUPERSEDED`); a `TASK` decision expires (`EXPIRED`) once unrelated work starts. Decisions are carried, never enforced, and never inferred from casual wording.

## Existing projects

Nothing is migrated destructively. On the first 0.12 call, the ledger starts and the 40 most recent bound validations from `runtime.json` are imported once, marked `legacy` and `AGENT_REPORTED` / `UNVERIFIED` (DevGuard's own self-check stays `OBSERVED`), bound to the whole-tree fingerprint they were recorded with. Old history rows are never rewritten. New history rows store carried-over dirty work as `carriedDirtyCount` + `carriedDirtyHash` instead of thousands of paths; the full finalized file set lives once in `.devguard/state/finalized-files.json`.

## Agent and CLI interface

| MCP tool | CLI |
| --- | --- |
| `record_task_outcome` | `dev-guard record-outcome --status STOPPED --reason "…" [--blocked-on "…"] [--next-intent "…"] [--supersedes <id,…>]` |
| `record_user_decision` | `dev-guard record-decision --decision "…" [--scope LINEAGE] [--supersedes <decisionId,…>]` |
| `record_validation_result` (now returns `provenance` / `verification`) | `dev-guard record-validation …` |

`prepare_task_context` returns a compact `state` block: outcome, active blockers, active decisions, `verified` (observed) and `reported` (agent-only) checks, mismatches, stale/superseded counts and `nextIntent`.
