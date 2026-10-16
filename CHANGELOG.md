# Changelog

## DevGuard v0.11.1

`@dev-guard/cli` 0.11.1 / `@dev-guard/core` 0.11.0 (unchanged, not republished) — reliability hotfix from the PartnerFlow dogfood audit. No new dependencies.

- **Instruction conflicts are visible.** An obsolete "read DevGuard markdown first" block in `~/.codex/AGENTS.md` or `~/.claude/CLAUDE.md` is now reported by `prepare_task_context` (first warning) and Dashboard health (**Warning**), not only by `doctor`. One shared, stat-cached detector; DevGuard still never edits those files.
- **No DevGuard-development wording in other projects.** Quality Report, Handoff, review items and change summaries no longer contain sentences written for DevGuard's own repository (e.g. "Quality Report QA wording … without changing Dashboard, Handoff, watch") or another product's UI vocabulary; suggested checks come from the project's own verification commands.
- **Disk-full / write-failure hardening.** Atomic state writes delete their own temp file on failure, use bounded backoff (2 attempts for disk-full/permission errors), log a repeated identical failure at most once a minute, and surface it in Dashboard health ("DevGuard cannot save state because the disk is full."). Health recovers on the next successful write without restarting watch; the watch heartbeat backs off while writes fail.
- **Wrong-root MCP diagnostics.** A rejected `projectRoot` now names the MCP root, the requested project, both git toplevels, and likely causes (empty, non-git, or same-name sibling checkout). Still fail-closed; DevGuard never switches roots.

## DevGuard v0.11.0

`@dev-guard/cli` 0.11.0 / `@dev-guard/core` 0.11.0 (core version-aligned, no code changes) — faster `prepare_task_context` (stat-cached working-tree hash, call-scope reuse, ranking hot-path fixes: ~1.66s → ~0.37s on a 10K-file synthetic repo), routing to files outside the ~1,200-file deep Code Index by path, large-repo Project Knowledge (separate bounded budgets for pages, Next.js API routes and HTTP handlers; framework-aware handler sampling; found-vs-kept `coverage`), a compact dashboard (Now / This task / Context flow / collapsed Details, one primary issue, one action), and `.devguard/` / `devguard.backup-*/` added to `.gitignore` on first run in Git repositories (append-only; tracked state is never untracked). No new dependencies. Full notes: [docs/release-notes-v0.11.0.md](docs/release-notes-v0.11.0.md).

## DevGuard v0.10.0

`@dev-guard/cli` 0.10.0 / `@dev-guard/core` 0.10.0 — zero-setup product flow (`dev-guard watch` prepares a new project itself; `dev-guard setup [--dry-run]` is an optional preflight on the same engine), API-keyless by contract (a shell-wide `OPENAI_API_KEY` no longer activates AI), structural Project Knowledge freshness, large-repo first run (git-aware single enumeration, no 2000-file cap, workspace-sampled content reads, no new dependencies), bounded and concurrency-safe JSONL logs, safer MCP/Codex/instruction config updates, and hybrid thread-policy wording. Full notes: [docs/release-notes-v0.10.0.md](docs/release-notes-v0.10.0.md).

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

