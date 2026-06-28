export type DashboardLanguage = "en" | "ko";

export const dashboardTranslations: Record<DashboardLanguage, Record<string, string>> = {
  en: {
    // App shell
    appSubtitle: "Real-time control center for your AI coding session",
    loading: "Loading...",
    dashboardUpdated: "Updated",
    language: "Language",

    // Status card
    currentStatus: "Status",
    notInitializedTitle: "Setup required",
    notInitializedBody: "Run dev-guard init to get started.",
    watchNotRunningTitle: "Not monitoring",
    watchNotRunningBody: "Run dev-guard watch to start monitoring your AI coding session.",
    statusMonitoringTitle: "Monitoring project",
    statusMonitoringBody: "Everything is up to date. Waiting for your next edit.",
    statusWorkingTitle: "Detecting changes",
    statusWorkingBody: "Files are changing. DevGuard will finalize automatically when things settle.",
    statusReadyTitle: "Preparing update",
    statusReadyBody: "Changes have settled. Generating session reports now.",
    statusFinalizingTitle: "Updating project",
    statusFinalizingBody: "Generating reports and refreshing project context.",
    statusProcessedTitle: "Up to date",
    statusProcessedBody: "Session reports are fresh. You can start your next task.",

    // Current activity card
    currentActivityTitle: "Current Activity",
    activityInit: "Waiting for setup",
    activityStartWatch: "Not monitoring yet",
    activityMonitoring: "Watching for file changes",
    activitySettling: "Detecting changes",
    activityAiCompletion: "Preparing update",
    activityFinalizing: "Updating project",
    activityProcessed: "Ready for next task",
    sessionStarted: "Started",
    lastChange: "Last change",
    changesCount: "Changes",
    never: "Not yet",
    unknown: "—",

    // Recent changes card (current session)
    recentChangesTitle: "Current Session",
    noRecentFilesTitle: "No changes yet",
    noRecentFilesBody: "Start editing and DevGuard will track changes automatically.",
    moreFiles: "more files",

    // Today's progress card
    todayProgressTitle: "Today's Progress",
    todaySessionsLabel: "Sessions",
    todayFilesLabel: "Files changed",
    todayReportsLabel: "Reports",
    todayLastUpdateLabel: "Last update",
    todayNone: "—",

    // Recent sessions card
    recentSessionsTitle: "Recent Sessions",
    today: "Today",
    yesterday: "Yesterday",
    noSessionsTitle: "Welcome to DevGuard",
    noSessionsBody: "Start coding. Your first session will appear here.",
    sessionLabelGeneric: "Code update",
    sessionLabelCli: "CLI update",
    sessionLabelCliConfig: "CLI & config update",
    sessionLabelConfig: "Config update",
    sessionLabelDocs: "Documentation update",
    sessionLabelTests: "Test update",
    sessionLabelApi: "API update",
    sessionFiles: "files",
    sessionHandoffReady: "Handoff ready",
    verdictHealthy: "Healthy",
    verdictReview: "Review needed",
    verdictBlocked: "Blocked",
    verdictUnknown: "—",

    // Project health card
    healthTitle: "Project Health",
    healthQuality: "Quality",
    healthContext: "Context",
    healthReports: "Reports",
    healthGood: "Healthy",
    healthWarning: "Review needed",
    healthMissing: "Not generated",
    healthUnknown: "Unknown",
    reportsUpdated: "Updated",
    reportsNeverUpdated: "Not generated yet",

    // Quality trend
    qualityTrendTitle: "Recent Quality",

    // Next action card
    nextActionTitle: "Next Action",
    nextInit: "Run dev-guard init to set up this project.",
    nextStartWatch: "Run dev-guard watch to start monitoring.",
    nextMonitoring: "Nothing required. Continue coding.",
    nextSettling: "DevGuard will finalize automatically when changes settle.",
    nextAiCompletion: "Generating reports — no action needed.",
    nextFinalizing: "Returning to monitoring when complete.",
    nextProcessed: "Session reports are ready. Continue with your next task.",

    // Timeline
    timelineTitle: "Activity Timeline",
    timelineSession: "Session completed",
    timelineWatchStart: "Monitoring started",
    timelineFileChange: "File changed",
    timelineEmpty: "No recent activity.",

    // Advanced details (collapsed)
    advancedTitle: "Advanced Details",
    sessionDuration: "Session duration",
    internalStatus: "Internal status",
    idleCountdown: "Settling timer",
    noCountdown: "—",

    // Reports (inside advanced)
    reportHandoff: "Handoff",
    reportQuality: "Quality Report",
    reportContext: "Agent Context",
    availability: "Status",
    lastUpdated: "Updated",
    ready: "Ready",
    notCreated: "Not created",
    preview: "Preview",

    // Misc
    dashboardUnavailableTitle: "Dashboard unavailable",
    commandLabel: "Command"
  },
  ko: {
    // App shell
    appSubtitle: "AI 코딩 세션 실시간 제어판",
    loading: "불러오는 중...",
    dashboardUpdated: "갱신됨",
    language: "언어",

    // Status card
    currentStatus: "상태",
    notInitializedTitle: "초기 설정이 필요합니다",
    notInitializedBody: "dev-guard init을 실행해 프로젝트를 설정하세요.",
    watchNotRunningTitle: "모니터링이 꺼져 있습니다",
    watchNotRunningBody: "dev-guard watch를 실행하면 AI 코딩 세션을 실시간으로 추적합니다.",
    statusMonitoringTitle: "프로젝트를 모니터링하는 중",
    statusMonitoringBody: "모든 작업이 최신 상태입니다. 다음 작업을 기다리는 중입니다.",
    statusWorkingTitle: "변경 내용을 감지하는 중",
    statusWorkingBody: "파일이 변경되고 있습니다. 변경이 멈추면 DevGuard가 자동으로 처리합니다.",
    statusReadyTitle: "변경 내용을 정리하는 중",
    statusReadyBody: "파일 변경이 안정되었습니다. 세션 보고서를 생성하고 있습니다.",
    statusFinalizingTitle: "프로젝트를 업데이트하는 중",
    statusFinalizingBody: "보고서를 생성하고 프로젝트 컨텍스트를 갱신하는 중입니다.",
    statusProcessedTitle: "최신 상태",
    statusProcessedBody: "세션 보고서가 갱신되었습니다. 다음 작업을 시작할 수 있습니다.",

    // Current activity card
    currentActivityTitle: "현재 동작",
    activityInit: "초기 설정을 기다리는 중",
    activityStartWatch: "아직 모니터링 시작 전",
    activityMonitoring: "파일 변경을 감시하는 중",
    activitySettling: "변경 내용을 감지하는 중",
    activityAiCompletion: "변경 내용을 정리하는 중",
    activityFinalizing: "프로젝트를 업데이트하는 중",
    activityProcessed: "다음 작업 준비 완료",
    sessionStarted: "시작",
    lastChange: "마지막 변경",
    changesCount: "변경 수",
    never: "아직 없음",
    unknown: "—",

    // Recent changes card (current session)
    recentChangesTitle: "현재 세션",
    noRecentFilesTitle: "변경된 파일이 없습니다",
    noRecentFilesBody: "파일을 수정하면 DevGuard가 자동으로 변경을 추적합니다.",
    moreFiles: "개 더",

    // Today's progress card
    todayProgressTitle: "오늘의 작업",
    todaySessionsLabel: "세션",
    todayFilesLabel: "변경 파일",
    todayReportsLabel: "보고서",
    todayLastUpdateLabel: "마지막 갱신",
    todayNone: "—",

    // Recent sessions card
    recentSessionsTitle: "최근 세션",
    today: "오늘",
    yesterday: "어제",
    noSessionsTitle: "DevGuard에 오신 것을 환영합니다",
    noSessionsBody: "코딩을 시작하면 첫 번째 세션이 여기에 표시됩니다.",
    sessionLabelGeneric: "코드 변경",
    sessionLabelCli: "CLI 업데이트",
    sessionLabelCliConfig: "CLI 및 설정 업데이트",
    sessionLabelConfig: "설정 업데이트",
    sessionLabelDocs: "문서 업데이트",
    sessionLabelTests: "테스트 업데이트",
    sessionLabelApi: "API 업데이트",
    sessionFiles: "개 파일",
    sessionHandoffReady: "인수인계 준비됨",
    verdictHealthy: "정상",
    verdictReview: "검토 필요",
    verdictBlocked: "블록됨",
    verdictUnknown: "—",

    // Project health card
    healthTitle: "프로젝트 상태",
    healthQuality: "품질",
    healthContext: "컨텍스트",
    healthReports: "보고서",
    healthGood: "정상",
    healthWarning: "검토 필요",
    healthMissing: "아직 생성 안 됨",
    healthUnknown: "알 수 없음",
    reportsUpdated: "갱신됨",
    reportsNeverUpdated: "아직 생성되지 않음",

    // Quality trend
    qualityTrendTitle: "최근 품질",

    // Next action card
    nextActionTitle: "다음 할 일",
    nextInit: "dev-guard init을 실행해 프로젝트를 설정하세요.",
    nextStartWatch: "dev-guard watch를 실행해 모니터링을 시작하세요.",
    nextMonitoring: "할 일이 없습니다. 계속 코딩하세요.",
    nextSettling: "변경이 멈추면 DevGuard가 자동으로 처리합니다.",
    nextAiCompletion: "보고서를 생성하는 중입니다. 기다려 주세요.",
    nextFinalizing: "처리가 끝나면 모니터링으로 돌아갑니다.",
    nextProcessed: "세션 보고서가 준비되었습니다. 다음 작업을 진행하세요.",

    // Timeline
    timelineTitle: "활동 타임라인",
    timelineSession: "세션 완료",
    timelineWatchStart: "모니터링 시작",
    timelineFileChange: "파일 변경",
    timelineEmpty: "최근 활동이 없습니다.",

    // Advanced details (collapsed)
    advancedTitle: "상세 정보",
    sessionDuration: "세션 시간",
    internalStatus: "내부 상태",
    idleCountdown: "안정화 타이머",
    noCountdown: "—",

    // Reports (inside advanced)
    reportHandoff: "인수인계",
    reportQuality: "품질 보고서",
    reportContext: "에이전트 컨텍스트",
    availability: "상태",
    lastUpdated: "갱신",
    ready: "준비됨",
    notCreated: "아직 없음",
    preview: "미리보기",

    // Misc
    dashboardUnavailableTitle: "대시보드를 사용할 수 없습니다",
    commandLabel: "명령어"
  }
};
