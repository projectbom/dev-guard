# dev-guard

[한국어 README](https://github.com/projectbom/dev-guard/blob/main/README.ko.md)

Long AI coding sessions eventually hit context compaction: the thread is summarized, details are lost, and the agent drifts. Starting a new session avoids that, but then the agent has to learn the project all over again — searching the repository, re-reading files, rediscovering what was just done.

**DevGuard bridges that gap.** It keeps the project and task context locally in `.devguard/` and hands it to Codex / Claude at the start of every task, so a fresh session starts from the right files instead of from zero.

- **No OpenAI API key needed.** The whole workflow runs locally and deterministically.
- **No separate AI agent.** DevGuard does not write code and, by default, never calls an LLM; it only prepares and preserves context for the agent you already use.

## Quick Start

```bash
npm install -g @dev-guard/cli
```

```bash
cd my-project
dev-guard watch
```

That's it. The first `watch` prepares the project automatically and starts watching; later runs reuse the cached analysis and start immediately.

## How It Works

- **Before a task** — your agent calls the DevGuard MCP tool `prepare_task_context` with the task. It returns which files and line ranges to read first, the constraints, and anything left unresolved from the previous task.
- **During work** — `dev-guard watch` tracks changes and opens a local dashboard (`127.0.0.1` only).
- **After a task** — DevGuard records what changed and what was verified, so the next session picks up from there.

On first run, `watch` indexes the project (honoring `.gitignore`), builds Project Knowledge, registers the MCP server for Claude Code and Codex, adds a DevGuard section to `AGENTS.md` / `CLAUDE.md` (your own text is kept), and installs completion hooks.

## Optional

```bash
dev-guard setup --dry-run   # preview what DevGuard would set up, without writing
dev-guard doctor            # check integrations
```

`dev-guard setup` is never required. AI-assisted extras (`task-ai`, AI `review`) are opt-in and are the only features that use an OpenAI key.

## Documentation

- [Korean README](https://github.com/projectbom/dev-guard/blob/main/README.ko.md)
- [English README](https://github.com/projectbom/dev-guard#readme)
- npm install & usage guide: [English](https://github.com/projectbom/dev-guard/blob/main/docs/npm-setup.md) · [한국어](https://github.com/projectbom/dev-guard/blob/main/docs/npm-setup.ko.md)
