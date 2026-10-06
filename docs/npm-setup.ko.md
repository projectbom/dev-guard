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

## 2. 프로젝트 초기 세팅

사용할 프로젝트 루트에서 실행합니다.

```bash
cd your-project
dev-guard init
dev-guard install-agent-instructions
dev-guard install-hooks
dev-guard status
```

각 명령의 역할:

- `init`: `.devguard/` 기본 파일을 만듭니다. 기존 파일은 덮어쓰지 않습니다.
- `install-agent-instructions`: `AGENTS.md`, `CLAUDE.md`에 dev-guard 컨텍스트를 먼저 읽으라는 섹션을 추가합니다.
- `install-hooks`: Claude Code / Codex 완료 전략 파일을 설치합니다.
- `status`: pending 변경, 최근 작업, quality verdict, hook 상태를 확인합니다.

hook을 바로 신뢰할 수 없는 환경이면 수동 모드로 시작합니다.

```bash
dev-guard watch --manual
# 작업이 끝난 뒤
dev-guard done
dev-guard status
```

## 3. GPT 설정

기본 `watch`, `done`, `status`, `handoff` 흐름은 GPT/API 설정 없이 동작합니다.
GPT 설정은 `review`, `task-ai` 같은 AI 보조 명령을 사용할 때만 필요합니다.

OpenAI provider 설정:

```bash
export DEV_GUARD_OPENAI_API_KEY="your_api_key"
# 또는:
export OPENAI_API_KEY="your_api_key"
dev-guard configure ai --provider openai --model gpt-4o-mini
dev-guard doctor
```

모델만 바꿀 때:

```bash
dev-guard config set model gpt-5
dev-guard config show
```

API 키는 `.devguard/config.json`, `.env`, markdown, git 추적 파일에 저장하지 않습니다. 런타임 환경 변수로만 전달합니다.

AI provider를 끄거나 로컬 휴리스틱 중심으로만 쓰려면:

```bash
dev-guard configure ai --provider none --model gpt-4o-mini
```

## 4. AGENTS.md / CLAUDE.md 문구

`dev-guard install-agent-instructions`가 `AGENTS.md`(Codex)와 `CLAUDE.md`(Claude Code)에 표시된 섹션(`<!-- dev-guard-section-start -->` … `<!-- dev-guard-section-end -->`)을 씁니다. 설치된 버전과 문구가 항상 일치하도록 직접 붙여넣기보다 명령을 사용하세요. 이 섹션은 하나의 workflow만 설명합니다.

- **MCP 사용 가능:** 새 작업마다 먼저 `prepare_task_context` 호출 → TARGET 범위 읽기 → 구체적인 공백이 있을 때만 CANDIDATE 열기 → 둘 다 다루지 못한 부분만 좁게 검색. `.devguard` markdown은 함께 읽지 않습니다.
- **MCP 사용 불가:** `.devguard/context/agent-brief.md` → `.devguard/reports/read-map.md` → `.devguard/reports/code-map.md` 순서로 fallback.
- `project-handoff.md` / `quality-report.md`는 명시적 요청(이전 작업 재개, QA 조사)이 있을 때만 읽습니다.
- 서로 다른 작업은 새 agent thread에서 시작하고, 검증은 `record_validation_result`로 기록하며, `dev-guard done` 또는 Stop hook으로 마칩니다.

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

새 Codex/Claude 세션으로 이어갈 때:

```bash
dev-guard handoff
cat .devguard/reports/project-handoff.md
```

새 세션 첫 프롬프트:

```txt
Read .devguard/context/agent-context.md and continue.
```

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

npm 업데이트 뒤 프로젝트마다 한 번 확인합니다.

```bash
dev-guard --help
dev-guard status
dev-guard doctor --agents
dev-guard doctor --hooks --dry-run
dev-guard install-agent-instructions --force
```

hook script 자체가 바뀐 버전이면 필요한 프로젝트에서 다시 설치합니다.

```bash
dev-guard install-hooks
```

기존 설정을 강제로 갱신해야 할 때만 `--force`를 사용합니다.

```bash
dev-guard install-hooks --force
```
