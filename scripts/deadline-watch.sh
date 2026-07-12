#!/usr/bin/env bash
# deadline-watch.sh — Cron watchdog for approaching/overdue Notion tasks.
# Runs every 2 hours Mon-Fri during work hours.
# Cron: 0 8,10,12,14,16 * * 1-5
#
# Writes:
#   ~/OpenDia/Time/.deadline-alerts.json  — full structured results
#   ~/OpenDia/Time/.deadline-notify       — one-liner summary if urgent items exist

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALERTS_FILE="$HOME/OpenDia/Time/.deadline-alerts.json"
NOTIFY_FILE="$HOME/OpenDia/Time/.deadline-notify"
LOG_FILE="$HOME/OpenDia/Time/.deadline-watch.log"
PYTHON="$(command -v python3)"

# Load NOTION_TOKEN from claude.json if not already in env
if [[ -z "${NOTION_TOKEN:-}" ]]; then
    NOTION_TOKEN="$("$PYTHON" -c "
import json, sys
try:
    d = json.load(open('$HOME/.claude.json'))
    print(d['mcpServers']['notion']['env']['NOTION_TOKEN'])
except Exception as e:
    sys.exit(1)
" 2>/dev/null || true)"
fi

if [[ -z "${NOTION_TOKEN:-}" ]]; then
    echo "$(date -Iseconds) ERROR: NOTION_TOKEN not found" >> "$LOG_FILE"
    exit 1
fi

export NOTION_TOKEN

# Run deadline check (24h forward window for watchdog)
OUTPUT="$("$PYTHON" "$SCRIPT_DIR/deadline_check.py" --hours 24 2>>"$LOG_FILE")"

if [[ -z "$OUTPUT" ]]; then
    echo "$(date -Iseconds) ERROR: deadline_check.py returned empty output" >> "$LOG_FILE"
    exit 1
fi

# Write alerts file
echo "$OUTPUT" > "$ALERTS_FILE"
echo "$(date -Iseconds) OK: wrote $ALERTS_FILE" >> "$LOG_FILE"

# Check if there are urgent items (overdue or due within 4h)
# Pass data via the alerts file to avoid heredoc+herestring conflict
URGENT="$("$PYTHON" -c "
import json, sys
from datetime import datetime, timedelta, timezone

data = json.load(open('$ALERTS_FILE'))
now = datetime.now(timezone.utc)
cutoff = now + timedelta(hours=4)

overdue = data.get('overdue', [])
imminent = []
for t in data.get('imminent', []) + data.get('today', []):
    due = t.get('due_end') or t.get('due_start')
    if due:
        try:
            due_dt = datetime.fromisoformat(due.replace('Z', '+00:00')).astimezone(timezone.utc)
            if due_dt <= cutoff:
                imminent.append(t)
        except Exception:
            pass

parts = []
if overdue:
    names = ', '.join(t.get('name','?') for t in overdue[:3])
    parts.append(f'OVERDUE ({len(overdue)}): {names}')
if imminent:
    names = ', '.join(t.get('name','?') for t in imminent[:3])
    parts.append(f'SOON ({len(imminent)}): {names}')

if parts:
    print(' | '.join(parts))
" 2>>"$LOG_FILE")"

if [[ -n "$URGENT" ]]; then
    echo "$URGENT" > "$NOTIFY_FILE"
    echo "$(date -Iseconds) URGENT: $URGENT" >> "$LOG_FILE"
else
    # Clear stale notify file
    rm -f "$NOTIFY_FILE"
fi
