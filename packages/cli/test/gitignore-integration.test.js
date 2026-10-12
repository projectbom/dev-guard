// Zero-setup Git hygiene: the first watch/setup keeps DevGuard's local state
// (`.devguard/`, `devguard.backup-*/`) out of Git by APPENDING only missing
// rules — never rewriting, reordering or duplicating user lines — and never
// touches the Git index or hides project integration files.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { prepareProject, planProjectSetup, formatPreparation } from "../dist/prepare.js";
import { appendedText, ensureDevguardGitIgnore } from "../dist/git-ignore.js";

const execFileAsync = promisify(execFile);
const cleanupRoots = [];
after(async () => {
  await Promise.all(cleanupRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function put(root, path, content = "x\n") {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
async function git(root, ...args) {
  return (await execFileAsync("git", ["-c", "user.email=t@e.st", "-c", "user.name=T", ...args], { cwd: root })).stdout;
}
async function repo(prefix, files = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanupRoots.push(root);
  await put(root, "package.json", JSON.stringify({ name: "fixture" }));
  await put(root, "src/index.ts", "export const a = 1;\n");
  for (const [path, content] of Object.entries(files)) await put(root, path, content);
  await git(root, "init", "-q");
  await git(root, "add", "--", "package.json", "src/index.ts");
  await git(root, "commit", "-qm", "init");
  return root;
}
async function ignored(root, path) {
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--no-index", "--", path], { cwd: root });
    return true;
  } catch {
    return false;
  }
}
const read = (root) => readFile(join(root, ".gitignore"), "utf8");
const BLOCK = "# DevGuard local state\n.devguard/\ndevguard.backup-*/\n";

test("A/C/I: first run creates the rules; repeated runs are no-ops; integration files stay visible to Git", async () => {
  const root = await repo("devguard-gi-a-");
  const first = await prepareProject(root);
  assert.equal(await read(root), BLOCK);
  assert.deepEqual(first.facts.gitIgnore, { status: "created", added: [".devguard/", "devguard.backup-*/"], trackedDevguardFiles: 0 });
  assert.match(formatPreparation(first).lines.join("\n"), /Created \.gitignore with \.devguard\/, devguard\.backup-\*\//);
  const status = await git(root, "status", "--porcelain", "--untracked-files=all");
  assert.ok(!status.includes(".devguard/"), status);
  // I: project integration files are never hidden.
  for (const path of ["AGENTS.md", "CLAUDE.md", ".mcp.json", ".codex/config.toml"]) {
    assert.equal(await ignored(root, path), false, `${path} must not be ignored`);
  }
  assert.match(status, /\?\? AGENTS\.md/);
  assert.match(status, /\?\? \.mcp\.json/);
  // C: repeated preparation never duplicates.
  const second = await prepareProject(root);
  await prepareProject(root);
  assert.equal(await read(root), BLOCK);
  assert.equal(second.facts.gitIgnore.status, "already-ignored");
  assert.ok(!formatPreparation(second).lines.some((line) => line.includes(".gitignore")));
});

test("B/J: existing content (comments, order, no trailing newline, CRLF) is preserved byte-for-byte; rules are appended", async () => {
  const original = "# build output\ndist\n\n# keep this comment\n!dist/keep.txt\nnode_modules";
  const root = await repo("devguard-gi-b-", { ".gitignore": original });
  await prepareProject(root);
  const after = await read(root);
  assert.ok(after.startsWith(original), "original bytes untouched");
  assert.equal(after, `${original}\n\n${BLOCK}`);

  const crlf = "node_modules\r\n# local\r\n.env\r\n";
  const winRoot = await repo("devguard-gi-j-", { ".gitignore": crlf });
  await prepareProject(winRoot);
  const winAfter = await read(winRoot);
  assert.ok(winAfter.startsWith(crlf));
  assert.equal(winAfter, `${crlf}\r\n# DevGuard local state\r\n.devguard/\r\ndevguard.backup-*/\r\n`);
  assert.ok(!/[^\r]\n/.test(winAfter), "line endings stay CRLF");

  // The backup rule covers DevGuard's own backup directories only.
  assert.equal(await ignored(root, "devguard.backup-20261012-101500/state.json"), true);
  assert.equal(await ignored(root, "devguard.backup.md"), false);
  assert.equal(await ignored(root, "src/devguard.backup-notes.ts"), false);
  assert.equal(await ignored(root, "mydevguard.backup-1/x"), false);
});

test("D/E: equivalent user rules count as ignored; only a missing rule is added", async () => {
  const equivalent = "/.devguard\ndevguard.backup-*\n";
  const root = await repo("devguard-gi-d-", { ".gitignore": equivalent });
  const result = await prepareProject(root);
  assert.equal(result.facts.gitIgnore.status, "already-ignored");
  assert.equal(await read(root), equivalent, "no redundant rules");

  const globbed = await repo("devguard-gi-d2-", { ".gitignore": ".devguard/**\n" });
  assert.deepEqual((await ensureDevguardGitIgnore(globbed)).added, ["devguard.backup-*/"]);
  assert.equal(await read(globbed), ".devguard/**\n\n# DevGuard local state\ndevguard.backup-*/\n");

  const partial = await repo("devguard-gi-e-", { ".gitignore": "node_modules\n.devguard/\n" });
  await prepareProject(partial);
  assert.equal(await read(partial), "node_modules\n.devguard/\n\n# DevGuard local state\ndevguard.backup-*/\n");
  // A header DevGuard already wrote is not repeated when a rule is added later.
  assert.equal(appendedText("# DevGuard local state\n.devguard/\n", ["devguard.backup-*/"]), "\ndevguard.backup-*/\n");
});

test("F: a tracked .devguard/ is reported, never removed from the index", async () => {
  const root = await repo("devguard-gi-f-");
  await put(root, ".devguard/config.json", "{}\n");
  await git(root, "add", "--", ".devguard/config.json");
  await git(root, "commit", "-qm", "track devguard state");
  const indexBefore = await git(root, "ls-files", "-s");
  const result = await prepareProject(root);
  assert.equal(result.facts.gitIgnore.trackedDevguardFiles, 1);
  assert.ok(result.warnings.some((warning) => warning.startsWith(".devguard/ is already tracked by Git (1 file). DevGuard will not modify the index automatically.")));
  assert.match(result.warnings.join("\n"), /git rm -r --cached \.devguard/);
  assert.equal(await git(root, "ls-files", "-s"), indexBefore, "index unchanged");
  assert.equal(await git(root, "diff", "--cached", "--name-only"), "", "nothing staged");
  assert.equal(await read(root), BLOCK, "the rule is still added for untracked state");
});

test("G: outside Git nothing is written and nothing is warned about .gitignore", async () => {
  const root = await mkdtemp(join(tmpdir(), "devguard-gi-g-"));
  cleanupRoots.push(root);
  await put(root, "package.json", JSON.stringify({ name: "plain" }));
  const result = await prepareProject(root);
  assert.equal(result.facts.gitIgnore.status, "not-git");
  await assert.rejects(access(join(root, ".gitignore")));
  assert.ok(!result.warnings.some((warning) => warning.includes(".gitignore")));
  assert.ok(!(await planProjectSetup(root)).some((entry) => entry.label.startsWith(".gitignore")));
});

test("H: setup --dry-run reports the .gitignore change without writing", async () => {
  const fresh = await repo("devguard-gi-h-");
  const plan = await planProjectSetup(fresh);
  assert.deepEqual(plan.find((entry) => entry.label.startsWith(".gitignore")), {
    key: "config",
    label: ".gitignore (local DevGuard state)",
    action: "create",
    detail: "would create .gitignore with .devguard/, devguard.backup-*/"
  });
  await assert.rejects(access(join(fresh, ".gitignore")));

  const existing = await repo("devguard-gi-h2-", { ".gitignore": "node_modules\n" });
  assert.equal((await planProjectSetup(existing)).find((entry) => entry.label.startsWith(".gitignore")).detail, "would add .devguard/, devguard.backup-*/");
  assert.equal(await read(existing), "node_modules\n");

  await prepareProject(existing);
  const done = (await planProjectSetup(existing)).find((entry) => entry.label.startsWith(".gitignore"));
  assert.deepEqual([done.action, done.detail], ["unchanged", "already ignored"]);
});
