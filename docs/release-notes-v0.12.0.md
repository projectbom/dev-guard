# DevGuard v0.12.0 — Verified Project State

`@dev-guard/cli` 0.12.0. `@dev-guard/core` is unchanged (0.11.0); no core source or API changed.

DevGuard moves from a local deterministic context broker toward a **local verified project-state layer** for coding agents: models plan and code; DevGuard records what actually happened, determines what is still valid, and gives the next agent the current verified state. See [verified-project-state.md](./verified-project-state.md).

## Highlights

- **Event ledger + one projection.** Small structured events in `.devguard/events/task-events.jsonl` (bounded, 2 MB rotation that re-seeds the new file with a live-state checkpoint) are folded deterministically into `.devguard/state/current.json`. `prepare_task_context`, Quality Report, Project Handoff and the dashboard all read that one projection. `current.json` is a cache and is rebuilt from the ledger whenever it is lost.
- **Provenance.** Every fact is `OBSERVED`, `AGENT_REPORTED`, `USER_DECISION` or `DERIVED`. `record_validation_result` now matches the reported command against the agent's own transcript (Codex `CommandExecution` exit codes, Claude Code Bash tool results): a match is `OBSERVED`/`MATCHED`; a PASS the transcript contradicts is `AGENT_REPORTED`/`MISMATCH` and is never shown as verified; anything unconfirmable stays `AGENT_REPORTED`/`UNVERIFIED`. Output piped into `tail`/`head`/`grep` never confirms a result on its own.
- **Task outcomes.** New MCP tool `record_task_outcome` (CLI `dev-guard record-outcome`): `PASS`, `FAIL`, `STOPPED` (a designed safety gate stopped the run on purpose), `BLOCKED` (waiting on approval or an external dependency), `UNKNOWN`, with one-sentence `reason` / `blockedOn` / `nextIntent`. A deliberate stop is never presented as a failure; the next task's next action names it as a deliberate stop.
- **User decisions.** New MCP tool `record_user_decision` (CLI `dev-guard record-decision`) carries explicit user decisions (`TASK` / `LINEAGE` / `PROJECT` scope) into later tasks until superseded. Carried, never enforced.
- **Deterministic supersession.** A later result for the same check or command supersedes an earlier one; an outcome supersedes the outcomes of the tasks it continues or names explicitly. An unrelated later task never supersedes anything. `nextIntent` comes only from the outcome in force, otherwise `null`.
- **Scoped validation freshness.** A validation is bound to the files the task touched plus the files its command names, not to the whole working tree. A change elsewhere in a large dirty tree no longer stales it; a change to a supporting file does. Without a safe scope it falls back to the whole-tree fingerprint.
- **Bare "Continue the current work."** is expanded deterministically with the continued task's goal and inherits its user-named inputs, so routing and lineage follow that task.
- **History diet.** History rows store carried-over dirty work as `carriedDirtyCount` + `carriedDirtyHash` (and cap path lists at 200 with a count + hash); the full finalized file set lives once in `.devguard/state/finalized-files.json`.
- **Dashboard.** The overview adds STATE, VERIFIED, BLOCKED ON and DECISIONS next to HEALTH; thread pressure stays available.

## Compatibility

- Existing `.devguard/` projects are not migrated destructively. The ledger starts on the first 0.12 call and imports the 40 most recent bound validations once, marked legacy and `AGENT_REPORTED`/`UNVERIFIED` (DevGuard's own self-check stays `OBSERVED`). Old history rows are not rewritten; readers accept both row shapes.
- No new runtime dependency, no vector database, embeddings, LLM or network calls.

## Measurements

Scratch copies and replays of real PartnerFlow history only (the live project was never modified).

- **Provenance:** 164 of 170 matchable agent-recorded validation commands in 102 Codex rollouts classify `OBSERVED` (96.5%); the other 6 are real transcript disagreements.
- **Outcomes:** in 65 replayed real tasks, 41 had deliberate safety stops or approval blocks that the old model surfaced as an "unresolved FAIL" in the next task; all 41 now render as `STOPPED`/`BLOCKED`, and no superseded outcome is ever shown as current.
- **Routing:** 30 real historical requests produce identical TARGET sets and identical full read plans before and after; prepare median 4,964 → 4,965 ms on the 7,255-dirty-file copy; payload median 1,673 → 1,665 estimated tokens. The `state` block itself is ~150–430 tokens.
- **Storage:** history row 1.4 MB → ~3 KB per task on PartnerFlow (7,165 carried dirty files kept as a count + hash); ledger ~6–7 KB per task, so 200 tasks fit in 1.3 MB, inside one 2 MB generation. 200-task fast replay through the production writer/projector: append 0.31 s total, full rebuild 19.5 ms, all state checks pass; at 400 tasks the ledger rotates and state is preserved.
- **Overhead (synthetic 5,000-file repo, 4,600 dirty):** prepare 1.77 → 1.75 s, `record_validation_result` 0.36 → 0.44 s, `record_task_outcome` ~2 ms, `done` unchanged (45.8 s on this fixture both before and after).
