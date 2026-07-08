# Architecture

[English](../README.md) | [한국어](../README.ko.md)

dev-guard is a pnpm TypeScript monorepo with a local-first AI Coding Context Provider workflow.

DevGuard is not an IDE, wrapper, or autonomous coding agent. It provides context before AI work and records context after AI work.

```text
packages/
  core/  reusable heuristics, diff intent, task routing, review helpers
  cli/   Node CLI, git/filesystem/config/provider/runtime integration
```

## Current Workflow

The official context pipeline is:

```text
Prepare
  -> Read Map
  -> Code Map
  -> Agent Brief
  -> Work
  -> Done
  -> Change Intelligence
  -> Quality Report
  -> Handoff
  -> Working Context
  -> Agent Context
  -> Memory Update
```

The public workflow remains event based:

```text
watch
  -> accumulate changed files in .devguard/runtime.json
  -> stable state suggests completion is ready to process
  -> Auto Mode waits for a runtime-verified agent completion strategy

done
  -> collect git diff and pending runtime files
  -> classify changed areas
  -> build one Change Intelligence summary
  -> update memory/code-index.json and memory/change-log.jsonl
  -> append history.jsonl
  -> write last-run report
  -> write history summary
  -> write decision candidates
  -> write read map, code map, and agent brief
  -> write quality report
  -> write next Codex/Claude prompt
  -> write project handoff for context overflow recovery
  -> write working context and agent context
  -> clear pending runtime state

status
  -> show pending files, last run, quality verdict, recent history, next action

reset
  -> clear runtime pending state only
```

In Auto Mode, `watch` itself does not guess completion from time or idle state. Claude Code uses Stop Hook. Codex prefers user-level notify when available; Codex Stop Hook is an advanced option that requires `/hooks` trust. In Manual Mode, the user runs `dev-guard done` explicitly.

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
  memory/code-index.json
  memory/change-log.jsonl
  context/agent-brief.md
  context/agent-context.md
  prompts/next-codex-prompt.md
  reports/last-run.md
  reports/history-summary.md
  reports/decision-candidates.md
  reports/quality-report.md
  reports/project-handoff.md
  reports/read-map.md
  reports/code-map.md
  reports/working-context.md
```

These files are generated or project-local. Existing markdown files are not overwritten when the workspace is initialized.

## Artifact Roles

| Artifact | Role |
| --- | --- |
| Project Knowledge | Long-term project structure memory. |
| Read Map | What the next agent should read first. |
| Code Map | Where to read inside relevant files. |
| Agent Brief | Compact current task brief. |
| Quality Report | QA result and remaining verification. |
| Project Handoff | Next-session work instruction. |
| Working Context | Current work structure and boundaries. |
| Agent Context | Agent rules and operating constraints. |
| Memory | Accumulated local context index and change history. |

One information source should be generated once and then reused. Change Intelligence is the shared source for Quality Report, Handoff, Working Context, Agent Context, Read Map, Code Map, and Agent Brief.

## Feature Classification

Core:

- `.devguard/` local context store
- `watch`, `done`, `status`, `handoff`
- Project Knowledge
- Read Map, Code Map, Agent Brief
- Change Intelligence
- Quality Report, Project Handoff, Working Context, Agent Context
- `.devguard/memory/code-index.json`, `.devguard/memory/change-log.jsonl`

Keep:

- Dashboard
- `install-agent-instructions`
- `install-hooks`
- `knowledge`
- OpenAI-assisted Quality Report summary
- `self-check`, `doctor`
- locale-aware user-facing reports

Experimental:

- `scan`, `refresh`
- `review`, `task-ai`, natural-language task helpers
- `update --write`
- Codex JSONL listener helper
- advanced hook/notify strategies outside the default watch flow

Out of scope for the current product:

- wrapper/intercept runtime
- embeddings or vector DB
- background full-project indexer
- cloud sync
- IDE-specific features

## Memory And Config

The same `.devguard/` path also stores advanced features:

- `.devguard/config.json`
- `.devguard/task.md`
- `.devguard/runs/`
- `.devguard/memory/code-index.json`
- `.devguard/memory/change-log.jsonl`

Memory is a local JSON/JSONL context store. It should help DevGuard understand the project over time without storing full source code or requiring a database.

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
