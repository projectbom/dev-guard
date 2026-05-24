# dev-guard

[English](./README.md) | [한국어](./README.ko.md)

dev-guard는 AI/Codex 작업 흐름을 위한 Alpha 단계 CLI guardrail입니다. 자연어 요구사항을 compact Codex 프롬프트로 만들고, 작업 후 git 변경이 요청 범위 안에 있는지 로컬 휴리스틱과 선택적 AI review로 확인합니다.

기본 흐름은 짧습니다.

```bash
dev-guard init
dev-guard status
dev-guard "로딩 깜빡임 수정"
dev-guard done
```

한국어와 영어 자연어 요구사항을 모두 입력할 수 있습니다. Codex 프롬프트도 한국어/영어 작업에 모두 사용할 수 있습니다. 공개 문서는 영어 중심으로 관리하지만, 한국어 사용자를 위해 이 가이드를 제공합니다.

## dev-guard가 하는 일

- `.devguard/` 아래에 프로젝트별 guard 파일을 만든다.
- 프로젝트 타입, package manager, runtime, git baseline, 변경 파일을 감지한다.
- import/reverse dependency 기반의 lightweight impact hint를 포함해 프로젝트 메모리를 만든다.
- 현재 요구사항을 Codex에 전달하기 좋은 compact prompt로 만든다.
- API key 없이도 local heuristic check/review를 실행한다.
- 필요하면 OpenAI provider를 연결해 task/review 품질을 높인다.
- 문서 업데이트는 안전하게 처리한다. `update`는 preview이고, `update --write`에서만 managed block을 수정한다.

## 설치

개발 환경:

```bash
pnpm install
pnpm run build
```

로컬 전역 링크:

```bash
cd packages/cli
pnpm build
pnpm link --global
dev-guard --help
```

## 빠른 시작

기본 흐름은 30초 안에 이해할 수 있어야 합니다.

```bash
dev-guard init
dev-guard status
dev-guard "로딩 깜빡임 수정"
# 출력된 prompt를 Codex에 전달하고 Codex가 파일을 수정하게 한다
dev-guard done
```

링크 전 monorepo 안에서는 `dev-guard` 대신 `pnpm cli`를 사용합니다.

```bash
pnpm cli init
pnpm cli status
pnpm cli "로딩 깜빡임 수정"
pnpm cli done
```

## 추천 사용 흐름

1. 처음 프로젝트에서 초기화
   - command:
     ```bash
     dev-guard init
     ```
   - purpose:
     `.devguard`와 기본 docs guard 파일을 준비한다. 기존 파일은 덮어쓰지 않는다.

2. 작업 시작 전 상태 확인
   - command:
     ```bash
     dev-guard status
     ```
   - purpose:
     provider/model, API key 상태, git baseline, project detection, pending changes, 다음 추천 명령을 확인한다.

3. 새 작업 프롬프트 생성
   - command:
     ```bash
     dev-guard "수정하고 싶은 내용"
     ```
   - purpose:
     요구사항을 분석해서 `.devguard/task.md`를 저장하고 Codex용 compact prompt를 출력한다.

4. 생성된 prompt를 Codex에 전달
   - purpose:
     Codex가 실제 코드를 수정한다. 출력된 `TASK`, `TYPE`, `FILES`, `PROTECT`, `SUCCESS`, `VERIFY`를 기준으로 작업한다.

5. Codex 작업 후 검증
   - command:
     ```bash
     dev-guard done
     ```
   - purpose:
     refresh, local check, heuristic review, compact report, docs update preview를 실행한다. docs는 수정하지 않는다.

6. 문서 업데이트가 필요하면 preview
   - command:
     ```bash
     dev-guard update
     ```
   - purpose:
     프로젝트 상태/현재 작업/결정/반복 방지 문서 후보를 미리 확인한다.

7. 문서 반영
   - command:
     ```bash
     dev-guard update --write
     ```
   - purpose:
     dev-guard managed block만 안전하게 갱신한다. 사용자 작성 영역은 보존한다.

8. 반복 작업
   - command:
     ```bash
     dev-guard "다음 작업 내용"
     ```
   - purpose:
     다음 Codex 작업 prompt를 생성한다.

## 자주 쓰는 명령어

```bash
dev-guard init
dev-guard status
dev-guard "수정할 내용"
dev-guard done
dev-guard update
dev-guard update --write
dev-guard watch
dev-guard help advanced
```

`watch`는 선택 사항입니다. 파일 변경 중 project memory를 최신화하지만, 기본값으로 코드 수정이나 docs write를 자동 실행하지 않습니다.

## 예시

- [Bugfix workflow](./examples/bugfix.md)
- [i18n workflow](./examples/i18n.md)
- [Architecture workflow](./examples/architecture.md)

## AI Provider 설정

API key가 없어도 local heuristic 기능은 동작합니다. AI 기반 task/review가 필요할 때만 provider를 설정합니다.

```bash
dev-guard configure ai --provider openai --model gpt-4o-mini
export OPENAI_API_KEY="your_api_key"
```

API key는 프로젝트 파일에 저장하지 말고 환경변수로 관리하는 것을 권장합니다.

설정은 나중에 바꿀 수 있습니다.

```bash
dev-guard config set provider openai
dev-guard config set model gpt-5
dev-guard config set temperature 0.2
dev-guard config show
```

## 안전 정책

- 기본 동작은 local + preview 중심이다.
- `dev-guard done`은 docs를 수정하지 않는다.
- `dev-guard update`는 파일을 수정하지 않는다.
- `dev-guard update --write`만 managed block을 갱신한다.
- `.devguard` cache/run 파일은 일반 변경 요약에서 제외된다.
- `.devguard/` runtime 파일은 기본적으로 local-only다. 예시는 [configuration docs](./docs/configuration.md)에 둔다.
- provider/API key는 필수가 아니다.
- watch는 memory refresh만 자동 수행하고 source edit은 하지 않는다.

## Alpha 상태

현재 공개 목표는 GitHub Alpha입니다.

```text
https://github.com/projectbom/dev-guard
```

패키징 확인은 유지합니다.

```bash
npm pack --dry-run --cache /private/tmp/dev-guard-npm-cache
```

`npm publish`는 npm 계정과 package ownership 준비 후 진행합니다. GitHub Alpha 공개의 필수 단계는 아닙니다.

Alpha 제한사항:

- TypeScript/Node 프로젝트에 최적화되어 있다.
- 휴리스틱 중심이며 full AST semantic engine이 아니다.
- drift detection은 확률적 신호이므로 review를 보조하는 용도로 봐야 한다.
- AI review 품질은 provider 설정에 좌우된다.
- local heuristic review는 의미 있는 guardrail이지만 완전한 semantic code review는 아니다.
- initial commit 전에는 untracked file warning이 많을 수 있다.
- watch는 보수적으로 동작한다.

## 상세 문서

- [명령어 reference](./docs/commands.md)
- [Configuration and tracking policy](./docs/configuration.md)
- [Release checklist](./docs/release-checklist.md)
- [Architecture notes](./docs/architecture.md)
- [Task AI와 prompt 생성](./docs/task-ai.md)
- [Review, drift, local heuristics](./docs/review-and-drift.md)
- [Watch mode](./docs/watch.md)
- [Docs update safety](./docs/update.md)
