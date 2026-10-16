# dev-guard

[English](./README.md) | [한국어](./README.ko.md)

dev-guard는 **AI Coding Context Provider**입니다.

IDE도 아니고, wrapper도 아니며, 스스로 코드를 수정하는 AI Agent도 아닙니다. 역할은 더 좁습니다.

- AI 작업 전: Agent가 바로 시작할 수 있는 최소 컨텍스트 제공
- AI 작업 후: 무엇이 바뀌었고, 무엇을 검증했으며, 다음 Agent가 어디서 이어가야 하는지 기록

DevGuard는 이 컨텍스트를 로컬 `.devguard/` 파일로 보존해서 Codex/Claude 작업을 레포지토리 재탐색 없이 이어갈 수 있게 합니다.

설치 후 프로젝트에서 명령 하나면 됩니다.

```bash
cd my-project
dev-guard watch   # 첫 실행에서 프로젝트를 자동 준비한 뒤 watch; Claude/Codex가 파일 수정
# 작업마다 agent가 DevGuard MCP 도구 prepare_task_context를 호출
```

별도 setup 단계와 OpenAI API key는 필요 없습니다. context broker는 결정적으로 동작합니다.

context window가 끊기거나, 여러 Agent를 오가거나, 긴 AI 코딩 작업을 다음 세션으로 넘겨야 할 때 사용합니다.

## 제품 경계

DevGuard는 AI Coding Agent 앞뒤에서 컨텍스트를 제공하는 도구입니다. Agent를 대체하지 않습니다.

```text
Before AI
  -> Prepare Context
  -> Read Map / Code Map / Agent Brief

AI Work
  -> Claude / Codex / GPT가 코드 수정

After AI
  -> Preserve Context
  -> Quality Report / Handoff / Working Context / Memory
```

DevGuard는 vector DB, background full-project indexer, cloud sync, IDE 전용 통합, 자동 코드 intercept를 구현하지 않습니다. 이런 항목은 현재 제품이 아니라 roadmap 수준의 아이디어로만 둡니다.

## Context Pipeline

DevGuard의 공식 파이프라인은 다음과 같습니다.

```text
Prepare
  -> Read Map
  -> Code Map
  -> Agent Brief
  -> Work
  -> Done
  -> Change Intelligence
  -> Quality Report
  -> Handoff
  -> Working Context
  -> Agent Context
  -> Memory Update
```

`done` 이후 하나의 Change Intelligence 요약을 만들고, 이후 문서들은 각자 새 요약을 만들지 않고 이 요약을 자기 역할에 맞게 사용합니다.

## 산출물 역할

| 산출물 | 역할 |
| --- | --- |
| Project Knowledge | 프로젝트 장기 구조 기억 |
| Read Map | 다음 Agent가 무엇을 먼저 읽을지 |
| Code Map | 관련 파일 안에서 어디를 읽을지 |
| Agent Brief | 다음 코딩 Agent를 위한 짧은 작업 요약 |
| Quality Report | QA 결과와 남은 검증 |
| Project Handoff | 다음 세션 작업 인계 |
| Working Context | 현재 작업 구조와 수정 경계 |
| Agent Context | Agent 작업 규칙과 현재 제약 |
| Next Prompt | 새 AI 세션에 붙여넣을 실행 프롬프트 |
| Dashboard | 사람을 위한 현재 상태와 다음 행동 요약 |

## 기능 분류

**Core**

- `.devguard/` 로컬 컨텍스트 저장소
- `setup`, `watch`, `done`, `status`, `handoff`
- DevGuard MCP (`prepare_task_context`, `record_validation_result`) — 결정적 context broker, API key 불필요
- Project Knowledge
- Read Map, Code Map, Agent Brief
- Change Intelligence
- Quality Report
- Project Handoff
- Working Context, Agent Context
- memory 파일: `.devguard/memory/code-index.json`, `.devguard/memory/change-log.jsonl`

**Keep**

- Dashboard
- `install-agent-instructions`
- `install-hooks`
- `knowledge`
- OpenAI 보조 Quality Report 요약
- `self-check`, `doctor`
- locale 기반 사용자 문서

**Experimental**

- `scan`, `refresh`
- `review`, `task-ai`, 자연어 task helper
- `update --write`
- Codex JSONL listener helper
- 기본 watch 흐름 밖의 고급 hook/notify 전략

## 문제 정의

AI 에이전트 작업은 끝난 뒤 맥락이 쉽게 끊깁니다. 다음 작업을 위해 긴 대화 로그를 붙여넣거나, 변경 범위 drift와 검증 기준을 놓치기 쉽습니다.

dev-guard는 이 흐름을 로컬에서 정리합니다.

- 작업 중 파일 변경 감시
- 파일 시스템이 안정된 후 자동으로 세션 완료 처리 — 별도 명령 불필요
- 크래시/훅 실패 시 수동 `done` fallback 유지 (복구 전용)
- 작업 이력 누적
- 품질 verdict 생성
- 다음 Claude/Codex용 handoff prompt 생성
- 자동 소스 수정/자동 문서 수정 없음

주요 사용 사례:

- context window 초과 후 Codex/Claude 작업 이어가기
- 한 Agent 세션에서 다른 Agent 세션으로 현재 프로젝트 상태 넘기기
- 변경 내용과 다음 검증 항목을 로컬 이력으로 압축 저장하기
- 현재 task, rules, docs, git diff를 바탕으로 다음 세션 prompt 만들기

## 빠른 시작

CLI 설치(설치 자체는 어떤 프로젝트도 분석하거나 변경하지 않습니다):

```bash
npm install -g @dev-guard/cli
```

프로젝트에서 실행:

```bash
cd my-project
dev-guard watch
```

첫 `watch`가 DevGuard를 자동으로 준비합니다 — `.devguard/` 설정 생성, 프로젝트 색인(Code Index), 구조 분석(Project Knowledge), `AGENTS.md` / `CLAUDE.md`에 DevGuard 섹션 추가, Claude Code와 Codex에 DevGuard MCP 서버 등록, completion hook best-effort 설치 — 그 뒤 로컬 대시보드를 열고 감시를 시작합니다. 이후 실행에서는 모두 최신이면 바로 시작하고("Project ready."), 없거나 오래된 부분만 갱신합니다.

Git 저장소에서는 첫 실행이 DevGuard 로컬 상태를 Git에서 제외합니다. Git이 아직 무시하지 않는 경우에만 `.gitignore`에 `.devguard/`와 `devguard.backup-*/`를 덧붙이고(파일이 없으면 생성), 기존 줄은 바꾸거나 순서를 바꾸지 않습니다. 프로젝트 연동 파일(`AGENTS.md`, `CLAUDE.md`, `.mcp.json`, `.codex/config.toml`)은 제외하지 않으니 필요하면 커밋해 공유하세요. `.devguard/`가 이미 Git에 추적되고 있으면 경고만 하고 Git index는 건드리지 않습니다(추적 해제는 직접 `git rm -r --cached .devguard`). Git 밖에서는 `.gitignore`를 만들지 않습니다.

DevGuard는 첫 watch에서 가볍고 결정적인 프로젝트 탐색을 수행하고, 이후 실행에서는 캐시된 분석을 재사용합니다. git 안에서는 `git ls-files`로 파일을 나열하므로 `.gitignore`된 파일(로컬 secret, 임시 폴더, 빌드 산출물)은 분석하지 않고, git 밖에서는 디렉터리를 순회합니다. 파일 내용 읽기는 예산 안에서 workspace package 전반에 고르게 샘플링되어, 큰 monorepo에서도 빠르면서 package가 누락되지 않습니다. 최대 25K 파일의 synthetic 저장소에서 검증했습니다(모든 저장소에 대한 보장은 아닙니다). 첫 `watch`는 25K 파일에서 약 1초에 준비되고, `prepare_task_context`는 10K 파일에서 약 0.4초, 25K에서 약 0.6초입니다. deep Code Index는 대표 파일 약 1,200개(심볼·토큰 포함)로 제한되며, 그 밖의 파일은 `prepare_task_context`가 모든 프로젝트 경로를 파일명/경로 단어로 순위 매긴 뒤 상위 몇 개만 해당 호출에서 읽고 일반 순위 계산에 맡깁니다. 인덱스에는 아무것도 추가로 쓰지 않습니다. Project Knowledge는 UI 페이지, Next.js API 라우트, HTTP 프레임워크 핸들러(Express, Fastify, Koa, Hono 등)를 각각 별도 예산으로 보관하고, 발견한 개수와 보관한 개수를 함께 기록하며, 핸들러는 프레임워크 의존성과 라우트 형태의 경로가 있는 곳부터 샘플링합니다.

선택 사항 — `dev-guard setup`은 같은 준비 과정을 watch 없이 실행하고 요약을 출력합니다(CI/스크립트, 감지 결과 확인, `dev-guard setup --dry-run`으로 쓰기 없이 미리보기). `watch` 전에 반드시 실행할 필요는 없습니다.

일상 루프:

```bash
dev-guard watch
# AI Agent와 작업; 새 작업마다 agent가 prepare_task_context 호출
# DevGuard가 변경을 감지하고 파일 시스템이 안정되면 자동으로
# 보고서를 생성하고 모니터링으로 돌아갑니다
dev-guard status  # 선택 사항: 품질 verdict 확인
```

고급/복구용: `dev-guard init`(`.devguard` 설정/템플릿만, 프로젝트 분석 없음), `dev-guard install-agent-instructions`, `dev-guard install-hooks` — `watch`가 모두 수행합니다.

이 monorepo를 개발할 때:

```bash
pnpm install
pnpm run build
pnpm cli status
```

npm 설치/업데이트 후 초기세팅, 선택적 AI 설정, `AGENTS.md`/`CLAUDE.md` 문구, 이후 CLI 흐름은 [npm 설치/업데이트 사용 가이드](./docs/npm-setup.ko.md)에 한 번에 정리되어 있습니다.

## 선택 사항: AI (OpenAI)

DevGuard의 제품 계약은 API key 없이 동작하는 것입니다. `setup`, `init`, `watch`, `status`, `doctor`, Code Index, Project Knowledge, MCP(`prepare_task_context`, `record_validation_result`), execution lineage, rollover 안내, 검증 기록, `done`, Quality Report, Handoff, 대시보드, telemetry, hook은 key 없이 동작하며 OpenAI를 호출하지 않습니다. context broker는 결정적이며 기본 경로에 AI reranker는 없습니다.

AI는 명시적 opt-in이며 `task-ai`, `review`(`--heuristic` 제외) / `fix-prompt`, 그리고 `done` Quality Report의 선택적 AI 요약에서만 사용됩니다.

```bash
dev-guard configure ai --provider openai --model gpt-4o-mini
dev-guard config set openaiApiKey "your_api_key_here"
# 또는: export DEV_GUARD_OPENAI_API_KEY="your_api_key_here"
dev-guard doctor
```

key는 `.devguard/config.json`, `DEV_GUARD_OPENAI_API_KEY`, `OPENAI_API_KEY` 순서로 읽습니다. 셸 전역 `OPENAI_API_KEY`만으로는 `done`의 AI 요약이 켜지지 않습니다(다른 도구용으로 설정된 경우가 많기 때문). `ai.provider: "openai"` 또는 `DEV_GUARD_OPENAI_API_KEY`로 켭니다. key가 없으면 `doctor`는 `OpenAI API: not configured (optional)`로 표시합니다. DevGuard는 key 값을 출력하거나 Dashboard API 응답에 포함하지 않습니다. `.devguard/config.json`에 key를 저장했다면 해당 파일을 git에 커밋하지 마세요.

## 핵심 명령어

```bash
dev-guard setup [--dry-run]
dev-guard watch [--depth 8] [--poll] [--stable-after 20]
dev-guard watch --no-dashboard
dev-guard watch --manual
dev-guard knowledge
dev-guard done
dev-guard handoff
dev-guard status
dev-guard reset
```

- `watch`: 시작 명령. 첫 실행에서 `.devguard/`, Code Index, Project Knowledge, AI instruction, MCP, completion hook을 자동 준비하고 대시보드와 감시를 시작합니다. 이후에는 오래된 부분만 갱신합니다.
- `setup`: 선택 사항. 같은 준비 과정을 watch 없이 실행하고 요약을 출력한 뒤 종료합니다(`--dry-run` 지원).
- `done`: 작업 완료 이벤트 처리, history/report/quality/handoff 생성
- `handoff`: 현재 `.devguard/` 산출물만 읽어서 `project-handoff.md` 재생성
- `status`: pending 상태, 최근 작업, quality verdict, 다음 권장 작업 출력
- `reset`: runtime pending buffer만 초기화

고급/복구 명령:

```bash
dev-guard init
dev-guard install-hooks [--force]
dev-guard install-hooks --agent claude
dev-guard install-hooks --agent codex
dev-guard install-hooks --agent codex-notify
dev-guard install-hooks --agent codex-notify --install-dispatcher
dev-guard install-hooks --agent all
dev-guard install-agent-instructions
dev-guard dashboard [--port 3737]
```

일반 사용자는 위 명령을 직접 실행할 필요가 없습니다. `watch`가 누락된 설정을 자동으로 준비합니다. `init`은 `.devguard` 설정/템플릿만 만들며 프로젝트를 분석하지 않습니다. 기존 `AGENTS.md` 또는 `CLAUDE.md`에는 DevGuard marker(`<!-- dev-guard-section-start -->` … `<!-- dev-guard-section-end -->`) 사이의 섹션만 추가/갱신하며, marker 밖의 사용자 텍스트는 바꾸지 않습니다.

## 생성되는 파일 구조

```text
.devguard/
  project.md
  architecture.md
  decisions.md
  tasks.md
  state.json
  runtime.json
  history.jsonl
  memory/
    code-index.json
    change-log.jsonl
  context/
    agent-brief.md
    agent-context.md
  prompts/
    next-codex-prompt.md
    next-claude-prompt.md
  reports/
    last-run.md
    history-summary.md
    decision-candidates.md
    quality-report.md
    project-handoff.md
    read-map.md
    code-map.md
    working-context.md
```

`.devguard/` runtime 산출물은 기본적으로 git ignore 대상입니다.

## Handoff Flow

`dev-guard done`은 다음 파일을 생성합니다.

- `.devguard/reports/last-run.md`
- `.devguard/history.jsonl`
- `.devguard/reports/history-summary.md`
- `.devguard/reports/decision-candidates.md`
- `.devguard/memory/code-index.json`
- `.devguard/memory/change-log.jsonl`
- `.devguard/reports/read-map.md`
- `.devguard/reports/code-map.md`
- `.devguard/context/agent-brief.md`
- `.devguard/reports/quality-report.md`
- `.devguard/reports/project-handoff.md`
- `.devguard/reports/working-context.md`
- `.devguard/context/agent-context.md`
- `.devguard/prompts/next-codex-prompt.md`

`read-map.md`와 `code-map.md`는 다음 Agent가 무엇을 먼저 읽을지 알려줍니다.
`project-handoff.md`는 context window 초과 후 새 Claude/Codex 스레드에서 바로 이어가기 위한 압축 인수인계 문서입니다.
`next-codex-prompt.md`는 새 Codex 세션에 붙여넣을 실행 프롬프트입니다.

Dashboard, 품질 보고서, 프로젝트 인수인계처럼 사용자가 직접 읽는 산출물은 locale을 따릅니다. DevGuard는 `.devguard/config.json`의 `locale`, OS locale(`LANG`, `LC_ALL`, `LC_MESSAGES`), 기본값 `en-US` 순서로 결정합니다. Dashboard 언어 토글도 같은 프로젝트 locale 설정을 저장합니다. `next-codex-prompt.md` 같은 AI 전용 산출물은 영어를 유지합니다.

자세한 내용은 [docs/handoff.md](./docs/handoff.md)를 참고하세요.

## Project Knowledge

DevGuard는 AI 세션이 레포지토리를 넓게 탐색하기 전에 읽을 수 있도록 `.devguard/project/project-knowledge.json`을 생성합니다. 이 파일은 검색 기능이나 semantic code index가 아니라 정적 프로젝트 구조 문서입니다. framework, package manager, entry point, page, component, API, database hint, command, important file, architecture module을 요약합니다.

세션 완료 후 갱신되며, 필요하면 수동으로 다시 생성할 수 있습니다.

```bash
dev-guard knowledge
```

생성되는 `AGENTS.md`와 `CLAUDE.md` 안내문은 agent가 source file을 넓게 열기 전에 Working Context, Handoff, Quality Report를 먼저 읽고 필요한 진입 파일부터 확인하도록 안내합니다.

## 에이전트별 완료 전략

dev-guard는 Claude Code와 Codex를 같은 방식으로 취급하지 않습니다.

- Claude Code: `.claude/settings.json`과 `.devguard/hooks/claude-stop.sh`를 사용하는 Stop Hook
- Codex 권장: user-level `~/.codex/config.toml`의 `notify`가 `.devguard/hooks/codex-notify.sh` 호출
- Codex 고급 옵션: `.codex/hooks.json`과 `.devguard/hooks/codex-stop.sh`를 사용하는 Stop Hook. `/hooks` trust 필요
- 보조 JSONL listener: `.devguard/hooks/codex-event-listener.ts`

Codex `notify`는 user-level 설정입니다. 공식 Codex 설정 문서는 project-local `.codex/config.toml`의 `notify`를 무시한다고 설명하므로, `dev-guard install-hooks --agent codex-notify`는 notify script를 만들고 user config를 검사하되 기존 값을 덮어쓰지 않습니다.

Codex notify는 user-level 단일 명령일 수 있습니다. 기존 Computer Use `turn-ended` notify가 있으면 dispatcher로 함께 실행합니다.

```bash
dev-guard install-hooks --agent codex-notify --install-dispatcher
```

이 명령은 `~/.codex/dev-guard-notify-dispatcher.sh`를 만들고, `~/.codex/config.toml`을 `~/.codex/config.toml.devguard-backup-YYYYMMDD-HHmmss`로 백업한 뒤 `notify`를 dispatcher로 바꿉니다. dispatcher는 기존 notify 명령을 보존해서 실행하고, 현재 프로젝트에 `.devguard/hooks/codex-notify.sh`가 있으면 추가로 실행합니다. 한쪽 notify 실패가 다른 쪽 실행을 막지 않습니다.

복구는 백업을 되돌리면 됩니다.

```bash
cp ~/.codex/config.toml.devguard-backup-YYYYMMDD-HHmmss ~/.codex/config.toml
```

전략이 설치된 것과 실제 runtime에서 검증된 것은 다릅니다. `dev-guard doctor --agents`는 Claude/Codex 전략 상태를 보여줍니다. `dev-guard doctor --hooks --dry-run`은 hook 파일/권한/설정 command 경로만 검사하고, `dev-guard doctor --hooks`는 hook script를 직접 실행합니다. 직접 실행 검사는 `dev-guard done`과 `dev-guard status`를 실행할 수 있습니다.

Codex는 project trust와 hook definition trust가 별도일 수 있습니다. Codex Stop Hook을 쓴다면 Codex TUI에서 `/hooks`를 열어 dev-guard Stop Hook을 review/trust해야 합니다. Claude Code Hook은 Claude Code가 설치되어 있고 해당 프로젝트에서 `.claude/settings.json`을 읽는 환경에서만 동작합니다. 실제 실행 여부(runtime verification)는 hook 스크립트가 `.devguard/hook-state/`에 남기는 작은 상태 파일로 판정하며 `dev-guard status`로 확인합니다. `.devguard/logs/claude-hook.log`, `codex-hook.log`, `codex-notify.log`는 진단용 로그일 뿐입니다: 이벤트마다 짧은 요약만 기록하고(raw payload 없음, 명령 출력은 실패 시에만), 2MB마다 회전해 이전 세대 2개(`.log.1`, `.log.2`)만 보존합니다. `DEV_GUARD_HOOK_DEBUG=1`을 설정하면 최대 4KB의 raw payload와 명령 출력 tail도 기록합니다. 이전 버전 DevGuard가 생성한 hook 스크립트는 다음 `dev-guard watch` 때 자동으로 재생성됩니다.

Codex의 `turn.completed`는 Hook 이벤트가 아니라 `codex exec --json` JSONL 출력 이벤트입니다. JSONL listener는 이 스트림을 감시하는 보조 기능이며 `.codex/hooks.json`에 섞지 않습니다.

## 사용 모드

### Auto Mode 권장

```bash
dev-guard install-hooks
dev-guard watch
```

Auto Mode는 전략이 설치되고 runtime에서 검증된 뒤에만 성공으로 봅니다. Claude Code는 Stop Hook을 사용합니다. Codex는 user-level notify를 우선 검토하고, Stop Hook은 `/hooks` trust가 필요한 고급 옵션입니다. 완료 전략이 실행되면 `dev-guard done`이 `quality-report.md`, `next-codex-prompt.md`, `project-handoff.md`를 생성합니다.

hook이 **runtime에서 검증**되면(설치만 된 상태가 아니라) 그 hook이 completion signal이 되고, `watch`는 더 이상 idle 상태로 완료를 추측하지 않습니다 — 파일만 추적하고 hook이 실제로 완료시킨 결과만 반영합니다. 검증되기 전(hook 설치만 된 상태, 또는 hook이 전혀 없는 상태)에는 `watch`가 변경이 멈춘 뒤 직접 자동 완료합니다 — 그래야 hook을 설정하는 동안에도 플래그 없이 자동 완료가 계속 동작합니다. 완료 처리 자체는 멱등적(idempotent)입니다: 같은 session/code state에 대해 hook이 다시 실행되거나 수동 `dev-guard done`과 경쟁해도, 그 사이 실제 변경이 없었다면 중복 완료가 아니라 아무 일도 일어나지 않습니다.

agent hook/notify 또는 사용자의 수동 `done`이 다른 프로세스에서 실행되면 `.devguard/runtime.json`, `.devguard/state.json`, `.devguard/history.jsonl`을 다시 읽어 processed/idle 상태로 화면을 갱신합니다 — 단, 실제로 새로운 완료가 있었을 때만 1회입니다.

`watch` 화면이 `ready_for_done`에 오래 머무르면 `dev-guard status`로 pending이 이미 비워졌는지, `.devguard/reports/hook-status.md`로 hook이 실제로 실행됐는지 확인한 뒤 수동 `dev-guard done`으로 넘어가세요.

### Manual Mode fallback

```bash
dev-guard watch --manual
dev-guard done
```

Hook을 사용할 수 없거나 신뢰되지 않았거나 실패했을 때 사용합니다. `watch`는 변경만 누적합니다. 브라우저에서는 Review Complete 버튼을 사용하고, 터미널만 쓰는 경우에는 검토와 앱 실행을 마친 뒤 `dev-guard done`으로 현재 세션을 완료 처리하고 quality/handoff 파일을 다시 생성합니다.

## 로컬 대시보드

로컬 대시보드는 `dev-guard watch`를 실행하면 자동으로 시작됩니다. 대시보드는 `127.0.0.1`에만 바인딩되고 기본 주소는 `http://127.0.0.1:3737`입니다. `/api/overview`를 2초마다 polling합니다. telemetry를 모두 늘어놓는 화면이 아니라 현재 작업과 컨텍스트 상태를 보여주며, 첫 화면에서 다섯 가지를 바로 알 수 있습니다.

- **지금** — 상태(DevGuard가 설정되어 감시 중이고 상태를 저장할 수 있는지), 스레드(여유 있음 / 다음 큰 작업은 새 스레드 권장 / 새 스레드 권장), 한 줄 현재 작업, 가장 큰 컨텍스트 문제 하나, 권장 행동 하나.
- **이번 작업** — 최대 다섯 개 숫자: 컨텍스트(제공사가 실제로 알려 준 사용량만), 읽기 계획(필수/선택 파일), 제안 사용, 검증(기록된 근거), 변경 파일. 각각 실측/계획/판단/추정치 표시가 붙습니다.
- **컨텍스트 흐름** — 이번 작업의 컨텍스트가 어디에 쓰였는지 보여주는 차트 하나(파일 크기 기반 추정치라 `~18K`처럼 표시).
- **자세히** — 접힌 상태: 읽기 계획, 실행 이력, 검색 활동, 검증 근거, 타임라인, 다른 문제, 리포트와 프롬프트, 설정과 연동, 프로젝트 정보, 원시 데이터.

UI는 브라우저 언어를 자동으로 따르며 English/한국어 토글을 제공합니다.

임의 파일 브라우징, 환경 변수 노출, shell 실행 기능은 없습니다. DevGuard가 프로젝트를 모니터링 중이 아니면 `dev-guard watch` 실행을 안내합니다.

대시보드는 일반 사용자를 위한 기본 workflow입니다. 다음 행동 하나(watch 시작, 새 스레드 시작, 가장 큰 문제 해결, 품질 리포트 검토, 계속 진행)를 보여주고, 막힌 검토가 끝났을 때 누를 수 있는 Review Complete 버튼을 제공합니다. CLI는 자동화, 터미널 전용 workflow, 복구용으로 남겨둡니다.

터미널만 쓰고 싶을 때는 고급 옵션을 사용합니다.

```bash
dev-guard watch --no-dashboard
```

## Watch Mode 실전 사용

AI 코딩 세션 동안 지속적인 DevGuard 지원이 필요하면 작업 시작 시 watcher를 실행합니다.

```bash
dev-guard watch
```

Codex/Claude가 파일을 수정하는 동안 별도 터미널에서 계속 켜두는 것을 권장합니다. `watch`는 로컬 대시보드를 자동으로 시작하고, 파일 변경을 관찰하며 pending 파일 buffer를 최신으로 유지합니다. idle 시간으로 완료를 추정하지 않고, build/test/commit도 실행하지 않습니다.

완료 처리는 검증된 hook/notify 전략 또는 수동 fallback으로 수행합니다.

```bash
dev-guard done
dev-guard status
```

`done` 이후 DevGuard는 `.devguard/reports/quality-report.md`, `.devguard/reports/project-handoff.md`, `.devguard/prompts/next-codex-prompt.md` 같은 품질/인수인계 산출물을 생성합니다. 다음 세션에서는 이 파일들로 레포지토리를 다시 훑지 않고 이어갈 수 있습니다.

## Context Overflow 복구

긴 스레드가 compaction될 때까지 기다리거나 긴 history를 새 스레드에 붙여넣지 마세요. thread 정책은 hybrid입니다: 같은 작업의 작고 밀접한 후속 수정은 thread 부담이 낮으면(`LOW`, 또는 compaction 없는 `UNKNOWN`) 현재 스레드에서 이어가도 되고, 별도/큰 작업이나 `SOON` / `NEW_THREAD` 안내, compaction이 일어난 스레드는 새 agent 스레드로 옮깁니다. 어느 경우든 구체적인 작업으로 DevGuard MCP `prepare_task_context`를 호출합니다. 읽을 파일/범위, 제약, 이월된 dirty 작업, 이전 작업의 미해결 검증이 함께 반환됩니다. `record_validation_result` 응답에도 (provider가 기록하는 경우) 현재 스레드의 관측된 압박도가 포함되어 언제 넘어가야 할지 알 수 있습니다.

이전 작업을 명시적으로 재개하거나 MCP를 쓸 수 없을 때만 handoff를 재생성해 읽습니다.

```bash
dev-guard handoff
cat .devguard/reports/project-handoff.md
```

그 next action을 구체적인 작업으로 바꿔 새 스레드에서 `prepare_task_context`를 호출하세요.

## Multi-Agent Workflow

### 권장 세션 인수인계 순서

1. `dev-guard watch` — watcher 시작
2. Claude/Codex가 파일 수정; Stop Hook이 `done` 자동 실행 (작업을 준비한 스레드가 아닌 다른 스레드의 Stop은 무시됨)
3. 다음 작업은 `prepare_task_context`로 시작 (별도/큰 작업이거나 `SOON` / `NEW_THREAD` 안내 이후면 새 agent 스레드에서)
4. TARGET 범위부터 읽기

### Codex ↔ Claude 전환 시 (또는 다른 Agent로 전환)

둘 다 같은 프로젝트 섹션(`AGENTS.md` / `CLAUDE.md`)을 읽으므로 시작 프롬프트는 작업 내용이면 충분합니다. MCP를 쓸 수 없을 때만:

```txt
Read .devguard/context/agent-brief.md, then .devguard/reports/read-map.md and .devguard/reports/code-map.md; continue from the targeted file ranges.
```

`.devguard/reports/project-handoff.md` / `.devguard/reports/quality-report.md`는 명시적으로 재개하거나 QA를 조사할 때만 읽습니다.

### 생성되는 Agent context 파일

`dev-guard done`과 `dev-guard handoff`는 다음 파일을 생성합니다.

- `.devguard/context/agent-context.md` — 새 세션용 단일 진입 컨텍스트 문서
- `.devguard/reports/read-map.md` — 무엇을 먼저 읽을지
- `.devguard/reports/code-map.md` — 관련 파일 내부에서 어디를 읽을지
- `.devguard/context/agent-brief.md` — 다음 Agent를 위한 짧은 작업 요약
- `.devguard/reports/working-context.md` — 현재 작업 구조와 수정 경계
- `.devguard/prompts/next-claude-prompt.md` — Claude 세션용 시작 프롬프트
- `.devguard/prompts/next-codex-prompt.md` — Codex 세션용 압축 실행 프롬프트

### AGENTS.md / CLAUDE.md

`dev-guard watch`는 `AGENTS.md`와 `CLAUDE.md`가 없을 때 DevGuard가 관리하는 instruction 파일을 자동 생성합니다. 이미 파일이 있고 DevGuard marker가 없으면 사용자가 직접 관리하는 파일로 보고 그대로 둡니다. `install-agent-instructions`는 복구나 명시적 갱신이 필요할 때 쓰는 고급 명령입니다.

```bash
dev-guard install-agent-instructions
# 기존 섹션 갱신이 필요한 경우:
dev-guard install-agent-instructions --force
```

다음 Agent를 지원합니다:

- Claude Code (`CLAUDE.md`를 시작 시 읽음)
- Codex (`AGENTS.md`를 참고)
- 프로젝트 레벨 instruction 파일을 인식하는 기타 Agent

사용자 전역 지침 파일은 사용자 소유입니다. DevGuard는 `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`를 수정하지 않습니다. 이 파일에 예전 "`.devguard/reports/project-handoff.md` / `quality-report.md` / `next-codex-prompt.md`를 먼저 읽으라"는 블록이 남아 있으면 `dev-guard doctor`, `prepare_task_context` 경고, 대시보드 상태가 이를 알려 줍니다. 에이전트가 실제 입력 대신 오래된 인수인계 파일을 넘기게 되므로 해당 블록은 직접 지워 주세요.

이 파일은 강제 규칙이 아니라 **권장 사항**입니다. dev-guard 산출물을 먼저 참고하여 레포지토리 전체 재스캔을 줄이고 컨텍스트 재구축 비용을 낮추도록 유도하는 용도입니다. 기존 파일 내용은 유지하며, dev-guard는 자신의 섹션(HTML 주석 마커로 표시)만 추가하거나 갱신합니다.

## Quality Flow

`done`은 build/test를 자동 실행하지 않습니다. 대신 어떤 검증이 필요한지 판단합니다.

Verdict:

- `PASS`: 최종 확인 또는 커밋 가능
- `NEEDS_REVIEW`: drift, 넓은 변경, 위험 영역, CLI/router/watch/runtime/prompt 변경 등으로 검토 필요
- `BLOCKED`: generated/runtime 파일이 git 변경에 포함되었거나 package/lockfile 상태가 불일치하는 등 커밋 전 해결 필요

자세한 내용은 [docs/quality.md](./docs/quality.md)를 참고하세요.

## 안전 정책

- `watch`, `done`, `status`, `reset`은 소스 파일을 수정하지 않습니다.
- `watch`는 주기 실행이 아니라 이벤트 기반입니다.
- `done`은 `.devguard/` runtime 산출물만 씁니다.
- `decisions.md`는 자동 수정하지 않고 후보만 생성합니다.
- `update`는 preview이며, `update --write`에서만 managed block을 수정합니다.
- API provider는 선택 사항이며, 명시적 opt-in 없이는 OpenAI를 호출하지 않습니다.
- 대시보드 상태는 프로젝트의 빌드/테스트가 아니라 DevGuard 자신의 상태만 보여 줍니다. `.devguard/runtime.json`을 쓸 수 없으면(예: "디스크 공간이 부족해 DevGuard 상태를 저장할 수 없습니다.") **확인 필요**로 표시되고, 상태 파일은 손상되지 않으며, 같은 실패는 1분에 한 번만 기록되고, 다음 쓰기가 성공하면 watch 재시작 없이 정상으로 돌아옵니다.
- DevGuard는 사용자 전역 에이전트 지침 파일을 수정하지 않고, 예전 DevGuard 블록이 있을 때 경고만 합니다.
- MCP 서버는 자신이 시작된 프로젝트(또는 그 안의 `projectRoot`)만 다룹니다. 다른 프로젝트 요청은 전환하지 않고 거부하며, 오류에 MCP 루트, 요청한 프로젝트, 양쪽 git toplevel, 비어 있거나 같은 이름의 형제 checkout 같은 가능성 있는 원인을 표시합니다.
- `.devguard`의 생성 markdown은 고정 경로 단일 파일로 덮어쓰고, `history.jsonl` / `memory/change-log.jsonl`(8 MB) / `telemetry.jsonl`(4 MB)은 한도를 넘으면 원자적으로 `<file>.1`로 이름을 바꿔 회전합니다(1세대 보관, 읽을 때 두 파일을 합쳐 동시 쓰기나 중단에도 기록이 유실되지 않음). 새 프로젝트에는 `docs/PROJECT_STATE.md` 등 루트 템플릿을 더 이상 만들지 않으며, 기존 파일은 삭제하지 않습니다.

## Advanced

아래 명령은 유지되지만 기본 사용 흐름은 아닙니다.

- `scan`, `refresh`
- `check`, `review`, `report`
- `prompt`, `task-ai`
- `update`, `update --write`
- `doctor`, `telemetry`
- `self`, `self-check`

## 상세 문서

- [npm 설치/업데이트 사용 가이드](./docs/npm-setup.ko.md)
- [Command reference](./docs/commands.md)
- [Architecture](./docs/architecture.md)
- [Handoff prompt](./docs/handoff.md)
- [Quality verdicts](./docs/quality.md)
- [Watch mode](./docs/watch.md)
- [Configuration and tracking policy](./docs/configuration.md)
- [Docs update safety](./docs/update.md)
- [Review, drift, and local heuristics](./docs/review-and-drift.md)
- [Task AI and prompt generation](./docs/task-ai.md)
- [Release checklist](./docs/release-checklist.md)
