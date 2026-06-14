# Handoff Files

[English](../README.md) | [한국어](../README.ko.md)

`dev-guard done` writes two handoff files:

```text
.devguard/prompts/next-codex-prompt.md
.devguard/reports/project-handoff.md
```

`next-codex-prompt.md` is a ready-to-paste task prompt. `project-handoff.md` is the compressed context-overflow recovery file for a fresh Claude/Codex thread. The goal is to let the next Claude/Codex session continue safely without pasting a long chat history.

## Prompt Sections

`next-codex-prompt.md` includes:

- `Current Project Context`: summary from `.devguard/project.md`, `architecture.md`, and `decisions.md`
- `Recent Work Summary`: current done result and recent history
- `Changed Files`: changed paths, inferred roles, and areas
- `Risk / Drift Candidates`: what needs attention and how to check it
- `Quality Gate`: PASS / NEEDS_REVIEW / BLOCKED, verification commands, before-commit checklist
- `Do Not Change`: guardrails for the next agent
- `Already Decided / Decision Candidates`: decisions to preserve or manually record
- `Next Task`: one priority task only
- `Verification Commands`: commands discovered from package scripts
- `Completion Report Format`: how the next agent should report back

## Source Inputs

The handoff prompt is rule-based and local. It uses:

- `.devguard/project.md`
- `.devguard/architecture.md`
- `.devguard/decisions.md`
- `.devguard/tasks.md`
- `.devguard/history.jsonl`
- current git diff and untracked files
- package.json scripts

If a project doc is empty or still contains TODO-only content, the prompt says `확인 필요`.

## Safety Rules

- The prompt is generated only when `done` runs.
- It does not grant permission to rewrite unrelated files.
- It includes generated file paths as `Do Not Change`.
- It never stores API keys.
- It is ignored by git by default.

## Typical Use

```bash
dev-guard done
cat .devguard/prompts/next-codex-prompt.md
```

Paste the content into Claude/Codex for the next focused task.

## Context Overflow Recovery

If the Claude/Codex context window is full, regenerate only the compact project handoff:

```bash
dev-guard handoff
cat .devguard/reports/project-handoff.md
```

Start a new Claude/Codex thread and ask it to read `.devguard/reports/project-handoff.md`. The file includes current state, active workflow, recent changes, important decisions, quality status, open risks, one next best task, do-not-change constraints, and a short resume prompt.
