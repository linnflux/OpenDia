#!/usr/bin/env bash
# oracle_run.sh — recurring monthly Oracle run.
#
# Runs the full business-intelligence sweep headless via Claude Code, publishes a
# dated brief as a child page under the Oracle Notion page, and emails a summary.
#
# Also performs a monthly memory-reclaim health step (reclaim_memory): kills
# abandoned `claude` TUI sessions idle > 7 days that would otherwise exhaust
# RAM+swap and break the google-workspace MCP / the Oracle's own subagents.
#
# Crontab (1st of each month, 7:00 AM ET):
#   0 7 1 * * /home/linnflux/OpenDia/scripts/oracle_run.sh
#
# Run manually any time:
#   /home/linnflux/OpenDia/scripts/oracle_run.sh
#
# Auth: uses the stored Claude login in $HOME/.claude (subscription — no marginal
# API cost). If that ever fails headless, add ANTHROPIC_API_KEY to
# ~/.config/opendia/inbox.env and uncomment the source line below.

set -euo pipefail

# ── Environment (cron has a minimal env) ──────────────────────────────────────
export HOME="${HOME:-/home/linnflux}"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export TZ="America/New_York"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/OpenDia/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/oracle-$(date +%Y-%m).log"
PROMPT_FILE="$SCRIPT_DIR/oracle_prompt.md"
TODAY="$(date +%Y-%m-%d)"

log() { echo "$(date -Iseconds) [oracle] $*" | tee -a "$LOG_FILE"; }

memsnap() { free -m | awk '/^Mem:/{m=$3"M/"$2"M"} /^Swap:/{s=$3"M/"$2"M"} END{print "RAM "m", swap "s}'; }

# ── Memory reclaim: kill abandoned interactive `claude` TUIs idle > 7 days ─────
# Stale Claude Code sessions accumulate in detached tmux/ssh panes (~200MB each)
# and silently exhaust RAM+swap, which makes the heavy google-workspace MCP
# (googleapis import) thrash or get OOM-killed mid-handshake — and would do the
# same to the Oracle's own reader subagents. Reclaim before the run.
# Safety: never touches this script's own process ancestry, the cc-daemon infra
# (--bg-spare/--bg-pty-host/--reply-on-resume), or any headless `claude -p` run;
# only matches TUIs whose args end in `claude`/`claude --resume`. Fully non-fatal.
reclaim_memory() {
    local threshold=604800 self_tree=" $$ " cur="$PPID" pid etimes freed p
    local pids=() alive=()
    while [ -n "$cur" ] && [ "$cur" != "1" ]; do
        self_tree+="$cur "
        cur="$(ps -o ppid= -p "$cur" 2>/dev/null | tr -d ' ')"
    done
    log "memory before reclaim: $(memsnap)"
    while read -r pid etimes; do
        [ -z "$pid" ] && continue
        case "$self_tree" in *" $pid "*) continue ;; esac
        [ "$etimes" -gt "$threshold" ] 2>/dev/null && pids+=("$pid")
    done < <(ps -eo pid=,etimes=,args= | awk '/[/ ]claude( --resume)?$/{print $1, $2}' || true)

    if [ "${#pids[@]}" -eq 0 ]; then
        log "memory reclaim: no stale claude sessions (>7d) found"
        return 0
    fi
    freed="$(ps -o rss= -p "$(IFS=,; echo "${pids[*]}")" 2>/dev/null | awk '{s+=$1} END{printf "%.1f", s/1024/1024}')"
    log "memory reclaim: terminating ${#pids[@]} stale claude session(s) >7d (~${freed}GB resident)"
    kill -TERM "${pids[@]}" 2>/dev/null || true
    sleep 5
    for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && alive+=("$p") || true; done
    if [ "${#alive[@]}" -gt 0 ]; then
        kill -KILL "${alive[@]}" 2>/dev/null || true
        log "memory reclaim: SIGKILLed ${#alive[@]} straggler(s)"
    fi
    log "memory after reclaim:  $(memsnap)"
}

# Optional: API-key auth instead of subscription login.
# ENV_FILE="$HOME/.config/opendia/inbox.env"
# [ -f "$ENV_FILE" ] && { set -o allexport; source "$ENV_FILE"; set +o allexport; }

# ── Resolve claude binary ─────────────────────────────────────────────────────
CLAUDE_BIN="$(command -v claude || true)"
[ -z "$CLAUDE_BIN" ] && CLAUDE_BIN="$HOME/.local/bin/claude"
if [ ! -x "$CLAUDE_BIN" ]; then
    log "ERROR: claude binary not found at $CLAUDE_BIN"
    exit 1
fi

# ── Load NOTION_TOKEN from ~/.claude.json (belt-and-suspenders for the MCP) ────
PYTHON="$(command -v python3)"
if [ -z "${NOTION_TOKEN:-}" ]; then
    NOTION_TOKEN="$("$PYTHON" -c "
import json
try:
    print(json.load(open('$HOME/.claude.json'))['mcpServers']['notion']['env']['NOTION_TOKEN'])
except Exception:
    pass
" 2>/dev/null || true)"
    [ -n "${NOTION_TOKEN:-}" ] && export NOTION_TOKEN
fi

[ -f "$PROMPT_FILE" ] || { log "ERROR: prompt file missing: $PROMPT_FILE"; exit 1; }

# ── flock: never overlap runs ─────────────────────────────────────────────────
LOCK_FILE="/tmp/opendia-oracle.lock"
exec 200>"$LOCK_FILE"
flock -n 200 || { log "Another Oracle run is in progress. Exiting."; exit 0; }

log "=== Oracle run start ($TODAY) ==="
cd "$HOME/OpenDia"

# Free RAM/swap before the sweep (non-fatal — never block the run on cleanup).
reclaim_memory || log "memory reclaim step errored (non-fatal); continuing"

set +e
timeout 45m "$CLAUDE_BIN" -p "$(cat "$PROMPT_FILE")" \
    --dangerously-skip-permissions \
    --model opus \
    --max-budget-usd 12 \
    --add-dir "$HOME/OpenDia" \
    >> "$LOG_FILE" 2>&1
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ]; then
    log "=== Oracle run complete (exit 0) ==="
else
    log "=== Oracle run FAILED (exit $STATUS) ==="
    # Non-silent failure: alert the operator.
    printf 'The monthly Oracle run failed on %s (exit code %s).\n\nCheck the log:\n%s\n' \
        "$TODAY" "$STATUS" "$LOG_FILE" \
        | "$PYTHON" "$SCRIPT_DIR/oracle_email.py" --subject "Oracle run FAILED — $TODAY" \
        >> "$LOG_FILE" 2>&1 || log "Alert email also failed."
    exit "$STATUS"
fi
