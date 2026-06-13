# dev-guard

[English](./README.md) | [한국어](./README.ko.md)

dev-guard는 AI/Codex/Claude 작업 흐름을 위한 Alpha 단계 CLI guardrail입니다. 파일 변경을 감시하고, 작업이 끝났을 때 변경 내역/품질/다음 프롬프트를 로컬에서 정리합니다.

현재 MVP의 기본 흐름은 아래입니다.

```bash
dev-guard init
dev-guard watch
# Claude/Codex가 파일 수정
dev-guard done
dev-guard status
```

## 문제 정의

AI 에이전트 작업은 끝난 뒤 맥락이 쉽게 끊깁니다. 다음 작업을 위해 긴 대화 로그를 붙여넣거나, 변경 범위 drift와 검증 기준을 놓치기 쉽습니다.

dev-guard는 이 흐름을 로컬에서 정리합니다.

- 작업 중 파일 변경 감시
- 사용자가 `done`을 실행했을 때만 완료 처리
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
pnpm cli watch
# 파일 수정
pnpm cli done
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
dev-guard watch
dev-guard done
dev-guard status
```

## 핵심 명령어

```bash
dev-guard init
dev-guard watch [--depth 8] [--poll] [--stable-after 20]
dev-guard done
dev-guard status
dev-guard reset
```

- `init`: 초기 guard 파일 생성
- `watch`: 변경 파일 감시 및 pending buffer 누적
- `done`: 작업 완료 이벤트 처리, history/report/quality/handoff 생성
- `status`: pending 상태, 최근 작업, quality verdict, 다음 권장 작업 출력
- `reset`: runtime pending buffer만 초기화

## 생성되는 파일 구조

```text
devguard/
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
```

`devguard/` runtime 산출물은 기본적으로 git ignore 대상입니다.

## Handoff Flow

`dev-guard done`은 다음 파일을 생성합니다.

- `devguard/reports/last-run.md`
- `devguard/history.jsonl`
- `devguard/reports/history-summary.md`
- `devguard/reports/decision-candidates.md`
- `devguard/reports/quality-report.md`
- `devguard/prompts/next-codex-prompt.md`

`next-codex-prompt.md`는 다음 Claude/Codex에 바로 전달할 수 있는 인수인계 문서입니다.

자세한 내용은 [docs/handoff.md](./docs/handoff.md)를 참고하세요.

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
- `done`은 `devguard/` runtime 산출물만 씁니다.
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
