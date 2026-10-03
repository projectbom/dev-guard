# Local Development (No npm Publish Required)

[English](./local-development.md)

This covers developing DevGuard against a real downstream project (e.g. a separate repo like `partner-flow`) without publishing to npm on every change. `npm publish` is only needed for an actual release.

## One-Time Setup

```bash
cd packages/cli
pnpm link --global
```

This replaces whatever `dev-guard` was previously resolved from (an npm-registry install, if any) with a symlink to this repo's `packages/cli`. It only needs to be done once — a normal source edit afterward never requires re-linking.

Verify it actually took effect (don't assume — check the resolved binary):

```bash
which dev-guard
cat "$(which dev-guard)"   # the shim's exec line should point at .../dev-guard/packages/cli/dist/index.js
pnpm list -g               # should show @dev-guard/cli@link:... pointing at this repo
```

## Daily Workflow

```bash
# Terminal 1 — leave this running
cd /Users/everyshare/dev/dev-guard
pnpm watch

# Terminal 2 — use the downstream project as normal
cd /path/to/downstream-project
dev-guard status
# Claude / Codex: prepare_task_context, etc.
```

`pnpm watch` runs `tsc -b -w` from the repo root against the root `tsconfig.json`, which has TypeScript project references to both `packages/core` and `packages/cli`. This means editing `packages/core/src/*.ts` rebuilds `core`'s `dist/` automatically, and (because `packages/cli`'s dependency on `@dev-guard/core` is `workspace:*`, resolved via a real symlink in `packages/cli/node_modules/@dev-guard/core`) a plain `dev-guard` invocation picks up the new core code immediately — Node resolves the import at run time, so `cli`'s own `dist/index.js` does not even need to be rebuilt for a pure core-internal change to take effect. `tsc -b -w` still keeps `cli` itself compiled whenever `cli`'s own source, or a type signature `cli` depends on, changes.

No `npm publish`, no version bump, no `pnpm install`, no re-running `pnpm link --global` for ordinary edits.

## Confirming Which DevGuard Is Running

There is no `--version` flag. To check identity directly:

```bash
which dev-guard                 # resolved executable
cat "$(which dev-guard)"        # shim's target path — local repo vs. something else
cat /path/to/that/package.json  # version string, if you need it
```

If a project launches DevGuard's MCP server via `npx --no-install dev-guard mcp` (as generated `.mcp.json` files do), that also resolves through the same `which dev-guard` binary — verified by a live marker test, not assumed, during this setup. It is not pulled from a separate npm-global install even if one exists on the machine.

## Restart Contract

- **CLI invocations** (`dev-guard status`, `dev-guard task-ai`, ...): each call is a fresh process, so a `pnpm watch` rebuild is visible on the very next call. No restart needed.
- **MCP server** (`dev-guard mcp`): this is a long-lived process held open by whatever agent/client started it (Claude Code, Codex). It loads the JS once at start and keeps running — a `pnpm watch` rebuild does **not** reach an already-running MCP process. If you've changed DevGuard source and need the MCP tool itself (not just the CLI) to reflect it, the MCP connection needs to be restarted from the agent side (e.g. reconnect/restart the MCP server in Claude Code or Codex for that project). There is no DevGuard command that does this from the outside — it is the agent client's responsibility to relaunch the server process it owns.

## Downstream Project Notes

- Do not add `@dev-guard/cli` as an npm `dependency`/`devDependency` of the downstream project — it is a local CLI/MCP development tool, not an application runtime dependency. A production build/deploy of the downstream project must not assume `/Users/.../dev-guard` exists.
- `.devguard/` (runtime state: code index, history, logs) is machine-local and regenerated — gitignore it per-project.
- `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `.claude/settings.json`, `.codex/*` are portable project setup (generated once by `dev-guard install-agent-instructions`/`dev-guard install-hooks`/`dev-guard watch`'s first run) and should stay tracked.
