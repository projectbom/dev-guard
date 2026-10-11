# DevGuard v0.10.0

`@dev-guard/cli` 0.10.0 and `@dev-guard/core` 0.10.0 (both packages changed; install them together).

## Highlights

- **Zero-setup first run.** `npm install -g @dev-guard/cli`, then `dev-guard watch` in a project. The first watch validates the root, creates `.devguard/`, builds the Code Index, generates Project Knowledge, writes the DevGuard section of `AGENTS.md` / `CLAUDE.md`, registers the DevGuard MCP server for Claude Code and Codex, installs completion hooks, then opens the dashboard and watches. Later watches print `Project ready.` and refresh only stale parts. `npm install` itself never touches a project.
- **Optional `dev-guard setup [--dry-run]`.** Same preparation engine as `watch` (`prepareProject`), without starting the watcher: prints the detected stack, commands, and integration status. `--dry-run` writes nothing. Never required.
- **API-keyless contract.** setup, watch, MCP (`prepare_task_context`, `record_validation_result`), `done`, reports, dashboard, telemetry, and hooks make no OpenAI calls. AI is an explicit opt-in for `task-ai`, `review` / `fix-prompt`, and the optional `done` Quality Report summary — enabled only by `ai.provider: "openai"` or `DEV_GUARD_OPENAI_API_KEY`. **Behavior change:** a shell-wide `OPENAI_API_KEY` alone no longer makes `done` send the diff to OpenAI. `doctor` shows a missing key as `not configured (optional)`.
- **Structural Project Knowledge freshness.** Knowledge stores a fingerprint of the project file set (paths only, Markdown and dot-paths excluded) plus content hashes of package manifests, framework/TS config, and the CLI router. A new route, component, migration, or workspace now refreshes it; README edits or a touched-but-unchanged `package.json` do not. Knowledge written by 0.9.x is refreshed once.
- **Bounded, concurrency-safe logs.** `history.jsonl`, `memory/change-log.jsonl` (8 MB) and `telemetry.jsonl` (4 MB) rotate to `<file>.1` with a single atomic rename under an exclusive rotate lock; readers merge the live tail with `.1`. No line is lost under concurrent writers, and a crash mid-rotation never hides the latest record.
- **First-run output.** Watch lists only what it did and detected (`✓ Indexed N project files`, `✓ Detected pnpm / TypeScript / Next.js`, MCP/instructions/hooks), and every warning states the problem, its impact, and the action.

## Fixed

- Updating the `dev-guard` table in `.codex/config.toml` could delete the user's tables that followed it (e.g. `[profiles.*]`). The table is now replaced line-by-line up to the next header only.
- A `.mcp.json` that exists but is not valid JSON was replaced by a DevGuard-only file (dropping other servers); it is now left unchanged with a warning.
- Duplicate DevGuard marker sections in `AGENTS.md` / `CLAUDE.md` collapse to one; text outside the markers is preserved.
- The MCP server check spawned `process.argv[1]` instead of the CLI entry shipped next to it.
- An `AGENTS.md`/`CLAUDE.md` write failure no longer aborts preparation; it becomes a warning and the other steps run.

## Changed

- New projects no longer get `docs/PROJECT_STATE.md`, `docs/CURRENT_TASK.md`, `docs/DECISIONS.md`, `docs/DO_NOT_REPEAT.md` templates (MCP and `done` never read them). Existing files are kept and still read by the legacy `prompt` / `review` / `task-ai` / `update` helpers.
- Thread policy wording is hybrid everywhere: a small related follow-up may stay in a low-pressure thread; a separate or large task, a `SOON` / `NEW_THREAD` notice, or a compacted thread moves to a fresh thread.
- Current docs lead with `dev-guard watch`; `setup` is optional; `init` / `install-agent-instructions` / `install-hooks` are Advanced / Recovery. Older release notes carry a "historical record" banner.

## Upgrade

```bash
npm install -g @dev-guard/cli@latest
cd your-project
dev-guard watch
```

The first 0.10 watch in an existing project refreshes the DevGuard section of `AGENTS.md` / `CLAUDE.md`, regenerates Project Knowledge once (new fingerprint), refreshes outdated hook scripts in place, and rotates an oversized `history.jsonl` on the next `done`. If you relied on a shell-wide `OPENAI_API_KEY` for the `done` AI summary, enable it explicitly with `dev-guard configure ai --provider openai`.
