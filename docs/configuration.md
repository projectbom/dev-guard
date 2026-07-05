# Configuration And Tracking Policy

[English](../README.md) | [한국어](../README.ko.md)

## Local Runtime Files

The current event-based workflow writes runtime artifacts under `.devguard/`:

- `runtime.json`
- `state.json`
- `history.jsonl`
- `reports/`
- `prompts/`
- optional project notes such as `project.md`, `architecture.md`, `decisions.md`, and `tasks.md`

These are local by default. They are generated to help `watch`, `done`, `status`, and handoff prompts.

## Legacy `devguard/` Migration

`.devguard/` is the official internal directory.

If a project only has the legacy `devguard/` directory, dev-guard migrates it to `.devguard/`.

If both `.devguard/` and `devguard/` exist, dev-guard does not merge or delete user data automatically. `status` warns about the legacy directory. With forceful hook installation, legacy data is moved to a timestamped backup directory such as `devguard.backup-YYYYMMDD-HHmmss/`.

## Local `.devguard` Files

The `.devguard/` directory is local project state by default. Generated files are ignored:

- `task.md`
- `runs/`
- project memory cache JSON
- `code-graph.json`
- telemetry files
- runtime state, reports, logs, hooks, and prompts

Use documentation examples instead of committing local runtime files.

Example config shape:

```json
{
  "locale": "ko-KR",
  "ai": {
    "provider": "none",
    "model": "gpt-4o-mini"
  }
}
```

`locale` is optional. Supported values are `en-US` and `ko-KR`. If it is missing, DevGuard uses OS locale variables (`LC_ALL`, `LC_MESSAGES`, `LANG`) and then falls back to `en-US`. User-facing outputs follow this locale; AI-facing prompts and internal state stay in English. Changing language in the dashboard updates the same `.devguard/config.json` locale.

## Rules And Mistakes

For this public dev-guard repository, `.devguard/rules.md` and `.devguard/mistakes.md` are not tracked by default. Project-specific rules should live in each consuming project, not in the published dev-guard source package.

If a project wants to share rules with its team, it can explicitly unignore or commit those files in that project.

## API Keys

DevGuard works without an OpenAI API key. When no key is configured, Quality Reports use local rule-based guidance and commands still succeed.

OpenAI API key resolution order:

1. `.devguard/config.json` via `dev-guard config set openaiApiKey <key>` or the dashboard setting
2. `DEV_GUARD_OPENAI_API_KEY`
3. `OPENAI_API_KEY`
4. no key, local rule-based fallback

DevGuard never prints the key and the dashboard API only reports whether a key is configured. If you store a key in `.devguard/config.json`, treat that file as a local secret and keep it out of git.
