import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import type { ProjectScanInputFile } from "@dev-guard/core";
import { fileMetadata, fromRoot, readTextFile } from "./fs.js";

const maxScanFileCharacters = 20000;

export async function readScanInputFile(root: string, path: string): Promise<ProjectScanInputFile> {
  const fullPath = fromRoot(root, path);
  const [metadata, fullContent] = await Promise.all([fileMetadata(fullPath), readTextFile(fullPath)]);
  const content = fullContent.slice(0, maxScanFileCharacters);

  return {
    path,
    content,
    size: metadata.size,
    lastModified: metadata.lastModified,
    hash: hashText(fullContent)
  };
}

export async function fileExists(root: string, path: string): Promise<boolean> {
  try {
    await access(fromRoot(root, path));
    return true;
  } catch {
    return false;
  }
}

export async function readFileHash(root: string, path: string): Promise<string> {
  return hashText(await readTextFile(fromRoot(root, path)));
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
