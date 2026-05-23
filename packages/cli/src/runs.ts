import type { DevGuardRunLog, ProjectIdentity } from "@dev-guard/core";
import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import { fromRoot, readJsonFile, writeTextFile } from "./fs.js";
import { getGitIdentity } from "./git.js";
import { loadCurrentProjectIdentity, sameProjectIdentity } from "./project-identity.js";

interface SaveRunInput {
  command: string;
  userRequest?: string;
  generatedTaskMarkdown?: string;
  generatedCodexPrompt?: string;
  relatedFiles?: string[];
  model?: string;
  provider?: DevGuardRunLog["provider"];
  changedFilesAtCreation?: string[];
  projectIdentity?: ProjectIdentity;
  status?: DevGuardRunLog["status"];
}

const promptMaxLength = 200_000;

export async function createRunLog(root: string, input: SaveRunInput): Promise<DevGuardRunLog | undefined> {
  try {
    const createdAt = new Date().toISOString();
    const id = createRunId(createdAt);
    const git = await getGitIdentity(root).catch(() => ({ gitHead: "", gitBranch: "" }));
    const projectIdentity = input.projectIdentity ?? (await loadCurrentProjectIdentity(root).catch(() => undefined));
    const run: DevGuardRunLog = {
      id,
      createdAt,
      updatedAt: createdAt,
      command: input.command,
      title: makeRunTitle(input.userRequest || input.command),
      userRequest: input.userRequest,
      generatedTaskMarkdown: truncate(input.generatedTaskMarkdown),
      generatedCodexPrompt: truncate(input.generatedCodexPrompt),
      relatedFiles: input.relatedFiles ?? [],
      model: input.model,
      provider: input.provider,
      gitHead: git.gitHead,
      gitBranch: git.gitBranch,
      changedFilesAtCreation: input.changedFilesAtCreation ?? [],
      projectIdentity,
      status: input.status ?? "created"
    };
    await writeRunFiles(root, run);
    return run;
  } catch (error) {
    warnRunFailure("save", error);
    return undefined;
  }
}

export async function upsertLatestRun(root: string, input: SaveRunInput): Promise<DevGuardRunLog | undefined> {
  const latest = await readLatestRun(root);
  if (!latest) {
    return createRunLog(root, input);
  }
  const projectIdentity = input.projectIdentity ?? (await loadCurrentProjectIdentity(root).catch(() => undefined));
  if (projectIdentity && latest.projectIdentity && !sameProjectIdentity(projectIdentity, latest.projectIdentity)) {
    return createRunLog(root, {
      ...input,
      projectIdentity
    });
  }

  return updateRunLog(root, latest.id, {
    command: latest.command,
    userRequest: input.userRequest ?? latest.userRequest,
    generatedTaskMarkdown: input.generatedTaskMarkdown ?? latest.generatedTaskMarkdown,
    generatedCodexPrompt: input.generatedCodexPrompt ?? latest.generatedCodexPrompt,
    relatedFiles: input.relatedFiles ?? latest.relatedFiles,
    model: input.model ?? latest.model,
    provider: input.provider ?? latest.provider,
    changedFilesAtCreation: input.changedFilesAtCreation ?? latest.changedFilesAtCreation,
    projectIdentity: projectIdentity ?? latest.projectIdentity,
    status: input.status ?? latest.status
  });
}

export async function updateRunLog(
  root: string,
  id: string,
  patch: Partial<Omit<DevGuardRunLog, "id" | "createdAt">>
): Promise<DevGuardRunLog | undefined> {
  try {
    const current = (await readRunById(root, id)) ?? (await readLatestRun(root));
    if (!current) {
      return undefined;
    }

    const next: DevGuardRunLog = {
      ...current,
      ...patch,
      generatedTaskMarkdown: truncate(patch.generatedTaskMarkdown ?? current.generatedTaskMarkdown),
      generatedCodexPrompt: truncate(patch.generatedCodexPrompt ?? current.generatedCodexPrompt),
      fixPrompt: truncate(patch.fixPrompt ?? current.fixPrompt),
      reviewResult: truncate(patch.reviewResult ?? current.reviewResult),
      updatedAt: new Date().toISOString()
    };
    await writeRunFiles(root, next);
    return next;
  } catch (error) {
    warnRunFailure("update", error);
    return undefined;
  }
}

export async function readLatestRun(root: string): Promise<DevGuardRunLog | undefined> {
  const run = await readJsonFile<DevGuardRunLog | undefined>(fromRoot(root, ".devguard/runs/latest.json"), undefined);
  return run?.id ? run : undefined;
}

export async function readRunById(root: string, id: string): Promise<DevGuardRunLog | undefined> {
  const safeId = basename(id).replace(/\.json$/i, "");
  const run = await readJsonFile<DevGuardRunLog | undefined>(fromRoot(root, `.devguard/runs/${safeId}.json`), undefined);
  return run?.id ? run : undefined;
}

export async function listRunLogs(root: string): Promise<DevGuardRunLog[]> {
  try {
    const entries = await readdir(fromRoot(root, ".devguard/runs"));
    const ids = entries
      .filter((entry) => entry.endsWith(".json") && entry !== "latest.json")
      .map((entry) => entry.replace(/\.json$/i, ""));
    const runs = await Promise.all(ids.map((id) => readRunById(root, id)));

    return runs
      .filter((run): run is DevGuardRunLog => Boolean(run))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  } catch {
    return [];
  }
}

export function logRunSaved(run: DevGuardRunLog | undefined): void {
  if (run) {
    console.error(`dev-guard run saved: ${run.id}`);
  }
}

function writeRunFiles(root: string, run: DevGuardRunLog): Promise<void[]> {
  const content = `${JSON.stringify(run, null, 2)}\n`;
  return Promise.all([
    writeTextFile(fromRoot(root, `.devguard/runs/${run.id}.json`), content),
    writeTextFile(fromRoot(root, ".devguard/runs/latest.json"), content)
  ]);
}

function compactTimestamp(value: string): string {
  return value.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function createRunId(createdAt: string): string {
  return `run_${compactTimestamp(createdAt)}`.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 60);
}

function makeRunTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 120) || "dev-guard run";
}

function truncate(value: string | undefined): string | undefined {
  if (!value || value.length <= promptMaxLength) {
    return value;
  }

  return `${value.slice(0, promptMaxLength)}\n... truncated by dev-guard run log limit ...`;
}

function warnRunFailure(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`dev-guard warning: failed to ${action} run log (${message})`);
}
