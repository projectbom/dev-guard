# dev-guard

[English](./README.md) | [한국어](./README.ko.md)

dev-guard는 AI/Codex/Claude 작업 흐름을 위한 Alpha 단계 CLI guardrail입니다. 파일 변경을 감시하고, 작업이 끝났을 때 변경 내역/품질/다음 프롬프트를 로컬에서 정리합니다.

기본 권장 흐름은 Hook 기반 Auto Mode입니다.

```bash
dev-guard init
dev-guard install-hooks
dev-guard watch
# Claude/Codex가 파일 수정; Stop Hook이 done 실행
dev-guard status
# context window 초과 시 새 스레드에서 이어가기
dev-guard handoff
```

## 문제 정의

AI 에이전트 작업은 끝난 뒤 맥락이 쉽게 끊깁니다. 다음 작업을 위해 긴 대화 로그를 붙여넣거나, 변경 범위 drift와 검증 기준을 놓치기 쉽습니다.

dev-guard는 이 흐름을 로컬에서 정리합니다.

- 작업 중 파일 변경 감시
- 신뢰된 Claude/Codex Stop Hook으로 완료 처리
- Hook을 쓸 수 없을 때는 수동 `done` fallback 유지
- 작업 이력 누적
- 품질 verdict 생성
- 다음 Claude/Codex용 handoff prompt 생성
- 자동 소스 수정/자동 문서 수정 없음

## 빠른 시작

개발 환경:

```bash
pnpm install
pnpm run build
```

이 monorepo 안에서 실행:

```bash
pnpm cli init
pnpm cli install-hooks
pnpm cli watch
# Claude/Codex가 파일 수정; Stop Hook이 done 실행
pnpm cli status
```

전역 링크 후:

```bash
cd packages/cli
pnpm build
pnpm link --global
dev-guard --help
```

다른 프로젝트에서:

```bash
dev-guard init
dev-guard install-hooks
dev-guard watch
# Hook이 없거나 실패하면 dev-guard watch --manual 후 dev-guard done
dev-guard status
```

## 핵심 명령어

```bash
dev-guard init
dev-guard install-hooks [--force]
dev-guard watch [--depth 8] [--poll] [--stable-after 20]
dev-guard watch --manual
dev-guard done
dev-guard handoff
dev-guard status
dev-guard reset
```

- `init`: 초기 guard 파일 생성
- `watch`: 권장 Auto Mode watcher, 변경 파일 감시 및 Stop Hook 기반 done 대기
- `install-hooks`: Claude Code / Codex Stop Hook 설치
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

## Hook 연동

`dev-guard install-hooks`는 repo-local Stop Hook 파일을 생성합니다.

- Claude Code: `.claude/settings.json`의 `hooks.Stop[].hooks[]`
- Codex CLI: `.codex/hooks.json`의 `hooks.Stop[].hooks[]`
- Hook script: `.devguard/hooks/claude-stop.sh`, `.devguard/hooks/codex-stop.sh`
- 보조 JSONL listener: `.devguard/hooks/codex-event-listener.ts`

Codex의 `turn.completed`는 Hook 이벤트가 아니라 `codex exec --json` JSONL 출력 이벤트입니다. JSONL listener는 이 스트림을 감시하는 보조 기능이며 `.codex/hooks.json`에 섞지 않습니다.

## 사용 모드

### Auto Mode 권장

```bash
dev-guard install-hooks
dev-guard watch
```

Auto Mode가 기본 권장 사용법입니다. Claude Code / Codex Stop Hook이 에이전트 작업 종료를 감지하고 `dev-guard done`을 자동 실행합니다. `done`은 `quality-report.md`, `next-codex-prompt.md`, `project-handoff.md`를 생성합니다.

Auto Mode는 idle timeout, polling 기반 완료 추정, 자동 build/test, 자동 git commit을 사용하지 않습니다.

### Manual Mode fallback

```bash
dev-guard watch --manual
dev-guard done
```

Hook을 사용할 수 없거나 신뢰되지 않았거나 실패했을 때 사용합니다. `watch`는 변경만 누적하고, 사용자가 직접 `done`을 실행합니다.

## Context Overflow 복구

Claude/Codex 세션이 context window 초과로 끊기면 긴 history를 붙여넣지 말고 다음 파일을 사용합니다.

```bash
dev-guard handoff
cat .devguard/reports/project-handoff.md
```

새 Claude/Codex 스레드에서는 `.devguard/reports/project-handoff.md`를 읽게 하고, Current State / Quality Status / Next Best Task 기준으로 이어서 작업하게 합니다.

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
