# Configuration And Tracking Policy

[English](../README.md) | [한국어](../README.ko.md)

## Local `.devguard` Files

The `.devguard/` directory is local project state by default. Generated files are ignored:

- `task.md`
- `runs/`
- project memory cache JSON
- `code-graph.json`
- telemetry files

Use documentation examples instead of committing local runtime files.

Example config shape:

```json
{
  "ai": {
    "provider": "none",
    "model": "gpt-4o-mini"
  }
}
```

## Rules And Mistakes

For this public dev-guard repository, `.devguard/rules.md` and `.devguard/mistakes.md` are not tracked by default. Project-specific rules should live in each consuming project, not in the published dev-guard source package.

If a project wants to share rules with its team, it can explicitly unignore or commit those files in that project.

## API Keys

Do not store API keys in `.devguard/config.json`, markdown files, or run logs. Use environment variables such as `OPENAI_API_KEY`.
