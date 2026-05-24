# Architecture Notes

[English](../README.md) | [한국어](../README.ko.md)

dev-guard is a pnpm TypeScript monorepo.

```text
packages/
  core/  Rule-based analysis, task routing, prompt generation, review helpers
  cli/   Node.js CLI, filesystem/git/config/provider integration
```

## Design Goals

- Keep reusable analysis in `packages/core`.
- Keep filesystem, git, clipboard, and terminal behavior in `packages/cli`.
- Make provider integration optional.
- Keep default behavior preview-first and local-first.
- Avoid project-specific hardcoding.

## Project Memory

`dev-guard scan` and `dev-guard refresh` write project-local memory under `.devguard/`:

- `project-index.json`
- `file-summaries.json`
- `code-graph.json`
- `project-map.md`
- `project-identity.json`

Project identity includes the project root, package name, git remote, framework/runtime hints, and fingerprint. This is used to reduce cross-project context contamination.

`code-graph.json` is a lightweight, heuristic graph for TypeScript/Node-style projects. It stores resolved relative imports, export hints, reverse dependencies, and compact impact candidates. It is not a full AST or compiler-backed graph.

## Context Selection

Task generation prioritizes current user requirements over older context:

```text
requirement > current code context > task subtype context > previous runs/docs
```

Older runs and stale docs are treated as hints, not as the source of truth.

## Prompt Density

Prompts can be compacted by task type and budget. Guardrail-critical sections such as `TASK`, `TYPE`, `PROTECT`, `SUCCESS`, and `VERIFY` should remain present even in ultra-compact prompts.

## Safety Boundaries

- `update` previews only.
- `update --write` writes managed blocks only.
- `watch` refreshes memory only by default.
- API keys are never stored in config or markdown files.
