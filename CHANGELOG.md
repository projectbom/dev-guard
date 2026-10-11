# Changelog

## Unreleased (post-0.9.0)

### Added

- `dev-guard setup [--dry-run]`: first-run command that prepares a project (config, Code Index, Project Knowledge, AGENTS.md/CLAUDE.md section, Claude/Codex MCP, completion hooks, MCP check), prints a summary, and exits. It runs the same `prepareProject` engine as `watch`, so `watch` alone still prepares a new project (zero-config). Idempotent; `--dry-run` writes nothing. It refuses the home directory and `/`.
- `doctor` storage summary (current state / bounded history / logs / saved runs, retention status).

### Changed

- API-keyless contract: the `done` Quality Report AI summary now runs only after an explicit opt-in (`ai.provider: "openai"` or `DEV_GUARD_OPENAI_API_KEY`). A shell-wide `OPENAI_API_KEY` alone no longer sends diffs to OpenAI. `doctor` shows a missing key as `not configured (optional)`; AI-only commands explain that AI is optional.
- `history.jsonl`, `memory/change-log.jsonl` (8 MB) and `telemetry.jsonl` (4 MB) rotate to `<file>.1` past their threshold, keeping the most recent records in the live file. Measured downstream: 14 MB history after one week of watch use.
- New setups no longer create the `docs/PROJECT_STATE.md`, `CURRENT_TASK.md`, `DECISIONS.md`, `DO_NOT_REPEAT.md` templates (not read by MCP or `done`). Existing files are kept and still read by the legacy helpers.
- Thread policy wording is hybrid everywhere (instructions, MCP tool description, rollover advice, `done` output, Next Prompt, docs): a small related follow-up may stay in a low-pressure thread; separate/large tasks, `SOON`/`NEW_THREAD`, or a compacted thread move to a fresh thread.
- Docs unify first run as `npm install -g @dev-guard/cli` → `dev-guard setup` → `dev-guard watch`; `init` / `install-agent-instructions` / `install-hooks` are Advanced / Recovery.
- The `task-ai` prompt preamble puts MCP `prepare_task_context` first, with `.devguard/AI_CONTEXT.md` as the no-MCP fallback.

### Fixed

- MCP setup no longer replaces a `.mcp.json` that exists but is not valid JSON (which dropped the user's other servers); it leaves it unchanged and warns.
- The MCP server check spawns the CLI entry that ships next to it rather than `process.argv[1]`.

## DevGuard v0.9.0

`@dev-guard/cli` 0.9.0 / `@dev-guard/core` 0.9.0 — MCP-first context broker (`prepare_task_context` read plan with explicit inputs, TARGET/CANDIDATE roles and structured ranges), budget-bounded execution lineage, thread ownership and foreign-Stop protection, post-done follow-up safety, observed-only thread pressure with rollover notices, and Context Efficiency dashboard causes. Full notes: [docs/release-notes-v0.9.0.md](docs/release-notes-v0.9.0.md). Releases 0.3–0.8 are described in `docs/release-notes-v*.md` and the git history.

## DevGuard v0.2.0

### Added

- First-run onboarding guidance for `dev-guard status` and `dev-guard doctor`.
- v0.2.0 product-polish audit covering installation, command UX, first-use friction, and release readiness.
- npm package metadata for discovery: descriptions, keywords, homepage, and bugs URL.

### Improved

- README and npm package README now lead with AI coding session continuity, project context persistence, handoff, and next-session recovery.
- `dev-guard init` now points users to the current setup flow: `install-agent-instructions`, then hooks or manual watch/done mode.
- Watch mode docs now emphasize keeping `dev-guard watch` running during an AI coding session and using `done/status` for completion.

### Fixed

- Reduced first-run confusion where `status` recommended `watch` before project initialization.
- Clarified that `prompt` is local prompt generation; OpenAI setup is only needed for AI-backed commands such as `review` and `task-ai`.

### Upgrade

```bash
npm install -g @dev-guard/cli@latest
dev-guard --help
dev-guard doctor
```

