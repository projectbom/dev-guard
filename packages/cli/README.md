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

## Verified Project State

DevGuard is not "AI memory". It records small structured events (task started, validation recorded, outcome, user decision, task closed) and projects them into the current verified state that `prepare_task_context`, the Quality Report, the Handoff and the dashboard all read:

- **Provenance** — `OBSERVED` (DevGuard saw the command and exit code in the agent's own transcript), `AGENT_REPORTED` (the agent's word only), `USER_DECISION` (an explicit user decision, carried — not enforced), `DERIVED` (computed from other evidence).
- **Outcomes** — `PASS`, `FAIL`, `STOPPED` (a safety gate stopped the run on purpose), `BLOCKED` (waiting on approval or an external dependency), `UNKNOWN`. A deliberate stop is never shown as a failure.
- **Freshness** — a validation goes `STALE` only when a file that supports it changes, and `SUPERSEDED` when a later result replaces it. An agent PASS the transcript contradicts is a `MISMATCH`, never "verified".

Agents record outcomes with the MCP tool `record_task_outcome` and explicit user decisions with `record_user_decision` (CLI: `dev-guard record-outcome`, `dev-guard record-decision`). No vector DB, no embeddings, no LLM; everything stays in `.devguard/`, and the Markdown reports are views, not the source of truth.

On first run, `watch` indexes the project (honoring `.gitignore`), builds Project Knowledge, registers the MCP server for Claude Code and Codex, adds a DevGuard section to `AGENTS.md` / `CLAUDE.md` (your own text is kept), and installs completion hooks. In a Git repository it also appends `.devguard/` and `devguard.backup-*/` to `.gitignore` when Git does not already ignore them (existing lines untouched; `AGENTS.md`, `CLAUDE.md` and MCP config are not ignored). An already-tracked `.devguard/` gets a warning — DevGuard never changes the Git index.

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
- [Verified Project State](https://github.com/projectbom/dev-guard/blob/main/docs/verified-project-state.md)
