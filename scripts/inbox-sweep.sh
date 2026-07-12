#!/usr/bin/env bash
# inbox-sweep.sh — Weekly sweep: kill inbox-* tmux sessions inactive for >7 days.
#
# Crontab entry (runs Sunday at 3 AM):
#   0 3 * * 0 /home/linnflux/OpenDia/scripts/inbox-sweep.sh
#
# Uses tmux's built-in #{session_activity} to measure last activity time.
# Any session you attach to resets its activity clock — sessions you're still
# using will survive indefinitely.
#
# Note on session_activity units: tmux reports seconds since epoch on most versions,
# but some older builds report milliseconds. This script detects which by magnitude
# and normalizes.

set -euo pipefail

LOG_DIR="$HOME/OpenDia/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/inbox-sweep-$(date +%Y-%m-%d).log"

log() {
    echo "$(date -Iseconds) [inbox-sweep] $*" | tee -a "$LOG_FILE"
}

NOW=$(date +%s)
SEVEN_DAYS=$((7 * 24 * 3600))
THRESHOLD=$(( NOW - SEVEN_DAYS ))

log "=== Sweep start === (threshold: sessions inactive before $(date -d "@$THRESHOLD" -Iseconds 2>/dev/null || date -r "$THRESHOLD" -Iseconds 2>/dev/null || echo "$THRESHOLD"))"

# Get all inbox-* sessions with their last activity timestamp
# Format: "session_name activity_ts"
mapfile -t SESSION_LINES < <(tmux list-sessions -F '#{session_name} #{session_activity}' 2>/dev/null || true)

if [ ${#SESSION_LINES[@]} -eq 0 ]; then
    log "No active tmux sessions found."
    log "=== Sweep complete ==="
    exit 0
fi

KILLED=0
KEPT=0

for line in "${SESSION_LINES[@]}"; do
    name="${line%% *}"
    activity_raw="${line##* }"

    # Only process inbox-* sessions
    if [[ "$name" != inbox-* ]]; then
        continue
    fi

    # Normalize: if activity_raw > 1e12 it's milliseconds, else seconds
    if [ "${#activity_raw}" -ge 13 ]; then
        activity_sec=$(( activity_raw / 1000 ))
    else
        activity_sec="$activity_raw"
    fi

    if [ "$activity_sec" -lt "$THRESHOLD" ]; then
        log "Killing inactive session: $name (last activity: $(date -d "@$activity_sec" -Iseconds 2>/dev/null || echo "$activity_sec"))"
        tmux kill-session -t "$name" 2>/dev/null || log "  (already gone)"
        KILLED=$(( KILLED + 1 ))
    else
        log "Keeping session: $name (last activity: $(date -d "@$activity_sec" -Iseconds 2>/dev/null || echo "$activity_sec"))"
        KEPT=$(( KEPT + 1 ))
    fi
done

log "Sweep complete: killed=$KILLED kept=$KEPT"
