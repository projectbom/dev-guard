# Task AI And Prompt Generation

[English](../README.md) | [한국어](../README.ko.md)

`dev-guard "<requirement>"` is the default task prompt flow. Advanced users can call `dev-guard task-ai "<requirement>"` directly.

## Requirement Anchoring

The current user requirement is the anchor. Existing `.devguard/task.md`, saved runs, docs summaries, and project memory can help, but they should not replace the current request.

## Task Type Router

dev-guard classifies requests before selecting files. Supported broad task types include:

- `ui_text_cleanup`
- `ui_polish`
- `bugfix`
- `feature_add`
- `architecture`
- `i18n`
- `refactor`
- `migration`
- `performance`
- `styling`
- `docs`
- `infra_config`

Bugfix requests can also receive subtypes such as navigation/state, persistence, rendering, text content, API error, or build error.

## File Selection

File selection uses generic relevance scoring:

- request keywords vs path tokens
- file-summary keywords
- category and route segment matches
- component/function/export names
- related features from scan cache
- scoped recent memory when relevant

Debug output can show scores and reasons:

```bash
dev-guard task-ai "Fix navigation state" --debug-context
```

## Completion Criteria

Task prompts include completion criteria so build success is not treated as the only definition of done. For example:

- UI text cleanup should check wording consistency and avoid logic changes.
- i18n work should check resource parity and hardcoded user-facing strings.
- architecture or migration work should include phasing and rollback/verification.

## Provider Fallback

Without an AI provider, the simplified `dev-guard "<requirement>"` flow uses a local heuristic task skeleton. Advanced `task-ai` requires a configured provider.
