#!/usr/bin/env python3
"""Standalone Notion deadline checker — no MCP dependency.

Queries the Tasks database for overdue and imminent tasks.
Outputs JSON to stdout.

Usage:
    python3 deadline_check.py                  # overdue + due within 24h
    python3 deadline_check.py --hours 4        # overdue + due within 4h
    python3 deadline_check.py --hours 72       # overdue + due within 72h (3 days)
    python3 deadline_check.py --hello          # hello mode: 3-day window, 3-bucket output

Exit codes: 0 = success, 1 = error
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
from opendia_config import get_id  # noqa: E402

TASKS_DB_ID = get_id("NOTION_TASKS_DB_ID")
NOTION_API_VERSION = "2022-06-28"
LOOKBACK_DAYS = 90
SKIP_STATUSES = {"Completed", "Reference"}

def get_token():
    token = os.environ.get("NOTION_API_KEY") or os.environ.get("NOTION_TOKEN")
    if not token:
        # Current location since the 2026-08-05 MCP migration: one env file per server.
        try:
            with open(os.path.expanduser("~/.claude/mcp-credentials/notion.env")) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    if key.strip() in ("NOTION_TOKEN", "NOTION_API_KEY"):
                        token = val.strip().strip('"').strip("'")
                        break
        except Exception:
            pass
    if not token:
        # Legacy fallback: pre-migration stdio MCP config.
        try:
            import json as _json
            claude_cfg = os.path.expanduser("~/.claude.json")
            with open(claude_cfg) as f:
                d = _json.load(f)
            token = d["mcpServers"]["notion"]["env"]["NOTION_TOKEN"]
        except Exception:
            pass
    if not token:
        print(json.dumps({"error": "NOTION_TOKEN not found"}))
        sys.exit(1)
    return token

def headers(token):
    return {
        "Authorization": f"Bearer {token}",
        "Notion-Version": NOTION_API_VERSION,
        "Content-Type": "application/json",
    }

# ---------------------------------------------------------------------------
# Notion query helpers
# ---------------------------------------------------------------------------
def query_tasks(token, after_date: datetime, before_date: datetime):
    """Query Tasks DB: status not in skip set, due date in [after, before]."""
    url = f"https://api.notion.com/v1/databases/{TASKS_DB_ID}/query"

    # Status is a select property in this DB (not status type)
    status_filters = [
        {"property": "Status", "select": {"does_not_equal": s}}
        for s in SKIP_STATUSES
    ]

    date_filter = {
        "and": [
            {
                "property": "Due Date",
                "date": {"on_or_after": after_date.isoformat()}
            },
            {
                "property": "Due Date",
                "date": {"on_or_before": before_date.isoformat()}
            },
        ]
    }

    filter_payload = {
        "and": status_filters + [date_filter]
    }

    results = []
    cursor = None
    while True:
        body = {"filter": filter_payload, "page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        resp = requests.post(url, headers=headers(token), json=body, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        results.extend(data.get("results", []))
        if not data.get("has_more"):
            break
        cursor = data.get("next_cursor")
    return results

def resolve_company(token, page_id: str) -> str:
    """Fetch company name from a Notion page ID."""
    url = f"https://api.notion.com/v1/pages/{page_id}"
    try:
        resp = requests.get(url, headers=headers(token), timeout=10)
        resp.raise_for_status()
        props = resp.json().get("properties", {})
        # Try common name properties
        for key in ("Name", "Company Name", "Title", "title"):
            val = props.get(key)
            if val:
                if val.get("type") == "title":
                    items = val.get("title", [])
                    if items:
                        return items[0].get("plain_text", "")
    except Exception:
        pass
    return ""

# ---------------------------------------------------------------------------
# Property extraction
# ---------------------------------------------------------------------------
def extract_text(prop) -> str:
    if not prop:
        return ""
    t = prop.get("type", "")
    if t == "title":
        items = prop.get("title", [])
    elif t == "rich_text":
        items = prop.get("rich_text", [])
    else:
        return ""
    return "".join(i.get("plain_text", "") for i in items)

def extract_status(prop) -> str:
    if not prop:
        return ""
    s = prop.get("select") or prop.get("status") or {}
    return s.get("name", "") if s else ""

def extract_select(prop) -> str:
    if not prop:
        return ""
    s = prop.get("select", {})
    return s.get("name", "") if s else ""

def extract_people(prop) -> list:
    if not prop:
        return []
    return [p.get("name", "") for p in prop.get("people", [])]

def extract_date(prop):
    """Returns (start_str, end_str) or (None, None)."""
    if not prop:
        return None, None
    d = prop.get("date")
    if not d:
        return None, None
    return d.get("start"), d.get("end")

def extract_relation_ids(prop) -> list:
    if not prop:
        return []
    return [r.get("id", "") for r in prop.get("relation", [])]

def parse_notion_dt(s: str) -> datetime:
    """Parse a Notion date string to UTC-aware datetime."""
    if not s:
        return None
    # Date-only: YYYY-MM-DD
    if len(s) == 10:
        return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
    # Datetime with tz offset or Z
    s = s.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s).astimezone(timezone.utc)
    except Exception:
        return None

# ---------------------------------------------------------------------------
# Build task record
# ---------------------------------------------------------------------------
def build_record(page, token, company_cache: dict) -> dict:
    props = page.get("properties", {})

    name = extract_text(props.get("Name") or props.get("Task Name") or props.get("title") or {})
    # Try all title-type props if name is empty
    if not name:
        for v in props.values():
            if v.get("type") == "title":
                name = extract_text(v)
                if name:
                    break

    status = extract_status(props.get("Status", {}))
    priority = extract_select(props.get("Priority", {}))
    responsible = extract_people(props.get("Responsible", {}))
    due_start, due_end = extract_date(props.get("Due Date", {}))

    # Company from relation
    company = ""
    company_ids = extract_relation_ids(props.get("Company", props.get("Company Name", {})))
    if company_ids:
        cid = company_ids[0]
        if cid not in company_cache:
            company_cache[cid] = resolve_company(token, cid)
        company = company_cache[cid]

    return {
        "id": page["id"],
        "name": name,
        "company": company,
        "due_start": due_start,
        "due_end": due_end,
        "status": status,
        "priority": priority,
        "responsible": responsible,
    }

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hours", type=float, default=24.0,
                        help="Forward window in hours (default: 24)")
    parser.add_argument("--hello", action="store_true",
                        help="Hello mode: 72h forward window, bucket output")
    args = parser.parse_args()

    if args.hello:
        forward_hours = 72.0
    else:
        forward_hours = args.hours

    token = get_token()
    now = datetime.now(timezone.utc)
    lookback = now - timedelta(days=LOOKBACK_DAYS)
    forward = now + timedelta(hours=forward_hours)

    try:
        pages = query_tasks(token, lookback, forward)
    except requests.HTTPError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    company_cache = {}
    records = [build_record(p, token, company_cache) for p in pages]

    # Bucket
    overdue = []
    today_tasks = []
    upcoming = []

    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_end = today_start + timedelta(days=1)

    for r in records:
        if not r["due_start"]:
            continue
        # Use end time if available for overdue check, else start
        ref_dt = parse_notion_dt(r["due_end"] or r["due_start"])
        start_dt = parse_notion_dt(r["due_start"])
        if ref_dt is None or start_dt is None:
            continue

        if ref_dt < now:
            overdue.append(r)
        elif today_start <= start_dt < today_end:
            today_tasks.append(r)
        elif now <= start_dt < now + timedelta(hours=forward_hours):
            upcoming.append(r)

    output = {
        "generated": now.isoformat(),
        "overdue": overdue,
        "today": today_tasks if args.hello else [],
        "imminent": today_tasks + upcoming if not args.hello else upcoming,
    }

    print(json.dumps(output, indent=2, default=str))


if __name__ == "__main__":
    main()
