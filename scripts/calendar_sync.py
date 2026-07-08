#!/usr/bin/env python3
"""Two-way sync: Notion task due dates + card next_step dates <-> Google Calendar.

Creates/maintains an "OpenDia" secondary calendar in the owner's Google
account. Events carry deep links back to the dashboard card and the Notion
task. Reconciliation is three-way (Notion/DB state, Google state, last-synced
base state) so a date moved on EITHER side propagates to the other:

  - Notion/next_step changed, Google unchanged  -> push to Google
  - Google changed, Notion unchanged            -> push back to Notion / card
  - Both changed                                -> newer edit wins (CONFLICT logged)

Existence is owned by Notion/OpenDia: deleting an event in Google Calendar
does not complete a task — the event is recreated on the next run. Past
events are never touched (completed work stays on the calendar as history).

Config file (~/OpenDia/.opendia-calendar.json, not in git):
  { "base_url": "https://<dashboard-host>", "calendar_id": "<set by script>" }

Usage: calendar_sync.py [--dry-run]
"""

import argparse
import fcntl
import json
import os
import re
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone

import requests

HOME = os.path.expanduser("~")
TASKS_DB_ID = "aff52e96-1dfd-438c-8b15-84c446afd054"
NOTION_API_VERSION = "2022-06-28"
SKIP_STATUSES = {"Completed", "Reference"}
CAL_NAME = "OpenDia"
CAL_TZ = "America/New_York"

GOOGLE_CREDS = os.path.join(HOME, ".claude", "mcp-credentials", "google-workspace.json")
GOOGLE_TOKENS = os.path.join(HOME, ".claude", "mcp-credentials", "google-workspace", "tokens.json")
CONFIG_FILE = os.path.join(HOME, "OpenDia", ".opendia-calendar.json")
STATE_FILE = os.path.join(HOME, "OpenDia", ".opendia-calendar-state.json")
LOCK_FILE = os.path.join(HOME, "OpenDia", ".opendia-calendar.lock")
DB_PATH = os.path.join(HOME, "OpenDia", "opendia.db")
DASHBOARD_LOCAL = "http://localhost:8038"
GCAL = "https://www.googleapis.com/calendar/v3"

NEXT_STEP_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}):\s*(.*)$", re.S)

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def notion_token():
    token = os.environ.get("NOTION_API_KEY") or os.environ.get("NOTION_TOKEN")
    if not token:
        try:
            with open(os.path.join(HOME, ".claude.json")) as f:
                token = json.load(f)["mcpServers"]["notion"]["env"]["NOTION_TOKEN"]
        except Exception:
            pass
    if not token:
        sys.exit("NOTION_TOKEN not found")
    return token


def notion_headers(token):
    return {
        "Authorization": f"Bearer {token}",
        "Notion-Version": NOTION_API_VERSION,
        "Content-Type": "application/json",
    }


def google_token():
    """Mint an access token from the MCP server's stored refresh token.
    Read-only: never writes tokens.json (the MCP server owns that file)."""
    with open(GOOGLE_CREDS) as f:
        creds = json.load(f)["installed"]
    with open(GOOGLE_TOKENS) as f:
        tokens = json.load(f)
    # Use the stored access token if it's still comfortably valid
    if tokens.get("expiry_date") and tokens["expiry_date"] / 1000 > datetime.now(timezone.utc).timestamp() + 120:
        return tokens["access_token"]
    resp = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": creds["client_id"],
        "client_secret": creds["client_secret"],
        "refresh_token": tokens["refresh_token"],
        "grant_type": "refresh_token",
    }, timeout=15)
    resp.raise_for_status()
    return resp.json()["access_token"]


# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------
def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def save_json_atomic(path, data):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def norm_dt(s):
    """Normalize an ISO datetime string for comparison."""
    if not s:
        return None
    if len(s) == 10:
        return s  # date-only
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
    except Exception:
        return s


def pair(start, end):
    return (norm_dt(start), norm_dt(end))


# ---------------------------------------------------------------------------
# Google Calendar API
# ---------------------------------------------------------------------------
class GCal:
    def __init__(self, token):
        self.h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    def req(self, method, path, ok=(200,), **kw):
        r = requests.request(method, f"{GCAL}{path}", headers=self.h, timeout=20, **kw)
        if r.status_code not in ok:
            raise RuntimeError(f"{method} {path} -> {r.status_code}: {r.text[:300]}")
        return r.json() if r.text else {}

    def ensure_calendar(self, cfg):
        cal_id = cfg.get("calendar_id")
        if cal_id:
            r = requests.get(f"{GCAL}/calendars/{cal_id}", headers=self.h, timeout=15)
            if r.status_code == 200:
                return cal_id
        # Look for an existing calendar by name
        page = None
        while True:
            params = {"maxResults": 250}
            if page:
                params["pageToken"] = page
            data = self.req("GET", "/users/me/calendarList", params=params)
            for c in data.get("items", []):
                if c.get("summary") == CAL_NAME:
                    return c["id"]
            page = data.get("nextPageToken")
            if not page:
                break
        created = self.req("POST", "/calendars", json={"summary": CAL_NAME, "timeZone": CAL_TZ})
        return created["id"]

    def list_future_opendia_events(self, cal_id):
        events = {}
        page = None
        while True:
            # From start-of-today (not "now") so events that already ended
            # earlier today are still managed instead of re-created each run.
            params = {
                "privateExtendedProperty": "opendia=1",
                "timeMin": datetime.now().astimezone().replace(
                    hour=0, minute=0, second=0, microsecond=0).isoformat(),
                "singleEvents": "true",
                "maxResults": 2500,
                "showDeleted": "false",
            }
            if page:
                params["pageToken"] = page
            data = self.req("GET", f"/calendars/{cal_id}/events", params=params)
            for e in data.get("items", []):
                events[e["id"]] = e
            page = data.get("nextPageToken")
            if not page:
                break
        return events


def gdates(event):
    """(start, end) strings from a Google event, date or dateTime."""
    s = event.get("start", {})
    e = event.get("end", {})
    return (s.get("date") or s.get("dateTime"), e.get("date") or e.get("dateTime"))


def notion_shape(event, base_rec):
    """Convert a Google event's dates to Notion Due Date shape so both sides
    compare (and write back) in the same terms:
    - all-day: Google end is EXCLUSIVE -> inclusive; single-day -> end None
    - timed: our display default adds start+1h when Notion had no end —
      collapse that back to None so it never reads as a change."""
    g_start, g_end = gdates(event)
    if g_start and len(g_start) == 10:
        end_incl = (date.fromisoformat(g_end) - timedelta(days=1)).isoformat() if g_end else g_start
        return g_start, (None if end_incl <= g_start else end_incl)
    end = g_end
    if base_rec and base_rec.get("end") is None and g_start and g_end:
        try:
            if datetime.fromisoformat(g_end) - datetime.fromisoformat(g_start) == timedelta(hours=1):
                end = None
        except Exception:
            pass
    return g_start, end


# ---------------------------------------------------------------------------
# Desired events
# ---------------------------------------------------------------------------
def query_notion_tasks(token, today_iso):
    url = f"https://api.notion.com/v1/databases/{TASKS_DB_ID}/query"
    status_filters = [{"property": "Status", "select": {"does_not_equal": s}} for s in SKIP_STATUSES]
    flt = {"and": status_filters + [{"property": "Due Date", "date": {"on_or_after": today_iso}}]}
    results, cursor = [], None
    while True:
        body = {"filter": flt, "page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        r = requests.post(url, headers=notion_headers(token), json=body, timeout=20)
        r.raise_for_status()
        d = r.json()
        results.extend(d.get("results", []))
        if not d.get("has_more"):
            break
        cursor = d.get("next_cursor")
    return results


def title_of(props):
    for v in props.values():
        if v.get("type") == "title":
            return "".join(i.get("plain_text", "") for i in v.get("title", []))
    return ""


def load_db_maps():
    """notion_id -> card row, plus cards with dated next_steps."""
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT p.id, p.name, p.status, p.next_step, p.notion_id,
               COALESCE(c.short_name, c.name) AS company
        FROM projects p LEFT JOIN companies c ON p.company_id = c.id
    """).fetchall()
    conn.close()
    by_notion = {r["notion_id"]: r for r in rows if r["notion_id"]}
    next_steps = []
    for r in rows:
        if r["status"] not in ("in_progress", "wfhuman"):
            continue
        m = NEXT_STEP_RE.match(r["next_step"] or "")
        if m:
            next_steps.append((r, m.group(1), m.group(2).strip()))
    return by_notion, next_steps


def event_body(summary, start, end, description, kind, color=None):
    body = {
        "summary": summary,
        "description": description,
        "extendedProperties": {"private": {"opendia": "1", "kind": kind}},
    }
    if color:
        body["colorId"] = color
    if len(start) == 10:  # all-day
        end_date = end if end and len(end) == 10 else start
        # Google all-day end is exclusive
        excl = (date.fromisoformat(end_date) + timedelta(days=1)).isoformat()
        body["start"] = {"date": start}
        body["end"] = {"date": excl}
    else:
        if not end or len(end) == 10:
            end = (datetime.fromisoformat(start.replace("Z", "+00:00")) + timedelta(hours=1)).isoformat()
        body["start"] = {"dateTime": start}
        body["end"] = {"dateTime": end}
    return body


def build_desired(token, cfg, today_iso):
    base_url = (cfg.get("base_url") or "").rstrip("/")
    by_notion, next_steps = load_db_maps()
    desired = {}  # event_id -> dict

    company_cache = {}
    for page in query_notion_tasks(token, today_iso):
        pid = page["id"]
        props = page.get("properties", {})
        d = (props.get("Due Date") or {}).get("date") or {}
        start, end = d.get("start"), d.get("end")
        if not start:
            continue
        name = title_of(props)
        card = by_notion.get(pid)
        company = card["company"] if card and card["company"] else None
        if company is None:
            rel = (props.get("Company") or {}).get("relation") or []
            if rel:
                cid = rel[0]["id"]
                if cid not in company_cache:
                    try:
                        r = requests.get(f"https://api.notion.com/v1/pages/{cid}",
                                         headers=notion_headers(token), timeout=10)
                        company_cache[cid] = title_of(r.json().get("properties", {})) if r.ok else ""
                    except Exception:
                        company_cache[cid] = ""
                company = company_cache[cid]
        summary = f"{company} — {name}" if company else name
        lines = []
        if card and base_url:
            lines.append(f"Card: {base_url}/?project={card['id']}")
        lines.append(f"Notion: https://www.notion.so/{pid.replace('-', '')}")
        eid = "od" + pid.replace("-", "")
        desired[eid] = {
            "kind": "task",
            "notion_id": pid,
            "start": start,
            "end": end,
            "last_edited": page.get("last_edited_time"),
            "body": event_body(summary, start, end, "\n".join(lines), "task"),
        }

    for row, ds, action in next_steps:
        if ds < today_iso:
            continue
        summary = f"→ {row['company']} — {action}" if row["company"] else f"→ {action}"
        if len(summary) > 120:
            summary = summary[:117] + "…"
        lines = []
        if base_url:
            lines.append(f"Card: {base_url}/?project={row['id']}")
        if row["notion_id"]:
            lines.append(f"Notion: https://www.notion.so/{row['notion_id'].replace('-', '')}")
        eid = f"odns{row['id']}"
        desired[eid] = {
            "kind": "next_step",
            "card_id": row["id"],
            "action": action,
            "start": ds,
            "end": None,
            "last_edited": None,  # sqlite updated_at is touched by unrelated field edits; don't trust for tie-breaks
            "body": event_body(summary, ds, None, "\n".join(lines), "next_step", color="6"),
        }
    return desired


# ---------------------------------------------------------------------------
# Push-back writers (Google -> Notion / card)
# ---------------------------------------------------------------------------
def push_back_task(token, item, start, end):
    """Write a Google-side date move into the Notion task's Due Date.
    start/end arrive already converted to Notion shape (notion_shape)."""
    r = requests.patch(
        f"https://api.notion.com/v1/pages/{item['notion_id']}",
        headers=notion_headers(token),
        json={"properties": {"Due Date": {"date": {"start": start, "end": end}}}},
        timeout=15,
    )
    r.raise_for_status()
    return start, end


def push_back_next_step(item, g_start):
    """Rewrite the card's next_step date prefix via the dashboard API."""
    new_date = g_start[:10]
    r = requests.patch(
        f"{DASHBOARD_LOCAL}/api/projects/{item['card_id']}",
        json={"next_step": f"{new_date}: {item['action']}"},
        timeout=10,
    )
    r.raise_for_status()
    return new_date, None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    lock = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(f"[{datetime.now().isoformat(timespec='seconds')}] another sync is running; skipped")
        return

    today_iso = date.today().isoformat()
    ntoken = notion_token()
    cfg = load_json(CONFIG_FILE, {})
    state = load_json(STATE_FILE, {})

    cal = GCal(google_token())
    cal_id = cal.ensure_calendar(cfg)
    if cfg.get("calendar_id") != cal_id:
        cfg["calendar_id"] = cal_id
        save_json_atomic(CONFIG_FILE, cfg)

    desired = build_desired(ntoken, cfg, today_iso)
    google = cal.list_future_opendia_events(cal_id)

    created = updated = pushed_back = deleted = conflicts = 0
    new_state = {}

    for eid, item in desired.items():
        want = pair(item["start"], item["end"])
        have_event = google.get(eid)
        base_rec = state.get(eid)
        base = pair(base_rec.get("start"), base_rec.get("end")) if base_rec else None

        if not have_event:
            if not args.dry_run:
                body = dict(item["body"], id=eid)
                try:
                    cal.req("POST", f"/calendars/{cal_id}/events", ok=(200,), json=body)
                except RuntimeError as e:
                    if "409" in str(e):  # id exists but event was cancelled -> revive via update
                        cal.req("PUT", f"/calendars/{cal_id}/events/{eid}", json=item["body"])
                    else:
                        raise
            created += 1
            new_state[eid] = {"start": item["start"], "end": item["end"]}
            continue

        g_shaped = notion_shape(have_event, base_rec)
        have = pair(*g_shaped)
        notion_changed = want != (base if base else want)
        google_changed = have != (base if base else have)
        if base is None and want != have:
            # No base to arbitrate — treat as both-changed and use timestamps
            notion_changed = google_changed = True

        final = item["start"], item["end"]

        def apply_google_side():
            if item["kind"] == "task":
                return push_back_task(ntoken, item, g_shaped[0], g_shaped[1])
            return push_back_next_step(item, g_shaped[0])

        if want == have:
            pass  # dates agree; still refresh summary/description if stale
        elif notion_changed and not google_changed:
            if not args.dry_run:
                cal.req("PATCH", f"/calendars/{cal_id}/events/{eid}", json=item["body"])
            updated += 1
        elif google_changed and not notion_changed:
            if not args.dry_run:
                final = apply_google_side()
            else:
                final = g_shaped
            pushed_back += 1
        else:  # both changed -> newer edit wins
            conflicts += 1
            g_updated = have_event.get("updated", "")
            n_edited = item.get("last_edited") or ""
            if n_edited >= g_updated:
                if not args.dry_run:
                    cal.req("PATCH", f"/calendars/{cal_id}/events/{eid}", json=item["body"])
                updated += 1
                winner = "notion"
            else:
                if not args.dry_run:
                    final = apply_google_side()
                else:
                    final = g_shaped
                pushed_back += 1
                winner = "google"
            print(f"  CONFLICT {eid}: both sides moved; {winner} won")

        # Keep summary/description fresh when dates already agree
        if want == have and not args.dry_run:
            if (have_event.get("summary") != item["body"]["summary"]
                    or (have_event.get("description") or "") != item["body"]["description"]):
                cal.req("PATCH", f"/calendars/{cal_id}/events/{eid}", json={
                    "summary": item["body"]["summary"],
                    "description": item["body"]["description"],
                })

        new_state[eid] = {"start": final[0], "end": final[1]}

    # Removal pass: future OpenDia events no longer desired
    for eid, ev in google.items():
        if eid not in desired:
            if not args.dry_run:
                cal.req("DELETE", f"/calendars/{cal_id}/events/{eid}", ok=(200, 204, 410))
            deleted += 1

    if not args.dry_run:
        save_json_atomic(STATE_FILE, new_state)

    ts = datetime.now().isoformat(timespec="seconds")
    print(f"[{ts}] events={len(desired)} created={created} updated={updated} "
          f"pushed_back={pushed_back} deleted={deleted} conflicts={conflicts}"
          f"{' (dry-run)' if args.dry_run else ''}")


if __name__ == "__main__":
    main()
