import { defaultConfig, type AIProviderName, type DevGuardConfig } from "@dev-guard/core";
import { fromRoot, readJsonFile, writeTextFile } from "./fs.js";
import { loadConfig, printConfigSummary, writeConfigValue } from "./config.js";

interface ConfigureAIOptions {
  provider: AIProviderName;
  model: string;
}

export async function runConfigure(root: string, args: string[]): Promise<void> {
  const target = args[0];

  if (target === "set") {
    const key = args[1];
    const value = args[2];
    if (!key || value === undefined) {
      throw new Error(
        "Usage: dev-guard config set <key> <value>\n" +
        "AI keys:    provider  model  temperature  maxTokens  reasoningEffort  baseURL\n" +
        "Locale key: locale\n" +
        "Watch keys: watch.dashboard  watch.autoComplete  watch.autoCompleteDelay\n" +
        "            watch.stableAfter  watch.poll  watch.depth  watch.compact  watch.includeLockfiles"
      );
    }
    const next = await writeConfigValue(root, key, value);
    console.log("dev-guard config set");
    console.log(`- ${key}: ${value}`);
    console.log("- wrote: .devguard/config.json");
    if (key === "locale") {
      console.log(`- locale: ${next.locale ?? value}`);
    } else if (key.startsWith("watch.")) {
      const watch = next.watch ?? {};
      console.log(`- watch.autoComplete: ${watch.autoComplete ?? true}`);
      console.log(`- watch.autoCompleteDelay: ${watch.autoCompleteDelay ?? 8}s`);
      console.log(`- watch.stableAfter: ${watch.stableAfter ?? 20}s`);
      console.log(`- watch.dashboard: ${watch.dashboard ?? true}`);
    } else {
      console.log(`- provider: ${next.ai?.provider ?? defaultConfig.ai.provider}`);
      console.log(`- model: ${next.ai?.model ?? defaultConfig.ai.model}`);
    }
    return;
  }

  if (target === "show" || target === undefined) {
    printConfigSummary("dev-guard config", await loadConfig(root));
    return;
  }

  if (target !== "ai") {
    throw new Error("지원하는 configure 대상: ai, set, show. 예: dev-guard config set model gpt-5");
  }

  const options = parseConfigureAIOptions(args.slice(1));
  const configPath = fromRoot(root, ".devguard/config.json");
  const current = await readJsonFile<DevGuardConfig>(configPath, defaultConfig);
  const next: DevGuardConfig = {
    ...current,
    ai: {
      provider: options.provider,
      model: options.model
    }
  };

  await writeTextFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
  const resolved = await loadConfig(root);
  const storedAI = next.ai ?? {};
  const resolvedAI = resolved.config.ai ?? {};
  console.log("dev-guard configure ai");
  console.log("Stored Config:");
  console.log(`- provider: ${storedAI.provider ?? defaultConfig.ai.provider}`);
  console.log(`- model: ${storedAI.model ?? defaultConfig.ai.model}`);
  console.log("- config source: .devguard/config.json");
  console.log("");
  console.log("Runtime Resolution:");
  console.log(`- resolved provider: ${resolvedAI.provider ?? defaultConfig.ai.provider}`);
  console.log(`- resolved model: ${resolvedAI.model ?? defaultConfig.ai.model}`);
  console.log(`- API key: ${resolved.env.apiKey.found ? "found" : "missing"}`);
  console.log(`- API key source: ${resolved.env.apiKey.selectedKey ?? "none"}`);
  console.log(`- config source: ${resolved.source}`);
  console.log("");
  console.log("Note:");
  console.log("- API key is not stored. It is read from environment at runtime.");
}

function parseConfigureAIOptions(args: string[]): ConfigureAIOptions {
  const provider = readOption(args, "--provider") ?? "none";
  const model = readOption(args, "--model") ?? "gpt-4o-mini";

  if (provider !== "openai" && provider !== "none") {
    throw new Error("지원하지 않는 AI provider입니다. 가능한 값: openai, none");
  }

  return {
    provider,
    model
  };
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} 옵션에는 값이 필요합니다.`);
  }

  return value;
}
