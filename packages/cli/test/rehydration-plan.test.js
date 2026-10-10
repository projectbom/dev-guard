// Rehydration read plan, from the PartnerFlow Run1C–Run1F audit: a fresh
// thread spent ~55K (27–86K) estimated tokens in its first two minutes
// batch-reading previous-phase docs, evidence JSON and collector scripts,
// because (1) the user's "read first" list never reached prepare_task_context,
// (2) scripts named in the previous step's evidence-index were never
// suggested, (3) 3–10 line Markdown ranges were ignored and the whole file
// re-read, (4) 1-line JSON opening-line ranges were useless.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { ensureCodeIndex, ensureDevguardWorkspace, prepareTaskContext, readRuntimeState, toAgentContextPayload } from "../dist/runtime-state.js";
import { jsonSections } from "../dist/document-ranges.js";
import { extractPathReferences, resolveExplicitInputs } from "../dist/rehydration-plan.js";
import { readTaskTelemetry } from "../dist/task-telemetry.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, "../dist/index.js");
const cleanup = [];
after(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}
async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

// A phase-by-phase ops workstream shaped like PartnerFlow's: per-step docs,
// evidence JSON naming the scripts each step ran, and unrelated older docs.
const evidenceIndex = {
  task: "Run1D targeted blocker closure",
  executedCollector: { path: "infra/standby/run1d/collect_targeted.py", sha256: "x" },
  inputFiles: [
    { path: "docs/run1c-route-policy.md", sha256: "a" },
    { path: "infra/standby/phase5j/capacity-snapshot.sql", sha256: "b" },
    { path: "infra/standby/phase5n/preflight-once.py", sha256: "c" },
    { path: "infra/standby/missing-file.json", sha256: "d" },
    { path: "assets/diagram.png", sha256: "e" }
  ],
  outputFiles: [{ path: "infra/standby/run1d/route500-attribution.json", sha256: "f" }],
  note: "Free text mentioning infra/standby/phase5n/preflight-once.py is not a file reference by key.",
  FULL_PREFLIGHT_RERUN_ELIGIBLE: "NO"
};

const section = (title, lines) => [`## ${title}`, "", ...Array.from({ length: lines }, (_, index) => `- ${title.toLowerCase()} detail ${index}: route latency budget review evidence line with enough words to be a real line.`), ""];
// > WHOLE_FILE_MARKDOWN_TOKENS: many short flat sections, like the real reports.
const largeReport = [
  "# Run1E Historical Route500 Final Forensics",
  "",
  ...Array.from({ length: 30 }, (_, index) => section(`Filler Topic ${index}`, 8)).flat(),
  ...section("ROUTE_500_CLASSIFICATION", 2),
  ...section("HISTORICAL_CAUSE_RECOVERABILITY", 3),
  ...section("OPERATOR_LATENCY_REVIEW", 2),
  ...section("Next Decision Options", 4),
  ...Array.from({ length: 10 }, (_, index) => section(`Appendix Item ${index}`, 8)).flat()
].join("\n");

const bigChild = (name, count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`${name}Field${index}`, `value ${index} for ${name}`]));
// > WHOLE_FILE_JSON_TOKENS, with one top-level object over 200 lines.
const largeEvidence = JSON.stringify({
  createdAt: "2026-10-09",
  FULL_PREFLIGHT_RERUN_ELIGIBLE: "NO",
  warnings: [],
  details: { alphaSection: bigChild("alpha", 90), betaSection: bigChild("beta", 90), gammaRetrySection: bigChild("gamma", 90) },
  history: Array.from({ length: 40 }, (_, index) => ({ id: `h${index}`, text: "older history entry, unrelated" }))
}, null, 2);

let fixtureRoot;
async function opsFixture() {
  if (fixtureRoot) return fixtureRoot;
  const root = await mkdtemp(join(tmpdir(), "devguard-rehydration-"));
  cleanup.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "t@example.com"]);
  await git(root, ["config", "user.name", "t"]);
  await put(root, "package.json", JSON.stringify({ name: "ops" }));
  await put(root, ".gitignore", ".devguard/\ndist/\n");
  await put(root, "infra/standby/run1d/evidence-index.json", JSON.stringify(evidenceIndex, null, 2));
  await put(root, "infra/standby/run1d/collect_targeted.py", "# reads infra/standby/phase5k/never-followed.py\nimport json\nprint('collect')\n");
  await put(root, "infra/standby/phase5k/never-followed.py", "print('two hops away')\n");
  await put(root, "infra/standby/phase5j/capacity-snapshot.sql", "select 1;\n");
  await put(root, "infra/standby/phase5n/preflight-once.py", "print('preflight')\n");
  await put(root, "infra/standby/run1d/route500-attribution.json", JSON.stringify({ route: "/internal/refresh-due", status: 500 }, null, 2));
  await put(root, "assets/diagram.png", "not really a png");
  await put(root, "docs/run1c-route-policy.md", "# Run1C Route Policy\n\n## Decision\n\nKnown recurring latency is reviewed per route.\n");
  await put(root, "docs/run1e-final-forensics.md", largeReport);
  await put(root, "infra/standby/run1e/forensics-evidence.json", largeEvidence);
  await put(root, "docs/run1d-blocker-closure.md", "# Run1D Blocker Closure\n\n## Route500 Cause\n\nUnknown.\n\n## Group B\n\nNOT_RESUMED.\n");
  for (let index = 0; index < 12; index += 1) await put(root, `docs/older-phase-${index}.md`, `# Older phase ${index} route latency budget\n\nroute latency budget review notes ${index}.\n`);
  await put(root, "dist/generated.json", "{}\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "fixture"]);
  await ensureDevguardWorkspace(root);
  await ensureCodeIndex(root);
  fixtureRoot = root;
  return root;
}

test("explicit inputs: every valid user-named path is a TARGET (100% recall); invalid ones are warnings, never context", async () => {
  const root = await opsFixture();
  const explicitInputs = [
    "docs/run1d-blocker-closure.md",
    "./infra/standby/run1d/evidence-index.json",
    join(root, "docs/run1c-route-policy.md"),
    "docs/does-not-exist.md",
    "infra/standby/run1d/",
    "../outside.md",
    "/etc/hosts",
    "dist/generated.json"
  ];
  const result = await prepareTaskContext({ root, task: "Run1E final forensics for the route500 event.", explicitInputs, persistTask: true });
  const byPath = Object.fromEntries(result.files.map((file) => [file.path, file]));
  for (const path of ["docs/run1d-blocker-closure.md", "infra/standby/run1d/evidence-index.json", "docs/run1c-route-policy.md"]) {
    assert.equal(byPath[path]?.role, "TARGET", `${path}: ${JSON.stringify(byPath[path])}`);
    assert.equal(byPath[path].source, "explicit-user-input");
  }
  assert.ok(!result.files.some((file) => /does-not-exist|outside|hosts|dist\//.test(file.path)));
  const warnings = result.warnings.join("\n");
  assert.match(warnings, /`docs\/does-not-exist\.md` not found/);
  assert.match(warnings, /is a directory/);
  assert.match(warnings, /path traversal/);
  assert.match(warnings, /outside the repository/);
  assert.match(warnings, /generated or ignored/);
  assert.deepEqual(result.readPlan.explicitInputs, { captured: 3, rejected: 5 });
  // Stored as normalized paths only; the task text is untouched.
  const runtime = await readRuntimeState(root);
  assert.deepEqual(runtime.currentTask.explicitInputs, ["docs/run1d-blocker-closure.md", "infra/standby/run1d/evidence-index.json", "docs/run1c-route-policy.md"]);
  assert.equal(runtime.currentTask.text, "Run1E final forensics for the route500 event.");
  const prepared = (await readTaskTelemetry(root, 50)).filter((event) => event.event === "TASK_PREPARED").at(-1);
  assert.equal(prepared.explicitInputCount, 3);
  assert.ok(!JSON.stringify(prepared).includes("does-not-exist"), "rejected raw inputs are not persisted");
});

test("explicit reading list: a long user list is fully kept; ranked suggestions shrink to CANDIDATEs around it", async () => {
  const root = await opsFixture();
  const explicitInputs = Array.from({ length: 12 }, (_, index) => `docs/older-phase-${index}.md`);
  const result = await prepareTaskContext({ root, task: "Review the route latency budget across older phases.", explicitInputs, persistTask: false });
  const targets = result.files.filter((file) => file.role === "TARGET").map((file) => file.path);
  for (const path of explicitInputs) assert.ok(targets.includes(path), `${path} missing from TARGETs`);
  const others = result.files.filter((file) => !explicitInputs.includes(file.path));
  assert.ok(others.length <= 3, others.map((file) => file.path).join(", "));
  assert.ok(others.every((file) => file.role !== "TARGET" || file.source === "reference"), "ranked files never compete with the user's list as TARGETs");
  assert.equal(result.files[0].source, "explicit-user-input", "the user's own files lead the plan");
});

test("one-hop references: scripts named in a structured TARGET are planned; missing/binary/free-text/two-hop paths are not", async () => {
  const root = await opsFixture();
  const result = await prepareTaskContext({
    root,
    task: "Run1E final forensics: start from the Run1D evidence.",
    explicitInputs: ["infra/standby/run1d/evidence-index.json"],
    persistTask: false
  });
  const references = result.files.filter((file) => file.source === "reference");
  const paths = references.map((file) => file.path);
  assert.ok(paths.includes("infra/standby/run1d/collect_targeted.py"), paths.join(", "));
  assert.equal(paths[0], "infra/standby/run1d/collect_targeted.py", "a role-named single reference (executedCollector.path) ranks first");
  assert.ok(paths.includes("infra/standby/phase5n/preflight-once.py"), paths.join(", "));
  assert.ok(paths.includes("infra/standby/phase5j/capacity-snapshot.sql"), paths.join(", "));
  assert.ok(paths.length <= 4);
  assert.ok(!paths.some((path) => /missing-file|diagram\.png|never-followed/.test(path)), paths.join(", "));
  for (const file of references) {
    assert.equal(file.role, "CANDIDATE");
    assert.match(file.reason, /^Referenced by infra\/standby\/run1d\/evidence-index\.json at `/);
  }
  assert.equal(result.readPlan.references, references.length);

  // Named by the task itself → TARGET.
  const named = await prepareTaskContext({
    root,
    task: "Run1E: rerun collect_targeted.py exactly as Run1D did.",
    explicitInputs: ["infra/standby/run1d/evidence-index.json"],
    persistTask: false
  });
  assert.equal(named.files.find((file) => file.path === "infra/standby/run1d/collect_targeted.py")?.role, "TARGET");

  // Key semantics: a path in a non-file key (free text) is not a reference.
  const raw = extractPathReferences("x/evidence-index.json", JSON.stringify(evidenceIndex));
  assert.ok(!raw.some((entry) => entry.at === "note"), JSON.stringify(raw));
  assert.ok(raw.some((entry) => entry.at === "executedCollector.path" && entry.named));
  assert.ok(raw.some((entry) => entry.at === "inputFiles[].path" && !entry.named && entry.inputLike));
});

test("Markdown: a small TARGET doc is WHOLE_FILE; a large one gets readable section units (≥12 lines), never 3-line stubs", async () => {
  const root = await opsFixture();
  const result = await prepareTaskContext({
    root,
    task: "Decide the operator latency review: read the route 500 classification, historical cause recoverability and next decision options.",
    explicitInputs: ["docs/run1e-final-forensics.md", "docs/run1d-blocker-closure.md"],
    persistTask: false
  });
  const small = result.files.find((file) => file.path === "docs/run1d-blocker-closure.md");
  assert.deepEqual(small.ranges.map((range) => range.kind), ["WHOLE_FILE"]);
  const large = result.files.find((file) => file.path === "docs/run1e-final-forensics.md");
  assert.ok(!large.ranges.some((range) => range.kind === "WHOLE_FILE"), "large docs are not planned whole");
  assert.ok(large.ranges.length >= 1);
  for (const range of large.ranges) assert.ok(range.endLine - range.startLine + 1 >= 12, `${range.label}: ${range.startLine}-${range.endLine}`);
  const text = (await readFile(join(root, "docs/run1e-final-forensics.md"), "utf8")).split("\n");
  const covered = (heading) => large.ranges.some((range) => text.slice(range.startLine - 1, range.endLine).some((line) => line === `## ${heading}`));
  assert.ok(covered("ROUTE_500_CLASSIFICATION") && covered("HISTORICAL_CAUSE_RECOVERABILITY"), large.ranges.map((range) => `${range.label} ${range.startLine}-${range.endLine}`).join(" | "));
  assert.ok(!large.ranges.some((range) => /Appendix|Filler/.test(range.label)), large.ranges.map((range) => range.label).join(" | "));
  const payload = toAgentContextPayload(result);
  assert.equal(payload.files.find((file) => file.path === "docs/run1d-blocker-closure.md").ranges[0].kind, "WHOLE_FILE");
});

test("JSON: no opening-line-only or empty-container ranges; a complete scalar decision line stays; a >200-line object splits one level", async () => {
  const root = await opsFixture();
  const result = await prepareTaskContext({
    root,
    task: "Check FULL_PREFLIGHT_RERUN_ELIGIBLE, the warnings and the gammaRetrySection details in the Run1E forensics evidence.",
    explicitInputs: ["infra/standby/run1e/forensics-evidence.json"],
    persistTask: false
  });
  const evidence = result.files.find((file) => file.path === "infra/standby/run1e/forensics-evidence.json");
  const lines = largeEvidence.split("\n");
  const labels = evidence.ranges.map((range) => `${range.label} ${range.startLine}-${range.endLine}`);
  assert.ok(evidence.ranges.some((range) => range.label === "json key: details.gammaRetrySection"), labels.join(" | "));
  const gamma = evidence.ranges.find((range) => range.label === "json key: details.gammaRetrySection");
  assert.equal(lines[gamma.startLine - 1].trim(), '"gammaRetrySection": {');
  assert.equal(lines[gamma.endLine - 1].trim().replace(/,$/, ""), "}");
  assert.ok(!evidence.ranges.some((range) => range.label === "json key: details"), "the 270-line parent is not offered whole");
  for (const range of evidence.ranges.filter((entry) => entry.startLine === entry.endLine)) {
    assert.match(lines[range.startLine - 1], /^\s*"[^"]+":\s*"[^"]*",?$/, `1-line range must be a complete scalar: ${range.label}`);
  }
  assert.ok(!evidence.ranges.some((range) => /warnings/.test(range.label)), `"warnings": [] is an empty container: ${labels.join(" | ")}`);

  const sections = jsonSections(largeEvidence);
  const child = sections.find((entry) => entry.kind === "json-child" && entry.name === "details.betaSection");
  assert.ok(child);
  assert.equal(lines[child.startLine - 1].trim(), '"betaSection": {');
  assert.ok(!sections.some((entry) => entry.kind === "json-child" && entry.name.startsWith("history.")), "children only for objects, items stay items");
});

test("read plan: one canonical plan with a planned-initial estimate (characters/4, not provider tokens)", async () => {
  const root = await opsFixture();
  const result = await prepareTaskContext({
    root,
    task: "Run1E final forensics.",
    explicitInputs: ["docs/run1d-blocker-closure.md", "infra/standby/run1d/evidence-index.json"],
    persistTask: false
  });
  const targets = result.files.filter((file) => file.role === "TARGET");
  assert.equal(result.readPlan.required.files, targets.length);
  assert.ok(result.readPlan.required.estimatedTokens > 0);
  const duplicates = result.files.map((file) => file.path).filter((path, index, all) => all.indexOf(path) !== index);
  assert.deepEqual(duplicates, [], "no file is listed twice");
  const payload = toAgentContextPayload(result);
  assert.match(payload.readPlan.estimateBasis, /not a provider token count/);
  assert.match(payload.readPlan.order, /WHOLE_FILE means read it once, whole/);
});

test("MCP: explicitInputs passes through the tool schema; the payload marks the user's files", async () => {
  const root = await opsFixture();
  const env = { ...process.env, HOME: root, CODEX_HOME: join(root, ".no-codex") };
  delete env.CLAUDE_CODE_SESSION_ID;
  const transport = new StdioClientTransport({ command: process.execPath, args: [cliEntry, "mcp"], cwd: root, env, stderr: "ignore" });
  const client = new Client({ name: "devguard-rehydration-test", version: "0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const prepare = tools.find((tool) => tool.name === "prepare_task_context");
    assert.ok(prepare.inputSchema.properties.explicitInputs, "schema exposes explicitInputs");
    const response = await client.callTool({ name: "prepare_task_context", arguments: { task: "Run1E final forensics.", explicitInputs: ["docs/run1d-blocker-closure.md"] } });
    const payload = JSON.parse(response.content[0].text);
    const file = payload.files.find((entry) => entry.path === "docs/run1d-blocker-closure.md");
    assert.equal(file.role, "TARGET");
    assert.equal(file.source, "explicit-user-input");
    assert.equal(payload.readPlan.explicitInputs.captured, 1);
  } finally {
    await client.close();
  }
});

test("explicit input validation in isolation: symlink escapes and duplicates", async () => {
  const root = await opsFixture();
  const { symlink } = await import("node:fs/promises");
  const outside = await mkdtemp(join(tmpdir(), "devguard-outside-"));
  cleanup.push(outside);
  await writeFile(join(outside, "secret.md"), "# outside\n");
  await symlink(join(outside, "secret.md"), join(root, "docs/linked-secret.md")).catch(() => undefined);
  const resolution = await resolveExplicitInputs(root, ["docs/linked-secret.md", "docs/run1c-route-policy.md", "docs/run1c-route-policy.md"], () => false);
  assert.deepEqual(resolution.accepted, ["docs/run1c-route-policy.md"]);
  assert.match(resolution.warnings.join("\n"), /linked-secret\.md` ignored: not a regular file inside the repository/);
});

// --- Dashboard: the primary issue is the largest real source ---------------

import { classifyCommand } from "../dist/agent-activity.js";
import { contextIssues } from "../dist/context-efficiency.js";

function efficiency(overrides) {
  return {
    sessionId: "s", label: "t", startedAt: "2026-10-09T00:00:00Z", estTokens: 58000,
    costByCategory: { MCP: 2600, FALLBACK_DOCS: 0, SEARCH: 5000, CODE_READS: 39400, CODE_EDITS: 4500, VALIDATION: 0, ADMIN: 2900, OTHER: 3600 },
    modeTokens: { IMPLEMENTATION: 4700, EXPLORATION: 44200, VALIDATION: 1100, CONTEXT_ADMIN: 2900, RESUME_RECOVERY: 1500, OTHER: 3600 },
    otherBreakdown: {}, provided: { files: 8 }, usedFiles: 15, providedUsed: 4, nonProvidedUsed: 11,
    searchCalls: 3, broadSearchCalls: 0, searchBeforeProvidedRead: false, fallbackDocReads: 0, repeatedFallbackDocReads: 0,
    validation: { pass: 0, fail: 0, unknown: 0 }, threads: ["a"], compactions: 0, activityEvents: 20, touchedFiles: [],
    unusedSuggestionReads: { files: 4, estTokens: 6600 },
    nonProvidedReads: { files: 11, estTokens: 39000 },
    providedDocRereads: { files: 0, estTokens: 0 },
    ...overrides
  };
}

test("dashboard: ~39K of unplanned required reads outranks ~6.6K of unused suggestions (the real B0–B4 task)", () => {
  const issues = contextIssues(efficiency({}));
  assert.equal(issues[0].id, "MISSING_REQUIRED_INPUTS", issues.map((issue) => issue.id).join(", "));
  assert.equal(issues[0].severity, "strong");
  assert.match(issues[0].action, /explicitInputs/);
  assert.ok(issues.some((issue) => issue.id === "UNUSED_SUGGESTIONS"), "still reported, just not primary");
  assert.ok(!issues.some((issue) => issue.id === "SUGGESTIONS_MISSED"), "subsumed by MISSING_REQUIRED_INPUTS");

  const rereads = contextIssues(efficiency({ nonProvidedReads: { files: 1, estTokens: 1000 }, providedDocRereads: { files: 3, estTokens: 9000 } }));
  assert.equal(rereads[0].id, "INSUFFICIENT_DOCUMENT_RANGES", rereads.map((issue) => issue.id).join(", "));
});

test("activity: inline-script JSON reads after `cd`/`env` prefixes and literal Path joins are file reads; dynamic paths stay unknown", async () => {
  const root = await opsFixture();
  const { existsSync } = await import("node:fs");
  const exists = existsSync;
  const script = "cd infra && python3 - <<'PY'\nimport json\nfrom pathlib import Path\nd=json.loads((Path('standby/run1d') / 'evidence-index.json').read_text())\nPY";
  const joined = classifyCommand(script, [], root, root, exists);
  assert.equal(joined.category, "CODE_READS");
  assert.deepEqual(joined.paths, ["infra/standby/run1d/evidence-index.json"]);

  const prefixed = classifyCommand("cat docs/run1c-route-policy.md; env -i PATH=/usr/bin python3 -c \"import json; json.load(open('infra/standby/run1d/route500-attribution.json'))\"", [], root, root, exists);
  assert.equal(prefixed.category, "CODE_READS");
  assert.deepEqual(prefixed.paths.sort(), ["docs/run1c-route-policy.md", "infra/standby/run1d/route500-attribution.json"]);

  const dynamic = classifyCommand("python3 - <<'PY'\nfrom pathlib import Path\nb=Path('infra/standby/run1d')\nfor n in ['a','b']:\n  print((b/(n+'.json')).read_text())\nPY", [], root, root, exists);
  assert.equal(dynamic.category, "OTHER", "a computed path is not guessed");
  assert.equal(dynamic.otherLabel, "inline script");
});
