import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { fromRoot } from "./fs.js";
import { DEVGUARD_DIR, LEGACY_DEVGUARD_DIR } from "./paths.js";

export interface LegacyMigrationResult {
  action: "none" | "renamed" | "backup" | "warning";
  message?: string;
}

export async function migrateLegacyDevguardDir(root: string, options: { force?: boolean } = {}): Promise<LegacyMigrationResult> {
  const legacy = fromRoot(root, LEGACY_DEVGUARD_DIR);
  const current = fromRoot(root, DEVGUARD_DIR);
  const hasLegacy = existsSync(legacy);
  const hasCurrent = existsSync(current);

  if (!hasLegacy) {
    return { action: "none" };
  }

  if (!hasCurrent) {
    await rename(legacy, current);
    return {
      action: "renamed",
      message: `Migrated legacy ${LEGACY_DEVGUARD_DIR}/ to ${DEVGUARD_DIR}/.`
    };
  }

  if (options.force) {
    const backupName = `${LEGACY_DEVGUARD_DIR}.backup-${timestampForPath()}`;
    await rename(legacy, fromRoot(root, backupName));
    return {
      action: "backup",
      message: `Legacy ${LEGACY_DEVGUARD_DIR}/ moved to ${backupName}/ because ${DEVGUARD_DIR}/ already exists.`
    };
  }

  return {
    action: "warning",
    message: `Legacy ${LEGACY_DEVGUARD_DIR}/ directory detected. Recommended path is ${DEVGUARD_DIR}/. Move or back up legacy files before continuing.`
  };
}

export function legacyDevguardWarning(root: string): string | undefined {
  if (existsSync(fromRoot(root, LEGACY_DEVGUARD_DIR))) {
    return `Legacy ${LEGACY_DEVGUARD_DIR}/ directory detected. Recommended path is ${DEVGUARD_DIR}/. Run migration or move files before continuing.`;
  }
  return undefined;
}

function timestampForPath(): string {
  const value = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  return value.replace("T", "-");
}
