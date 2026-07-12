#!/usr/bin/env bash
# inbox-tick.sh — Cron entry-point for the email → Claude Code inbox pipeline.
#
# Runs every 5 minutes via crontab:
#   */5 * * * * /home/linnflux/OpenDia/scripts/inbox-tick.sh
#
# Uses flock to prevent concurrent runs from double-processing messages.
# Logs to ~/OpenDia/logs/inbox-YYYY-MM-DD.log (appended by stages A and B).

set -euo pipefail

# ── Pause switch ──────────────────────────────────────────────────────────────
# Create ~/OpenDia/inbox.disabled to halt all processing without losing any emails.
# Messages will stay labeled "OpenDia Inbox" and be processed on the next run after
# the file is removed.
if [ -f "$HOME/OpenDia/inbox.disabled" ]; then
    exit 0
fi

# ── Load environment ──────────────────────────────────────────────────────────
# Secrets live in ~/.config/opendia/inbox.env (mode 600).
# Required: ANTHROPIC_API_KEY
ENV_FILE="$HOME/.config/opendia/inbox.env"
if [ -f "$ENV_FILE" ]; then
    # shellcheck source=/dev/null
    set -o allexport
    source "$ENV_FILE"
    set +o allexport
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "$(date -Iseconds) [inbox-tick] ERROR: ANTHROPIC_API_KEY not set in $ENV_FILE" >&2
    echo "  Run: nano $ENV_FILE  and add  ANTHROPIC_API_KEY=sk-ant-..." >&2
    exit 1
fi

# ── Ensure log dir exists ─────────────────────────────────────────────────────
LOG_DIR="$HOME/OpenDia/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/inbox-$(date +%Y-%m-%d).log"

# ── Scope check: gmail.modify required for label operations ───────────────────
PYTHON="$(command -v python3)"
if ! "$PYTHON" -c "
import json, sys
t = json.load(open('$HOME/.claude/mcp-credentials/google-workspace/tokens.json'))
if 'gmail.modify' not in t.get('scope',''):
    print('[inbox-tick] ERROR: gmail.modify scope missing from OAuth token.')
    print('  Run: python3 $HOME/OpenDia/scripts/inbox_setup_auth.py')
    sys.exit(1)
" 2>&1 | tee -a "$LOG_FILE"; then
    exit 1
fi

log() {
    echo "$(date -Iseconds) [inbox-tick] $*" | tee -a "$LOG_FILE"
}

# ── flock: prevent overlapping runs ──────────────────────────────────────────
LOCK_FILE="/tmp/opendia-inbox.lock"

(
    flock -n 200 || { log "Another run is in progress (flock held). Exiting cleanly."; exit 0; }

    log "=== Tick start ==="

    PYTHON="$(command -v python3)"
    SCRIPTS_DIR="$HOME/OpenDia/scripts"

    # ── Stage A: classify ─────────────────────────────────────────────────────
    log "Stage A: classify"
    "$PYTHON" "$SCRIPTS_DIR/inbox_stage_a.py" 2>&1 | tee -a "$LOG_FILE" || {
        log "Stage A exited non-zero. Continuing to Stage B."
    }

    # Stage B (dispatch) is NOT called here.
    # All dispatch is triggered by the operator via dashboard buttons.
    # Stage B's run() is invoked only via --redispatch or --server-dispatch.

    log "=== Tick complete ==="

) 200>"$LOCK_FILE"
