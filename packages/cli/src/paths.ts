export const DEVGUARD_DIR = ".devguard";
export const LEGACY_DEVGUARD_DIR = "devguard";

export const devguardPaths = {
  config: `${DEVGUARD_DIR}/config.json`,
  task: `${DEVGUARD_DIR}/task.md`,
  rules: `${DEVGUARD_DIR}/rules.md`,
  mistakes: `${DEVGUARD_DIR}/mistakes.md`,
  project: `${DEVGUARD_DIR}/project.md`,
  architecture: `${DEVGUARD_DIR}/architecture.md`,
  decisions: `${DEVGUARD_DIR}/decisions.md`,
  tasks: `${DEVGUARD_DIR}/tasks.md`,
  runtime: `${DEVGUARD_DIR}/runtime.json`,
  state: `${DEVGUARD_DIR}/state.json`,
  history: `${DEVGUARD_DIR}/history.jsonl`,
  hooksDir: `${DEVGUARD_DIR}/hooks`,
  logsDir: `${DEVGUARD_DIR}/logs`,
  reportsDir: `${DEVGUARD_DIR}/reports`,
  promptsDir: `${DEVGUARD_DIR}/prompts`,
  contextDir: `${DEVGUARD_DIR}/context`,
  projectDir: `${DEVGUARD_DIR}/project`,
  claudeHook: `${DEVGUARD_DIR}/hooks/claude-stop.sh`,
  codexHook: `${DEVGUARD_DIR}/hooks/codex-stop.sh`,
  codexNotifyHook: `${DEVGUARD_DIR}/hooks/codex-notify.sh`,
  codexEventListener: `${DEVGUARD_DIR}/hooks/codex-event-listener.ts`,
  claudeLog: `${DEVGUARD_DIR}/logs/claude-hook.log`,
  codexLog: `${DEVGUARD_DIR}/logs/codex-hook.log`,
  codexNotifyLog: `${DEVGUARD_DIR}/logs/codex-notify.log`,
  watchLog: `${DEVGUARD_DIR}/logs/watch.log`,
  hookStatus: `${DEVGUARD_DIR}/reports/hook-status.md`,
  lastRunReport: `${DEVGUARD_DIR}/reports/last-run.md`,
  historySummary: `${DEVGUARD_DIR}/reports/history-summary.md`,
  decisionCandidates: `${DEVGUARD_DIR}/reports/decision-candidates.md`,
  qualityReport: `${DEVGUARD_DIR}/reports/quality-report.md`,
  projectHandoff: `${DEVGUARD_DIR}/reports/project-handoff.md`,
  readMap: `${DEVGUARD_DIR}/reports/read-map.md`,
  codeMap: `${DEVGUARD_DIR}/reports/code-map.md`,
  workingContext: `${DEVGUARD_DIR}/reports/working-context.md`,
  nextCodexPrompt: `${DEVGUARD_DIR}/prompts/next-codex-prompt.md`,
  nextClaudePrompt: `${DEVGUARD_DIR}/prompts/next-claude-prompt.md`,
  agentContext: `${DEVGUARD_DIR}/context/agent-context.md`,
  agentBrief: `${DEVGUARD_DIR}/context/agent-brief.md`,
  projectKnowledge: `${DEVGUARD_DIR}/project/project-knowledge.json`
} as const;

export function legacyDevguardPath(path = ""): string {
  return path ? `${LEGACY_DEVGUARD_DIR}/${path}` : LEGACY_DEVGUARD_DIR;
}
