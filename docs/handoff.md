# Handoff Files

[English](../README.md) | [한국어](../README.ko.md)

`dev-guard done` writes two handoff files:

```text
.devguard/prompts/next-codex-prompt.md
.devguard/reports/project-handoff.md
```

`next-codex-prompt.md` is a compact execution prompt. `project-handoff.md` is the compressed context-overflow recovery file for a fresh Claude/Codex thread. The goal is to let the next Claude/Codex session continue safely without pasting a long chat history.

## Role In The Context Pipeline

Handoff is only one part of the DevGuard context pipeline:

- `read-map.md`: what the next agent should read first.
- `code-map.md`: where to read inside the relevant files.
- `agent-brief.md`: compact current-task brief.
- `quality-report.md`: QA result and remaining verification.
- `project-handoff.md`: next-session work instruction.
- `working-context.md`: current work structure and boundaries.
- `agent-context.md`: agent rules and operating constraints.

These documents should not each invent a new summary. They reuse the same Change Intelligence and render it for different readers.

## Prompt Sections

`next-codex-prompt.md` includes:

- `Next`: the smallest executable next step
- `State`: goal, completion status, quality verdict, and verification commands
- `Changed`: semantic change summary plus compact file list
- `Outstanding`: unresolved warnings or blocked items
- `Context`: recent session context and project knowledge pointer
- `Guardrails`: scope constraints for the next agent

`project-handoff.md` is even more compressed. It is ordered by quality state:

- `BLOCKED`: `Outstanding` and `Quality` come first.
- `NEEDS_REVIEW`: `Goal`, `Outstanding`, `Quality`, then `Next`.
- `PASS`: `Goal`, `Next`, and `Changed` come first.

It also includes a short `Handoff Quality` self-check with coverage, redundancy, and readability.

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
- It never includes API keys in generated handoff or prompt text.
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

Start a new Claude/Codex thread and ask it to read `.devguard/reports/project-handoff.md`. The file includes `Goal`, `Outstanding`, `Quality`, `Next`, `Changed`, `History`, `Project`, and a short resume prompt.
