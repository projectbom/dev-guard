// DG-05 regression tests: DevGuard's deterministic file-candidate layer
// (analyzeFileRelevance / scoreFileRelevance / applyGraphImpactScoring /
// generateTaskMarkdownResult's postProcessTaskMarkdown feed) must not
// promote a merely-related file to role "edit" — and once promoted, the
// AI prompt told models to trust role=edit uncritically ("점수 기반 후보
// 분리에서 role=edit인 파일은 특별한 반대 근거가 없으면 수정 대상에
// 포함하세요" in taskAISystemPrompt-adjacent buildTaskAIPrompt rules).
// Both gpt-4o-mini and gpt-6-luna reproduced the exact same wrong edit
// targets in the model benchmark because of this — this suite proves the
// bug and its fix at the deterministic layer, with NO AI API calls.
//
// Generic fixtures only (no PartnerFlow/downstream-project naming).
import { test } from "node:test";
import assert from "node:assert/strict";

import { analyzeFileRelevance, generateTaskMarkdownResult } from "@dev-guard/core";

function roleOf(candidates, path) {
  return candidates.find((c) => c.path === path)?.role;
}

// --- H. Sibling File Isolation (found via PartnerFlow downstream revalidation) ---
//
// A real monorepo commonly has sibling files sharing one meaningful path
// segment (api-client.ts / api-client.server.ts / api-client.test.ts all
// contain "client"). An earlier version of this fix still treated an exact
// "specific" path-token match as strong evidence, which promoted every
// sibling to "edit" alongside the explicitly named file — directly
// contradicting an explicit "do not change any other file" instruction.
// Caught during PartnerFlow smoke testing, not by any of fixtures A-G
// above (all of which happen to have no same-stem siblings) — kept here so
// this exact shape never regresses silently again.

test("H. Sibling File Isolation: siblings sharing a path segment with the explicit target are not promoted to edit", () => {
  const candidates = analyzeFileRelevance(
    "In src/lib/api-client.ts, move the stray import at the end of the file to the top, grouped with the other imports. Do not change any other file.",
    ["src/lib/api-client.ts", "src/lib/api-client.server.ts", "src/lib/api-client.test.ts", "src/lib/api-client.server.test.ts"]
  );
  assert.equal(roleOf(candidates, "src/lib/api-client.ts"), "edit");
  assert.notEqual(roleOf(candidates, "src/lib/api-client.server.ts"), "edit");
  assert.notEqual(roleOf(candidates, "src/lib/api-client.test.ts"), "edit");
  assert.notEqual(roleOf(candidates, "src/lib/api-client.server.test.ts"), "edit");
});

// --- I. Plural Directory Naming (found via PartnerFlow downstream revalidation) ---
//
// GENERIC_LOW_SPECIFICITY_WORDS originally listed only singular structural
// names ("app", not "apps"). A monorepo using the equally common plural
// convention (apps/admin/..., apps/api/...) let "apps" slip through as a
// "specific" token, promoting unrelated files across the whole apps/
// tree to edit. isGenericLowSpecificityWord now matches the simple
// plural/singular counterpart too.

test("I. Plural Directory Naming: a plural structural directory name (apps/, packages/) never counts as specific", () => {
  const candidates = analyzeFileRelevance(
    "In apps/admin/lib/api-client.ts, move the stray import at the end of the file to the top, grouped with the other imports. Do not change any other file.",
    ["apps/admin/lib/api-client.ts", "apps/admin/app/api/widgets/route.ts", "apps/api/src/index.ts", "packages/contracts/src/index.ts"]
  );
  assert.equal(roleOf(candidates, "apps/admin/lib/api-client.ts"), "edit");
  assert.notEqual(roleOf(candidates, "apps/admin/app/api/widgets/route.ts"), "edit");
  assert.notEqual(roleOf(candidates, "apps/api/src/index.ts"), "edit");
  assert.notEqual(roleOf(candidates, "packages/contracts/src/index.ts"), "edit");
});

// --- A. Explicit Path Isolation ---------------------------------------------

test("A. Explicit Path Isolation: the explicitly named file is edit; unrelated same-keyword files are not", () => {
  const candidates = analyzeFileRelevance(
    "Fix src/client/api-client.ts",
    ["src/client/api-client.ts", "src/api/users.ts", "src/auth/session.ts", "src/db/schema.ts"]
  );
  assert.equal(roleOf(candidates, "src/client/api-client.ts"), "edit");
  assert.notEqual(roleOf(candidates, "src/api/users.ts"), "edit");
  assert.notEqual(roleOf(candidates, "src/auth/session.ts"), "edit");
  assert.notEqual(roleOf(candidates, "src/db/schema.ts"), "edit");
});

// --- B. UI-only Isolation ----------------------------------------------------

test("B. UI-only Isolation: the UI file is edit; negated auth/API/DB concepts are protected, never edit", () => {
  const candidates = analyzeFileRelevance(
    "Polish layout of src/pages/Settings.tsx. Do not change auth, API, or DB.",
    ["src/pages/Settings.tsx", "src/auth/session.ts", "src/api/users.ts", "src/db/schema.ts"]
  );
  assert.equal(roleOf(candidates, "src/pages/Settings.tsx"), "edit");
  assert.notEqual(roleOf(candidates, "src/auth/session.ts"), "edit");
  assert.notEqual(roleOf(candidates, "src/api/users.ts"), "edit");
  assert.notEqual(roleOf(candidates, "src/db/schema.ts"), "edit");
  assert.equal(roleOf(candidates, "src/auth/session.ts"), "protected");
  assert.equal(roleOf(candidates, "src/db/schema.ts"), "protected");
});

// --- C. Refactor Dependency --------------------------------------------------

test("C. Refactor Dependency: the direct target is edit; a dependent file is reference at most, never edit from adjacency alone", () => {
  const codeGraph = [
    { file: "src/utils/formatter.ts", imports: [], importedBy: ["src/components/Report.tsx"], exports: ["formatDate"], category: "utils", impactCandidates: [], usageHints: [] },
    { file: "src/components/Report.tsx", imports: ["src/utils/formatter.ts"], importedBy: [], exports: ["Report"], category: "components", impactCandidates: [], usageHints: [] }
  ];
  const candidates = analyzeFileRelevance(
    "Extract helper logic from src/utils/formatter.ts without changing behavior.",
    ["src/utils/formatter.ts", "src/components/Report.tsx", "src/unrelated/other.ts"],
    { codeGraph }
  );
  assert.equal(roleOf(candidates, "src/utils/formatter.ts"), "edit");
  assert.notEqual(roleOf(candidates, "src/components/Report.tsx"), "edit", "a reverse-dependency bump alone must not promote to edit");
  assert.notEqual(roleOf(candidates, "src/unrelated/other.ts"), "edit");
});

// --- D. AI model independence -----------------------------------------------

const WEAK_STUB_MARKDOWN = `## 목표
stub

## 사용자 요구사항 해석
- 원문: stub
- inferred intent: stub
- inferred domain: 확인 필요
- inferred subtype: stub
- inferred risk: low
- 이 작업이 아닌 것:
  - stub

## 작업 유형
- type: stub

## 현재 문제
stub

## 수정 범위
관련 파일 확인 필요

## 수정 대상
관련 파일 확인 필요

## 참고 대상
없음

## 보호 대상
없음

## 반드시 지킬 규칙
- stub

## 건드리면 안 되는 것
- stub

## 완료 조건
- stub

## 검증 명령어
- \`pnpm run build\`

## Codex에게 전달할 주의사항
- stub
`;

function stubProvider(markdown = WEAK_STUB_MARKDOWN) {
  return { name: "none", async generateText() { return markdown; } };
}

const baseContext = {
  rulesMarkdown: "",
  mistakesMarkdown: "",
  projectStateMarkdown: "",
  decisionsMarkdown: "",
  changedFiles: [],
  diffText: ""
};

test("D. AI model independence: with a deliberately weak/empty AI output (no real model reasoning), wrong files still never land in edit targets", async () => {
  const result = await generateTaskMarkdownResult(stubProvider(), {
    ...baseContext,
    requirement: "Polish layout of src/pages/Settings.tsx. Do not change auth, API, or DB.",
    projectFiles: ["src/pages/Settings.tsx", "src/auth/session.ts", "src/api/users.ts", "src/db/schema.ts"]
  });
  const editSection = result.markdown.split("## 참고 대상")[0];
  assert.ok(editSection.includes("src/pages/Settings.tsx"));
  assert.ok(!editSection.includes("src/auth/session.ts"));
  assert.ok(!editSection.includes("src/api/users.ts"));
  assert.ok(!editSection.includes("src/db/schema.ts"));
});

// --- E. Protected Never Promoted ---------------------------------------------

test("E. Protected Never Promoted: a role=protected candidate never appears in the final 수정 대상 section, even with a weak AI output", async () => {
  const result = await generateTaskMarkdownResult(stubProvider(), {
    ...baseContext,
    requirement: "Polish layout of src/pages/Settings.tsx. Do not change auth, API, or DB.",
    projectFiles: ["src/pages/Settings.tsx", "src/auth/session.ts", "src/api/users.ts", "src/db/schema.ts"]
  });
  const targetSection = result.markdown.split("## 수정 대상")[1]?.split("## 참고 대상")[0] ?? "";
  assert.ok(!targetSection.includes("src/auth/session.ts"));
  assert.ok(!targetSection.includes("src/db/schema.ts"));
});

// --- F. Reference Never Auto-Promoted ---------------------------------------

test("F. Reference Never Auto-Promoted: a weak/generic-only candidate (reference) is not injected into 수정 대상 by fallback filling", () => {
  // "services" is a generic, low-specificity directory word — path-token
  // matches on it alone must stay weak (reference), never edit.
  const candidates = analyzeFileRelevance(
    "Extract the duplicated retry logic found in src/services/paymentClient.ts and src/services/notificationClient.ts into a new shared src/services/retry.ts helper.",
    ["src/services/paymentClient.ts", "src/services/notificationClient.ts", "src/services/retry.ts", "src/services/emailClient.ts", "src/services/smsClient.ts"]
  );
  assert.equal(roleOf(candidates, "src/services/paymentClient.ts"), "edit");
  assert.equal(roleOf(candidates, "src/services/notificationClient.ts"), "edit");
  assert.equal(roleOf(candidates, "src/services/retry.ts"), "edit");
  assert.notEqual(roleOf(candidates, "src/services/emailClient.ts"), "edit");
  assert.notEqual(roleOf(candidates, "src/services/smsClient.ts"), "edit");
});

// --- G. Explicit High-Confidence Preserved ----------------------------------

test("G. Explicit High-Confidence Preserved: an explicit target survives into 수정 대상 even when the AI output omits it entirely", async () => {
  const result = await generateTaskMarkdownResult(stubProvider(), {
    ...baseContext,
    requirement: "Fix src/client/api-client.ts",
    projectFiles: ["src/client/api-client.ts", "src/api/users.ts", "src/auth/session.ts"]
  });
  const targetSection = result.markdown.split("## 수정 대상")[1]?.split("## 참고 대상")[0] ?? "";
  assert.ok(targetSection.includes("src/client/api-client.ts"), "the explicit target must be re-inserted by deterministic scope-filling even though the stub AI never mentioned it");
});
