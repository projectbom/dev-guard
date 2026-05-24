export type Severity = "info" | "warning";

export interface DevGuardConfig {
  allowedPaths?: string[];
  protectedPaths?: string[];
  docPaths?: string[];
  sourcePaths?: string[];
  docsRequiredFor?: string[];
  riskIgnoredPaths?: string[];
  ai?: AIConfig;
}

export interface ProjectIdentity {
  root: string;
  gitRemoteOrigin?: string;
  packageName?: string;
  frameworkKeywords: string[];
  fingerprint: string;
}

export type AIProviderName = "none" | "openai";

export interface AIConfig {
  provider?: AIProviderName;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
  baseURL?: string;
}

export type ChangeFileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "staged";
export type ChangeFileSource = "workingTree" | "staged" | "untracked";

export interface ChangeFile {
  path: string;
  status: ChangeFileStatus;
  source: ChangeFileSource;
  oldPath?: string;
}

export interface DiffInput {
  changedFiles: string[];
  changeFiles?: ChangeFile[];
  diffText: string;
  taskText: string;
  rulesText: string;
  config?: DevGuardConfig;
  includeContextFiles?: boolean;
  codeGraph?: CodeGraphEntry[];
}

export interface GuardFinding {
  severity: Severity;
  code: string;
  title: string;
  message: string;
  files?: string[];
}

export interface GuardReport {
  changedFiles: string[];
  changeFiles: ChangeFile[];
  findings: GuardFinding[];
  docsUpdateNeeded: boolean;
}

export interface UpdateSuggestionInput {
  changedFiles: string[];
  changeFiles?: ChangeFile[];
  diffText: string;
  taskMarkdown: string;
  rulesMarkdown: string;
  mistakesMarkdown: string;
  includeContextFiles?: boolean;
  runLog?: DevGuardRunLog;
}

export interface UpdateSuggestions {
  projectStateSuggestion: string;
  currentTaskSuggestion: string;
  decisionsSuggestion: string;
  doNotRepeatSuggestion: string;
  summary: string;
}

export interface CodexPromptInput {
  taskMarkdown: string;
  rulesMarkdown: string;
  mistakesMarkdown: string;
  projectStateMarkdown: string;
  decisionsMarkdown: string;
  changedFiles: string[];
  changeFiles?: ChangeFile[];
  diffText: string;
  compact?: boolean;
  ultraCompact?: boolean;
  density?: "ultra" | "compact" | "verbose";
  maxPromptTokens?: number;
  includeContextFiles?: boolean;
  impactHints?: ImpactHint[];
}

export interface CodexPrompt {
  promptText: string;
  summary: string;
  includedSections: string[];
}

export interface GenerateTextInput {
  system?: string;
  prompt: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
}

export interface AIProvider {
  name: AIProviderName;
  generateText(input: GenerateTextInput): Promise<string>;
}

export interface TaskAIContext {
  requirement: string;
  rulesMarkdown: string;
  mistakesMarkdown: string;
  projectStateMarkdown: string;
  decisionsMarkdown: string;
  changedFiles: string[];
  changeFiles?: ChangeFile[];
  diffText: string;
  projectFiles?: string[];
  relatedFileCandidates?: string[];
  fileCandidates?: TaskAIFileCandidate[];
  codeContexts?: TaskAICodeContext[];
  taskType?: TaskTypeResult;
  completionCriteria?: TaskCompletionCriteria;
  codeGraph?: CodeGraphEntry[];
  impactHints?: ImpactHint[];
}

export interface TaskMarkdownResult {
  markdown: string;
  scopeFilledFromCandidates: boolean;
}

export interface TaskAICodeContext {
  path: string;
  matchedKeywords: string[];
  excerpt: string;
  truncated: boolean;
}

export type TaskAIFileCandidateRole = "edit" | "reference" | "file-protected" | "logic-protected" | "protected" | "ignored";

export interface TaskAIFileCandidate {
  path: string;
  score: number;
  reasons: string[];
  negativeReasons: string[];
  role: TaskAIFileCandidateRole;
}

export type TaskType =
  | "ui_text_cleanup"
  | "ui_polish"
  | "bugfix"
  | "feature_add"
  | "architecture"
  | "i18n"
  | "refactor"
  | "migration"
  | "performance"
  | "styling"
  | "docs"
  | "infra_config";

export type TaskTypeConfidence = "low" | "medium" | "high";
export type TaskRiskLevel = "low" | "medium" | "high";

export interface TaskTypeResult {
  type: TaskType;
  subtype?: string;
  confidence: TaskTypeConfidence;
  reasons: string[];
  strategy: string;
  riskLevel: TaskRiskLevel;
  requiresPhasing: boolean;
  domainKeywords?: string[];
}

export interface ContextPriority {
  requirement: number;
  relatedCode: number;
  taskSubtypeContext: number;
  recentRun: number;
  projectMemory: number;
  staleDocs: number;
}

export type DriftSeverity = "low" | "medium" | "high";

export interface DriftResult {
  driftScore: number;
  severity: DriftSeverity;
  reasons: string[];
  requirementDomains: string[];
  generatedDomains: string[];
  requirementZones: string[];
  generatedZones: string[];
  allowedExpansions: string[];
  similarity: number;
}

export interface DriftTelemetry {
  driftType: string;
  severity: DriftSeverity;
  source: string;
  timestamp: number;
  subtype?: string;
}

export interface WorkflowQualityScore {
  requirementAlignment: number;
  driftRisk: number;
  scopeSafety: number;
  confidence: number;
}

export interface TaskCompletionCriteria {
  requiredChecks: string[];
  forbiddenPatterns?: string[];
  reviewHints?: string[];
  blockingFailures?: string[];
}

export type ReviewStatus = "pass" | "info" | "warning" | "needs_changes" | "risky" | "critical" | "unknown";

export interface ReviewFileContext {
  path: string;
  excerpt: string;
  truncated: boolean;
}

export interface ReviewMemorySummary {
  path: string;
  role: string;
  keywords: string[];
  features: string[];
}

export interface ReviewContext {
  taskMarkdown: string;
  rulesMarkdown: string;
  mistakesMarkdown: string;
  projectStateMarkdown: string;
  decisionsMarkdown: string;
  changedFiles: string[];
  changeFiles?: ChangeFile[];
  diffText: string;
  untrackedFileContexts?: ReviewFileContext[];
  memorySummaries?: ReviewMemorySummary[];
  projectMapMarkdown?: string;
  runLog?: DevGuardRunLog;
  runSelectionSummary?: string;
  impactHints?: ImpactHint[];
}

export interface ReviewResult {
  markdown: string;
  status: ReviewStatus;
  fixPrompt: string;
}

export interface ReviewFixPromptInput {
  review: ReviewResult;
  taskMarkdown: string;
  changedFiles: string[];
  changeFiles?: ChangeFile[];
}

export interface ReviewFixPrompt {
  promptText: string;
  needed: boolean;
}

export type RunStatus = "created" | "in_progress" | "reviewed" | "completed";

export interface DevGuardRunLog {
  id: string;
  createdAt: string;
  updatedAt?: string;
  command: string;
  title?: string;
  userRequest?: string;
  generatedTaskMarkdown?: string;
  generatedCodexPrompt?: string;
  relatedFiles: string[];
  model?: string;
  provider?: AIProviderName;
  gitHead?: string;
  gitBranch?: string;
  changedFilesAtCreation: string[];
  projectIdentity?: ProjectIdentity;
  status: RunStatus;
  reviewResult?: string;
  fixPrompt?: string;
  targetFiles?: string[];
  reason?: string;
}

export interface ProjectIndexEntry {
  path: string;
  extension: string;
  category: string;
  keywords: string[];
  size: number;
  lastModified: string;
  hash?: string;
}

export interface FileSummary {
  path: string;
  role: string;
  keywords: string[];
  features: string[];
  relatedFiles: string[];
}

export interface CodeGraphEntry {
  file: string;
  imports: string[];
  importedBy: string[];
  exports: string[];
  category: string;
  impactCandidates: string[];
  usageHints: string[];
}

export interface ImpactHint {
  file: string;
  importedByCount: number;
  importedBy: string[];
  impactCandidates: string[];
  affectedAreas: string[];
}

export interface ProjectScanInputFile {
  path: string;
  content: string;
  size: number;
  lastModified: string;
  hash?: string;
}

export interface ProjectScanResult {
  index: ProjectIndexEntry[];
  summaries: FileSummary[];
  projectMapMarkdown: string;
  codeGraph: CodeGraphEntry[];
}

export interface ProjectRefreshInput {
  existingIndex: ProjectIndexEntry[];
  existingSummaries: FileSummary[];
  existingCodeGraph?: CodeGraphEntry[];
  updatedFiles: ProjectScanInputFile[];
  removedPaths: string[];
}

export interface ProjectRefreshResult extends ProjectScanResult {
  updatedPaths: string[];
  removedPaths: string[];
  unchangedCount: number;
}

export interface CompactReportInput {
  taskMarkdown: string;
  changedFiles: string[];
  checkReport: GuardReport;
  runLog?: DevGuardRunLog;
  scanStale?: boolean;
}

export interface CompactReport {
  task: string;
  userRequest: string;
  changedFiles: string[];
  check: string;
  review: string;
  runId: string;
  nextAction: string;
}
