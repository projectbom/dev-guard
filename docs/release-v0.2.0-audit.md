# DevGuard v0.2.0 Product Polish Audit

## Installation Audit

### Friction Points

- `dev-guard doctor` in an empty directory reports that `.devguard` exists because reading runtime state creates workspace files. First-time users can see partial project state before `dev-guard init`.
- `dev-guard status` before setup shows `Quality: unknown` and recommends `dev-guard watch`, but the better first action is `dev-guard init` or `dev-guard install-hooks`.
- `dev-guard init` ends with the older task-generation next step: edit `.devguard/task.md`, then run `scan` or `task-ai`. This is not aligned with the current session-continuity quick start.
- `dev-guard done` after only `install-agent-instructions` can produce `Quality: BLOCKED` because new `AGENTS.md` / `CLAUDE.md` are untracked. This is correct for commit safety but surprising during onboarding.
- `dev-guard watch` may hit OS file descriptor limits and prints a good recovery list, but first-time docs do not surface `--poll` / `--depth 4` early enough.
- `dev-guard prompt` fails clearly outside a git repository, but after `init` it can generate a generic prompt before the user has written a task. That is useful but not obviously positioned.

### Missing Documentation

- Package metadata lacks npm discovery fields: `description`, `keywords`, `homepage`, and `bugs`.
- README explains the main flow, but the first 60 seconds still mix npm install, monorepo development, linking, and consuming-project setup in one Quick Start.
- README does not show a compact "daily loop" before the detailed workflow.
- `prompt` is documented as an advanced command, but the first-use purpose is not clear: it generates a Codex-ready prompt from current DevGuard context and git diff; it does not call OpenAI.
- First-run docs should explicitly say `done` can create handoff/status files even when no agent hook is installed.

### Confusing Commands

- `install-hooks` and `install-agent-instructions` are distinct but adjacent. Names are accurate, but users may not know they need both.
- `done` is intuitive after a task, but its quality output can feel like an error when onboarding files are merely untracked.
- `prompt` overlaps conceptually with generated `.devguard/prompts/next-codex-prompt.md`; one is an explicit prompt-generation command, the other is produced by `done`.
- `status` is useful, but before init it does not make the onboarding path obvious enough.

### Recommended Fixes

- Add first-run guidance to `status` when project files are missing: run `dev-guard init`, then `dev-guard install-agent-instructions`, then optionally `dev-guard install-hooks`.
- Update `init` next steps to match v0.2.0 onboarding: install agent instructions, install hooks or use manual mode, then run watch/status.
- Add a short README "60-second flow" that separates installed CLI usage from monorepo development.
- Surface `watch --poll` and `watch --depth 4` in the watch docs as the first fix for file descriptor errors.
- Add package metadata for npm discovery and user trust.
- Keep command names as-is for v0.2.0; no alias is necessary yet.

## README Optimization

### Findings

- Hero positioning should stay practical: AI coding session continuity, local context persistence, handoff, and next-session recovery.
- The README should show npm install and first project setup before monorepo development commands.
- No screenshot is required for v0.2.0. Command examples are more useful for this CLI stage.
- Common use cases should be visible before detailed hook strategy sections.

### Applied Fixes

- Rewrote the README opening to state that DevGuard keeps context, changed files, quality checks, and handoff prompts in `.devguard/`.
- Added a compact daily loop and resume example.
- Moved local monorepo development commands below the installed CLI path.
- Kept OpenAI setup scoped to AI-backed commands only: `review` and `task-ai`.

## Command UX Review

### Findings

- `init`: solves project bootstrap, but previous next step emphasized older task-generation flow.
- `status`: solves "what is current DevGuard state?", but before init it did not guide first-time users to setup.
- `doctor`: solves environment/config diagnostics, but before init it needs an explicit setup hint.
- `watch`: command name is intuitive and documented. It should keep emphasizing observer-only behavior and manual fallback.
- `done`: command name is intuitive for completion, but quality warnings are expected when onboarding files are untracked.
- `prompt`: useful local prompt generation, but it overlaps conceptually with generated next prompt files. Documentation now clarifies it is local prompt generation, not an OpenAI call.

### Low-Risk Improvements Applied

- `dev-guard init` now points to `install-agent-instructions`, then `install-hooks` or manual `watch --manual` / `done`.
- `dev-guard status` now detects missing project setup files and recommends `dev-guard init`.
- `dev-guard doctor` now prints a setup hint when project setup files are missing.

## Fresh Machine Simulation

### Simulated Commands

```bash
dev-guard doctor
dev-guard init
dev-guard install-agent-instructions
dev-guard watch --poll --depth 4
```

### Findings

- `doctor` works before init and now prints a setup hint.
- `init` creates the expected `.devguard/` and docs files.
- `install-agent-instructions` creates `AGENTS.md` and `CLAUDE.md`.
- `watch --poll --depth 4` starts cleanly in the test environment and gives manual fallback guidance when hooks are not installed.
- Plain `watch` may hit OS file descriptor limits in constrained environments; the existing recovery text is good, and docs should keep `--poll` / `--depth 4` visible.

## Release Readiness Review

### Package Metadata

- Root, core, and CLI package versions are prepared as `0.2.0`.
- `@dev-guard/cli` depends on `@dev-guard/core@0.2.0`.
- Package metadata now includes description, keywords, homepage, bugs URL, repository, license, `bin`, and `files`.
- `npm pack --dry-run` succeeds for `@dev-guard/core` and `@dev-guard/cli`.

### Remaining Manual Step

- Do not publish automatically. Manual publish should happen only after final review, commit, and tag.
