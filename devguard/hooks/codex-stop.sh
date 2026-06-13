#!/usr/bin/env bash
set +e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="$ROOT/devguard/logs/codex-hook.log"
mkdir -p "$(dirname "$LOG")" "$ROOT/devguard/reports"

timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
{
  echo "timestamp=$timestamp hook=codex.stop status=start"
  cd "$ROOT" || exit 1
  if [ -f package.json ] && grep -q '"cli"' package.json; then
    pnpm cli done
    done_status=$?
    pnpm cli status
    status_status=$?
  else
    dev-guard done
    done_status=$?
    dev-guard status
    status_status=$?
  fi
  if [ "$done_status" -eq 0 ] && [ "$status_status" -eq 0 ]; then
    echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=codex.stop status=success done=$done_status status_cmd=$status_status"
  else
    echo "timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ") hook=codex.stop status=failed done=$done_status status_cmd=$status_status"
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

exit 0
