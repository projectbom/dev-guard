# Architecture

[English](../README.md) | [한국어](../README.ko.md)

dev-guard is a pnpm TypeScript monorepo with a local-first CLI workflow.

```text
packages/
  core/  reusable heuristics, diff intent, task routing, review helpers
  cli/   Node CLI, git/filesystem/config/provider/runtime integration
```

## Current Workflow

The public MVP workflow is event based:

```text
watch
  -> accumulate changed files in .devguard/runtime.json
  -> stable state suggests completion is ready to process
  -> Auto Mode waits for a Claude/Codex Stop Hook

done
  -> collect git diff and pending runtime files
  -> classify changed areas
  -> infer diff intent and drift candidates
  -> append history.jsonl
  -> write last-run report
  -> write history summary
  -> write decision candidates
  -> write quality report
  -> write next Codex/Claude handoff prompt
  -> write project handoff for context overflow recovery
  -> clear pending runtime state

status
  -> show pending files, last run, quality verdict, recent history, next action

reset
  -> clear runtime pending state only
```

In Auto Mode, `watch` itself does not guess completion from time or idle state. A trusted Claude/Codex Stop Hook runs `dev-guard done` when the agent turn ends. In Manual Mode, the user runs `dev-guard done` explicitly.

## Runtime Files

The event workflow uses `.devguard/`:

```text
.devguard/
  project.md
  architecture.md
  decisions.md
  tasks.md
  state.json
  runtime.json
  history.jsonl
  prompts/next-codex-prompt.md
  reports/last-run.md
  reports/history-summary.md
  reports/decision-candidates.md
  reports/quality-report.md
```

These files are generated or project-local. Existing markdown files are not overwritten when the workspace is initialized.

## Advanced Memory And Config

The same `.devguard/` path also stores advanced features:

- `.devguard/config.json`
- `.devguard/task.md`
- `.devguard/runs/`
- `.devguard/project-index.json`
- `.devguard/file-summaries.json`
- `.devguard/code-graph.json`
- `.devguard/project-map.md`

`scan` and `refresh` maintain project memory cache here. The event workflow can reuse this context when available, but the main user flow no longer requires manual scan/refresh.

## Analysis Layers

`done` is rule-based. It does not call an LLM.

Current local layers:

- git diff and untracked file collection
- changed-file area classification
- diff intent inference and clustering
- drift candidate extraction
- documentation update candidate summary
- package.json-based verification command discovery
- completion quality verdict
- handoff prompt rendering

## Safety Boundaries

- No source files are modified by `watch`, `done`, `status`, or `reset`.
- `done` writes only `.devguard/` runtime artifacts.
- `decisions.md` is never auto-edited; candidates go to `reports/decision-candidates.md`.
- `update` remains preview-first and only `update --write` writes managed doc blocks.
- Provider integration is optional and separate from the default event workflow.
