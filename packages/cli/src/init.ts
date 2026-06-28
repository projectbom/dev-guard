import {
  configTemplate,
  currentTaskTemplate,
  decisionsTemplate,
  doNotRepeatTemplate,
  mistakesTemplate,
  projectStateTemplate,
  rulesTemplate,
  taskTemplate
} from "@dev-guard/core";
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
  },
  {
    path: "docs/PROJECT_STATE.md",
    content: projectStateTemplate
  },
  {
    path: "docs/CURRENT_TASK.md",
    content: currentTaskTemplate
  },
  {
    path: "docs/DECISIONS.md",
    content: decisionsTemplate
  },
  {
    path: "docs/DO_NOT_REPEAT.md",
    content: doNotRepeatTemplate
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

export async function runInit(root: string): Promise<void> {
  const results = await ensureInitialProjectFiles(root);

  console.log("dev-guard init");
  for (const result of results) {
    const label = result.status === "created" ? "created" : "exists";
    console.log(`- ${label}: ${result.path}`);
  }
  console.log("- write policy: existing files are preserved; missing files are created only");
  console.log("- next: run dev-guard watch");
  console.log("- tip: run dev-guard install-agent-instructions to add CLAUDE.md / AGENTS.md guidance");
}
