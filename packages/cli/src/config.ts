import { defaultConfig, type AIConfig, type AIProviderName, type DevGuardConfig } from "@dev-guard/core";
import { fromRoot, readJsonFile, readTextFile, writeTextFile } from "./fs.js";
import { normalizeLocale } from "./locale.js";

interface PackageJsonConfig {
  devGuard?: DevGuardConfig;
}

// Watch-specific configuration — stored in the `watch` section of config.json.
// All fields are optional; unset fields use hardcoded defaults.
export interface WatchConfig {
  dashboard?: boolean;         // default: true  — open the browser dashboard
  autoComplete?: boolean;      // default: true  — auto-finalize after filesystem settles
  autoCompleteDelay?: number;  // default: 8     — grace period in seconds before auto-finalize
  stableAfter?: number;        // default: 20    — seconds of inactivity before "settled"
  poll?: boolean;              // default: false — use polling instead of fs events
  depth?: number;              // default: 8     — chokidar recursive depth
  compact?: boolean;           // default: false — suppress per-event console output
  includeLockfiles?: boolean;  // default: false — include lockfile changes in tracking
}

// Defaults for all watch config fields
export const defaultWatchConfig: Required<WatchConfig> = {
  dashboard: true,
  autoComplete: true,
  autoCompleteDelay: 8,
  stableAfter: 20,
  poll: false,
  depth: 8,
  compact: false,
  includeLockfiles: false
};

// Internal: config.json may have both DevGuardConfig fields and a `watch` section.
type ConfigFileShape = DevGuardConfig & { watch?: WatchConfig; locale?: string };

export interface ResolvedConfig {
  config: DevGuardConfig;
  watchConfig: WatchConfig;
  source: string;
  warnings: string[];
  env: EnvResolution;
}

export interface EnvResolution {
  apiKey: {
    checked: Array<{ name: "DEV_GUARD_OPENAI_API_KEY" | "OPENAI_API_KEY"; found: boolean }>;
    selectedKey?: "DEV_GUARD_OPENAI_API_KEY" | "OPENAI_API_KEY";
    found: boolean;
  };
}

const configCandidates = [".devguard/config.json", ".devguardrc", "devguard.config.json"];

export async function loadConfig(root: string, cliAI: Partial<AIConfig> = {}): Promise<ResolvedConfig> {
  const warnings: string[] = [];
  const local = await loadLocalConfig(root, warnings);
  const envResolution = resolveOpenAIEnv();
  const env = envConfig(envResolution);
  const merged = mergeDevGuardConfig(defaultConfig, env, local.config, { ai: cliAI });
  if (envResolution.apiKey.found) {
    merged.ai = {
      ...(merged.ai ?? {}),
      provider: "openai",
      model: merged.ai?.model ?? defaultConfig.ai.model
    };
  }

  return {
    config: merged,
    watchConfig: local.watchConfig,
    source: sourceLabel(local.source, env),
    warnings,
    env: envResolution
  };
}

export async function loadWatchConfig(root: string): Promise<WatchConfig> {
  const { watchConfig } = await loadConfig(root);
  return watchConfig;
}

export async function writeConfigValue(root: string, key: string, value: string): Promise<ConfigFileShape> {
  const configPath = fromRoot(root, ".devguard/config.json");
  const current = await readJsonFile<ConfigFileShape>(configPath, defaultConfig);
  const next = applyConfigValue(current, key, value);
  await writeTextFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function printConfigSummary(label: string, resolved: ResolvedConfig): void {
  const ai = resolved.config.ai ?? {};
  const watch = resolved.watchConfig;
  console.log(label);
  console.log("AI:");
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
  console.log("Watch:");
  console.log(`- dashboard: ${watch.dashboard ?? defaultWatchConfig.dashboard}`);
  console.log(`- autoComplete: ${watch.autoComplete ?? defaultWatchConfig.autoComplete}`);
  console.log(`- autoCompleteDelay: ${watch.autoCompleteDelay ?? defaultWatchConfig.autoCompleteDelay}s`);
  console.log(`- stableAfter: ${watch.stableAfter ?? defaultWatchConfig.stableAfter}s`);
  console.log(`- poll: ${watch.poll ?? defaultWatchConfig.poll}`);
  console.log(`- depth: ${watch.depth ?? defaultWatchConfig.depth}`);
  console.log(`- compact: ${watch.compact ?? defaultWatchConfig.compact}`);
  console.log(`- includeLockfiles: ${watch.includeLockfiles ?? defaultWatchConfig.includeLockfiles}`);
  console.log(`- locale: ${(resolved.config as ConfigFileShape).locale ?? "auto"}`);
  console.log("Source:");
  console.log(`- config source: ${resolved.source}`);
  console.log(`- env DEV_GUARD_OPENAI_API_KEY: ${resolved.env.apiKey.checked[0]?.found ? "found" : "missing"}`);
  console.log(`- env OPENAI_API_KEY: ${resolved.env.apiKey.checked[1]?.found ? "found" : "missing"}`);
  console.log(`- selected API key source: ${resolved.env.apiKey.selectedKey ?? "none"}`);
  for (const warning of resolved.warnings) {
    console.log(`- warning: ${warning}`);
  }
}

async function loadLocalConfig(root: string, warnings: string[]): Promise<{ config: DevGuardConfig; watchConfig: WatchConfig; source: string }> {
  for (const path of configCandidates) {
    const text = await readTextFile(fromRoot(root, path));
    if (!text.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(text) as ConfigFileShape;
      const { watch, ...devGuardConfig } = parsed;
      return { config: devGuardConfig as DevGuardConfig, watchConfig: watch ?? {}, source: path };
    } catch (error) {
      warnings.push(`${path} is invalid JSON; ignored (${errorMessage(error)})`);
      continue;
    }
  }

  const packageJson = await readJsonFile<PackageJsonConfig>(fromRoot(root, "package.json"), {});
  if (packageJson.devGuard) {
    return { config: packageJson.devGuard, watchConfig: {}, source: "package.json#devGuard" };
  }

  return { config: {}, watchConfig: {}, source: "defaults/env" };
}

function envConfig(envResolution: EnvResolution): DevGuardConfig {
  const ai: AIConfig = {};
  if (process.env.DEV_GUARD_PROVIDER === "openai" || process.env.DEV_GUARD_PROVIDER === "none") {
    ai.provider = process.env.DEV_GUARD_PROVIDER;
  }
  if (envResolution.apiKey.found) {
    ai.provider = "openai";
  }
  if (process.env.DEV_GUARD_MODEL) {
    ai.model = process.env.DEV_GUARD_MODEL.trim();
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

export function resolveOpenAIEnv(env: NodeJS.ProcessEnv = process.env): EnvResolution {
  const checked = [
    { name: "DEV_GUARD_OPENAI_API_KEY" as const, found: hasNonEmptyEnv(env.DEV_GUARD_OPENAI_API_KEY) },
    { name: "OPENAI_API_KEY" as const, found: hasNonEmptyEnv(env.OPENAI_API_KEY) }
  ];
  const selected = checked.find((entry) => entry.found);
  return {
    apiKey: {
      checked,
      selectedKey: selected?.name,
      found: Boolean(selected)
    }
  };
}

export function readOpenAIApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const devGuardKey = env.DEV_GUARD_OPENAI_API_KEY?.trim();
  if (devGuardKey) {
    return devGuardKey;
  }
  const openAIKey = env.OPENAI_API_KEY?.trim();
  return openAIKey || undefined;
}

function hasNonEmptyEnv(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function sourceLabel(localSource: string, env: DevGuardConfig): string {
  if (Object.keys(env.ai ?? {}).length === 0) {
    return localSource;
  }
  return localSource.includes("env") ? localSource : `${localSource}+env`;
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

function applyConfigValue(config: ConfigFileShape, key: string, value: string): ConfigFileShape {
  // Handle watch.* keys
  if (key.startsWith("watch.")) {
    const watchKey = key.slice("watch.".length);
    return applyWatchConfigValue(config, watchKey, value);
  }

  if (key === "locale") {
    const locale = normalizeLocale(value);
    if (!locale) {
      throw new Error("locale 값은 en-US 또는 ko-KR만 지원합니다.");
    }
    return { ...config, locale };
  }

  // Handle AI keys (legacy flat keys for backward compatibility)
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
    throw new Error(
      "지원하는 config key: provider, model, temperature, maxTokens, reasoningEffort, baseURL, locale, " +
      "watch.dashboard, watch.autoComplete, watch.autoCompleteDelay, watch.stableAfter, " +
      "watch.poll, watch.depth, watch.compact, watch.includeLockfiles"
    );
  }

  return { ...config, ai };
}

function applyWatchConfigValue(config: ConfigFileShape, key: string, value: string): ConfigFileShape {
  const watch = { ...(config.watch ?? {}) };
  if (key === "dashboard" || key === "autoComplete" || key === "poll" || key === "compact" || key === "includeLockfiles") {
    if (value !== "true" && value !== "false") {
      throw new Error(`watch.${key} 값은 true 또는 false여야 합니다.`);
    }
    (watch as Record<string, unknown>)[key] = value === "true";
  } else if (key === "autoCompleteDelay" || key === "stableAfter" || key === "depth") {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue <= 0) {
      throw new Error(`watch.${key} 값은 양수여야 합니다.`);
    }
    (watch as Record<string, unknown>)[key] = numberValue;
  } else {
    throw new Error(
      "지원하는 watch config key: dashboard, autoComplete, autoCompleteDelay, stableAfter, poll, depth, compact, includeLockfiles"
    );
  }
  return { ...config, watch };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
