#!/usr/bin/env python3
"""Timer hygiene report: billed time vs wall-clock engagement span.

READ THIS BEFORE TRUSTING THE NUMBERS.

This is NOT an estimate-accuracy report, and it cannot be one. OpenDia timers
are open engagements, not stopwatches — a timer runs from /od-go to /od-stop
and may span lunch, a weekend, or several days. `estimated_minutes` (what gets
billed) is the human judgment of actual work time; `duration` is just the wall
clock between start and stop. There is NO ground-truth record of real work
time anywhere in the system, so "am I under-quoting?" is genuinely unanswerable
from this data. Ratios of 3-5x are normal and mean nothing on their own.

What this DOES surface is timer hygiene: entries whose wall-clock span is so
far beyond the billed estimate that a timer was almost certainly left running.
Those are worth finding — they pollute any future attempt to measure real work
time, and they make the ledger harder to defend if a client ever asks.

If you want real estimate accuracy, the system has to start capturing actual
work time as a first-class field (e.g. /od-stop asking "how long was this
really?"). That's a product change, not a report.

Usage:
  estimate_variance.py                     # trailing 6 months
  estimate_variance.py --months 12
  estimate_variance.py --from 2026-01 --to 2026-06
  estimate_variance.py --by division
  estimate_variance.py --json
"""

import argparse
import json
import sys
from collections import defaultdict
from datetime import date

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from timeentry import load_month_entries  # noqa: E402


def month_range(from_ym, to_ym):
    y, m = map(int, from_ym.split("-"))
    ty, tm = map(int, to_ym.split("-"))
    out = []
    while (y, m) <= (ty, tm):
        out.append((y, m))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def shift_months(y, m, delta):
    total = y * 12 + (m - 1) + delta
    return total // 12, total % 12 + 1


def collect(months):
    entries = []
    for y, m in months:
        entries.extend(load_month_entries(y, m))
    # Only closed, billable entries with a real estimate tell us anything.
    return [e for e in entries if e["estimated_minutes"] > 0 and e["duration_minutes"] > 0]


def summarize(entries, key):
    groups = defaultdict(list)
    for e in entries:
        groups[e[key] or "(none)"].append(e)

    rows = []
    for name, items in groups.items():
        est = sum(i["estimated_minutes"] for i in items)
        act = sum(i["duration_minutes"] for i in items)
        rows.append({
            key: name,
            "entries": len(items),
            "estimated_hours": round(est / 60, 1),
            "actual_hours": round(act / 60, 1),
            "ratio": round(act / est, 2) if est else 0.0,
            "delta_hours": round((act - est) / 60, 1),
        })
    return sorted(rows, key=lambda r: -abs(r["delta_hours"]))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--months", type=int, default=6, help="trailing months (default 6)")
    ap.add_argument("--from", dest="from_ym", help="start month YYYY-MM")
    ap.add_argument("--to", dest="to_ym", help="end month YYYY-MM")
    ap.add_argument("--by", choices=["client", "division", "month"], default="client")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    today = date.today()
    if args.from_ym:
        to_ym = args.to_ym or f"{today.year:04d}-{today.month:02d}"
        months = month_range(args.from_ym, to_ym)
    else:
        start = shift_months(today.year, today.month, -(args.months - 1))
        months = month_range(f"{start[0]:04d}-{start[1]:02d}", f"{today.year:04d}-{today.month:02d}")

    entries = collect(months)
    if not entries:
        print("No entries with both an estimate and a recorded duration in that range.")
        return

    key = "date" if args.by == "month" else args.by
    if args.by == "month":
        for e in entries:
            e["date"] = e["date"][:7]

    rows = summarize(entries, key)
    total_est = sum(e["estimated_minutes"] for e in entries) / 60
    total_act = sum(e["duration_minutes"] for e in entries) / 60
    overall = total_act / total_est if total_est else 0

    if args.json:
        print(json.dumps({
            "months": [f"{y:04d}-{m:02d}" for y, m in months],
            "entries": len(entries),
            "estimated_hours": round(total_est, 1),
            "actual_hours": round(total_act, 1),
            "overall_ratio": round(overall, 2),
            "rows": rows,
        }, indent=2))
        return

    span = f"{months[0][0]:04d}-{months[0][1]:02d} → {months[-1][0]:04d}-{months[-1][1]:02d}"
    print(f"\nTimer hygiene — {span}  ({len(entries)} closed entries)")
    print(f"Billed: {total_est:.1f}h    Wall-clock span: {total_act:.1f}h    Ratio: {overall:.2f}x")
    print("NB: wall clock is engagement span, not work time. Ratios >1 are normal;")
    print("    this finds timers left running, NOT estimate accuracy.\n")

    label = args.by.capitalize()
    print(f"{label:<28} {'Entries':>7} {'Est h':>7} {'Actual h':>9} {'Ratio':>7} {'Delta h':>8}")
    print("-" * 72)
    for r in rows:
        flag = "  <<" if r["ratio"] >= 8.0 and r["entries"] >= 3 else ""
        print(f"{str(r[key])[:28]:<28} {r['entries']:>7} {r['estimated_hours']:>7} "
              f"{r['actual_hours']:>9} {r['ratio']:>6}x {r['delta_hours']:>8}{flag}")

    outliers = [r for r in rows if r["ratio"] >= 8.0 and r["entries"] >= 3]
    if outliers:
        print(f"\n<< {len(outliers)} run 8x+ past the billed time across 3+ entries —")
        print("   almost certainly timers left running, not work actually happening.")
        print("   Worth spot-checking the longest entries for these clients.")


if __name__ == "__main__":
    main()
