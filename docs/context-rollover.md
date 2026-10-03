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

from DevGuard-owned signals only — pending changed file count, recorded
validation count, current task age, and the estimated resume-bundle size
above. **It never reads or guesses any AI provider's actual context-window
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
