#!/usr/bin/env bash
# intake-tick.sh — Cron entry-point for the FluxCC intake automation pipeline.
#
# Crontab entry:
#   */5 * * * * /home/linnflux/OpenDia/scripts/intake-tick.sh >> /home/linnflux/OpenDia/logs/intake-pipeline.log 2>&1
#
# Create ~/OpenDia/intake.disabled to pause all processing without losing data.

set -euo pipefail

if [ -f "$HOME/OpenDia/intake.disabled" ]; then
    exit 0
fi

# Load env (shares inbox.env for ANTHROPIC_API_KEY if needed by future stages)
ENV_FILE="$HOME/.config/opendia/inbox.env"
if [ -f "$ENV_FILE" ]; then
    set -o allexport
    # shellcheck source=/dev/null
    source "$ENV_FILE"
    set +o allexport
fi

LOG_DIR="$HOME/OpenDia/logs"
mkdir -p "$LOG_DIR"

log() {
    echo "$(date -Iseconds) [intake-tick] $*"
}

LOCK_FILE="/tmp/opendia-intake.lock"
PYTHON="$(command -v python3)"
SCRIPTS_DIR="$HOME/OpenDia/scripts"

(
    flock -n 200 || { log "Another run in progress. Exiting."; exit 0; }

    log "=== Tick start ==="
    "$PYTHON" "$SCRIPTS_DIR/intake_pipeline.py" poll || {
        log "pipeline exited non-zero (exit $?)"
    }
    log "=== Tick complete ==="

) 200>"$LOCK_FILE"
