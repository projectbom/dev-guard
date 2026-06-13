#!/usr/bin/env bash
set +e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="$ROOT/devguard/logs/claude-hook.log"
mkdir -p "$(dirname "$LOG")" "$ROOT/devguard/reports"

hook_input="$(cat)"
timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
{
  echo "timestamp=$timestamp hook=claude.stop status=start"
  if [ -n "$hook_input" ]; then
    echo "timestamp=$timestamp hook=claude.stop stdin_json_begin"
    printf '%s\n' "$hook_input"
    echo "timestamp=$timestamp hook=claude.stop stdin_json_end"
  fi
  cd "$ROOT" || exit 1
  if [ -f package.json ] && grep -q '"cli"' package.json; then
    if command -v pnpm >/dev/null 2>&1; then
      pnpm cli done
      done_status=$?
      pnpm cli status
      status_status=$?
    else
      echo "dev-guard hook failed: pnpm was not found. Install pnpm or run dev-guard done/status manually."
      done_status=127
      status_status=127
    fi
  else
    if command -v dev-guard >/dev/null 2>&1; then
      dev-guard done
      done_status=$?
      dev-guard status
      status_status=$?
    else
      echo "dev-guard hook failed: dev-guard was not found on PATH. Install/link dev-guard or run the local CLI manually."
      done_status=127
      status_status=127
    fi
  fi
  if [ "$done_status" -eq 0 ] && [ "$status_status" -eq 0 ]; then
    echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=claude.stop status=success done=$done_status status_cmd=$status_status"
  else
    echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=claude.stop status=failed done=$done_status status_cmd=$status_status"
    if [ "$done_status" -ne 0 ]; then
      echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=claude.stop handoff=not_generated reason=done_failed"
    fi
  fi
} >> "$LOG" 2>&1

cat > "$ROOT/devguard/reports/hook-status.md" <<EOF
# Hook Status

## Installed
- Claude Code: $([ -f "$ROOT/.claude/settings.json" ] && [ -f "$ROOT/devguard/hooks/claude-stop.sh" ] && echo INSTALLED || echo NOT_INSTALLED)
- Codex CLI: $([ -f "$ROOT/.codex/hooks.json" ] && [ -f "$ROOT/devguard/hooks/codex-stop.sh" ] && echo INSTALLED || echo NOT_INSTALLED)

## Files
- devguard/hooks/claude-stop.sh: $([ -f "$ROOT/devguard/hooks/claude-stop.sh" ] && echo exists || echo missing)
- devguard/hooks/codex-stop.sh: $([ -f "$ROOT/devguard/hooks/codex-stop.sh" ] && echo exists || echo missing)
- .claude/settings.json: $([ -f "$ROOT/.claude/settings.json" ] && echo exists || echo missing)
- .codex/hooks.json: $([ -f "$ROOT/.codex/hooks.json" ] && echo exists || echo missing)

## Last Hook Trigger
- time: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
- success: $([ "$done_status" -eq 0 ] && [ "$status_status" -eq 0 ] && echo yes || echo no)
EOF

if [ "claude" = "codex" ]; then
  printf '{}\n'
fi

exit 0
