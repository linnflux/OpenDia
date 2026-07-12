#!/usr/bin/env bash
# rotate_logs.sh — keep ~/OpenDia/logs/ from growing without bound.
#
# Nothing rotated these before: intake-pipeline.log was a single ever-appended
# file (mostly "[intake-poll] done." every 5 minutes) and the daily inbox-*.log
# files went back months. Not a disk emergency, but unbounded growth makes the
# logs useless for debugging and slow to grep.
#
# Runs from user cron (no sudo, no /etc/logrotate.d needed).

set -euo pipefail

LOG_DIR="$HOME/OpenDia/logs"
MAX_BYTES=$((10 * 1024 * 1024))   # rotate any log over 10 MB
KEEP_ROTATIONS=5                  # keep foo.log.1.gz … foo.log.5.gz
DATED_RETENTION_DAYS=45           # prune inbox-YYYY-MM-DD.log older than this

[ -d "$LOG_DIR" ] || exit 0

rotated=0
pruned=0

# 1. Size-based rotation for the ever-appended logs.
for log in "$LOG_DIR"/*.log; do
    [ -f "$log" ] || continue
    # Dated logs are handled by retention below, not by size.
    case "$(basename "$log")" in *-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].log) continue ;; esac

    size=$(stat -c %s "$log")
    [ "$size" -gt "$MAX_BYTES" ] || continue

    for i in $(seq $((KEEP_ROTATIONS - 1)) -1 1); do
        [ -f "$log.$i.gz" ] && mv "$log.$i.gz" "$log.$((i + 1)).gz"
    done
    # Copy-truncate: appenders holding the fd keep writing to the same inode.
    cp "$log" "$log.1"
    : > "$log"
    gzip -f "$log.1"
    rm -f "$log.$((KEEP_ROTATIONS + 1)).gz"
    rotated=$((rotated + 1))
done

# 2. Retention for dated logs (inbox-2026-04-17.log and friends).
while IFS= read -r old; do
    rm -f "$old"
    pruned=$((pruned + 1))
done < <(find "$LOG_DIR" -maxdepth 1 -type f -name '*-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].log' \
         -mtime +"$DATED_RETENTION_DAYS" 2>/dev/null)

# 3. Old compressed rotations beyond retention.
find "$LOG_DIR" -maxdepth 1 -type f -name '*.log.*.gz' -mtime +90 -delete 2>/dev/null || true

echo "[$(date '+%Y-%m-%dT%H:%M')] log-rotate: rotated=$rotated pruned=$pruned dir_size=$(du -sh "$LOG_DIR" | cut -f1)"
