# Changelog

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

