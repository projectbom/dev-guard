import { access } from "node:fs/promises";
import { configTemplate, mistakesTemplate, rulesTemplate, taskTemplate } from "@dev-guard/core";
import { fromRoot, writeFileIfMissing } from "./fs.js";
import { defaultWatchConfig } from "./config.js";

interface InitFile {
  path: string;
  content: string;
}

// Config template with watch defaults included so first-time users get a
// fully configured file without having to know any CLI flags.
const fullConfigTemplate = {
  ...configTemplate,
  watch: {
    dashboard: defaultWatchConfig.dashboard,
    autoComplete: defaultWatchConfig.autoComplete,
    autoCompleteDelay: defaultWatchConfig.autoCompleteDelay,
    stableAfter: defaultWatchConfig.stableAfter
  }
};

// Only `.devguard/` is created. The project-root templates older versions
// wrote (docs/PROJECT_STATE.md, docs/CURRENT_TASK.md, docs/DECISIONS.md,
// docs/DO_NOT_REPEAT.md) are no longer created: neither MCP
// (prepare_task_context) nor `done` reads them — only the explicit legacy
// helpers (prompt, review, task-ai, update) do, and those treat a missing
// file as empty. Existing copies are user-owned and are never touched.
// task.md / rules.md / mistakes.md stay inside .devguard for those same
// legacy helpers (check, review, prompt, infer-task).
const initFiles: InitFile[] = [
  {
    path: ".devguard/config.json",
    content: `${JSON.stringify(fullConfigTemplate, null, 2)}\n`
  },
  {
    path: ".devguard/task.md",
    content: taskTemplate
  },
  {
    path: ".devguard/rules.md",
    content: rulesTemplate
  },
  {
    path: ".devguard/mistakes.md",
    content: mistakesTemplate
  }
];

export async function ensureInitialProjectFiles(root: string): Promise<Array<{ path: string; status: "created" | "exists" }>> {
  return Promise.all(
    initFiles.map(async (file) => {
      const status = await writeFileIfMissing(fromRoot(root, file.path), file.content);
      return { path: file.path, status };
    })
  );
}

/** Read-only: which init files are missing (for `setup --dry-run`). */
export async function planInitialProjectFiles(root: string): Promise<Array<{ path: string; status: "missing" | "exists" }>> {
  return Promise.all(
    initFiles.map(async (file) => {
      const exists = await access(fromRoot(root, file.path)).then(() => true, () => false);
      return { path: file.path, status: exists ? ("exists" as const) : ("missing" as const) };
    })
  );
}

export async function runInit(root: string): Promise<void> {
  const results = await ensureInitialProjectFiles(root);

  console.log("dev-guard init");
  for (const result of results) {
    const label = result.status === "created" ? "created" : "exists";
    console.log(`- ${label}: ${result.path}`);
  }
  console.log("- write policy: existing files are preserved; missing files are created only");
  console.log("- note: init is the low-level/manual-recovery step; it does not analyze the project");
  console.log("- next: run dev-guard watch (prepares Code Index, Project Knowledge, MCP, agent instructions, hooks on first run)");
}
