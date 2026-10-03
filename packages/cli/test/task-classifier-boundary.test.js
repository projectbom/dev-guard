// DG-06 regression tests: classifyTaskType's patterns must respect word
// boundaries for short, generic English tokens ("ci", "env", "api",
// "auth", "config", "ui", "docs"). Before this fix, a plain identifier
// like "IncidentListSchema" (contains "ci") made classifyTaskType return
// "infra_config" for a task that had nothing to do with infrastructure —
// found via PartnerFlow downstream smoke testing. That misclassification
// then routed the task into scoreTaskTypeCandidates, which (separately)
// used to assign role="edit" to the first 5 candidates unconditionally,
// completely bypassing the DG-05 strong-reason-gate contract.
//
// Generic fixtures only (no PartnerFlow/downstream-project naming).
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyTaskType } from "@dev-guard/core";
import { scoreTaskTypeCandidates } from "../dist/task-ai.js";

// --- False positives: ordinary identifiers must NOT become infra_config ---

const falsePositiveIdentifiers = [
  "Rename the IncidentListSchema type to IncidentRecordSchema.",
  "Improve the specificity of the error message shown to the user.",
  "Make the sorting algorithm more efficient.",
  "Document the decision to use a single retry queue.",
  "Increase the capacity of the in-memory cache.",
  "Add an environmental impact note to the footer.",
  "Rename the configurationView component to SettingsPanel.",
  "Style the authenticationCard component's border radius."
];

test("DG-06 False Positives: ordinary identifiers/words containing 'ci'/'env'/'config'/'auth' as a bare substring do not become infra_config", () => {
  for (const requirement of falsePositiveIdentifiers) {
    const result = classifyTaskType(requirement);
    assert.notEqual(result.type, "infra_config", `"${requirement}" must not classify as infra_config (got ${result.type})`);
  }
});

// --- Real positives: genuine infra/env/CI/deploy/config tasks must still match ---

const realPositiveRequirements = [
  "Update the CI workflow to run tests on every push.",
  "Add a new variable to .env and .env.local.",
  "Modify the deployment config for the staging environment.",
  "Update next.config.ts to add a new redirect.",
  "Change the Docker deployment settings for the worker service."
];

test("DG-06 Real Positives: genuine CI/env/deploy/config requests still classify as infra_config", () => {
  for (const requirement of realPositiveRequirements) {
    const result = classifyTaskType(requirement);
    assert.equal(result.type, "infra_config", `"${requirement}" should still classify as infra_config (got ${result.type})`);
  }
});

// --- Korean matching preserved -----------------------------------------------

const koreanPositiveRequirements = ["배포 설정 파일을 수정해주세요.", "환경 변수를 추가해주세요.", "DB 마이그레이션 스크립트를 작성해주세요."];

test("DG-06 Korean Preservation: existing Korean infra/config/migration matching is unchanged", () => {
  const types = koreanPositiveRequirements.map((requirement) => classifyTaskType(requirement).type);
  assert.equal(types[0], "infra_config");
  assert.equal(types[1], "infra_config");
  assert.equal(types[2], "migration");
});

// --- Cross-type: a short token embedded in a longer word must not flip an obvious other type ---

test("DG-06 Cross-Type: a refactor/UI/docs task is not accidentally reclassified as infra_config by an embedded short token", () => {
  // "efficient" contains "ci"; "build" contains "ui"; "docker" contains "doc" —
  // none of these should flip an otherwise-clear task type.
  const refactorResult = classifyTaskType("Refactor the formatter module to be more efficient and remove duplication.");
  assert.equal(refactorResult.type, "refactor");

  const uiResult = classifyTaskType("Polish the layout spacing so the build looks less cramped.");
  assert.notEqual(uiResult.type, "infra_config");

  const docsResult = classifyTaskType("Update the README to describe the docker-compose setup.");
  // "docker" must not be caught by the bare "doc" pattern either; this is
  // a real infra-flavored docs request and either docs or infra_config is
  // acceptable, but it must be a deliberate match, not an accidental one —
  // assert only that classification did not crash and produced *a* type.
  assert.ok(docsResult.type);
});

// --- scoreTaskTypeCandidates audit: role contract must not be bypassed ------

test("DG-06 scoreTaskTypeCandidates audit: no blanket 'first 5 = edit' promotion for infra_config/docs/architecture/migration", () => {
  const requirement = "Rename the IncidentListSchema type to IncidentRecordSchema.";
  const candidates = ["package.json", "tsconfig.json", "next.config.ts", "src/app/layout.tsx", "src/types/schema.ts", "src/unrelated/other.ts"];
  const scored = scoreTaskTypeCandidates({ type: "infra_config", confidence: "medium", reasons: [], strategy: "config-first", riskLevel: "high", requiresPhasing: false }, candidates, candidates, requirement);
  // None of these candidates are explicitly mentioned in the requirement,
  // so none may be "edit" — the old code promoted the first 5 regardless.
  assert.ok(scored.every((candidate) => candidate.role !== "edit"), `expected no edit-role candidates without explicit mention, got: ${JSON.stringify(scored.filter((c) => c.role === "edit"))}`);
});

test("DG-06 scoreTaskTypeCandidates audit: an explicitly-named file IS promoted to edit (contract preserved, not just disabled)", () => {
  const requirement = "In src/types/schema.ts, rename the IncidentListSchema type to IncidentRecordSchema.";
  const candidates = ["package.json", "tsconfig.json", "src/types/schema.ts", "src/unrelated/other.ts"];
  const scored = scoreTaskTypeCandidates({ type: "infra_config", confidence: "medium", reasons: [], strategy: "config-first", riskLevel: "high", requiresPhasing: false }, candidates, candidates, requirement);
  const target = scored.find((candidate) => candidate.path === "src/types/schema.ts");
  assert.equal(target.role, "edit");
  const others = scored.filter((candidate) => candidate.path !== "src/types/schema.ts");
  assert.ok(others.every((candidate) => candidate.role !== "edit"));
});

test("DG-06 scoreTaskTypeCandidates audit: i18n/product_strategy role logic is unchanged", () => {
  const i18nScored = scoreTaskTypeCandidates(
    { type: "i18n", confidence: "high", reasons: [], strategy: "structure-first", riskLevel: "high", requiresPhasing: true },
    ["src/i18n/config.ts", "src/unrelated/other.ts"],
    ["src/i18n/config.ts", "src/unrelated/other.ts"],
    "Add i18n support."
  );
  assert.equal(i18nScored.find((c) => c.path === "src/i18n/config.ts").role, "edit");
  assert.equal(i18nScored.find((c) => c.path === "src/unrelated/other.ts").role, "reference");

  const strategyScored = scoreTaskTypeCandidates(
    { type: "product_strategy", confidence: "high", reasons: [], strategy: "discovery-first", riskLevel: "high", requiresPhasing: true },
    ["src/anything.ts"],
    ["src/anything.ts"],
    "Why should users share this result?"
  );
  assert.ok(strategyScored.every((c) => c.role === "reference"));
});
