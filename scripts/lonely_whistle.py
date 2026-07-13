#!/usr/bin/env python3
"""
lonely_whistle.py — Daily end-of-day summary email.

Reads today's time ledger, builds a plain-text summary grouped by client,
and sends it to opendia@linnflux.com with subject:
  Lonely Whistle - YYYY-MM-DD

Run at 5pm via cron:
  0 17 * * * /home/linnflux/OpenDia/scripts/lonely_whistle.py

Skip days with no entries. Include open (unclosed) timers noting their elapsed time.
"""

import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

# ── Local imports ─────────────────────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent))
from gmail_helper import _load_service, send_email

EASTERN = ZoneInfo("America/New_York")
RECIPIENT = "opendia@linnflux.com"


# ── Duration helpers ──────────────────────────────────────────────────────────

def parse_duration(s: str) -> int:
    """Parse '2h 32m', '45m', '1h', '0m' → total minutes. Returns 0 on failure."""
    if not s or not s.strip():
        return 0
    s = s.strip()
    total = 0
    h = re.search(r"(\d+)\s*h", s)
    m = re.search(r"(\d+)\s*m", s)
    if h:
        total += int(h.group(1)) * 60
    if m:
        total += int(m.group(1))
    return total


def format_duration(minutes: int) -> str:
    """Format minutes as '2h 32m', '45m', '1h', '0m'."""
    if minutes <= 0:
        return "0m"
    h, m = divmod(minutes, 60)
    if h and m:
        return f"{h}h {m}m"
    if h:
        return f"{h}h"
    return f"{m}m"


def elapsed_since(start_str: str) -> int:
    """Minutes elapsed since a 'YYYY-MM-DDTHH:MM' timestamp (Eastern time)."""
    try:
        start = datetime.strptime(start_str, "%Y-%m-%dT%H:%M").replace(tzinfo=EASTERN)
        now = datetime.now(tz=EASTERN)
        delta = now - start
        return max(0, int(delta.total_seconds() // 60))
    except Exception:
        return 0


# ── Ledger parser ─────────────────────────────────────────────────────────────

def parse_ledger(path: Path) -> list[dict]:
    """
    Parse a daily ledger file into a list of entry dicts.
    Each dict has: client, project, division, task, estimated_minutes,
                   start, end, duration_str, duration_min, billable,
                   notes, next_step, open
    """
    text = path.read_text()
    # Split on --- separators; each block starts with the HTML comment marker
    blocks = re.split(r"\n---\n", text)
    entries = []

    for block in blocks:
        if "<!-- entry:" not in block:
            continue

        def field(name: str) -> str:
            m = re.search(rf"^{name}:\s*(.*)$", block, re.MULTILINE)
            return m.group(1).strip() if m else ""

        # Notes: either inline or YAML block scalar
        notes_raw = ""
        notes_m = re.search(r"^notes:\s*\|?\s*\n((?:  .*\n?)*)", block, re.MULTILINE)
        if notes_m:
            # Multiline block scalar — strip 2-space indent
            notes_raw = "\n".join(
                line[2:] if line.startswith("  ") else line
                for line in notes_m.group(1).splitlines()
            ).strip()
        else:
            notes_m2 = re.search(r"^notes:\s+(.+)$", block, re.MULTILINE)
            if notes_m2:
                notes_raw = notes_m2.group(1).strip()

        # Split off NEXT: line
        next_step = ""
        notes_lines = []
        for line in notes_raw.splitlines():
            if line.startswith("NEXT:"):
                next_step = line[5:].strip()
            else:
                notes_lines.append(line)
        notes_body = "\n".join(notes_lines).strip()

        duration_str = field("duration")
        end_val = field("end")
        is_open = not end_val.strip()

        if is_open:
            elapsed = elapsed_since(field("start"))
            duration_min = elapsed
        else:
            duration_min = parse_duration(duration_str)

        entries.append({
            "client":     field("client"),
            "project":    field("project"),
            "division":   field("division"),
            "task":       field("task"),
            "start":      field("start"),
            "end":        end_val,
            "duration_str": duration_str,
            "duration_min": duration_min,
            "billable":   field("billable").lower() == "true",
            "notes":      notes_body,
            "next_step":  next_step,
            "open":       is_open,
        })

    return entries


# ── Email formatter ───────────────────────────────────────────────────────────

def build_email(date_str: str, entries: list[dict]) -> str:
    total_min = sum(e["duration_min"] for e in entries)
    billable_min = sum(e["duration_min"] for e in entries if e["billable"])
    internal_min = total_min - billable_min

    lines = []
    lines.append(f"Lonely Whistle — {date_str}")
    lines.append("")
    lines.append(
        f"Total: {format_duration(total_min)}"
        f"  |  Billable: {format_duration(billable_min)}"
        f"  |  Internal: {format_duration(internal_min)}"
    )
    lines.append("")

    # Group by client (preserve first-seen order)
    seen_clients: list[str] = []
    by_client: dict[str, list[dict]] = {}
    for e in entries:
        c = e["client"] or "(no client)"
        if c not in by_client:
            by_client[c] = []
            seen_clients.append(c)
        by_client[c].append(e)

    sep = "─" * 60

    for client in seen_clients:
        client_entries = by_client[client]
        client_min = sum(e["duration_min"] for e in client_entries)

        # Division — use most common across client's entries
        divisions = [e["division"] for e in client_entries if e["division"]]
        division_label = f"  [{divisions[0]}]" if divisions else ""

        lines.append(sep)
        lines.append(f"{client.upper()}{division_label}  {format_duration(client_min)}")
        lines.append("")

        for e in client_entries:
            # Duration label
            if e["open"]:
                dur_label = f"(open — {format_duration(e['duration_min'])} elapsed)"
            else:
                dur_label = format_duration(e["duration_min"])

            bill_label = "billable" if e["billable"] else "internal"
            lines.append(f"  {e['task']}")
            lines.append(f"  {dur_label} · {bill_label}")

            if e["notes"]:
                # Wrap notes at ~72 chars, indent 4 spaces
                for note_line in e["notes"].splitlines():
                    note_line = note_line.strip()
                    if note_line:
                        lines.append(f"    {note_line}")

            if e["next_step"]:
                lines.append(f"    NEXT: {e['next_step']}")

            lines.append("")

    lines.append(sep)
    lines.append("")
    lines.append("-- OpenDia Automated Summary")

    return "\n".join(lines)


# ── Main ──────────────────────────────────────────────────────────────────────

def backup_warning() -> str:
    """Return a warning line if the last successful backup is stale (>36h), else ''."""
    marker = Path.home() / "OpenDia" / "logs" / ".last-backup-success"
    if not marker.exists():
        return "WARNING: Drive backup has never completed (no .last-backup-success marker found)"
    age_hours = (datetime.now().timestamp() - marker.stat().st_mtime) / 3600
    if age_hours > 36:
        return f"WARNING: Drive backup last completed {age_hours:.0f}h ago -- investigate ~/OpenDia/logs/backup.log"
    return ""


def calendar_sync_warnings() -> list[str]:
    """Health-check the Google Calendar sync (docs/calendar-sync.md).

    Failure mode is silent staleness, not data loss — this is the alerting.
    Checks: successful-run freshness (state file mtime), a crashed last run
    (log tail isn't a summary line), and watch-channel expiry (webhook dead
    -> degraded to 30-min polling).
    """
    warns = []
    home = Path.home()

    state = home / "OpenDia" / ".opendia-calendar-state.json"
    if not state.exists():
        return ["WARNING: calendar sync has never completed (no state file)"]
    age_hours = (datetime.now().timestamp() - state.stat().st_mtime) / 3600
    # Cron runs every 30 min 7am-7pm; at the 5pm send, >2h stale means broken
    if age_hours > 2:
        warns.append(
            f"WARNING: calendar sync last succeeded {age_hours:.0f}h ago -- investigate ~/OpenDia/logs/calendar-sync.log"
        )

    log = home / "OpenDia" / "logs" / "calendar-sync.log"
    if log.exists():
        try:
            lines = [l for l in log.read_text().splitlines() if l.strip()]
            if lines and "] events=" not in lines[-1] and "skipped" not in lines[-1]:
                warns.append(f"WARNING: calendar sync last run ended abnormally: {lines[-1][:160]}")
        except OSError:
            pass

    try:
        import json as _json
        cfg = _json.loads((home / "OpenDia" / ".opendia-calendar.json").read_text())
        exp_ms = cfg.get("channel_expiration") or 0
        if cfg.get("webhook_url") and exp_ms and exp_ms / 1000 < datetime.now().timestamp():
            warns.append(
                "WARNING: calendar webhook channel expired -- instant sync degraded to 30-min polling (renewal happens in sync runs; see calendar-sync.log)"
            )
    except (OSError, ValueError):
        pass

    return warns


def reaper_warnings() -> list[str]:
    """Health-check the Claude session reaper (docs/session-reaper.md).

    Silent until the reaper has run at least once (log exists) — so this
    produces no noise before the cron is activated. Cron runs every 6h;
    at the 5pm send, >8h stale means a missed run.
    """
    warns = []
    log = Path.home() / "OpenDia" / "logs" / "session-reaper.log"
    if not log.exists():
        return warns
    age_hours = (datetime.now().timestamp() - log.stat().st_mtime) / 3600
    if age_hours > 8:
        warns.append(
            f"WARNING: session reaper last ran {age_hours:.0f}h ago -- check crontab / ~/OpenDia/logs/session-reaper.log"
        )
    try:
        lines = [l for l in log.read_text().splitlines() if l.strip()]
        if lines and "reaped=" not in lines[-1] and not lines[-1].startswith(("  reaped:", "  POSSIBLY-HUNG:")):
            warns.append(f"WARNING: session reaper last run ended abnormally: {lines[-1][:160]}")
    except OSError:
        pass
    return warns


def toggl_coverage_warnings() -> list[str]:
    """Toggl hours feed billing. A single user token silently under-reports them
    (~100h/month of a second operator's time), and the v2 Reports API that used
    to cover the whole workspace is now 402-gated. Surface it once a month rather
    than discovering it mid-billing-run."""
    if datetime.now(tz=EASTERN).day > 3:
        return []  # only nag near month end/start, when billing actually happens
    multi = Path.home() / ".toggl_tokens"
    try:
        toks = [l for l in multi.read_text().splitlines()
                if l.strip() and not l.startswith("#")] if multi.exists() else []
    except OSError:
        toks = []
    if len(toks) > 1:
        return []
    return [
        "WARNING: Toggl has only ONE user token — billing hours exclude the other "
        "operator's time (~100h/month). Add each user's token to ~/.toggl_tokens. "
        "See docs/billing.md."
    ]


def main():
    now = datetime.now(tz=EASTERN)
    date_str = now.strftime("%Y-%m-%d")
    year = now.strftime("%Y")
    month = now.strftime("%m")

    ledger_path = Path.home() / "OpenDia" / "Time" / year / month / f"{date_str}.md"

    # Health checks run FIRST and unconditionally. They used to sit below the
    # ledger check, so on any day with no logged work (weekends, days off — about
    # 1 in 4) a dead backup or dead calendar sync alerted nobody. Quiet days are
    # exactly when nothing else would catch it.
    warnings = ([w for w in [backup_warning()] if w] + calendar_sync_warnings()
                + reaper_warnings() + toggl_coverage_warnings())

    entries = parse_ledger(ledger_path) if ledger_path.exists() else []

    if not entries:
        if not warnings:
            print(f"[lonely-whistle] No ledger for {date_str}, systems healthy — nothing to send.")
            sys.exit(0)
        # No work logged, but something is broken — send the warnings alone.
        body = "\n".join(warnings) + (
            f"\n\nNo time entries logged for {date_str}. "
            "This alert is the system health check, not a work summary."
        )
        subject = f"Lonely Whistle - {date_str} - SYSTEM WARNING"
    else:
        body = build_email(date_str, entries)
        if warnings:
            body = "\n".join(warnings) + "\n\n" + body
        subject = f"Lonely Whistle - {date_str}"

    service = _load_service()
    result = send_email(service, RECIPIENT, subject, body)
    print(f"[lonely-whistle] Sent '{subject}' → {RECIPIENT} (id={result.get('id')})")


if __name__ == "__main__":
    main()
