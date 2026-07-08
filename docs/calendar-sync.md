# OpenDia Google Calendar Sync — Operations

Two-way sync between the "OpenDia" Google calendar and (a) Notion task Due
Dates, (b) dashboard card `next_step` date prefixes. Day-granular items are
auto-time-blocked into 30/60-minute slots. Fully automatic — no routine
manual steps.

## Moving parts

| Component | What | Runs |
|---|---|---|
| `scripts/calendar_sync.py` | The whole sync + slot scheduler + watch-channel renewal | cron `*/30 7-19 * * *` → `logs/calendar-sync.log`; also on webhook pings and `POST /api/calendar/sync` |
| Google watch channel | Push notification on any calendar change → instant sync | 7-day TTL, auto-renewed by any sync run within 12h of expiry |
| `POST /api/calendar/webhook` (dashboard) | Receives Google pings (public route, token-validated), coalesces sync runs | always (dashboard service) |
| `cloudflared-opendia` (user systemd) | Cloudflare Tunnel exposing ONLY the webhook path publicly | always; `Restart=always`; linger enabled so it survives reboot without login |

## Local files (machine-specific, not in git)

| File | Contents |
|---|---|
| `~/OpenDia/.opendia-calendar.json` | dashboard base_url, calendar_id, webhook_url + webhook_token, watch-channel id/expiry |
| `~/OpenDia/.opendia-calendar-state.json` | last-synced dates per event (the three-way reconciliation base) |
| `~/OpenDia/.cloudflared-opendia-token` | tunnel run token (mode 600) |

All three ride the nightly Drive backup (`+ **` rule). User systemd units are
snapshotted to `~/OpenDia/systemd-units/` by the backup script.

## Behavior rules

- **Durations**: 30 min if the text matches quick-action keywords
  (call/follow up/confirm/check/email/reply/send/ask/remind/verify/schedule/
  invoice/review), else 60 min. Constants at the top of the script.
- **Placement**: first free slot 08:00–20:00 ET on the due day; today's
  placements start after "now". Respects primary-calendar busyness via
  freeBusy; ignores banner-length (≥20h) busy blocks; same-day items stack.
- **Stickiness**: an event timed on the correct day is never re-slotted —
  drags within a day are permanent user choices.
- **Cross-day drags** push a DATE-ONLY value back to Notion (or rewrite the
  `YYYY-MM-DD:` next_step prefix via the dashboard API). Explicit Notion
  datetimes sync verbatim; multi-day ranges stay all-day.
- **Existence**: owned by Notion/OpenDia. Deleting an event in Google does
  NOT complete the task (recreated next run). Completing a task removes its
  future events; past events remain as history.
- **Conflicts** (both sides moved between syncs): newer edit wins; logged as
  `CONFLICT` lines.

## Health checks

```bash
tail -5 ~/OpenDia/logs/calendar-sync.log          # summary line per run
systemctl --user status cloudflared-opendia       # tunnel up?
journalctl --user -u opendia-dashboard | grep "calendar webhook" | tail  # pings arriving?
~/OpenDia/scripts/calendar_sync.py --dry-run      # what would change
```

A healthy steady-state run prints all zeros. Failures land in
`calendar-sync.log` (cron) — there is no active alerting on sync failures;
the 30-min cron means a broken webhook degrades to polling, and a fully
broken sync shows stale event data rather than data loss.

## Disaster recovery

1. Script + this doc: in the repo (GitHub). Local config/state/token files:
   restore from Drive backup (`gdrive:OpenDia/`).
2. Tunnel token invalid/lost: regenerate via CF API
   (`GET /accounts/{aid}/cfd_tunnel/{tid}/token`) or recreate the tunnel and
   update the DNS CNAME (`opendia-hook` on linnflux.com → `<tid>.cfargotunnel.com`).
3. Watch channel gone: any sync run recreates it (config drives it).
4. Calendar deleted: next run recreates "OpenDia" and repopulates events
   (state file resets naturally; history events are lost with the calendar).
5. systemd units: copies in `~/OpenDia/systemd-units/` (Drive-backed);
   `systemctl --user enable --now cloudflared-opendia opendia-dashboard`
   and `loginctl enable-linger $USER` after restore.
