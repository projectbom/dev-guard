// DG-07 regression tests: task-ai's prompt to the AI provider must stay
// within a safe input-token budget on a large repository, without ever
// dropping Priority-1 sections (raw requirement, explicit targets/routes,
// task type, completion criteria, the role-tagged candidate list,
// generation rules) and without adding any extra provider calls. Found via
// PartnerFlow downstream smoke testing: a real large repo's uncommitted
// diff alone measured ~146,000 estimated tokens — by itself already past
// gpt-4o-mini's context window before any other section was even counted.
//
// Generic fixtures only (no PartnerFlow/downstream-project naming).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildTaskAIPromptSections,
  buildTaskAIPromptWithBudget,
  trimTaskAIPromptSections,
  generateTaskMarkdownResult
} from "@dev-guard/core";

const smallContext = {
  requirement: "Add a subtract(a, b) function to src/math.ts.",
  rulesMarkdown: "- keep changes minimal",
  mistakesMarkdown: "- avoid scope creep",
  projectStateMarkdown: "a small generic project",
  decisionsMarkdown: "- decision: none relevant",
  changedFiles: ["src/math.ts"],
  diffText: "diff --git a/src/math.ts b/src/math.ts\n+export function subtract(a,b){return a-b;}",
  projectFiles: ["src/math.ts", "src/index.ts", "README.md"]
};

function makeLargeRepoContext() {
  const projectFiles = Array.from({ length: 1200 }, (_, i) => `src/modules/module-${i}/index.ts`);
  const hugeProse = (label) => Array.from({ length: 2000 }, (_, i) => `- ${label} line ${i}: filler content to simulate a very large real document.`).join("\n");
  const hugeDiff = Array.from({ length: 300 }, (_, i) => [
    `diff --git a/src/modules/module-${i}/index.ts b/src/modules/module-${i}/index.ts`,
    "index 1111111..2222222 100644",
    "--- a/src/modules/module-" + i + "/index.ts",
    "+++ b/src/modules/module-" + i + "/index.ts",
    "@@ -1,3 +1,10 @@",
    "+export function generatedHelper() {",
    "+  return " + i + ";",
    "+}"
  ].join("\n")).join("\n");
  return {
    requirement: "In src/client/api-client.ts, move the stray import at the end of the file to the top. Do not change any other file.",
    rulesMarkdown: hugeProse("rule"),
    mistakesMarkdown: hugeProse("mistake"),
    projectStateMarkdown: hugeProse("state"),
    decisionsMarkdown: hugeProse("decision"),
    changedFiles: projectFiles.slice(0, 300),
    diffText: hugeDiff,
    projectFiles: [...projectFiles, "src/client/api-client.ts"]
  };
}

test("A. Small repo: output semantics unchanged, nothing trimmed, well under budget", () => {
  const { report } = buildTaskAIPromptWithBudget(smallContext);
  assert.equal(report.trimmedSections.length, 0);
  assert.ok(report.estimatedTotalTokens < report.budget);
});

test("B. Large repository: 1200+ files, large state/decisions/mistakes, a huge diff — final prompt stays within budget", () => {
  const { prompt, report } = buildTaskAIPromptWithBudget(makeLargeRepoContext());
  assert.ok(report.estimatedTotalTokens <= report.budget, `expected <= ${report.budget}, got ${report.estimatedTotalTokens}`);
  assert.ok(prompt.length > 0);
  assert.ok(report.trimmedSections.length > 0, "a repo this large should actually need trimming");
});

test("C. Explicit target survival: the explicit file path and role-tagged candidate list survive budget pressure", () => {
  const { prompt } = buildTaskAIPromptWithBudget(makeLargeRepoContext());
  assert.ok(prompt.includes("src/client/api-client.ts"), "the explicitly named file must still appear in the prompt");
  assert.ok(prompt.includes("점수 기반 후보 분리"), "the role-tagged candidate section must never be trimmed");
});

test("D. Protected constraints survival: explicit route guidance and generation rules survive budget pressure", () => {
  const { prompt } = buildTaskAIPromptWithBudget(makeLargeRepoContext());
  assert.ok(prompt.includes("명시 route 기반 대상 분리"));
  assert.ok(prompt.includes("task.md 생성 규칙"));
  assert.ok(prompt.includes('role=protected인 파일은 "보호 대상"에 넣고 수정하지 마세요.'));
});

test("E. Low-priority trimming order: Priority 4 (bulk listings) are trimmed before Priority 3, and Priority 1/2 are never trimmed", () => {
  const sections = buildTaskAIPromptSections(makeLargeRepoContext());
  const { report } = trimTaskAIPromptSections(sections, 500); // artificially tiny budget to force maximum trimming
  const trimmedPriorities = report.sections.filter((s) => s.trimmed).map((s) => s.priority);
  const keptPriorities = report.sections.filter((s) => !s.trimmed).map((s) => s.priority);
  assert.ok(trimmedPriorities.every((p) => p > 1), "only priority 2/3/4 sections may be trimmed");
  assert.ok(keptPriorities.every((p) => p === 1), "with an extreme budget, only priority 1 sections should remain");
  // Trimmed order must be highest-priority-number (lowest importance) first.
  const trimmedInOrder = report.trimmedSections.map((label) => sections.find((s) => s.label === label)?.priority ?? 0);
  for (let i = 1; i < trimmedInOrder.length; i++) {
    assert.ok(trimmedInOrder[i] <= trimmedInOrder[i - 1], "trim order must proceed from lowest to higher priority (4 before 3 before 2)");
  }
});

test("F. Deterministic output: the same input produces the same section selection every time", () => {
  const context = makeLargeRepoContext();
  const first = buildTaskAIPromptWithBudget(context);
  const second = buildTaskAIPromptWithBudget(context);
  assert.deepEqual(first.report.trimmedSections, second.report.trimmedSections);
  assert.equal(first.prompt, second.prompt);
});

test("G. No extra API calls: a huge-diff fixture still makes exactly one provider call (plus the pre-existing email/password retry path, unrelated)", async () => {
  let calls = 0;
  const provider = {
    name: "none",
    async generateText() {
      calls += 1;
      return "## 목표\nstub\n\n## 사용자 요구사항 해석\nstub\n\n## 작업 유형\nstub\n\n## 현재 문제\nstub\n\n## 수정 범위\nstub\n\n## 수정 대상\nsrc/client/api-client.ts\n\n## 참고 대상\n없음\n\n## 보호 대상\n없음\n\n## 반드시 지킬 규칙\nstub\n\n## 건드리면 안 되는 것\nstub\n\n## 완료 기준\nstub\n\n## 완료 조건\nstub\n\n## 검증 명령어\n- `pnpm run build`\n\n## Codex에게 전달할 주의사항\nstub\n";
    }
  };
  await generateTaskMarkdownResult(provider, makeLargeRepoContext());
  assert.equal(calls, 1, "budget trimming must not itself trigger any additional AI call");
});
