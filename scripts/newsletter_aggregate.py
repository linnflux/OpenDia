#!/usr/bin/env python3
"""
newsletter_aggregate.py — pull timer data for a date range and output JSON.
Notion queries happen in the skill prompt (MCP-only).

Usage:
    python3 newsletter_aggregate.py --from YYYY-MM-DD --to YYYY-MM-DD
"""

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from monthly_billing import parse_entries_from_file

TIMER_BASE = os.path.expanduser("~/OpenDia/Time")
MAX_RANGE_DAYS = 92


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--from", dest="from_date", required=True)
    p.add_argument("--to", dest="to_date", required=True)
    return p.parse_args()


def validate_range(from_str, to_str):
    try:
        from_d = date.fromisoformat(from_str)
        to_d = date.fromisoformat(to_str)
    except ValueError as e:
        sys.exit(f"Invalid date: {e}")
    if from_d > to_d:
        sys.exit(f"--from {from_str} is after --to {to_str}")
    if (to_d - from_d).days > MAX_RANGE_DAYS:
        sys.exit(f"Range exceeds {MAX_RANGE_DAYS} days")
    return from_d, to_d


def collect_timers(from_d, to_d):
    entries = []
    cur = from_d
    while cur <= to_d:
        fp = os.path.join(
            TIMER_BASE,
            f"{cur.year:04d}",
            f"{cur.month:02d}",
            f"{cur.isoformat()}.md",
        )
        if os.path.isfile(fp):
            try:
                entries.extend(parse_entries_from_file(fp))
            except Exception:
                pass
        cur += timedelta(days=1)

    by_client = defaultdict(lambda: {
        "total_minutes": 0,
        "billable": False,
        "divisions": set(),
        "tasks": [],
    })
    for e in entries:
        c = e["client"]
        by_client[c]["total_minutes"] += e["estimated_minutes"]
        if e["billable"]:
            by_client[c]["billable"] = True
        if e["division"]:
            by_client[c]["divisions"].add(e["division"])
        task = e["task"]
        if task and task not in by_client[c]["tasks"]:
            by_client[c]["tasks"].append(task)

    result = []
    for client, data in sorted(by_client.items()):
        result.append({
            "client": client,
            "total_minutes": data["total_minutes"],
            "billable": data["billable"],
            "divisions": sorted(data["divisions"]),
            "tasks": data["tasks"][:10],
        })
    return result, len(entries)


def main():
    args = parse_args()
    from_d, to_d = validate_range(args.from_date, args.to_date)

    timer_summary, timer_count = collect_timers(from_d, to_d)

    print(json.dumps({
        "range": {"from": from_d.isoformat(), "to": to_d.isoformat()},
        "timer_summary": timer_summary,
        "stats": {
            "timer_entries": timer_count,
        },
    }, indent=2))


if __name__ == "__main__":
    main()
