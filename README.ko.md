# dev-guard

[English](./README.md) | [한국어](./README.ko.md)

dev-guard는 AI 코딩 세션을 이어가기 위한 CLI context guard입니다. 프로젝트 맥락, 변경 파일, 품질 체크, 다음 세션용 handoff prompt를 로컬 `.devguard/` 파일로 보존해서 Codex/Claude 작업을 레포지토리 재탐색 없이 이어갈 수 있게 합니다.

기본 권장 흐름은 에이전트별 완료 전략 기반 Auto Mode입니다.

```bash
dev-guard init
dev-guard install-hooks
dev-guard watch
# Claude/Codex가 파일 수정; 검증된 완료 전략이 done 실행
dev-guard status
# context window 초과 시 새 스레드에서 이어가기
dev-guard handoff
```

context window가 끊기거나, 여러 Agent를 오가거나, 긴 AI 코딩 작업을 다음 세션으로 넘겨야 할 때 사용합니다.

## 문제 정의

AI 에이전트 작업은 끝난 뒤 맥락이 쉽게 끊깁니다. 다음 작업을 위해 긴 대화 로그를 붙여넣거나, 변경 범위 drift와 검증 기준을 놓치기 쉽습니다.

dev-guard는 이 흐름을 로컬에서 정리합니다.

- 작업 중 파일 변경 감시
- 검증된 에이전트별 완료 전략으로 완료 처리
- Hook을 쓸 수 없을 때는 수동 `done` fallback 유지
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

CLI 설치:

```bash
npm install -g @dev-guard/cli
dev-guard --help
dev-guard doctor
```

프로젝트에서 시작:

```bash
dev-guard init
dev-guard install-agent-instructions
dev-guard install-hooks
dev-guard watch
# Codex/Claude가 파일 수정
dev-guard done   # Hook을 못 쓰는 경우 수동 fallback
dev-guard status
```

일상 루프:

```bash
dev-guard watch
# AI Agent와 작업
dev-guard done
dev-guard status
```

새 세션으로 이어가기:

```bash
dev-guard handoff
cat .devguard/reports/project-handoff.md
```

이 monorepo를 개발할 때:

```bash
pnpm install
pnpm run build
pnpm cli status
```

npm 설치/업데이트 후 초기세팅, GPT 설정, `AGENTS.md`/`CLAUDE.md` 문구, 이후 CLI 흐름은 [npm 설치/업데이트 사용 가이드](./docs/npm-setup.ko.md)에 한 번에 정리되어 있습니다.

## OpenAI GPT 설정

대부분의 세션 연속성 명령은 API key 없이 동작합니다: `init`, `watch`, `done`, `status`, `handoff`, 로컬 휴리스틱 검사.

OpenAI가 필요한 AI 보조 명령(`review`, `task-ai`)을 사용할 때만 환경 변수로 API key를 설정합니다. DevGuard는 API key를 환경 변수에서만 읽습니다.

```bash
export DEV_GUARD_OPENAI_API_KEY="your_api_key_here"
# 또는:
export OPENAI_API_KEY="your_api_key_here"
```

AI 보조 명령을 쓸 때 provider/model을 설정합니다.

```bash
dev-guard configure ai --provider openai --model gpt-4o-mini
dev-guard doctor
```

API key는 git에 넣지 않습니다. `.env`, secret이 들어간 `.devguard/config.json`, 로컬 secret 파일을 커밋하지 마세요.

## 핵심 명령어

```bash
dev-guard init
dev-guard install-hooks [--force]
dev-guard install-hooks --agent claude
dev-guard install-hooks --agent codex
dev-guard install-hooks --agent codex-notify
dev-guard install-hooks --agent codex-notify --install-dispatcher
dev-guard install-hooks --agent all
dev-guard watch [--depth 8] [--poll] [--stable-after 20]
dev-guard watch --no-dashboard
dev-guard watch --manual
dev-guard dashboard [--port 3737]
dev-guard done
dev-guard handoff
dev-guard status
dev-guard reset
```

- `init`: 초기 guard 파일 생성
- `watch`: 권장 watcher, 로컬 대시보드 시작, 변경 파일 감시 및 검증된 완료 전략 기반 done 대기
- `install-hooks`: Claude Code / Codex 완료 전략 스크립트와 설정 설치
- `done`: 작업 완료 이벤트 처리, history/report/quality/handoff 생성
- `handoff`: 현재 `.devguard/` 산출물만 읽어서 `project-handoff.md` 재생성
- `status`: pending 상태, 최근 작업, quality verdict, 다음 권장 작업 출력
- `reset`: runtime pending buffer만 초기화

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
  prompts/
    next-codex-prompt.md
  reports/
    last-run.md
    history-summary.md
    decision-candidates.md
    quality-report.md
    project-handoff.md
```

`.devguard/` runtime 산출물은 기본적으로 git ignore 대상입니다.

## Handoff Flow

`dev-guard done`은 다음 파일을 생성합니다.

- `.devguard/reports/last-run.md`
- `.devguard/history.jsonl`
- `.devguard/reports/history-summary.md`
- `.devguard/reports/decision-candidates.md`
- `.devguard/reports/quality-report.md`
- `.devguard/prompts/next-codex-prompt.md`
- `.devguard/reports/project-handoff.md`

`next-codex-prompt.md`는 다음 Claude/Codex에 바로 전달할 수 있는 인수인계 문서입니다.
`project-handoff.md`는 context window 초과 후 새 Claude/Codex 스레드에서 바로 이어가기 위한 압축 인수인계 문서입니다.

자세한 내용은 [docs/handoff.md](./docs/handoff.md)를 참고하세요.

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

Codex는 project trust와 hook definition trust가 별도일 수 있습니다. Codex Stop Hook을 쓴다면 Codex TUI에서 `/hooks`를 열어 dev-guard Stop Hook을 review/trust해야 합니다. Claude Code Hook은 Claude Code가 설치되어 있고 해당 프로젝트에서 `.claude/settings.json`을 읽는 환경에서만 동작합니다. 실제 실행 여부는 `.devguard/logs/claude-hook.log`, `.devguard/logs/codex-hook.log`, `.devguard/logs/codex-notify.log`, `dev-guard status`로 확인합니다.

Codex의 `turn.completed`는 Hook 이벤트가 아니라 `codex exec --json` JSONL 출력 이벤트입니다. JSONL listener는 이 스트림을 감시하는 보조 기능이며 `.codex/hooks.json`에 섞지 않습니다.

## 사용 모드

### Auto Mode 권장

```bash
dev-guard install-hooks
dev-guard watch
```

Auto Mode는 전략이 설치되고 runtime에서 검증된 뒤에만 성공으로 봅니다. Claude Code는 Stop Hook을 사용합니다. Codex는 user-level notify를 우선 검토하고, Stop Hook은 `/hooks` trust가 필요한 고급 옵션입니다. 완료 전략이 실행되면 `dev-guard done`이 `quality-report.md`, `next-codex-prompt.md`, `project-handoff.md`를 생성합니다.

`watch`는 직접 `done`을 실행하지 않습니다. agent hook/notify 또는 사용자의 수동 `done`이 다른 프로세스에서 실행되면 `.devguard/runtime.json`, `.devguard/state.json`, `.devguard/history.jsonl`을 다시 읽어 processed/idle 상태로 화면을 갱신합니다.

Auto Mode는 idle timeout, polling 기반 완료 추정, 자동 build/test, 자동 git commit을 사용하지 않습니다.

`watch` 화면이 `ready_for_done`에 오래 머무르면 `dev-guard status`로 pending이 이미 비워졌는지 확인할 수 있습니다.

### Manual Mode fallback

```bash
dev-guard watch --manual
dev-guard done
```

Hook을 사용할 수 없거나 신뢰되지 않았거나 실패했을 때 사용합니다. `watch`는 변경만 누적하고, 사용자가 직접 `done`을 실행합니다.

## 로컬 대시보드

로컬 대시보드는 `dev-guard watch`를 실행하면 자동으로 시작됩니다. 대시보드는 `127.0.0.1`에만 바인딩되고 기본 주소는 `http://127.0.0.1:3737`입니다. `/api/state`를 1초마다 polling해서 DevGuard가 지금 무엇을 하는지, 왜 기다리는지, 다음에 무엇이 일어나는지, 최근 변경 파일, 다음 세션/프로젝트 상태/프로젝트 컨텍스트 정보가 준비됐는지 보여줍니다.

UI는 브라우저 언어를 자동으로 따르며 English/한국어 토글을 제공합니다.

임의 파일 브라우징, 환경 변수 노출, shell 실행 기능은 없습니다. DevGuard가 초기화되지 않았으면 `dev-guard init`을 안내하고, `watch`가 실행 중이 아니면 `dev-guard watch`를 안내합니다.

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

Claude/Codex 세션이 context window 초과로 끊기면 긴 history를 붙여넣지 말고 다음 파일을 사용합니다.

```bash
dev-guard handoff
cat .devguard/reports/project-handoff.md
```

새 Claude/Codex 스레드에서는 `.devguard/reports/project-handoff.md`를 읽게 하고, Current State / Quality Status / Next Best Task 기준으로 이어서 작업하게 합니다.

## Multi-Agent Workflow

`dev-guard done` (또는 Auto Mode)은 이제 `.devguard/context/agent-context.md`를 생성합니다. 새 Agent 세션이 가장 먼저 읽는 단일 진입 문서입니다. 레포지토리 전체를 스캔하는 대신 이 파일을 읽으면 됩니다.

### 권장 세션 인수인계 순서

1. `dev-guard watch` — watcher 시작
2. Claude/Codex가 파일 수정; Stop Hook이 `done` 자동 실행
3. `dev-guard done` — agent-context.md를 포함한 모든 산출물 생성
4. 새 Agent 세션 시작
5. `.devguard/context/agent-context.md` 읽기 — 이어서 작업

### Codex ↔ Claude 전환 시 (또는 다른 Agent로 전환)

새 세션 시작 프롬프트:

```txt
Read .devguard/context/agent-context.md and continue.
```

이 파일에는 현재 상태, 최근 완료 작업, 품질 상태, 다음 작업, 주요 결정, 관련 파일, 수정 금지 영역이 포함됩니다.

더 상세한 인수인계가 필요하면 `.devguard/reports/project-handoff.md`도 읽습니다.

### 생성되는 Agent context 파일

`dev-guard done`과 `dev-guard handoff`는 다음 파일을 생성합니다.

- `.devguard/context/agent-context.md` — 새 세션용 단일 진입 컨텍스트 문서
- `.devguard/prompts/next-claude-prompt.md` — Claude 세션용 시작 프롬프트
- `.devguard/prompts/next-codex-prompt.md` — Codex 세션용 인수인계 프롬프트 (최상단에 컨텍스트 로딩 안내 추가)

### AGENTS.md / CLAUDE.md

`dev-guard install-agent-instructions`는 `AGENTS.md`와 `CLAUDE.md`에 dev-guard 섹션을 생성하거나 추가합니다. Agent가 레포지토리를 탐색하기 전에 dev-guard 컨텍스트를 먼저 읽도록 **유도**하는 용도입니다.

```bash
dev-guard install-agent-instructions
# 기존 섹션 갱신이 필요한 경우:
dev-guard install-agent-instructions --force
```

다음 Agent를 지원합니다:

- Claude Code (`CLAUDE.md`를 시작 시 읽음)
- Codex (`AGENTS.md`를 참고)
- 프로젝트 레벨 instruction 파일을 인식하는 기타 Agent

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
- API provider는 선택 사항입니다.

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
