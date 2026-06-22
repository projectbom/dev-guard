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

interface InitFile {
  path: string;
  content: string;
}

const initFiles: InitFile[] = [
  {
    path: ".devguard/config.json",
    content: `${JSON.stringify(configTemplate, null, 2)}\n`
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

export async function runInit(root: string): Promise<void> {
  const results = await Promise.all(
    initFiles.map(async (file) => {
      const status = await writeFileIfMissing(fromRoot(root, file.path), file.content);
      return { path: file.path, status };
    })
  );

  console.log("dev-guard init");
  for (const result of results) {
    const label = result.status === "created" ? "created" : "exists";
    console.log(`- ${label}: ${result.path}`);
  }
  console.log("- write policy: existing files are preserved; missing files are created only");
  console.log("- next: run dev-guard install-agent-instructions");
  console.log("- then: run dev-guard install-hooks, or use dev-guard watch --manual and dev-guard done");
}
