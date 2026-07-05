import { fromRoot, readJsonFile } from "./fs.js";

export type DevGuardLocale = "en-US" | "ko-KR";

interface LocaleConfig {
  locale?: string;
}

const defaultLocale: DevGuardLocale = "en-US";

export async function resolveDevGuardLocale(root: string, env: NodeJS.ProcessEnv = process.env): Promise<DevGuardLocale> {
  const config = await readJsonFile<LocaleConfig>(fromRoot(root, ".devguard/config.json"), {} as LocaleConfig).catch(() => ({} as LocaleConfig));
  return normalizeLocale(config.locale) ?? localeFromEnv(env) ?? defaultLocale;
}

export function localeFromEnv(env: NodeJS.ProcessEnv = process.env): DevGuardLocale | undefined {
  return normalizeLocale(env.LC_ALL) ?? normalizeLocale(env.LC_MESSAGES) ?? normalizeLocale(env.LANG);
}

export function normalizeLocale(value?: string): DevGuardLocale | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/[.:].*$/, "").replace("_", "-").toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "ko" || normalized.startsWith("ko-")) return "ko-KR";
  if (normalized === "en" || normalized.startsWith("en-")) return "en-US";
  return undefined;
}

export function localeLanguage(locale: DevGuardLocale): "en" | "ko" {
  return locale === "ko-KR" ? "ko" : "en";
}
