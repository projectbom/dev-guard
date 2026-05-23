export const configTemplate = {
  allowedPaths: [],
  protectedPaths: ["pnpm-lock.yaml", ".github/", "infra/", "scripts/deploy"],
  docPaths: ["README.md", "docs/PROJECT_STATE.md", "docs/CURRENT_TASK.md", "docs/DECISIONS.md", "docs/DO_NOT_REPEAT.md"],
  sourcePaths: ["packages/", "src/", "apps/", "lib/", "components/"],
  docsRequiredFor: ["package.json", "pnpm-workspace.yaml", "tsconfig", "packages/", "src/", "apps/"],
  ai: {
    provider: "none",
    model: "gpt-4o-mini",
    temperature: 0.2,
    maxTokens: 4000
  }
};

export const taskTemplate = `# Current Task

Describe the exact request scope before running AI/Codex work.

## Goal
- 

## Allowed Paths
- 

## Out of Scope
- 
`;

export const rulesTemplate = `# Dev Guard Rules

- Keep changes inside the current task scope.
- Avoid unrelated formatting churn.
- Do not modify protected or deployment paths unless the task explicitly asks for it.
- Update project docs when behavior, architecture, setup, or decisions change.
`;

export const mistakesTemplate = `# Mistakes To Avoid

- Expanding the task into unrelated refactors.
- Changing files that were already working without a task reason.
- Forgetting to update docs after changing project behavior or setup.
`;

export const projectStateTemplate = `# Project State

Document the current stable project shape, setup, and known constraints.
`;

export const currentTaskTemplate = `# Current Task

Mirror the active .devguard/task.md in a human-readable project doc when useful.
`;

export const decisionsTemplate = `# Decisions

Record important technical decisions and why they were made.
`;

export const doNotRepeatTemplate = `# Do Not Repeat

Record mistakes, regressions, and patterns that should not be repeated.
`;
