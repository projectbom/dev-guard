import type { ChangeFile, CodeGraphEntry, InferredDiffIntent, InferredDiffIntentClusters, TaskTypeResult } from "./types.js";

const commands = ["task-ai", "fix-prompt", "self-check", "done", "status", "update", "watch", "review", "check", "prompt", "doctor", "report", "scan", "refresh", "telemetry", "self"];

const cliOutputPattern = /(console\.(log|error|warn)|format|summary|preview|success|error|warning|output|print|stdout|stderr|출력|요약|미리보기|성공|실패|경고|안내)/i;
const promptPattern = /(prompt|density|token|compact|ultra|context|프롬프트|토큰|압축)/i;
const relevancePattern = /(relevance|candidate|score|scope|drift|intent|router|routing|selection|후보|관련|범위|의도|분류)/i;
const workflowPattern = /(done|watch|review|check|report|guardrail|workflow|self|update preview|워크플로우|검증|가드)/i;
const cliCommandHandlerPattern = /(^|\/)(task-ai|fix-prompt|self-check|done|status|update|watch|review|check|prompt|doctor|report|scan|refresh|telemetry|self|index)\.ts$/i;
const appSourcePathPattern = /^(app|pages|components|src\/app|src\/pages|src\/components|lib|hooks|utils)\//i;
const livingDocumentPattern = /(living[-_]?document|thought[-_]?artifact|artifact|artifacts|brain|memo|folder|document[-_]?ui|문서|메모|폴더|생각)/i;

export function inferDiffIntent(input: {
  changedFiles: string[];
  changeFiles?: ChangeFile[];
  diffText: string;
  codeGraph?: CodeGraphEntry[];
}): InferredDiffIntent {
  return inferDiffIntentClusters(input).primaryIntent;
}

export function inferDiffIntentClusters(input: {
  changedFiles: string[];
  changeFiles?: ChangeFile[];
  diffText: string;
  codeGraph?: CodeGraphEntry[];
  taskText?: string;
}): InferredDiffIntentClusters {
  const changedFiles = normalizeFiles(input.changedFiles);
  const clusters = clusterChangedFiles(changedFiles, input.diffText ?? "", input.codeGraph ?? []);
  const intents = clusters.map((cluster) =>
    inferSingleDiffIntent({
      changedFiles: cluster.files,
      changeFiles: input.changeFiles?.filter((file) => cluster.files.includes(file.path)),
      diffText: buildClusterDiff(input.diffText ?? "", cluster.files),
      codeGraph: input.codeGraph
    })
  );
  const allIntents = intents.length > 0
    ? dedupeIntents(intents)
    : [
        inferSingleDiffIntent({
          changedFiles,
          changeFiles: input.changeFiles,
          diffText: input.diffText,
          codeGraph: input.codeGraph
        })
      ];
  const primaryIntent = selectPrimaryIntent(allIntents, input.taskText);
  const secondaryIntents = allIntents
    .filter((intent) => intent !== primaryIntent)
    .sort((a, b) => intentStrength(b) - intentStrength(a) || b.changedFiles.length - a.changedFiles.length);
  const secondaryDetails = normalizeSecondaryDetails(secondaryIntents.map((intent) => classifySecondaryIntent(intent, primaryIntent)));
  const normalizedSecondaryIntents = secondaryDetails.map((detail) => detail.intent);
  const unrelatedFiles = normalizedSecondaryIntents.flatMap((intent) => intent.changedFiles);
  const mixedRisk = inferMixedRisk(primaryIntent, secondaryDetails);
  return { primaryIntent, secondaryIntents: normalizedSecondaryIntents, secondaryDetails, mixedRisk, unrelatedFiles };
}

function dedupeIntents(intents: InferredDiffIntent[]): InferredDiffIntent[] {
  const byKey = new Map<string, InferredDiffIntent>();
  for (const intent of intents) {
    const key = `${intent.subtype ?? intent.type}:${intent.targetCommand ?? ""}:${intent.changedFiles.join("|")}`;
    const existing = byKey.get(key);
    if (!existing || intentStrength(intent) > intentStrength(existing)) {
      byKey.set(key, intent);
    }
  }
  return [...byKey.values()];
}

function normalizeSecondaryDetails(
  details: InferredDiffIntentClusters["secondaryDetails"]
): InferredDiffIntentClusters["secondaryDetails"] {
  const byKey = new Map<string, InferredDiffIntentClusters["secondaryDetails"][number]>();
  for (const detail of details) {
    const key = secondaryMergeKey(detail, byKey);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, detail);
      continue;
    }
    const severity = higherSeverity(existing.severity, detail.severity);
    byKey.set(key, {
      intent: {
        ...existing.intent,
        confidence: higherConfidence(existing.intent.confidence, detail.intent.confidence),
        changedFiles: normalizeFiles([...existing.intent.changedFiles, ...detail.intent.changedFiles]),
        evidence: [...new Set([...existing.intent.evidence, ...detail.intent.evidence])].slice(0, 3),
        riskSignals: [...new Set([...existing.intent.riskSignals, ...detail.intent.riskSignals])],
        supportingFiles: normalizeFiles([...existing.intent.supportingFiles, ...detail.intent.supportingFiles]).slice(0, 8),
        scope: [...new Set([...existing.intent.scope, ...detail.intent.scope])].slice(0, 5)
      },
      severity,
      reason: [...new Set([existing.reason, detail.reason])].slice(0, 2).join("; ")
    });
  }
  return [...byKey.values()].sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.intent.changedFiles.length - a.intent.changedFiles.length);
}

function secondaryMergeKey(
  detail: InferredDiffIntentClusters["secondaryDetails"][number],
  byKey: Map<string, InferredDiffIntentClusters["secondaryDetails"][number]>
): string {
  const subtype = detail.intent.subtype ?? detail.intent.type;
  const target = detail.intent.targetCommand ?? "";
  const exact = `${subtype}:${target}`;
  if (target) {
    const untargeted = `${subtype}:`;
    if (byKey.has(untargeted)) {
      return untargeted;
    }
    return exact;
  }
  const compatibleTargeted = [...byKey.keys()].find((key) => key.startsWith(`${subtype}:`) && key !== `${subtype}:`);
  return compatibleTargeted ?? exact;
}

function higherSeverity(
  a: InferredDiffIntentClusters["secondaryDetails"][number]["severity"],
  b: InferredDiffIntentClusters["secondaryDetails"][number]["severity"]
): InferredDiffIntentClusters["secondaryDetails"][number]["severity"] {
  return severityRank(b) > severityRank(a) ? b : a;
}

function severityRank(severity: InferredDiffIntentClusters["secondaryDetails"][number]["severity"]): number {
  return { info: 0, caution: 1, warning: 2, high: 3 }[severity];
}

function higherConfidence(a: InferredDiffIntent["confidence"], b: InferredDiffIntent["confidence"]): InferredDiffIntent["confidence"] {
  const rank = { low: 0, medium: 1, high: 2 };
  return rank[b] > rank[a] ? b : a;
}

function inferSingleDiffIntent(input: {
  changedFiles: string[];
  changeFiles?: ChangeFile[];
  diffText: string;
  codeGraph?: CodeGraphEntry[];
}): InferredDiffIntent {
  const changedFiles = normalizeFiles(input.changedFiles);
  const diffText = input.diffText ?? "";
  const addedLines = extractChangedLines(diffText, "+");
  const removedLines = extractChangedLines(diffText, "-");
  const changedText = [...addedLines, ...removedLines].join("\n");
  const symbols = extractChangedSymbols(diffText);
  const strings = extractAddedStrings(addedLines);
  const scores = new Map<string, number>();
  const evidence: string[] = [];
  const riskSignals: string[] = [];
  const supportingFiles = new Set<string>();
  const targetCommand = inferTargetCommand(changedFiles, changedText);
  const cliTooling = isCliToolingContext(changedFiles);
  const appContext = isAppSourceContext(changedFiles);

  if (targetCommand) {
    addScore(scores, "command_target", 40);
    evidence.push(`target command:${targetCommand}`);
  }
  if (targetCommand && new RegExp(`\\b${escapeRegExp(targetCommand)}\\b`, "i").test(changedText)) {
    addScore(scores, "command_token", 25);
    evidence.push(`diff mentions command:${targetCommand}`);
  }
  if (cliTooling && (cliOutputPattern.test(changedText) || changedFiles.some((file) => /packages\/cli\/src\/|(^|\/)cli(\/|$)/i.test(file)))) {
    addScore(scores, "cli_output", 20);
    evidence.push("CLI output/format keywords changed");
  } else if (appContext && cliOutputPattern.test(changedText)) {
    evidence.push("weak output keyword in app diff");
  }
  if (strings.length > 0) {
    addScore(scores, "user_facing_strings", 15);
    evidence.push(`added strings:${strings.slice(0, 3).join(" | ")}`);
  }
  if (isLivingDocumentRefactor(changedFiles, changedText)) {
    addScore(scores, "living_document_refactor", 70);
    evidence.push("living document/artifact migration");
  } else if (isAppSourceContext(changedFiles) && hasAppArchitectureSignal(changedFiles, changedText)) {
    addScore(scores, "app_architecture_refactor", 45);
    evidence.push("app API/UI architecture change");
  }
  if (input.codeGraph?.some((entry) => changedFiles.includes(entry.file) && entry.importedBy.length > 0)) {
    addScore(scores, "graph_adjacency", 10);
    evidence.push("code graph reverse dependencies found");
  }

  for (const file of changedFiles) {
    const graph = input.codeGraph?.find((entry) => entry.file === file);
    for (const candidate of graph?.importedBy.slice(0, 3) ?? []) {
      supportingFiles.add(candidate);
    }
  }

  if (changedFiles.every((file) => /\.(md|mdx)$/i.test(file) || /^docs\//i.test(file))) {
    return buildIntent("docs", "docs_update", undefined, ["docs"], "high", ["docs-only diff"], changedFiles, [], [...supportingFiles]);
  }
  if (changedFiles.every((file) => /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[tj]sx?$/i.test(file))) {
    return buildIntent("test", "test_update", undefined, ["tests"], "high", ["tests-only diff"], changedFiles, [], [...supportingFiles]);
  }
  if (changedFiles.every((file) => /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|\.npmignore|LICENSE|release|publish|npm|tsconfig|vite\.config|next\.config)/i.test(file))) {
    return buildIntent("infra_config", "release_config", undefined, ["release_config"], "high", ["release/config-only diff"], changedFiles, [], [...supportingFiles]);
  }

  const typeSubtype = inferTypeSubtype(changedFiles, changedText, symbols, targetCommand);
  const scope = inferScope(changedFiles, changedText, targetCommand);
  const confidence = inferConfidence(scores, evidence, changedFiles);

  if (changedFiles.some((file) => /(^|\/)(auth|session|db|database|supabase|api|network|package\.json|pnpm-lock\.yaml)(\/|$|\.)/i.test(file))) {
    riskSignals.push("high-impact config/auth/db/network path changed");
  }
  if (changedFiles.length >= 10) {
    riskSignals.push("broad diff");
  }

  return {
    type: typeSubtype.type,
    subtype: typeSubtype.subtype,
    targetCommand,
    scope,
    confidence,
    evidence: [...new Set([...evidence, ...symbols.slice(0, 4).map((symbol) => `symbol:${symbol}`)])].slice(0, 8),
    changedFiles,
    riskSignals,
    supportingFiles: [...supportingFiles].filter((file) => !changedFiles.includes(file)).slice(0, 8)
  };
}

export function inferredIntentToRequirement(intent: InferredDiffIntent): string {
  const target = intent.targetCommand ? ` for ${intent.targetCommand}` : "";
  return [
    `inferred from diff: ${intent.subtype ?? intent.type}${target}`,
    `scope: ${intent.scope.join(", ") || "changed files"}`,
    intent.evidence.length > 0 ? `evidence: ${intent.evidence.slice(0, 4).join("; ")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function inferredIntentToTaskType(intent: InferredDiffIntent): TaskTypeResult {
  if (intent.subtype === "docs_update") {
    return baseTaskType("docs", intent);
  }
  if (intent.subtype === "release_config") {
    return baseTaskType("infra_config", intent);
  }
  if (intent.subtype === "internal_refactor") {
    return baseTaskType("refactor", intent);
  }
  if (intent.subtype === "cli_output_polish" || intent.subtype === "noise_reduction") {
    return baseTaskType("ui_polish", intent);
  }
  if (intent.subtype === "prompt_quality" || intent.subtype === "token_optimization" || intent.subtype === "relevance_fix" || intent.subtype === "workflow_guardrail") {
    return baseTaskType("bugfix", intent);
  }
  return baseTaskType(intent.type === "polish" ? "ui_polish" : "bugfix", intent);
}

export function formatInferredDiffIntent(intent: InferredDiffIntent): string {
  const target = intent.targetCommand ? `(${intent.targetCommand})` : "";
  const intentName =
    intent.type === "app_feature_refactor" && intent.subtype
      ? `${intent.type}(${intent.subtype})`
      : `${intent.subtype ?? intent.type}${target}`;
  const flags = [
    intent.subtype === "cli_output_polish" ? "preview_clarity✓" : "",
    intent.subtype === "noise_reduction" ? "noise↓" : "",
    intent.subtype === "relevance_fix" ? "relevance✓" : "",
    intent.riskSignals.length > 0 ? "risk!" : ""
  ].filter(Boolean);
  return `INTENT: ${intentName}; SCOPE: ${intent.scope.join(", ") || "changed files"}; confidence=${intent.confidence}${flags.length ? `; FLAGS: ${flags.join(" ")}` : ""}`;
}

export function formatInferredDiffIntentClusters(clusters: InferredDiffIntentClusters): string {
  const primary = formatInferredDiffIntent(clusters.primaryIntent);
  const mixed = clusters.secondaryDetails.slice(0, 2).map(({ intent, severity }) => {
    const target = intent.targetCommand ? `(${intent.targetCommand})` : "";
    return `${intent.subtype ?? intent.type}${target}(${intent.changedFiles.length}) ${severity}`;
  });
  const remaining = clusters.secondaryDetails.length - mixed.length;
  return [primary, mixed.length > 0 ? `MIXED: ${mixed.join(", ")}${remaining > 0 ? `, +${remaining} clusters` : ""}` : "", `DRIFT: ${clusters.mixedRisk}`].filter(Boolean).join("; ");
}

export function filterDiffTextForFiles(diffText: string, files: string[]): string {
  return buildClusterDiff(diffText, files);
}

function inferTypeSubtype(changedFiles: string[], text: string, symbols: string[], targetCommand?: string): { type: string; subtype: string } {
  const cliTooling = isCliToolingContext(changedFiles);
  if (isLivingDocumentRefactor(changedFiles, text)) {
    return { type: "app_feature_refactor", subtype: "living_document" };
  }
  if (isAppSourceContext(changedFiles) && hasAppArchitectureSignal(changedFiles, text)) {
    return { type: "app_feature_refactor", subtype: "app_feature_refactor" };
  }
  if ((cliTooling && promptPattern.test(text)) || changedFiles.some((file) => /prompt|task-ai|ai\.ts|task-router|completion|density/i.test(file))) {
    return /token|density|compact|ultra|budget/i.test(text) ? { type: "polish", subtype: "token_optimization" } : { type: "bugfix", subtype: "prompt_quality" };
  }
  if ((cliTooling && relevancePattern.test(text)) || changedFiles.some((file) => /relevance|command-target|task-router|drift|analyze/i.test(file))) {
    return { type: "bugfix", subtype: "relevance_fix" };
  }
  if ((cliTooling && workflowPattern.test(text)) || targetCommand) {
    if (cliOutputPattern.test(text) || targetCommand === "done" || targetCommand === "status") {
      return { type: "polish", subtype: "cli_output_polish" };
    }
    return { type: "bugfix", subtype: "workflow_guardrail" };
  }
  if (changedFiles.some((file) => /refactor|types|utils|core/i.test(file)) && symbols.length > 0) {
    return { type: "refactor", subtype: "internal_refactor" };
  }
  return cliTooling && cliOutputPattern.test(text) ? { type: "polish", subtype: "cli_output_polish" } : { type: "bugfix", subtype: "command_behavior" };
}

function inferTargetCommand(changedFiles: string[], text: string): string | undefined {
  if (!isCliToolingContext(changedFiles)) {
    return undefined;
  }
  const scores = commands.map((command) => {
    let score = 0;
    const commandPattern = new RegExp(`(^|/|-)${escapeRegExp(command)}(\\.|/|-|$)`, "i");
    if (changedFiles.some((file) => commandPattern.test(file))) {
      score += 40;
    }
    if (new RegExp(`\\b${escapeRegExp(command)}\\b`, "i").test(text)) {
      score += 25;
    }
    const camel = command.replace(/(^|-)([a-z])/g, (_, __, letter: string) => letter.toUpperCase());
    if (new RegExp(`run${escapeRegExp(camel)}|${escapeRegExp(camel)}Options|${escapeRegExp(camel)}\\s+command`, "i").test(text)) {
      score += 70;
    }
    return { command, score };
  });
  const best = scores.sort((a, b) => b.score - a.score || a.command.localeCompare(b.command))[0];
  return best && best.score >= 40 ? best.command : undefined;
}

function clusterChangedFiles(changedFiles: string[], diffText: string, codeGraph: CodeGraphEntry[]): Array<{ key: string; files: string[] }> {
  const byKey = new Map<string, Set<string>>();
  for (const file of changedFiles) {
    const fileDiff = buildClusterDiff(diffText, [file]);
    const category = fileCategory(file);
    const subtype = inferSubtypeKey([file], fileDiff);
    const command = /^(docs|tests|release|high-impact)$/.test(category) ? undefined : inferTargetCommand([file], fileDiff);
    const key = command ? `command:${command}` : subtype === "living_document" ? `app:${subtype}` : `${category}:${subtype}`;
    const bucket = byKey.get(key) ?? new Set<string>();
    bucket.add(file);
    byKey.set(key, bucket);

    const graph = codeGraph.find((entry) => entry.file === file);
    for (const adjacent of [...(graph?.imports ?? []), ...(graph?.importedBy ?? [])]) {
      if (changedFiles.includes(adjacent) && fileCategory(adjacent) === fileCategory(file)) {
        bucket.add(adjacent);
      }
    }
  }
  return [...byKey.entries()].map(([key, files]) => ({ key, files: [...files].sort() }));
}

function fileCategory(file: string): string {
  if (/\.test\.[tj]sx?$|\.spec\.[tj]sx?$|(^|\/)(__tests__|tests?|specs?)(\/|$)/i.test(file)) return "tests";
  if (/\.(md|mdx)$/i.test(file) || /^docs\//i.test(file)) return "docs";
  if (/(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|\.npmignore|LICENSE|release|publish|npm|tsconfig|vite\.config|next\.config)/i.test(file)) return "release";
  if (/packages\/cli\/src|(^|\/)cli(\/|$)/i.test(file)) return "cli";
  if (/packages\/core\/src|(^|\/)(core|lib|src)(\/|$)/i.test(file)) return "core";
  if (/(^|\/)(auth|session|db|database|supabase|api|network)(\/|$|\.)/i.test(file)) return "high-impact";
  return "source";
}

function inferSubtypeKey(files: string[], text: string): string {
  if (files.every((file) => /\.(md|mdx)$/i.test(file) || /^docs\//i.test(file))) return "docs_update";
  if (files.every((file) => /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[tj]sx?$/i.test(file))) return "test_update";
  if (files.every((file) => /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|\.npmignore|LICENSE|release|publish|npm|tsconfig|vite\.config|next\.config)/i.test(file))) return "release_config";
  return inferTypeSubtype(files, text, extractChangedSymbols(text), inferTargetCommand(files, text)).subtype;
}

function selectPrimaryIntent(intents: InferredDiffIntent[], taskText?: string): InferredDiffIntent {
  const task = taskText?.trim() ?? "";
  const scored = intents.map((intent) => ({
    intent,
    score: intentStrength(intent) + (task ? taskSimilarity(intent, task) : 0)
  }));
  return scored.sort((a, b) => b.score - a.score || b.intent.changedFiles.length - a.intent.changedFiles.length)[0]?.intent ?? intents[0];
}

function intentStrength(intent: InferredDiffIntent): number {
  const confidence = intent.confidence === "high" ? 40 : intent.confidence === "medium" ? 20 : 5;
  return confidence + (intent.targetCommand ? 35 : 0) + intent.evidence.length * 4 + Math.min(intent.changedFiles.length, 8) * 3 - intent.riskSignals.length * 8;
}

function taskSimilarity(intent: InferredDiffIntent, taskText: string): number {
  const text = taskText.toLowerCase();
  let score = 0;
  if (intent.targetCommand && new RegExp(`\\b${escapeRegExp(intent.targetCommand)}\\b`, "i").test(text)) score += 60;
  if (intent.subtype && text.includes(intent.subtype.toLowerCase())) score += 30;
  for (const scope of intent.scope) {
    const token = scope.replace(/^command:/, "");
    if (token && text.includes(token.toLowerCase())) score += 10;
  }
  return score;
}

function inferMixedRisk(
  primary: InferredDiffIntent,
  secondaryDetails: InferredDiffIntentClusters["secondaryDetails"]
): "low" | "medium" | "high" {
  if (secondaryDetails.length === 0) {
    return primary.riskSignals.length > 0 ? "medium" : "low";
  }
  if (primary.confidence === "low" && secondaryDetails.some((detail) => detail.severity === "warning" || detail.severity === "high")) {
    return "high";
  }
  if (secondaryDetails.some((detail) => detail.severity === "high")) {
    return "high";
  }
  if (secondaryDetails.some((detail) => detail.severity === "warning")) {
    return "high";
  }
  if (secondaryDetails.some((detail) => detail.severity === "caution")) {
    return "medium";
  }
  return "low";
}

function classifySecondaryIntent(
  intent: InferredDiffIntent,
  primary: InferredDiffIntent
): InferredDiffIntentClusters["secondaryDetails"][number] {
  const subtype = intent.subtype ?? intent.type;
  if (subtype === "docs_update" || subtype === "test_update" || isFormattingOnly(intent)) {
    return { intent, severity: "info", reason: "safe supporting cluster" };
  }
  if (subtype === "release_config" || intent.scope.includes("release_config") || intent.changedFiles.some((file) => /package\.json|\.npmignore|tsconfig|vite\.config|next\.config/i.test(file))) {
    return { intent, severity: "caution", reason: "release/config cluster" };
  }
  if (intent.riskSignals.some((signal) => /auth|db|database|network|runtime|package|config/i.test(signal)) || intent.changedFiles.some((file) => /(^|\/)(auth|session|db|database|supabase|api|network|runtime)(\/|$|\.)/i.test(file))) {
    return { intent, severity: primary.confidence === "low" ? "high" : "warning", reason: "runtime/security-sensitive cluster" };
  }
  if (primary.confidence === "low" && intent.changedFiles.length > 1) {
    return { intent, severity: "high", reason: "low-confidence primary with unrelated files" };
  }
  return { intent, severity: "caution", reason: "unrelated implementation cluster" };
}

function isFormattingOnly(intent: InferredDiffIntent): boolean {
  return intent.changedFiles.every((file) => /\.(css|scss|sass|prettierrc|editorconfig)$/i.test(file));
}

function buildClusterDiff(diffText: string, files: string[]): string {
  if (!diffText.trim() || files.length === 0) {
    return diffText;
  }
  const fileSet = new Set(files);
  const sections = diffText.split(/\n(?=diff --git )/g);
  const selected = sections.filter((section) => {
    const match = section.match(/^diff --git a\/(.+?) b\/(.+?)(?:\n|$)/);
    if (!match) {
      return files.some((file) => section.includes(file));
    }
    return fileSet.has(match[1]) || fileSet.has(match[2]);
  });
  const untracked = diffText
    .split("\n")
    .filter((line) => /^Untracked file: /.test(line) && files.some((file) => line.includes(file)));
  return [...selected, ...untracked].join("\n\n") || diffText;
}

function inferScope(changedFiles: string[], text: string, targetCommand?: string): string[] {
  const scope = new Set<string>();
  const cliTooling = isCliToolingContext(changedFiles);
  if (targetCommand) {
    scope.add(`command:${targetCommand}`);
  }
  if (cliTooling && (changedFiles.some((file) => /packages\/cli\/src|(^|\/)cli(\/|$)/i.test(file)) || cliOutputPattern.test(text))) {
    scope.add("cli_output");
  }
  if (isLivingDocumentRefactor(changedFiles, text)) {
    const paths = changedFiles.join("\n");
    if (/(^|\/)components\/brain\//i.test(paths) || /\bbrain\b/i.test(text)) {
      scope.add("brain");
    }
    scope.add("living_document");
    if (changedFiles.some((file) => /(^|\/)app\/api\/artifacts\//i.test(file))) {
      scope.add("artifact_api");
    }
    if (/(^|\/)components\//i.test(paths) || /LivingDocumentView|ThoughtArtifactView/i.test(text)) {
      scope.add("document_ui");
    }
  }
  if (cliTooling && promptPattern.test(text)) {
    scope.add("prompt");
  }
  if (cliTooling && relevancePattern.test(text)) {
    scope.add("relevance");
  }
  if (changedFiles.some((file) => /\.(md|mdx)$/i.test(file) || /^docs\//i.test(file))) {
    scope.add("docs");
  }
  if (changedFiles.some((file) => /(^|\/)(package\.json|\.npmignore|LICENSE|release)/i.test(file))) {
    scope.add("release_config");
  }
  return [...scope].slice(0, 5);
}

function inferConfidence(scores: Map<string, number>, evidence: string[], changedFiles: string[]): "high" | "medium" | "low" {
  const total = [...scores.values()].reduce((sum, value) => sum + value, 0);
  if (total >= 65 || (changedFiles.length <= 4 && evidence.length >= 3)) {
    return "high";
  }
  if (total >= 35 || evidence.length >= 2) {
    return "medium";
  }
  return "low";
}

function baseTaskType(type: TaskTypeResult["type"], intent: InferredDiffIntent): TaskTypeResult {
  return {
    type,
    subtype: intent.subtype,
    confidence: intent.confidence,
    reasons: intent.evidence,
    strategy: intent.subtype === "cli_output_polish" ? "minimal-output-polish" : intent.subtype === "living_document" ? "scoped-architecture-change" : "diff-inferred-scope",
    riskLevel: intent.subtype === "living_document" ? "high" : intent.riskSignals.length > 0 ? "medium" : "low",
    requiresPhasing: false,
    domainKeywords: intent.scope
  };
}

function buildIntent(
  type: string,
  subtype: string,
  targetCommand: string | undefined,
  scope: string[],
  confidence: "high" | "medium" | "low",
  evidence: string[],
  changedFiles: string[],
  riskSignals: string[],
  supportingFiles: string[]
): InferredDiffIntent {
  return { type, subtype, targetCommand, scope, confidence, evidence, changedFiles, riskSignals, supportingFiles };
}

function extractChangedLines(diffText: string, prefix: "+" | "-"): string[] {
  const excluded = prefix === "+" ? "+++" : "---";
  return diffText
    .split("\n")
    .filter((line) => line.startsWith(prefix) && !line.startsWith(excluded))
    .map((line) => line.slice(1).trim())
    .filter(Boolean);
}

function extractChangedSymbols(diffText: string): string[] {
  const matches = diffText.matchAll(/^[+-]\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|class|interface|type)\s+([A-Za-z0-9_$-]+)/gm);
  return [...new Set([...matches].map((match) => match[1]).filter(Boolean))].slice(0, 12);
}

function extractAddedStrings(lines: string[]): string[] {
  return [...new Set(lines.flatMap((line) => [...line.matchAll(/["'`]([^"'`]{8,100})["'`]/g)].map((match) => match[1])))]
    .filter((value) => /[A-Za-z가-힣]/.test(value) && !/^[A-Z0-9_./:-]+$/.test(value))
    .slice(0, 8);
}

function addScore(scores: Map<string, number>, key: string, value: number): void {
  scores.set(key, (scores.get(key) ?? 0) + value);
}

function normalizeFiles(files: string[]): string[] {
  return [...new Set(files.map((file) => file.trim()).filter(Boolean))].sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCliToolingContext(changedFiles: string[]): boolean {
  return changedFiles.some((file) =>
    /packages\/cli\/src\//i.test(file) ||
    (/packages\/core\/src\//i.test(file) && /(diff-intent|prompt|report|review|check|analyze|task-router|completion|ai|types)\.ts$/i.test(file)) ||
    cliCommandHandlerPattern.test(file)
  );
}

function isAppSourceContext(changedFiles: string[]): boolean {
  return changedFiles.some((file) => appSourcePathPattern.test(file));
}

function isLivingDocumentRefactor(changedFiles: string[], text: string): boolean {
  const combined = `${changedFiles.join("\n")}\n${text}`;
  const hasLivingOrArtifact = livingDocumentPattern.test(combined);
  const hasMigrationSignal =
    /LivingDocumentView|living[-_]?document/i.test(combined) &&
    (/ThoughtArtifactView|thought[-_]?artifact/i.test(combined) || /(^|\/)app\/api\/artifacts\//i.test(changedFiles.join("\n")));
  return isAppSourceContext(changedFiles) && (hasMigrationSignal || (hasLivingOrArtifact && /(^|\/)(components\/brain|app\/api\/artifacts)\//i.test(changedFiles.join("\n"))));
}

function hasAppArchitectureSignal(changedFiles: string[], text: string): boolean {
  const paths = changedFiles.join("\n");
  return (
    isAppSourceContext(changedFiles) &&
    ((/(^|\/)app\/api\//i.test(paths) && /components?\//i.test(paths)) ||
      /(rename|remove|delete|migrate|migration|refactor|replace|전환|구조|삭제|이동|재해석)/i.test(text))
  );
}
