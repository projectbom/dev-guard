# npm 설치/업데이트 사용 가이드

[English](./npm-setup.md) | [한국어](./npm-setup.ko.md)

이 문서는 npm으로 `dev-guard`를 설치하거나 업데이트한 뒤, 새 프로젝트에서 바로 쓰기까지 필요한 절차를 한 번에 정리합니다.

## 1. npm 설치 또는 업데이트

새로 설치:

```bash
npm install -g @dev-guard/cli
dev-guard --help
dev-guard doctor
```

이미 설치되어 있으면 최신 npm 배포본으로 갱신:

```bash
npm install -g @dev-guard/cli@latest
dev-guard --help
dev-guard doctor
```

팀에서 전역 설치를 피한다면 프로젝트 안에서 임시 실행할 수 있습니다.

```bash
npx @dev-guard/cli --help
```

## 2. 프로젝트에서 바로 사용하기

별도 setup 단계는 없습니다. 프로젝트 루트에서:

```bash
cd your-project
dev-guard watch
```

첫 `watch`가 프로젝트를 준비한 뒤 로컬 대시보드를 열고 감시를 시작합니다. 준비 과정은 결정적이고 비대화형입니다(질문, API key, 네트워크 없음).

1. 프로젝트 루트 확인 (홈 디렉터리나 `/`는 거부)
2. 없는 `.devguard/` 설정 파일 생성 (기존 파일 유지)
3. 프로젝트 파일을 한 번 나열(git 안에서는 `git ls-files`로 `.gitignore`된 파일 제외, 그 외에는 디렉터리 순회)하고 Code Index 생성 (`.devguard/memory/code-index.json`)
4. Project Knowledge 생성 (`.devguard/project/project-knowledge.json`)
5. `AGENTS.md`, `CLAUDE.md`의 DevGuard 섹션 추가/갱신 (marker 밖 텍스트 유지)
6. Claude Code(`.mcp.json`)와 Codex(`.codex/config.toml`)에 DevGuard MCP 서버 등록 — 다른 서버/테이블 유지
7. completion hook 설치 (best-effort)
8. MCP 서버가 실행되어 `prepare_task_context`를 제공하는지 확인

이후 `watch`는 최신 상태인 항목을 재사용하고 "Project ready."만 출력합니다. Project Knowledge는 프로젝트 구조가 바뀔 때만 재생성됩니다(파일 추가/삭제 — 새 route, component, migration, workspace 등 — 또는 package manifest, framework/TS 설정, CLI router 변경). README 문구 수정만으로는 재생성하지 않습니다.

선택 사항 — watch 없이 준비만:

```bash
dev-guard setup            # 같은 준비 과정 실행 후 요약(감지된 스택, 명령어, 연동) 출력하고 종료
dev-guard setup --dry-run  # 생성/갱신될 항목만 표시, 아무것도 쓰지 않음
```

`setup`은 CI/스크립트 환경, 감지 결과 확인, watch 전 온보딩 진단용입니다. 필수가 아닙니다.

`npm install -g` 자체는 어떤 프로젝트도 분석하거나 변경하지 않습니다 — 어느 프로젝트가 대상인지 알 수 없기 때문입니다.

Git: 준비 과정, Code Index, Project Knowledge, MCP context는 git 없이도 동작합니다. `done`의 변경 파일 감지는 git이 필요합니다(git이 아닌 디렉터리에서는 watch가 경고를 표시).

고급 / 복구용 (보통 필요 없음 — watch가 모두 수행):

```bash
dev-guard init                        # .devguard 설정/템플릿만 생성, 프로젝트 분석 없음
dev-guard install-agent-instructions  # AGENTS.md / CLAUDE.md 섹션만
dev-guard install-hooks               # completion hook만
```

hook을 바로 신뢰할 수 없는 환경이면 수동 모드로 시작합니다.

```bash
dev-guard watch --manual
# 작업이 끝난 뒤
dev-guard done
dev-guard status
```

## 3. 선택 사항: AI (OpenAI)

API key는 필요 없습니다. `setup`, `init`, `watch`, `status`, `doctor`, Code Index, Project Knowledge, MCP(`prepare_task_context`, `record_validation_result`), 검증 기록, `done`, 보고서, dashboard, telemetry, hook은 모두 결정적으로 동작하며 OpenAI를 호출하지 않습니다. context broker는 결정적이며 기본 경로에 AI reranker는 없습니다.

AI는 명시적 opt-in입니다. OpenAI를 쓰는 기능은 다음뿐입니다(`scan --ai` / `refresh --ai`는 예약된 플래그로 rule-based 그대로입니다).

- `dev-guard task-ai` — 자연어 task 생성
- `dev-guard review`(`--heuristic` 제외)와 `dev-guard fix-prompt` — AI 리뷰
- `done` 시 Quality Report에 붙는 선택적 AI 요약 — opt-in 후에만

Opt-in:

```bash
dev-guard configure ai --provider openai --model gpt-4o-mini
dev-guard config set openaiApiKey "your_api_key"   # 또는: export DEV_GUARD_OPENAI_API_KEY=...
dev-guard doctor
```

key는 `.devguard/config.json`, `DEV_GUARD_OPENAI_API_KEY`, `OPENAI_API_KEY` 순서로 읽습니다. 셸 전역 `OPENAI_API_KEY`만으로는 `done`의 AI 요약이 켜지지 않습니다 — `ai.provider`를 `openai`로 설정하거나 `DEV_GUARD_OPENAI_API_KEY`를 사용하세요. key를 `.devguard/config.json`에 저장했다면 그 파일을 git에서 제외하세요.

key가 없으면 `doctor`는 `OpenAI API: not configured (optional)`로 표시하고, AI 전용 명령은 "OpenAI API is optional — DevGuard's core workflow does not need it. This command requires AI assistance." 안내와 함께 멈춥니다.

모델만 바꾸거나 AI를 다시 끄려면:

```bash
dev-guard config set model gpt-5
dev-guard configure ai --provider none --model gpt-4o-mini
```

## 4. AGENTS.md / CLAUDE.md 문구

`dev-guard install-agent-instructions`가 `AGENTS.md`(Codex)와 `CLAUDE.md`(Claude Code)에 표시된 섹션(`<!-- dev-guard-section-start -->` … `<!-- dev-guard-section-end -->`)을 씁니다. 설치된 버전과 문구가 항상 일치하도록 직접 붙여넣기보다 명령을 사용하세요. 이 섹션은 하나의 workflow만 설명합니다.

- **MCP 사용 가능:** 새 작업마다 먼저 `prepare_task_context` 호출 → TARGET 범위 읽기 → 구체적인 공백이 있을 때만 CANDIDATE 열기 → 둘 다 다루지 못한 부분만 좁게 검색. `.devguard` markdown은 함께 읽지 않습니다.
- **MCP 사용 불가:** `.devguard/context/agent-brief.md` → `.devguard/reports/read-map.md` → `.devguard/reports/code-map.md` 순서로 fallback.
- `project-handoff.md` / `quality-report.md`는 명시적 요청(이전 작업 재개, QA 조사)이 있을 때만 읽습니다.
- thread 정책은 hybrid입니다: 같은 작업의 작고 밀접한 후속 수정은 thread 부담이 낮으면 같은 thread에서 이어갈 수 있고, 별도/큰 작업, `SOON` / `NEW_THREAD` 안내, compaction이 일어난 thread는 새 agent thread로 옮깁니다. 검증은 `record_validation_result`로 기록하고 `dev-guard done` 또는 Stop hook으로 마칩니다.

기존 dev-guard 섹션을 최신 문구로 갱신하려면:

```bash
dev-guard install-agent-instructions --force
```

## 5. 전역 agent 지시문

DevGuard는 `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md` 같은 사용자 전역 지시문 파일을 쓰지 않습니다. 예전 가이드는 그곳에 "`project-handoff.md` / `quality-report.md`를 먼저 읽어라" 블록을 붙여넣도록 안내했는데, 이 블록은 위 프로젝트 섹션(MCP 우선, markdown 읽지 않음)과 충돌합니다. 전역 파일에 아직 남아 있다면 직접 제거하세요. `dev-guard doctor --agents`가 해당 블록을 발견하면 알려줍니다.

## 6. Codex / Claude hook 확인

설치 상태 확인:

```bash
dev-guard doctor --agents
dev-guard doctor --hooks --dry-run
```

직접 hook script 실행까지 확인하려면:

```bash
dev-guard doctor --hooks
```

주의: `doctor --hooks`는 hook script를 직접 실행하므로 `dev-guard done`과 `dev-guard status`를 실행할 수 있습니다.

Codex에서는 user-level `~/.codex/config.toml`의 `notify`가 권장 경로입니다.

```bash
dev-guard install-hooks --agent codex-notify
```

이미 다른 Codex `notify`가 있으면 dispatcher로 보존하면서 함께 실행합니다.

```bash
dev-guard install-hooks --agent codex-notify --install-dispatcher
```

Codex Stop Hook을 쓰는 고급 경로에서는 Codex TUI에서 `/hooks`를 열어 dev-guard hook을 review/trust해야 합니다.

## 7. 이후 CLI 명령어 흐름

일상 작업 권장 흐름:

```bash
dev-guard watch
# Codex/Claude가 파일 수정
# 검증된 hook/notify가 dev-guard done 실행
dev-guard status
```

hook이 실패하거나 아직 신뢰되지 않았을 때:

```bash
dev-guard watch --manual
# 작업 완료 후 직접 실행
dev-guard done
dev-guard status
```

다음 작업: 구체적인 작업(과 반드시 읽을 파일)만 전달합니다. agent가 `prepare_task_context`를 호출하고, 반환된 read plan의 TARGET 범위부터 읽으며, `.devguard` markdown은 열지 않습니다. 같은 작업의 작은 후속 수정은 현재 thread에서 이어가도 되고, 별도/큰 작업이나 `SOON` / `NEW_THREAD` 안내·compaction 이후의 작업은 새 thread에서 시작합니다.

수동 복구용 — MCP를 쓸 수 없을 때, 이전 작업을 명시적으로 재개할 때, DevGuard 출력을 디버깅할 때만:

```bash
dev-guard handoff
cat .devguard/reports/project-handoff.md
```

MCP 없이 진행할 때는 agent에게 `.devguard/context/agent-brief.md` → `.devguard/reports/read-map.md` → `.devguard/reports/code-map.md` 순서로 읽게 합니다.

문제 확인용 명령:

```bash
dev-guard status
dev-guard doctor --agents
dev-guard doctor --hooks --dry-run
```

pending watch buffer만 비울 때:

```bash
dev-guard reset
```

## 8. 업데이트 후 점검 체크리스트

npm 업데이트 뒤에는 각 프로젝트의 다음 `dev-guard watch`가 관리 섹션, MCP 항목, 오래된 hook script를 제자리에서 갱신합니다. watch 없이 확인하려면:

```bash
dev-guard setup --dry-run
dev-guard status
dev-guard doctor --agents
dev-guard doctor --hooks --dry-run
```

hook script 자체가 바뀐 버전이면 필요한 프로젝트에서 다시 설치합니다.

```bash
dev-guard install-hooks
```

기존 설정을 강제로 갱신해야 할 때만 `--force`를 사용합니다.

```bash
dev-guard install-hooks --force
```
