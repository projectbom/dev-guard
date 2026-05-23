import { spawn } from "node:child_process";

export async function copyTextToClipboard(text: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const command = clipboardCommand();
  if (!command) {
    return { ok: false, reason: "unsupported OS clipboard command" };
  }

  try {
    await writeToCommand(command.command, command.args, text);
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  }
}

function writeToCommand(command: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });

    child.stdin.end(input);
  });
}

function clipboardCommand(): { command: string; args: string[] } | undefined {
  if (process.platform === "darwin") {
    return { command: "pbcopy", args: [] };
  }

  if (process.platform === "win32") {
    return { command: "clip", args: [] };
  }

  return { command: "wl-copy", args: [] };
}
