import { defaultConfig, type AIConfig, type AIProviderName, type DevGuardConfig } from "@dev-guard/core";
import { fromRoot, readJsonFile, readTextFile, writeTextFile } from "./fs.js";

interface PackageJsonConfig {
  devGuard?: DevGuardConfig;
}

export interface ResolvedConfig {
  config: DevGuardConfig;
  source: string;
  warnings: string[];
}

const configCandidates = [".devguard/config.json", ".devguardrc", "devguard.config.json"];

export async function loadConfig(root: string, cliAI: Partial<AIConfig> = {}): Promise<ResolvedConfig> {
  const warnings: string[] = [];
  const local = await loadLocalConfig(root, warnings);
  const env = envConfig();
  const merged = mergeDevGuardConfig(defaultConfig, env, local.config, { ai: cliAI });

  return {
    config: merged,
    source: local.source,
    warnings
  };
}

export async function writeConfigValue(root: string, key: string, value: string): Promise<DevGuardConfig> {
  const configPath = fromRoot(root, ".devguard/config.json");
  const current = await readJsonFile<DevGuardConfig>(configPath, defaultConfig);
  const next = applyConfigValue(current, key, value);
  await writeTextFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function printConfigSummary(label: string, resolved: ResolvedConfig): void {
  const ai = resolved.config.ai ?? {};
  console.log(label);
  console.log(`- provider: ${ai.provider ?? defaultConfig.ai.provider}`);
  console.log(`- model: ${ai.model ?? defaultConfig.ai.model}`);
  console.log(`- temperature: ${ai.temperature ?? defaultConfig.ai.temperature}`);
  console.log(`- maxTokens: ${ai.maxTokens ?? defaultConfig.ai.maxTokens}`);
  if (ai.reasoningEffort) {
    console.log(`- reasoning effort: ${ai.reasoningEffort}`);
  }
  if (ai.baseURL) {
    console.log(`- baseURL: ${ai.baseURL}`);
  }
  console.log(`- config source: ${resolved.source}`);
  for (const warning of resolved.warnings) {
    console.log(`- warning: ${warning}`);
  }
}

async function loadLocalConfig(root: string, warnings: string[]): Promise<{ config: DevGuardConfig; source: string }> {
  for (const path of configCandidates) {
    const text = await readTextFile(fromRoot(root, path));
    if (!text.trim()) {
      continue;
    }
    try {
      return { config: JSON.parse(text) as DevGuardConfig, source: path };
    } catch (error) {
      warnings.push(`${path} is invalid JSON; ignored (${errorMessage(error)})`);
      continue;
    }
  }

  const packageJson = await readJsonFile<PackageJsonConfig>(fromRoot(root, "package.json"), {});
  if (packageJson.devGuard) {
    return { config: packageJson.devGuard, source: "package.json#devGuard" };
  }

  return { config: {}, source: "defaults/env" };
}

function envConfig(): DevGuardConfig {
  const ai: AIConfig = {};
  if (process.env.DEV_GUARD_PROVIDER === "openai" || process.env.DEV_GUARD_PROVIDER === "none") {
    ai.provider = process.env.DEV_GUARD_PROVIDER;
  }
  if (process.env.DEV_GUARD_MODEL) {
    ai.model = process.env.DEV_GUARD_MODEL;
  }
  if (process.env.DEV_GUARD_TEMPERATURE) {
    ai.temperature = Number(process.env.DEV_GUARD_TEMPERATURE);
  }
  if (process.env.DEV_GUARD_MAX_TOKENS) {
    ai.maxTokens = Number(process.env.DEV_GUARD_MAX_TOKENS);
  }
  if (process.env.DEV_GUARD_REASONING_EFFORT) {
    ai.reasoningEffort = process.env.DEV_GUARD_REASONING_EFFORT;
  }
  if (process.env.DEV_GUARD_BASE_URL) {
    ai.baseURL = process.env.DEV_GUARD_BASE_URL;
  }
  return Object.keys(ai).length > 0 ? { ai } : {};
}

function mergeDevGuardConfig(...configs: DevGuardConfig[]): DevGuardConfig {
  return configs.reduce<DevGuardConfig>((merged, config) => ({
    ...merged,
    ...config,
    ai: {
      ...(merged.ai ?? {}),
      ...(config.ai ?? {})
    }
  }), {});
}

function applyConfigValue(config: DevGuardConfig, key: string, value: string): DevGuardConfig {
  const ai = { ...(config.ai ?? {}) };
  if (key === "provider") {
    if (value !== "openai" && value !== "none") {
      throw new Error("provider 값은 openai 또는 none만 지원합니다.");
    }
    ai.provider = value as AIProviderName;
  } else if (key === "model") {
    ai.model = value;
  } else if (key === "temperature") {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
      throw new Error("temperature 값은 숫자여야 합니다.");
    }
    ai.temperature = numberValue;
  } else if (key === "maxTokens") {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue <= 0) {
      throw new Error("maxTokens 값은 양수여야 합니다.");
    }
    ai.maxTokens = numberValue;
  } else if (key === "reasoningEffort") {
    ai.reasoningEffort = value;
  } else if (key === "baseURL") {
    ai.baseURL = value;
  } else {
    throw new Error("지원하는 config key: provider, model, temperature, maxTokens, reasoningEffort, baseURL");
  }

  return {
    ...config,
    ai
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
