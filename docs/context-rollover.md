# Context Rollover And Resume Cost

[English](./context-rollover.md)

DevGuard's goal is not to help one AI session survive forever under context
compaction. It is to make starting a *new* session cheap enough that rolling
over is usually the better move. This page covers the two small, additive
pieces that support that: resume cost estimation and the Context Rollover
signal.

## Resume Cost (`estimatedTokens`)

`packages/core/src/context-cost.ts` exposes a provider-independent size
estimate (`estimateTokens`, `measureArtifactText`, `summarizeArtifactCosts`).
It is a plain character-count heuristic (`chars / 4`), not a real tokenizer —
DevGuard has no access to any AI provider's actual token accounting, so these
numbers are always reported as **approximate**, used only to compare
DevGuard's own artifacts against each other over time, never as a provider
billing/usage figure.

`packages/cli/src/rollover.ts`'s `measureResumeBundleCost(root)` applies this
to the six "before-agent" markdown artifacts (`agent-brief.md`, `read-map.md`,
`code-map.md`, `working-context.md`, `agent-context.md`,
`next-claude-prompt.md`) — the fallback bundle an agent reads when it does not
rely solely on `prepare_task_context`'s structured MCP result. `prepare_task_context`
now returns this as `resumeCost` on every call, so both a human (`dev-guard status`)
and an agent (the MCP result itself) can see how large that fallback bundle has
grown without reading it.

## Context Rollover Signal

`computeRolloverAssessment` in the same file produces one of:

- `SAFE`
- `ROLL_OVER_SOON`
- `ROLL_OVER_RECOMMENDED`

from DevGuard-owned signals only — pending changed file count, validations
recorded for the CURRENT task (an all-time count used to pin every mature
project at `ROLL_OVER_RECOMMENDED`), current task age, and the estimated
resume-bundle size above. **It never reads or guesses any AI provider's actual context-window
usage** — there is no portable, official API for that, and doing so would be
exactly the kind of unverifiable claim this feature has to avoid. It is a
recommendation for a human to act on (start a new AI session and call
`prepare_task_context` there), not something DevGuard enforces automatically.

Any single signal already past its own budget floors the status at
`ROLL_OVER_SOON`, even if every other signal is quiet — an oversized resume
bundle should not be averaged away into `SAFE` by unrelated quiet signals.

This is surfaced in two places, from the same computation:

- `dev-guard status` — a human-readable `Context Rollover: ...` line.
- `prepare_task_context`'s MCP result — a `rollover` field an agent can read
  directly, alongside the existing `files`/`constraints`/`warnings`.

## Rollover-First Workflow

DevGuard cannot shorten or speed up a provider's own context compaction, and
it cannot see the provider's context window. What it can do is make a fresh
thread cheap. A real downstream audit found one agent thread kept open for
23 hours through 8 compactions while every task start already had a small
MCP context available. The intended loop is:

1. Task done (`dev-guard done` or the Stop hook).
2. Next distinct task → open a fresh agent thread (or move after the first
   compaction at the latest).
3. `prepare_task_context` → read the returned ranges → targeted search only
   for a concrete gap.

`dev-guard done`, the Next Prompt, the Handoff resume prompt, the agent
instructions, and the MCP result's `rollover.advice` all state this.

## Agent Payload

The MCP tool sends `toAgentContextPayload(result)`, serialized without
indentation: task, `nextAction`, files with ranges (excluded-by-task files
labelled `Reference`), source-tagged `constraints` (`[task]` /
`[project config]`, never a fixed default list), `scope` (carried-over dirty
work as a count + warning), current-task validation, `openValidation` (the
previous task's FAIL/UNKNOWN results), and `rollover`. Duplicated artifact
paths and per-artifact cost rows are omitted; the markdown fallbacks are named
once under `fallbackOnly`. Agent instructions tell agents not to read
handoff/quality/next-prompt markdown when this result is sufficient.

## Validation Summary In `prepare_task_context`

`prepare_task_context`'s result also carries `validation`: fresh/stale/unbound
validation-evidence counts plus the 10 most recent fresh entries. It reuses
the exact same freshness rule Quality Report/Handoff use
(`partitionQaResultsByFreshness`/`isEvidenceFresh`) rather than re-deriving a
separate notion of "current" — so an agent can tell whether passing evidence
already exists for the current code state without opening Quality Report.

## Single Resolution Path

Read Map, Code Map, Working Context, and Agent Brief used to each
independently re-read project state, runtime state, recent history, Project
Knowledge, and the Code Index, and `prepare_task_context` read all of that a
second time afterward on top of that. `loadResumeRawInputs`/`ResumeRawInputs`
in `runtime-state.ts` now load that once per `prepare_task_context` call and
pass it through; each renderer still works standalone (with its own reads)
for any other caller that does not pass a preloaded snapshot — see
[architecture.md](./architecture.md#single-resolution-path-prepare_task_context).

## Local Development (no npm publish required)

`packages/cli`'s dependency on `@dev-guard/core` is `workspace:*`, so pnpm
always resolves it to the local `packages/core` build, not the last published
version. `pnpm publish` rewrites `workspace:*` to a real semver range at
publish time, so this is safe for releases too.

To try local DevGuard source changes against a separate downstream project
(e.g. `partner-flow`) without publishing:

```bash
# in dev-guard
pnpm -r build          # or: pnpm --filter @dev-guard/cli watch (tsc -b -w)
cd packages/cli && pnpm link --global

# in the downstream project
pnpm link --global @dev-guard/cli
dev-guard --help        # now resolves to your local build
```

Run `pnpm --filter @dev-guard/cli watch` (or the same in `packages/core`)
during active development so `dist/` stays current without re-running
`pnpm build` after every edit.

## TARGET / CANDIDATE / REFERENCE

`prepare_task_context` marks every suggested file with a role:

- **TARGET** — read first. Explicitly named files, or top-ranked files (within
  60% of the best score, max 3) that also have a strong signal: an
  identifier-shaped task token used in the file (exact or contained), a
  *rare* task word in the path (rarity from the Code Index), or same-workstream
  continuity.
- **CANDIDATE** — open only when the targets leave a concrete gap. Docs for a
  non-docs task, tests for a task that never mentions tests and UI files for a
  non-UI task can only be TARGET through one of the strong signals above.
- **REFERENCE** — background, e.g. a scope the task explicitly excludes.

The agent payload gives targets up to 3 ranges and others 1, lists targets
first, and tells the agent not to batch-read every file. Same-workstream
continuity: when the previous finalized goal shares ≥2 rare terms with the
current task, that task's own changed files that share a rare term become
low-cost candidates (never carried-over dirty files).

## Context Efficiency Dashboard

The dashboard's Context Efficiency panel is problem-first. The default view
answers five questions — is it OK (health), what is wrong (one issue + why),
what to do (one action), should this thread continue (thread + reason), and
the current task — then shows four numbers (suggestions used, repository
searches, context overhead, open blockers), one focus sentence and one "where
context went" bar. Trends, provided-vs-searched details, timeline, work mode,
the agent's task packet and sources are under "View details".

- **Sources.** DevGuard telemetry (task windows, provided files/targets,
  validation, completion). Codex local session logs (`item_completed`
  commands/MCP calls/file changes/compactions, `token_count` context usage,
  `session_meta` thread identity). A Claude Code adapter is an interface stub.
- **Measurement.** Commands are classified from the complete command text;
  Codex's `parsed_cmd.cmd` is a truncated display string and never decides
  scope. Searches are `broad` (repository root), `targeted` (a file or
  directory), `external` (outside the project, e.g. agent memory — not a
  repository search) or `unknown` (never promoted to broad). Reads include
  multi-file `cat`/`sed`, shell loops and inline scripts' string-literal
  paths that exist in the repository; `git status/log` read no file.
- **Health.** Deterministic issues — compaction or ≥60% observed context use,
  DevGuard doc re-reads, repository-wide search, suggested files read once and
  unused (≥3 files, ≥3K tokens), suggestions missed, context overhead ≥15%,
  exploration-heavy. No issue → GOOD; ≥2 strong (or 1 strong + 2 more) → POOR;
  otherwise NEEDS ATTENTION.
- **Thread.** CONTINUE / SOON / NEW THREAD from observed pressure (compaction,
  the agent log's own input/context-window figures — never estimated), thread
  reuse and a deterministic workstream relation (shared goal words, shared
  files; UNKNOWN is never treated as different). A finished task alone is not a
  reason for a new thread: heavy (≥70%) → NEW THREAD, moderate (≥45%) or
  3+ tasks in the thread → SOON, light → CONTINUE for the same workstream.
- **Evidence.** Observed = directly recorded; Estimated = text-size
  approximation (chars/4), not provider tokens; Inferred = rule-based.
- **Privacy.** Stored/returned: timestamps, hashed thread ids, categories,
  repo-relative read/edit paths, estimated token counts, observed context-use
  numbers, durations. Never stored: prompts, responses, command text or output,
  source content, search queries, reasoning.
