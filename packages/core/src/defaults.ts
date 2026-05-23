import type { DevGuardConfig } from "./types.js";

export const defaultConfig: Required<DevGuardConfig> = {
  allowedPaths: [],
  protectedPaths: [
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    ".github/",
    "infra/",
    "scripts/deploy"
  ],
  docPaths: [
    "README.md",
    "docs/PROJECT_STATE.md",
    "docs/CURRENT_TASK.md",
    "docs/DECISIONS.md",
    "docs/DO_NOT_REPEAT.md"
  ],
  sourcePaths: ["src/", "packages/", "apps/", "lib/", "components/"],
  docsRequiredFor: ["package.json", "pnpm-workspace.yaml", "tsconfig", "src/", "packages/", "apps/"],
  riskIgnoredPaths: ["node_modules/", "dist/", ".next/", "coverage/", ".gitignore", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"],
  ai: {
    provider: "none",
    model: "gpt-4o-mini",
    temperature: 0.2,
    maxTokens: 4000
  }
};

export function mergeConfig(config?: DevGuardConfig): Required<DevGuardConfig> {
  return {
    allowedPaths: config?.allowedPaths ?? defaultConfig.allowedPaths,
    protectedPaths: config?.protectedPaths ?? defaultConfig.protectedPaths,
    docPaths: config?.docPaths ?? defaultConfig.docPaths,
    sourcePaths: config?.sourcePaths ?? defaultConfig.sourcePaths,
    docsRequiredFor: config?.docsRequiredFor ?? defaultConfig.docsRequiredFor,
    riskIgnoredPaths: config?.riskIgnoredPaths ?? defaultConfig.riskIgnoredPaths,
    ai: {
      provider: config?.ai?.provider ?? defaultConfig.ai.provider,
      model: config?.ai?.model ?? defaultConfig.ai.model,
      temperature: config?.ai?.temperature ?? defaultConfig.ai.temperature,
      maxTokens: config?.ai?.maxTokens ?? defaultConfig.ai.maxTokens,
      reasoningEffort: config?.ai?.reasoningEffort ?? defaultConfig.ai.reasoningEffort,
      baseURL: config?.ai?.baseURL ?? defaultConfig.ai.baseURL
    }
  };
}
