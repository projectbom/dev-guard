import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function readTextFile(path: string, fallback = ""): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return fallback;
    }

    throw error;
  }
}

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  const text = await readTextFile(path);
  if (!text.trim()) {
    return fallback;
  }

  return JSON.parse(text) as T;
}

export async function writeFileIfMissing(path: string, content: string): Promise<"created" | "exists"> {
  await mkdir(dirname(path), { recursive: true });

  try {
    await writeFile(path, content, { flag: "wx" });
    return "created";
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return "exists";
    }

    throw error;
  }
}

export async function appendTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, content, "utf8");
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export async function fileMetadata(path: string): Promise<{ size: number; lastModified: string }> {
  const metadata = await stat(path);
  return {
    size: metadata.size,
    lastModified: metadata.mtime.toISOString()
  };
}

export function fromRoot(root: string, path: string): string {
  return join(root, path);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
