#!/usr/bin/env bash
# Morning briefing generation — crontab runs this at 06:30 ET daily:
#   30 6 * * * /home/linnflux/OpenDia/repo/scripts/briefing-cron.sh
# Same shape as agents-tick.sh: flock so overlapping runs can't stack, POST to
# the loopback dashboard (loopback = admin), fail quietly — the view shows a
# stale-morning banner rather than anything here alerting.

exec 9>/tmp/opendia-briefing.lock
flock -n 9 || exit 0

[ -f "$HOME/OpenDia/agents.disabled" ] && exit 0

curl -s -m 10 -X POST "http://127.0.0.1:8038/api/briefing/generate?section=all" >/dev/null 2>&1
