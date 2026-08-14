#!/usr/bin/env bash
# agents-tick.sh — Cron entry-point for OpenDia Agent (ODA) heartbeats.
#
# Runs every 5 minutes via crontab:
#   */5 * * * * /home/linnflux/OpenDia/scripts/agents-tick.sh
#
# The dashboard decides which agents are due (enabled + schedule window +
# heartbeat interval) and executes heartbeats in-process; this script is just
# the clock. A down dashboard shows up as ERROR lines in the log.

set -euo pipefail

export HOME=/home/linnflux
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export TZ="America/New_York"

# ── Pause switch ──────────────────────────────────────────────────────────────
# Create ~/OpenDia/agents.disabled to halt all agent heartbeats. Agents resume
# on the next tick after the file is removed.
if [ -f "$HOME/OpenDia/agents.disabled" ]; then
    exit 0
fi

LOG="$HOME/OpenDia/logs/agents-$(date +%Y-%m-%d).log"
mkdir -p "$HOME/OpenDia/logs"
log() { echo "$(date -Iseconds) [agents-tick] $*" >> "$LOG"; }

LOCK="/tmp/opendia-agents.lock"
(
    flock -n 200 || { log "flock held, exiting"; exit 0; }
    if RES=$(curl -sf -m 30 -X POST http://127.0.0.1:8038/api/agents/tick); then
        log "tick: $RES"
    else
        log "ERROR: dashboard unreachable"
    fi
) 200>"$LOCK"
