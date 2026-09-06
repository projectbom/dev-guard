import { appendFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
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

// Generous default: DevGuard's own JSON state/cache files (runtime.json,
// state.json, code-index.json, project-index.json, etc.) are all generated,
// bounded data structures — none of them should legitimately need to be
// this large. A file past this size is treated as corrupted/runaway rather
// than parsed, so a pathological file from a past bug (or external
// tampering) can't take down the whole process; the caller's fallback
// triggers a clean rebuild instead.
const DEFAULT_MAX_JSON_FILE_BYTES = 50 * 1024 * 1024;

export async function readJsonFile<T>(path: string, fallback: T, options: { maxBytes?: number } = {}): Promise<T> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_JSON_FILE_BYTES;
  try {
    const info = await stat(path);
    if (info.size > maxBytes) {
      logOversizedFileWarning(path, info.size, maxBytes);
      return fallback;
    }
  } catch (error) {
    if (isMissingFileError(error)) return fallback;
    // Non-ENOENT stat failure (e.g. permissions) — fall through and let
    // readTextFile's own error handling decide; do not fail the size check
    // silently in a way that masks a real problem.
  }
  const text = await readTextFile(path);
  if (!text.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    console.error(`dev-guard: ${path} contains invalid JSON; using defaults and rebuilding it.`);
    return fallback;
  }
}

function logOversizedFileWarning(path: string, actualBytes: number, maxBytes: number): void {
  const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  console.error(`dev-guard: ${path} is ${mb(actualBytes)}, exceeding the ${mb(maxBytes)} safety limit; treating it as invalid and rebuilding it instead of loading it into memory.`);
}

/**
 * Reads only the tail of a file, bounded to at most `maxBytes` from the end
 * — for append-only logs (e.g. history.jsonl) that can grow unbounded over
 * a long-lived project, where only the most recent lines are ever needed.
 * Never reads more than `maxBytes` into memory regardless of file size. The
 * first returned line may be a truncated fragment of a longer line when the
 * read started mid-file, so callers should tolerate/drop unparsable lines.
 */
export async function readTailLines(path: string, maxBytes: number): Promise<string[]> {
  let handle;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    const start = Math.max(0, info.size - maxBytes);
    const length = info.size - start;
    if (length <= 0) return [];
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines;
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
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
