# dev-guard

TypeScript monorepo MVP for checking whether Codex/AI work stayed inside the requested scope.

`dev-guard` reads the current git changes, task notes, and project rules, then prints rule-based warnings for:

- changed files
- possibly unrelated file edits
- possible requirement scope expansion
- docs that may need updates

Git change detection includes working tree diff, staged diff, and untracked files. This means `check` and `update` can still produce useful output before the first commit, when new files are not tracked yet.

AI integration is optional. Rule-based commands work without an API key, while `task-ai` and `review` use the configured provider when `OPENAI_API_KEY` is available.

## Workspace

```text
packages/
  core/  Rule-based diff analysis and templates
  cli/   Node.js command-line interface
```

## Install

```bash
pnpm install
```

## Build

```bash
pnpm run build
```

## Alpha Release

Current release target: GitHub Alpha at `https://github.com/projectbom/dev-guard`.

Before publishing release artifacts, inspect the npm package contents:

```bash
npm pack --dry-run --cache /private/tmp/dev-guard-npm-cache
```

`npm publish` is intentionally deferred until the npm account and package ownership are ready. The dry-run check is kept as a packaging sanity check, not as a required publish step for GitHub Alpha.

## Local Global Link

Use the CLI package as the globally linked executable:

```bash
cd packages/cli
pnpm build
pnpm link --global
dev-guard --help
```

## Quick Start

Default workflow:

```bash
pnpm cli init
pnpm cli "Describe the next change"
# run Codex / edit files
pnpm cli done
pnpm cli status
```

After the package is linked or installed:

```bash
dev-guard init
dev-guard "Fix the login redirect bug"
dev-guard done
dev-guard status
dev-guard watch
```

`dev-guard "<requirement>"` refreshes project memory, writes `.devguard/task.md`, and prints a compact Codex prompt. If no AI provider is configured, it falls back to a local heuristic task skeleton.

`dev-guard done` runs refresh, local check, heuristic review, compact report, and docs-update preview. It does not modify docs; use `dev-guard update --write` only when you want to write managed docs blocks.

Advanced commands remain available:

```bash
pnpm cli update          # preview docs update candidates
pnpm cli update --write  # append generated docs update section
pnpm cli refresh         # incrementally refresh project memory
pnpm cli watch --check   # keep memory fresh and run local checks
pnpm cli doctor          # provider/git/memory diagnostics
pnpm cli telemetry       # privacy-safe drift summary
pnpm cli prompt --copy   # compact Codex prompt by default
pnpm cli prompt --ultra-compact --copy
pnpm cli prompt --density ultra --max-prompt-tokens 1200
pnpm cli help advanced
```

## Dogfooding

Use dev-guard on this repository with a short prompt-first workflow:

```bash
pnpm cli self "prompt density 안전성 보강"
pnpm cli self-check
pnpm cli self "prompt density 안전성 보강" --check
```

`self` refreshes project memory, writes `.devguard/task.md`, and prints an ultra-compact Codex prompt. If no AI provider is configured, it falls back to a local heuristic task skeleton.

After the package is linked or installed, replace `pnpm cli` with `dev-guard`:

```bash
dev-guard init
dev-guard "Add a prompt quality improvement"
dev-guard done
dev-guard status
dev-guard help advanced
```

## `dev-guard init`

Creates these files if they do not already exist:

```text
.devguard/config.json
.devguard/task.md
.devguard/rules.md
.devguard/mistakes.md
docs/PROJECT_STATE.md
docs/CURRENT_TASK.md
docs/DECISIONS.md
docs/DO_NOT_REPEAT.md
```

Existing files are preserved.

## AI Provider Setup

`dev-guard` is rule-based by default. AI features are opt-in and currently support:

- `none`, the default
- `openai`

Configure the provider in `.devguard/config.json`:

```bash
dev-guard configure ai --provider openai --model gpt-4o-mini
```

or from the monorepo:

```bash
pnpm cli configure ai --provider openai --model gpt-4o-mini
```

You can also change runtime settings without recreating the project:

```bash
dev-guard config set provider openai
dev-guard config set model gpt-5
dev-guard config set temperature 0.2
dev-guard config set maxTokens 4000
dev-guard config show
```

Config resolution is:

```text
CLI args
→ local config
→ env
→ defaults
```

Local config is read from `.devguard/config.json`, `.devguardrc`, `devguard.config.json`, or `package.json#devGuard`. Environment fallback keys are `DEV_GUARD_PROVIDER`, `DEV_GUARD_MODEL`, `DEV_GUARD_TEMPERATURE`, `DEV_GUARD_MAX_TOKENS`, `DEV_GUARD_REASONING_EFFORT`, and `DEV_GUARD_BASE_URL`.

This writes only provider metadata:

```json
{
  "ai": {
    "provider": "openai",
    "model": "gpt-4o-mini"
  }
}
```

API keys are never stored in config or markdown files. Set the key through the environment:

```bash
export OPENAI_API_KEY="your_api_key"
```

For one command:

```bash
OPENAI_API_KEY="your_api_key" dev-guard task-ai "Tighten the check output for staged files"
```

## `dev-guard scan`

Scans the project once and writes commit-friendly project memory under `.devguard`:

```text
.devguard/project-index.json
.devguard/file-summaries.json
.devguard/project-map.md
.devguard/project-identity.json
```

`project-index.json` contains per-file metadata:

- `path`
- `extension`
- `category`
- `keywords`
- `size`
- `lastModified`
- `hash`

`file-summaries.json` contains rule-based summaries:

- short role description
- major keywords
- related features
- related file candidates

`project-map.md` is a human-readable grouped project map, such as auth, dashboard, settings/admin, supabase, styles, config, and UI areas.

`project-identity.json` records the current project boundary:

- absolute project root
- git remote origin
- `package.json` name
- framework keywords
- project fingerprint

`task-ai`, `review`, and scan cache loading use this identity to avoid reusing project memory or run logs from another checkout.

Run:

```bash
dev-guard scan
```

Force a full rescan:

```bash
dev-guard scan --full
```

Reserve AI summary mode:

```bash
dev-guard scan --ai
```

The current implementation writes rule-based summaries by default. The `--ai` flag is accepted as an extension point and does not store API keys.

Scan excludes generated and heavy paths such as `node_modules`, `.next`, `dist`, `build`, and `coverage`, plus lockfiles and binary/image/font assets. Large files are summarized by metadata and keywords, not by storing full content.

### Project Isolation

dev-guard treats `.devguard` as project-local memory. Context files, scan cache, and run logs are read only from the current project root.

To prevent cross-project contamination:

- scan writes `.devguard/project-identity.json`
- task generation ignores scan cache when the stored fingerprint does not match the current project
- review ignores run logs whose `projectIdentity` does not match the current project
- task-ai filters `.devguard/rules.md` and `.devguard/mistakes.md` by current request relevance before sending them to AI
- suppressed rules are visible with `dev-guard task-ai "..." --debug-context`

This keeps project-specific rules, such as a dashboard layout policy in one project, out of unrelated work in another project.

## `dev-guard refresh`

Updates existing project memory incrementally after code changes.

It reads:

- `git diff`
- `git diff --cached`
- untracked files
- deleted files
- renamed files
- existing `.devguard/project-index.json`
- existing `.devguard/file-summaries.json`

Then it updates:

```text
.devguard/project-index.json
.devguard/file-summaries.json
.devguard/project-map.md
.devguard/project-identity.json
```

Changed files are reanalyzed for:

- keywords
- category
- file summary
- related file candidates
- `lastModified`
- `hash`

Deleted files are removed from project memory and from the regenerated project map. The project map is regenerated from the updated index as a safe fallback.

Preview the refresh without writing:

```bash
dev-guard refresh --dry-run
```

Force a full memory rebuild:

```bash
dev-guard refresh --full
```

Reserve AI summary mode:

```bash
dev-guard refresh --ai
```

Logs include:

- updated summaries
- removed summaries
- unchanged files skipped

If `task-ai` sees git changes while using scan cache, it prints a stale-cache warning and suggests `dev-guard refresh`.

## `dev-guard watch`

Runs a lightweight watch mode that keeps project memory current while you edit files.

```bash
dev-guard watch
```

It watches source-oriented directories:

```text
app, components, lib, hooks, utils, constants, styles, supabase, src, packages
```

It also watches root/context files when they exist:

```text
AGENTS.md, CLAUDE.md, README.md, package.json, pnpm-workspace.yaml,
tsconfig.json, tsconfig.base.json,
.devguard/task.md, .devguard/rules.md, .devguard/mistakes.md,
.devguard/config.json, .devguardrc, devguard.config.json,
docs/PROJECT_STATE.md, docs/CURRENT_TASK.md, docs/DECISIONS.md, docs/DO_NOT_REPEAT.md
```

It ignores generated output and internal cache paths, including:

```text
node_modules, .next, dist, build, coverage, .git,
.devguard/runs,
.devguard/project-index.json,
.devguard/file-summaries.json,
.devguard/project-map.md,
.devguard/project-identity.json,
lockfiles, binary/image/font files
```

When a watched file changes, `watch` waits for a debounce window, runs the same incremental memory update as `dev-guard refresh`, and prints a compact summary:

```text
dev-guard watch started
watching directories: app, components, lib, ...
excluded: node_modules, .git, .next, dist, build, coverage, lockfiles, binary assets, .devguard cache files
action: auto-refresh project memory only; user docs/source files are not overwritten
stop: press Ctrl+C
changed: src/features/example-view.tsx
running: dev-guard refresh
refresh complete: updated 1, removed 0, skipped 124
writes: .devguard project memory cache only
next: run dev-guard check before commit
```

Run refresh once without staying in watch mode:

```bash
dev-guard watch --once
```

Run rule-based checks after each refresh:

```bash
dev-guard watch --check
```

Adjust the debounce interval:

```bash
dev-guard watch --debounce 1500
```

Optionally run AI review after each refresh:

```bash
dev-guard watch --review
```

`--review` is disabled by default because it can call the configured AI provider and may incur API cost. If `OPENAI_API_KEY` or provider configuration is missing, watch prints a warning and continues watching.

For drift guardrails in watch mode, run:

```bash
dev-guard watch --check
```

This runs the local check after refresh and can print `Potential semantic drift detected`. Watch never auto-fixes drift; it only reports warnings.

When config files change during watch mode, dev-guard reloads provider settings without restarting:

```text
config changed -> reloading provider settings
provider: openai
model: gpt-5
```

Invalid config is ignored and the previous settings are kept. Watch also uses debounce, merges burst events, and avoids concurrent refresh runs.

Alpha limitations:

- `watch` is intentionally conservative and only auto-refreshes `.devguard` project-memory cache by default.
- It does not auto-apply source edits, docs updates, or AI review unless explicitly requested.
- In package-manager wrapper commands such as `pnpm cli watch`, pressing `Ctrl+C` may still cause the wrapper to print a lifecycle interruption line after dev-guard has stopped.

Recommended workflow:

```bash
dev-guard scan
dev-guard watch --check
# edit code in another terminal
dev-guard report --compact
dev-guard review
dev-guard update
```

## `dev-guard report`

Prints a short current-work summary for ChatGPT/Codex handoff. Use it instead of pasting full `task-ai --debug-context`, `review`, `update`, or run-log output.

```bash
dev-guard report
```

The report summarizes:

- current task
- saved user request
- changed files
- rule-based check summary
- latest review status
- run id
- suggested next action

Compact mode is designed to stay small enough to paste into another AI chat:

```bash
dev-guard report --compact
```

Example:

```text
Task: 결과 페이지 문구 자연스럽게 수정
Request: 결과 페이지 AI 같은 단어 정리
Changed: components/result/view.tsx
Check: pass
Review: warning - 문구 2개 추가 압축 권장
Run: run_20260520T103000Z
Next: fix wording or commit
```

Copy the report when the OS clipboard is available:

```bash
dev-guard report --compact --copy
```

Machine-readable output:

```bash
dev-guard report --json
```

Summarize changes since a ref:

```bash
dev-guard report --since HEAD~1
```

`report` excludes internal/generated files from changed-file summaries by default, including `.devguard/**`, `.next/**`, `node_modules/**`, `dist/**`, `build/**`, and cache files.

## `dev-guard review`

Runs an AI-based review after Codex or another AI agent changes code. It compares the current diff against:

- `.devguard/task.md`
- `.devguard/rules.md`
- `.devguard/mistakes.md`
- `docs/PROJECT_STATE.md`
- `docs/DECISIONS.md`
- scan cache summaries from `.devguard/file-summaries.json`
- latest run context from `.devguard/runs/latest.json` when available

`review` does not edit code and does not update docs. It is intentionally separate from:

- `check`: fast rule-based scope and docs checks
- `review`: AI-based deeper review of requirement fit, scope drift, rule violations, and repeat mistakes
- `update`: project documentation update candidates

Basic flow after Codex work:

```bash
dev-guard check
dev-guard review
dev-guard update
```

Run a provider-free static review:

```bash
dev-guard review --heuristic
```

If `provider` is `none`, plain `dev-guard review` falls back to this local heuristic mode. It checks for broad diffs, untracked files, duplicate markdown headings, managed-marker corruption, obvious i18n omissions, and generated diff drift. It is not a semantic AI review.

The AI result includes:

- status: `pass`, `info`, `warning`, `needs_changes`, `risky`, `critical`, or `unknown`
- 결론
- 요구사항 충족 여부
- 범위 초과 수정
- 규칙 위반 가능성
- 반복 실수 가능성
- 확인이 필요한 파일
- Codex 재수정 프롬프트
- 커밋 가능 여부

By default, `review` excludes dev-guard context files from the reviewed diff:

- `.devguard/**`
- `docs/PROJECT_STATE.md`
- `docs/CURRENT_TASK.md`
- `docs/DECISIONS.md`
- `docs/DO_NOT_REPEAT.md`

It also always keeps generated/internal paths out of related-file analysis:

- `.next/**`
- `.devguard/runs/**`
- `.devguard/project-index.json`
- `.devguard/file-summaries.json`
- `.devguard/project-map.md`
- `.git/**`
- `node_modules/**`
- `dist/**`
- `build/**`
- lockfiles
- turbopack/cache files

Include those files when the task is specifically about dev-guard context:

```bash
dev-guard review --include-context-files
```

Save a review result:

```bash
dev-guard review --output review.md
```

Copy only the `Codex 재수정 프롬프트` section:

```bash
dev-guard review --copy-fix
```

Print a full Codex-ready fix prompt after the review:

```bash
dev-guard review --fix-prompt
```

Review and copy the generated fix prompt:

```bash
dev-guard review --fix-prompt --copy
```

Review against a specific saved run:

```bash
dev-guard review --run <id>
```

Force the latest saved run:

```bash
dev-guard review --run latest
```

Ignore run logs and use only current `.devguard/task.md` plus the diff:

```bash
dev-guard review --no-run
```

Without `--run`, `review` scores saved runs against the current diff using `relatedFiles`, `changedFilesAtCreation`, and paths found in the saved task/prompt. If the latest run does not match the current diff, dev-guard prints `latest run does not match current diff` and falls back to the best matching run or current `task.md`. Review output also includes the selected basis, such as `using run`, `using task.md`, and `run match score`.

Review only staged changes:

```bash
dev-guard review --staged
```

Review a commit/ref diff against `HEAD`:

```bash
dev-guard review --commit HEAD~1
```

Untracked files have no git diff body, so `review` reads text/code excerpts from relevant untracked files and sends them as review context. It includes the file head plus task-keyword-near lines when possible. Large files are truncated, and binary/image/font files are skipped.

Review status guidance:

- `pass`: provided diff/excerpts satisfy the task and no concrete violation is visible
- `info`: review found only informational notes
- `warning`: minor wording, small copy length, or preference-level issues; work can often continue without blocking
- `unknown`: there is not enough evidence for a firm pass, but no concrete violation is visible
- `risky`: the change has a clear risk that needs human attention
- `critical`: likely breakage of protected logic, data, auth, or core behavior
- `needs_changes`: use only when there is a concrete requirement miss, scope drift, rule violation, or likely build/runtime issue

Small wording issues should be `warning`, not `needs_changes`. For `needs_changes`, `risky`, or `critical`, the `Codex 재수정 프롬프트` should name the problem files, what differs from the requirement, exact correction items, and protected files or logic. Vague prompts such as "검토하세요" are not acceptable.

## `dev-guard fix-prompt`

Generates only the Codex-ready fix prompt from the current review context. It reuses the same AI review logic as `dev-guard review`, then rewrites the result into concise action items for Codex instead of pasting the raw review text.

```bash
dev-guard fix-prompt
```

Copy it to the clipboard:

```bash
dev-guard fix-prompt --copy
```

Write it to a file:

```bash
dev-guard fix-prompt --output fix-prompt.md
```

Use a specific saved run:

```bash
dev-guard fix-prompt --run <id>
```

The generated prompt includes:

- 문제 요약
- 원래 요구사항
- 현재 review 결과
- 수정 지시
- 되돌리지 말아야 할 것
- 되돌려야 할 가능성이 있는 것
- 확인 파일
- 완료 조건
- 검증 명령어

Safety rules are included in the prompt: do not blindly revert changes, revert only changes directly unrelated to the original requirement, preserve relevant UI work when restoring existing behavior, and mark uncertain items as `확인 후 판단`.

If the review status is `pass`, `fix-prompt` prints `재수정 프롬프트 불필요` instead of inventing follow-up work.

The fix-prompt formatter removes duplicate/generic lines and filters awkward wording such as `RIP처럼`, `간결하게 피기`, `위반이 발견되었습니다`, and vague "검토하세요" style instructions. The output is intended to be short, direct, and safe to paste back into Codex.

## Run Logs

dev-guard can record the exact prompt/context handed to Codex under `.devguard/runs/`.

Each saved run writes:

```text
.devguard/runs/run_<timestamp>.json
.devguard/runs/latest.json
```

Run file names are short ASCII-only identifiers such as `run_20260520T103000Z.json`. Long Korean requests are not used in file names; they are stored inside JSON as `title` and `userRequest`.

Run logs include `id`, `createdAt`, `command`, `title`, `userRequest`, `generatedTaskMarkdown`, `generatedCodexPrompt`, `relatedFiles`, `provider`, `model`, `gitHead`, `gitBranch`, `changedFilesAtCreation`, `projectIdentity`, and `status`.

API keys are never stored. If run-log writing fails, dev-guard prints a warning and continues the original command.

`task-ai` saves a run automatically for the normal handoff flow:

```bash
dev-guard task-ai "..." --write --prompt --copy
```

Preview-only task generation can still save a run explicitly:

```bash
dev-guard task-ai "..." --save-run
```

Prompt generation saves or updates run context when you copy or write a prompt, and can force a new run with:

```bash
dev-guard prompt --save-run
```

`review` no longer trusts `.devguard/runs/latest.json` blindly. It first requires the run `projectIdentity` to match the current project fingerprint, then compares the current diff with saved run file hints and uses the best matching run only when there is a concrete match.

`review` uses a matching run when present and logs:

```text
dev-guard review: using run <id>
dev-guard review: run match score <score>
```

If the latest run belongs to another project or lacks project identity, review ignores it and falls back to current `.devguard/task.md`.

Use a specific run with:

```bash
dev-guard review --run <id>
dev-guard fix-prompt --run <id>
```

`fix-prompt` stores the review result and generated fix prompt back into the linked run when one is available.

## `dev-guard check`

Reads:

- `git diff --name-only`
- `git diff`
- `git diff --cached --name-only`
- `git diff --cached`
- `git ls-files --others --exclude-standard`
- `.devguard/task.md`
- `.devguard/rules.md`
- `.devguard/config.json`

Then prints:

- changed file list grouped by working tree, staged, and untracked
- unrelated-file risk warnings
- scope-expansion risk warnings
- docs-update-needed status

The current MVP uses simple path and diff-size rules. It is designed to be conservative and explain where a human should review the diff. Low-signal generated paths such as `node_modules`, `dist`, `.next`, `coverage`, and common lockfiles are kept out of high-priority risk analysis by default, while relevant files can still appear in the changed-file list.

By default, `check` also excludes dev-guard context files from general code-scope analysis:

- `.devguard/**`
- `docs/PROJECT_STATE.md`
- `docs/CURRENT_TASK.md`
- `docs/DECISIONS.md`
- `docs/DO_NOT_REPEAT.md`

Internal generated files are excluded even when context files are included:

- `.devguard/runs/**`
- `.devguard/*.json`
- `.next/**`
- turbopack/cache files

Use this when you specifically want to inspect context-file changes too:

```bash
dev-guard check --include-context-files
```

`check` is local and rule-based by default. `--local` is accepted as an explicit reminder that no provider/API call is used:

```bash
dev-guard check --local
```

Before the first commit, dev-guard prints a git baseline warning because all project files may appear as untracked. Create a baseline when you want quieter scope checks:

```bash
git add .
git commit -m "initial commit"
```

`check` parses `## 수정 범위` path hints from `.devguard/task.md`, including candidate suffixes such as `app/admin/feedback/page.tsx (후보)` or backtick-wrapped paths, so scoped candidate files are not reported as unrelated changes.

Task scope also supports simple glob hints in `## 수정 범위` and `## 수정 대상`:

- `path/**`: every file under that directory
- `path/*`: direct child files in that directory

Examples:

- `app/about/service/**` matches `app/about/service/service-showcase.tsx`
- `components/about/*` matches `components/about/hero.tsx`
- `components/about/**` matches nested files too

Suffixes such as `(생성/수정 대상)`, `(삭제 대상)`, and `(후보)` are stripped before matching.

## `dev-guard update`

Reads:

- `git diff --name-only`
- `git diff`
- `git diff --cached --name-only`
- `git diff --cached`
- `git ls-files --others --exclude-standard`
- `.devguard/task.md`
- `.devguard/rules.md`
- `.devguard/mistakes.md`

Then generates preview-only update candidates for:

- `docs/PROJECT_STATE.md`
- `docs/CURRENT_TASK.md`
- `docs/DECISIONS.md`
- `docs/DO_NOT_REPEAT.md`

Each candidate includes:

- date/time
- change summary
- changed files
- decision and caution notes
- repeat-prevention rule candidates

No files are modified by default.

Untracked files are included in the change summary as newly created files even when they do not have a git diff body yet.

By default, `update` excludes dev-guard context files from the general changed-file summary and docs update candidates. If only context files changed, it reports that no code changes were detected. Include them explicitly with:

```bash
dev-guard update --include-context-files
```

## `dev-guard update --write`

Appends the generated candidates to:

```text
docs/PROJECT_STATE.md
docs/CURRENT_TASK.md
docs/DECISIONS.md
docs/DO_NOT_REPEAT.md
```

The docs directory and target files are created when needed. If the git diff is empty, the command prints `변경 사항 없음` and exits without writing files.
Before the initial commit, untracked files are enough for `update` to generate a preview or append suggestions with `--write`.

If the current directory is not inside a git repository, `dev-guard` exits with a friendly message asking you to run it from a git repository.

## `dev-guard task-ai "..."`

Generates `.devguard/task.md`-ready Markdown from a natural language requirement. It reads:

- `.devguard/rules.md`
- `.devguard/mistakes.md`
- `docs/PROJECT_STATE.md`
- `docs/DECISIONS.md`
- current git change summary
- project file index from git
- rule-based related file candidates
- `.devguard/project-index.json`, `.devguard/file-summaries.json`, and `.devguard/project-map.md` when scan cache exists

The generated task always includes:

- `## 목표`
- `## 작업 유형`
- `## 현재 문제`
- `## 수정 범위`
- `## 수정 대상`
- `## 참고 대상`
- `## 보호 대상`
- `## 반드시 지킬 규칙`
- `## 건드리면 안 되는 것`
- `## 완료 기준`
- `## 완료 조건`
- `## 검증 명령어`
- `## Codex에게 전달할 주의사항`

`task-ai` treats the current quoted user request as the highest-priority source. Existing task text, saved runs, and project-memory notes are context only; if they conflict with the new request, the new request wins. For follow-up requests such as "the previous/back button works, but the UI feels abrupt or unnatural", dev-guard frames the task as natural UI integration or polish instead of recreating the original feature-add task.

### Task Type Router

Before selecting related files, task-ai classifies the request into a task type:

- `ui_text_cleanup`
- `ui_polish`
- `bugfix`
- `feature_add`
- `architecture`
- `i18n`
- `refactor`
- `migration`
- `performance`
- `styling`
- `docs`
- `infra_config`

The router returns `type`, optional `subtype`, `domainKeywords`, `confidence`, `reasons`, `strategy`, `riskLevel`, and `requiresPhasing`. The result is printed by `--debug-context` and inserted into `## 작업 유형`.

Strategy examples:

- `ui_text_cleanup`: copy/text only; protect logic, state, and data.
- `ui_polish`: minimal UI integration; avoid new sections/cards/features.
- `bugfix`: include reproduction, likely cause, and verification.
- `feature_add`: clarify new feature scope and UI/state/data impact.
- `architecture`: design-first, phased change with impact/risk notes.
- `i18n`: structure-first; preserve existing language and add resources/provider.
- `refactor`: behavior-preserving; protect public API and component props.
- `migration`: phased transition with compatibility and rollback point.
- `performance`: measure-first; avoid functionality changes and broad refactors.
- `styling`: style expression only; prefer design-system tokens.
- `docs`: docs-only; code changes are out of scope.
- `infra_config`: config/env/build/deploy impact; never store secrets.

When `requiresPhasing` is true, task-ai adds `## 이번 단계`, `## 이후 단계`, and `## 이번 작업에서 제외할 것` so broad work does not become a one-shot mass edit.

Bugfix requests can be refined into subtypes such as:

- `bugfix.navigation_state`
- `bugfix.data_persistence`
- `bugfix.ui_rendering`
- `bugfix.text_content`
- `bugfix.api_error`
- `bugfix.build_error`

### Context Priority And Drift

task-ai treats the current user requirement as the anchor. Context priority is explicit:

```text
Requirement > Current code context > subtype context > previous runs/docs
```

The default weights are:

```text
requirement=100
relatedCode=80
taskSubtypeContext=70
recentRun=35
projectMemory=25
staleDocs=10
```

Generated task text is checked for semantic drift. Related expansions are allowed, for example:

- login issue -> auth/session/token/cookie
- navigation issue -> router/history/state
- i18n -> locale/messages/translation

Unrelated drift is blocked or reduced, for example:

- navigation bug -> wording cleanup
- text cleanup -> API bug
- build error -> UI redesign

Correction is intentionally graded:

- low drift: warning/debug only
- medium drift: add requirement-anchor cautions
- high drift: rewrite affected sections such as goal/problem/completion criteria

`## 사용자 요구사항 해석` includes the original request, inferred intent, inferred domain, inferred subtype, inferred risk, and non-goals.

Drift severity is calibrated as:

```text
0-20: clean
20-50: suspicious
50-80: drift
80-100: severe mismatch
```

The same drift system is used after code generation. `check` and heuristic `review` compare the current diff against the task requirement and warn on generated diff drift such as unrelated file modification, subtype mismatch, wording contamination, unexpected architecture or UI redesign, and large unrelated diff.

Generated diff review also infers semantic zones:

- `state_logic`
- `routing`
- `ui_copy`
- `styling`
- `architecture`
- `config`
- `auth`
- `data_flow`

For example, a navigation/state bug whose diff only touches UI copy receives a higher drift risk.

Heuristic review prints workflow scores:

```text
Requirement Alignment Score: 88
Drift Risk: 12
Scope Safety: 80
Confidence: 84
```

These scores are derived from drift severity, semantic zone mismatch, large/broad diff signals, destructive changes, and diff size. They are not random confidence values.

Privacy-safe drift telemetry is stored in `.devguard/drift-telemetry.json`. It stores drift type, severity, source, subtype, timestamp, and aggregate counts only. It does not store source code or full requirements. Telemetry is rotated to the latest 100 events and aggregate keys are capped.

Recent run memory is scoped by task domain/subtype. For example, a navigation bugfix can reuse recent navigation task file hints, while unrelated wording cleanup runs receive lower weight. Run memory also uses time decay, so old unrelated runs have much less influence than recent related runs.

## `dev-guard doctor`

Prints local diagnostics before publishing or relying on automation:

```bash
dev-guard doctor
```

It reports provider/model, API key presence, config source, git baseline, detected framework/language/runtime, telemetry status, watch capability, local heuristic availability, memory cache size, and stale run count.

## `dev-guard telemetry`

Prints privacy-safe drift summary:

```bash
dev-guard telemetry
```

Output includes top drift types, event sources, most unstable subtypes, and stored event count. It is intended for improving heuristics without storing private source code or full requirements.

### Completion Criteria

Each task type also generates completion criteria:

```ts
type TaskCompletionCriteria = {
  requiredChecks: string[]
  forbiddenPatterns?: string[]
  reviewHints?: string[]
  blockingFailures?: string[]
}
```

`task-ai` writes these into `## 완료 기준`. Build success is not enough by itself; completion criteria define what must be true before Codex can call the task done.

Examples:

- `i18n`: user-facing string inventory, locale resource parity, no mixed locale rendering, metadata/aria-label/title/placeholder handling, no hardcoded user-facing strings outside locale resources.
- `ui_text_cleanup`: wording consistency, duplicate phrasing removal, clearer CTA/title/empty/error copy, no logic/state/data changes.
- `architecture`: no unrelated file modification, no layer violation, dependency direction preserved, phased impact boundary.
- `infra_config`: config/env/build/deploy impact stated, no secrets stored, verification or official-docs check noted.

`check` and `review` can use these criteria. The first heuristic hook is i18n post-check: when task type is `i18n`, dev-guard warns about obvious missing locale resources, Korean hardcoded additions outside resource files, and untranslated aria/title/placeholder/metadata additions. This is heuristic, not a full AST parser, and is intended to catch clear omissions early.

For i18n and text cleanup tasks, the prompt also asks Codex to inventory user-facing strings before editing:

- visible UI text
- CTA/title/empty/error copy
- metadata strings
- aria labels, placeholders, and titles

UI-only requests are detected from phrases such as `자연스럽게`, `어색함 제거`, `뜬금없음 제거`, `위화감`, `시각적 위계`, `배치 조정`, `표현 수정`, `더 매끄럽게`, and `흐름 안에 녹아들게`. For these tasks, dev-guard adds guardrails automatically:

- do not reinterpret the request as feature addition
- keep existing behavior working
- avoid logic/state/storage/fetch/auth/routing changes unless explicitly requested
- prefer layout, wording, visual hierarchy, and integration-level edits
- keep the task phrasing short and observable

Large i18n requests are decomposed before file selection. Requests such as `전체 영문 변환`, `영어 버전 추가`, `다국어`, `i18n`, `localization`, `locale`, `translation`, or `언어 전환` are treated as a first-step structure task, not a broad text replacement task.

For i18n work, task-ai biases the task toward:

- preserving existing Korean copy
- adding English resources separately
- adding a message/config/helper structure such as `messages/ko`, `messages/en`, or `lib/i18n`
- wiring a minimal language resource path or provider only when needed
- applying one representative public/landing/about screen as a sample

For i18n work, task-ai avoids:

- replacing Korean text with English in place
- listing every page file as a modification target
- mass-editing global pages such as dashboard, settings, admin, checklist, or record flows
- changing auth/session, Supabase, record analysis/storage, Edge Functions, notification, or routing behavior unless explicitly in scope

i18n task output includes additional decomposition sections: `## 1단계 목표`, `## 이번 작업 범위`, `## 이후 단계`, and `## 이번 작업에서 제외할 것`.

File selection uses generic relevance scoring rather than project-specific file names. dev-guard scores candidates using request tokens, path tokens, route segments, scan categories, file-summary keywords, related features, and matching saved-run targets. Conflicting concepts are penalized; for example, a `result/결과` request lowers files centered on `question/choice/질문/선택`, while a question/choice request lowers result-centered files.

High-scoring candidates become `수정 대상`, medium-scoring candidates become `참고 대상`, protected candidates stay out of modification scope, and low-scoring candidates are ignored.

`task-ai` separates file intent:

- `수정 대상`: files to create, edit, or delete.
- `참고 대상`: existing UI or behavior files that Codex may inspect but should not directly edit.
- `보호 대상`: logic or areas that must stay unchanged unless explicitly requested.

Protected candidates are split conceptually into file-level and logic-level protection. UI-only tasks prefer logic-level protection so a file can still be edited for copy/layout while specific behavior remains protected. For example, an edit target file should not also appear as a protected file; instead, `보호 대상` should name the protected logic inside or around it.

If the AI leaves `보호 대상` as `없음`, dev-guard infers meaningful protected areas from the request, related files, and code context. Examples include result calculation/type derivation, localStorage/sessionStorage save/restore logic, auth/session handling, fetch/API/cache handling, routing/provider wiring, animation/transition state, cache/query state, and layout/shell/wrapper structure.

`건드리면 안 되는 것` is generated from the protected areas. Generic policy lines such as "문서 설정이 바뀌면 문서를 업데이트한다" are removed because they do not help Codex preserve the actual product behavior.

Repeated UI-only guardrail phrases are compacted so `반드시 지킬 규칙`, `보호 대상`, and `건드리면 안 되는 것` do not repeat the same "기능 추가 금지" or "로직 변경 금지" instruction several times. `Codex에게 전달할 주의사항` is also kept short, typically naming only the protected logic and the allowed edit surface.

The task generator also filters unsupported stakeholder wording. It should not invent phrases such as `디자이너의 요구`, `PM 요구사항`, `QA 피드백`, `사용자 조사 결과`, or `브랜드 정책` unless those words appear in the user request or provided context.

Explicit route requests take priority over fuzzy file candidates. For example, `about/service` maps to `app/about/service/page.tsx` and `app/about/service/**`, while `review/kakao` with a delete/remove request is marked as `app/review/kakao/page.tsx (삭제 대상)`.

For screening/preview/about-service requests such as `about/service`, `심사`, `서비스 화면`, `샘플 데이터`, `preview`, `실제 화면 그대로`, or `로그인하지 않아도`, dev-guard biases the task toward sample-data preview implementation. Real feature components can be listed as reference/protected files, but Supabase/Auth/user-data fetch logic is protected by default.

For these about/service preview tasks, auth and login entry points are excluded from modification candidates and moved to protected context instead:

- `app/auth/**`
- `components/landing/*login*`
- `components/landing/*start*`
- `lib/auth/**`
- Supabase auth/callback related files

When explicit routes are known, dev-guard also strengthens weak AI wording. For example, it replaces generic "관련 파일 확인 필요" style current-problem text with a concrete route-level problem, and it adds completion checks for `/about/service`, `/review/kakao`, login-free sample data, no real data fetch, no dashboard/home/auth logic edits, and `pnpm run build`.

`검증 명령어` always includes:

```bash
pnpm run build
```

Additional commands can appear when the task context suggests them, but build remains the default baseline.

Default behavior is preview-only:

```bash
dev-guard task-ai "Improve compact prompt related-file filtering"
```

Preview mode prints the generated Markdown and does not write `.devguard/task.md`. Use `--write` to save it.

Write to `.devguard/task.md` only when requested:

```bash
dev-guard task-ai "Improve compact prompt related-file filtering" --write
```

Also print a compact Codex prompt based on the generated task:

```bash
dev-guard task-ai "Improve compact prompt related-file filtering" --prompt
```

Write the task, print the Codex prompt, and copy the Codex prompt when clipboard access is available:

```bash
dev-guard task-ai "Improve compact prompt related-file filtering" --write --prompt --copy
```

Read more related candidate files into the AI context:

```bash
dev-guard task-ai "Move admin feedback review into the admin page" --context-files 8
```

Disable code-context reading and use only file names:

```bash
dev-guard task-ai "Move admin feedback review into the admin page" --no-code-context
```

Inspect the context sent to task generation:

```bash
dev-guard task-ai "Move admin feedback review into the admin page" --debug-context
```

`--debug-context` prints the requirement anchor, context priority, task type/subtype, confidence, strategy, risk, phasing requirement, semantic drift score, compact stale-context suppression summary, completion criteria, and each candidate file with score, positive reasons, negative reasons, and final role (`edit`, `reference`, `protected`, or `ignored`). Use it when a file appears in the wrong section or a request is classified too broadly.

Safety behavior:

- If the AI provider is `none`, the command prints setup guidance.
- If `OPENAI_API_KEY` is missing for the OpenAI provider, the command exits with a friendly error.
- If the API call fails, `.devguard/task.md` is not modified.
- Without `--write`, `.devguard/task.md` is never overwritten.
- The AI prompt includes a filtered project file list and scored candidate groups split into edit/reference/file-level protected/logic-level protected roles.
- Rules and mistake notes are filtered by the current request and project identity before they are sent to AI. Unrelated project-specific rules are suppressed instead of copied into the task prompt.
- The AI is instructed not to invent causes from unavailable code. If the relevant file is unclear, it should write `현재 코드 확인 필요` or `관련 파일 확인 필요`.
- The AI is instructed not to invent stakeholders or business context not present in the request.
- By default, `task-ai` uses scan cache when `.devguard/project-index.json` exists, and only re-reads the needed candidate files for code context.
- Scan cache is used only when `.devguard/project-identity.json` matches the current project root, remote, package name, and fingerprint.
- Use `--no-cache` to ignore scan memory and fall back to live project scanning.
- Use `--fresh` when a new request should minimize stale run/docs/cache influence and prioritize the current requirement plus live scan context.
- If git changes exist after scan, `task-ai` warns that memory may be stale and suggests `dev-guard refresh`.
- If AI leaves `## 수정 범위` empty or writes only `관련 파일 확인 필요`, dev-guard fills the scope from related file candidates when candidates exist.
- Filled scope entries are marked with `(후보)` unless AI provided a stronger scope itself.
- If AI omits explicit routes, dev-guard post-processing inserts route targets such as `app/about/service/page.tsx` or deletion targets such as `app/review/kakao/page.tsx (삭제 대상)`.
- For about/service preview tasks, real feature files such as `components/home/*` or `app/dashboard/page.tsx` are moved toward `참고 대상` or `보호 대상` instead of defaulting to `수정 대상`.
- For about/service preview tasks, auth/login/callback files are removed from `수정 범위` and `수정 대상`, then shown under `보호 대상`.
- For UI-only tasks, `완료 조건` is rewritten around observable results such as existing behavior remaining intact and the UI no longer looking like a bolted-on element.
- `검증 명령어` is post-processed so `pnpm run build` is present even if the AI omits it.
- Use `--debug-context` to print scan cache usage, extracted keywords, candidate scores/reasons, final roles, code-context files, candidate count, and rule filtering stats before the API call.

Project rule filtering:

```text
loaded rules: 12
relevant rules: 5
suppressed rules: 7
```

Suppressed rules are not included in the AI prompt. This prevents one project’s `.devguard/rules.md`, mistakes, or run history from contaminating a different project’s task generation.

Code context behavior:

- By default, `task-ai` reads up to 5 related candidate files.
- Each file contributes at most 4000 characters.
- The total code context is capped at 12000 characters.
- Large files use keyword-near excerpts first and fall back to the file head when no keyword is found.
- The code context is only a hint for task generation. Codex should still inspect the file directly before editing.
- Use `--context-files <number>` to adjust the candidate file count.
- Use `--no-code-context` to skip file content reading and use only file-name candidates.

Cache options:

```bash
dev-guard task-ai "Update admin feedback behavior" --no-cache
```

AI diff review and automatic mistake recording are intentionally left for a later step.

## `dev-guard prompt`

Reads:

- `.devguard/task.md`
- `.devguard/rules.md`
- `.devguard/mistakes.md`
- `docs/PROJECT_STATE.md`
- `docs/DECISIONS.md`
- current git changes, including working tree, staged, and untracked files

Then prints a Codex-ready prompt to stdout with:

- current task goal
- project state summary
- rules that must be followed
- mistakes that must not be repeated
- recent decisions
- current changed files
- Codex work instructions
- completion conditions
- verification commands

Missing markdown files are treated as empty context and reported as warnings.

By default, prompt generation reads dev-guard context files but excludes them from the changed/related file list:

- `.devguard/**`
- `docs/PROJECT_STATE.md`
- `docs/CURRENT_TASK.md`
- `docs/DECISIONS.md`
- `docs/DO_NOT_REPEAT.md`

This keeps `dev-guard init` output from crowding out the real task files in compact prompts.

Generated/cache paths are always excluded from prompt related files, even when git sees them as changed:

- `.next/**`
- `.devguard/runs/**`
- `.devguard/project-index.json`
- `.devguard/file-summaries.json`
- `.devguard/project-map.md`
- `.git/**`
- `node_modules/**`
- `dist/**`
- `build/**`
- lockfiles
- turbopack/cache files

If only context/cache files changed, prompt output says `현재 코드 변경 파일 없음`.

## `dev-guard prompt --compact`

Prints a shorter prompt for token-saving use. Compact output parses `.devguard/task.md` sections and renders them cleanly instead of embedding the whole task file under `## 목표`. It keeps:

- goal
- current problem
- task scope
- key rules
- forbidden patterns
- related files
- completion conditions
- verification commands

If `.devguard/task.md` contains `## 목표`, `## 현재 문제`, `## 수정 범위`, `## 수정 대상`, `## 참고 대상`, `## 보호 대상`, or `## 반드시 지킬 규칙`, those sections are shown as separate compact prompt sections. The compact `## 관련 파일` section also summarizes 수정/참고/보호 대상 when there are no current code changes.

## `dev-guard prompt --include-context-files`

Includes editable dev-guard context files and the default dev-guard docs in the related files list. Internal run/cache files such as `.devguard/runs/**` and `.devguard/project-index.json` remain excluded.

## `dev-guard prompt --copy`

Attempts to copy the generated prompt to the system clipboard. If clipboard access is unavailable, the prompt is still printed to stdout and a friendly warning is printed.

## `dev-guard prompt --output prompt.md`

Writes the generated prompt to the requested file. This option can be combined with `--compact` and `--copy`.
