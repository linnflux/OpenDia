#!/usr/bin/env python3
"""Monthly billing summary from OpenDia timer files.

Parses timer entries for a given month, groups by client, and optionally
writes the data to the "OpenDia" tab in the billing Google Sheet.

Usage:
    python3 monthly_billing.py                        # last month, stdout only
    python3 monthly_billing.py --month 2026-03        # specific month
    python3 monthly_billing.py --write-sheet           # write to Google Sheets
    python3 monthly_billing.py --clear-only            # clear the OpenDia tab only
"""

import argparse
import glob
import json
import math
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta

TIMER_BASE = os.path.expanduser("~/OpenDia/Time")
CREDENTIALS_PATH = os.path.expanduser("~/.claude/mcp-credentials/google-workspace.json")
TOKENS_PATH = os.path.expanduser("~/.claude/mcp-credentials/google-workspace/tokens.json")
DB_PATH = os.path.expanduser("~/OpenDia/opendia.db")
SPREADSHEET_ID = "1VowYnKQG3lM-RZIVqgtlCHc2QSx364epvdiRlSMsLFY"
TAB_NAME = "OpenDia"


# ---------------------------------------------------------------------------
# Timer file parsing — shared parser (repo/scripts/timeentry.py)
# ---------------------------------------------------------------------------
from timeentry import parse_entries_from_file  # noqa: E402

def load_month_entries(year, month):
    """Load all entries for the given year/month."""
    month_dir = os.path.join(TIMER_BASE, f"{year:04d}", f"{month:02d}")
    pattern = os.path.join(month_dir, "*.md")
    files = sorted(glob.glob(pattern))

    if not files:
        print(f"No timer files found in {month_dir}", file=sys.stderr)
        return []

    all_entries = []
    for fp in files:
        all_entries.extend(parse_entries_from_file(fp))

    return all_entries


# ---------------------------------------------------------------------------
# Client name canonicalization (against SQLite companies table)
# ---------------------------------------------------------------------------

# Bogus short_name values seen in the DB that should not be used for matching.
_BOGUS_SHORT_NAMES = {"", "none", "--short-name", "null"}


def load_company_index():
    """Return (name_index, short_index, all_names) from the companies table.

    Indexes map lowercased keys to the canonical `name`. If the DB is missing or
    unreadable the script falls back to using raw client names (no normalization).
    """
    if not os.path.exists(DB_PATH):
        return {}, {}, []
    try:
        import sqlite3
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute("SELECT name, short_name FROM companies").fetchall()
        conn.close()
    except Exception as e:
        print(f"Warning: could not load companies from {DB_PATH}: {e}", file=sys.stderr)
        return {}, {}, []

    name_index = {}
    short_index = {}
    all_names = []
    for name, short_name in rows:
        if not name:
            continue
        canonical = name.strip()
        all_names.append(canonical)
        name_index[canonical.lower()] = canonical
        if short_name and short_name.strip().lower() not in _BOGUS_SHORT_NAMES:
            short_index[short_name.strip().lower()] = canonical
    return name_index, short_index, all_names


def canonicalize_client(raw, name_index, short_index, all_names):
    """Map a raw client string to the canonical company name, or None on no match.

    Match order: exact name, exact short_name, unambiguous substring (one direction
    or the other). Multiple ambiguous matches → None to avoid silent merges.
    """
    if not raw:
        return None
    key = raw.strip().lower()
    if key in name_index:
        return name_index[key]
    if key in short_index:
        return short_index[key]
    matches = set()
    for db_name in all_names:
        db_lower = db_name.lower()
        if key in db_lower or db_lower in key:
            matches.add(db_name)
    if len(matches) == 1:
        return matches.pop()
    return None


def normalize_entries(entries):
    """Rewrite entry['client'] to its canonical DB form. Warns on unmatched names."""
    name_index, short_index, all_names = load_company_index()
    if not name_index:
        return entries  # DB unavailable — leave raw names alone
    unmatched = set()
    for e in entries:
        raw = e["client"]
        canonical = canonicalize_client(raw, name_index, short_index, all_names)
        if canonical is None:
            unmatched.add(raw)
        elif canonical != raw:
            e["client"] = canonical
    if unmatched:
        print(
            f"Warning: {len(unmatched)} client name(s) not found in companies DB: "
            f"{sorted(unmatched)}",
            file=sys.stderr,
        )
    return entries


def group_by_client(entries):
    """Group entries by client name (alphabetical), sorted by date within each."""
    by_client = defaultdict(list)
    for e in entries:
        by_client[e["client"]].append(e)

    # Sort each client's entries by date
    for client in by_client:
        by_client[client].sort(key=lambda e: e["date"])

    # Return as ordered list of (client, entries) tuples
    return sorted(by_client.items(), key=lambda x: x[0].lower())


# ---------------------------------------------------------------------------
# Console output
# ---------------------------------------------------------------------------

def print_summary(grouped, year, month):
    """Print a formatted summary to stdout."""
    print(f"\n{'='*70}")
    print(f"  OpenDia Billing Summary — {year:04d}-{month:02d}")
    print(f"{'='*70}\n")

    grand_total = 0

    for client, entries in grouped:
        client_total = sum(e["estimated_minutes"] for e in entries)
        grand_total += client_total

        print(f"  {client}")
        print(f"  {'-'*50}")
        for e in entries:
            bill = "Y" if e["billable"] else "N"
            print(f"    {e['date']}  {e['division']:<14} {e['task']:<30} {e['estimated_minutes']:>4}m  [{bill}]")
        print(f"  {'':>48} ------")
        print(f"  {'':>48} {client_total:>4}m")
        print()

    print(f"  {'='*50}")
    print(f"  GRAND TOTAL{' ':>35} {grand_total:>4}m")
    print(f"  {'='*50}\n")


# ---------------------------------------------------------------------------
# Google Sheets integration
# ---------------------------------------------------------------------------

def get_sheets_service():
    """Build and return an authenticated Google Sheets service."""
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    with open(CREDENTIALS_PATH) as f:
        creds_data = json.load(f)
    with open(TOKENS_PATH) as f:
        tokens = json.load(f)

    client_config = creds_data["installed"]
    creds = Credentials(
        token=tokens.get("access_token"),
        refresh_token=tokens.get("refresh_token"),
        token_uri=client_config["token_uri"],
        client_id=client_config["client_id"],
        client_secret=client_config["client_secret"],
        scopes=[
            "https://www.googleapis.com/auth/drive.readonly",
            "https://www.googleapis.com/auth/spreadsheets",
        ],
    )
    return build("sheets", "v4", credentials=creds)


def ensure_tab_exists(service, spreadsheet_id, tab_name):
    """Create the tab if it doesn't already exist. Returns True if it existed."""
    meta = service.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    for sheet in meta.get("sheets", []):
        if sheet["properties"]["title"] == tab_name:
            return True

    # Create the tab
    service.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={
            "requests": [{
                "addSheet": {
                    "properties": {"title": tab_name}
                }
            }]
        },
    ).execute()
    return False


def clear_tab(service, spreadsheet_id, tab_name):
    """Clear all data from the tab."""
    ensure_tab_exists(service, spreadsheet_id, tab_name)
    service.spreadsheets().values().clear(
        spreadsheetId=spreadsheet_id,
        range=f"'{tab_name}'",
        body={},
    ).execute()


def get_sheet_id(service, spreadsheet_id, tab_name):
    """Get the numeric sheetId for a tab by name."""
    meta = service.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    for sheet in meta.get("sheets", []):
        if sheet["properties"]["title"] == tab_name:
            return sheet["properties"]["sheetId"]
    return None


def apply_formatting(service, spreadsheet_id, tab_name, header_row, data_end_row, col_count):
    """Add filter and banded coloring to the data range."""
    sheet_id = get_sheet_id(service, spreadsheet_id, tab_name)
    if sheet_id is None:
        return

    requests = [
        # Add filter on the header row through end of data
        {
            "setBasicFilter": {
                "filter": {
                    "range": {
                        "sheetId": sheet_id,
                        "startRowIndex": header_row,
                        "endRowIndex": data_end_row,
                        "startColumnIndex": 0,
                        "endColumnIndex": col_count,
                    }
                }
            }
        },
        # Add banded (alternating) row colors
        {
            "addBanding": {
                "bandedRange": {
                    "range": {
                        "sheetId": sheet_id,
                        "startRowIndex": header_row,
                        "endRowIndex": data_end_row,
                        "startColumnIndex": 0,
                        "endColumnIndex": col_count,
                    },
                    "rowProperties": {
                        "headerColor": {
                            "red": 0.24, "green": 0.52, "blue": 0.78, "alpha": 1.0,
                        },
                        "firstBandColor": {
                            "red": 1.0, "green": 1.0, "blue": 1.0, "alpha": 1.0,
                        },
                        "secondBandColor": {
                            "red": 0.93, "green": 0.95, "blue": 0.97, "alpha": 1.0,
                        },
                    },
                }
            }
        },
        # Bold + white text on header row
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": header_row,
                    "endRowIndex": header_row + 1,
                    "startColumnIndex": 0,
                    "endColumnIndex": col_count,
                },
                "cell": {
                    "userEnteredFormat": {
                        "textFormat": {
                            "bold": True,
                            "foregroundColor": {
                                "red": 1.0, "green": 1.0, "blue": 1.0,
                            },
                        },
                    }
                },
                "fields": "userEnteredFormat.textFormat",
            }
        },
    ]

    service.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={"requests": requests},
    ).execute()


def write_to_sheet(service, spreadsheet_id, tab_name, grouped, year, month):
    """Write billing data to the OpenDia tab."""
    ensure_tab_exists(service, spreadsheet_id, tab_name)

    # Clear existing data first
    service.spreadsheets().values().clear(
        spreadsheetId=spreadsheet_id,
        range=f"'{tab_name}'",
        body={},
    ).execute()

    # Remove any existing banded ranges and filters
    sheet_id = get_sheet_id(service, spreadsheet_id, tab_name)
    if sheet_id is not None:
        meta = service.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
        cleanup_requests = []
        for sheet in meta.get("sheets", []):
            if sheet["properties"]["sheetId"] == sheet_id:
                for br in sheet.get("bandedRanges", []):
                    cleanup_requests.append({
                        "deleteBanding": {"bandedRangeId": br["bandedRangeId"]}
                    })
                if sheet.get("basicFilter"):
                    cleanup_requests.append({
                        "clearBasicFilter": {"sheetId": sheet_id}
                    })
        if cleanup_requests:
            service.spreadsheets().batchUpdate(
                spreadsheetId=spreadsheet_id,
                body={"requests": cleanup_requests},
            ).execute()

    # Pre-compute totals and notes for subtotals table
    grand_total = 0
    grand_billable = 0
    client_summaries = []
    for client, entries in grouped:
        client_total = sum(e["estimated_minutes"] for e in entries)
        client_billable = sum(e["estimated_minutes"] for e in entries if e["billable"])
        grand_total += client_total
        grand_billable += client_billable

        seen = []
        for e in entries:
            task = e["task"]
            summary = e.get("summary", "")
            line = f"{task} — {summary}" if summary else task
            if line not in seen:
                seen.append(line)
        notes = "; ".join(seen)
        client_summaries.append((client, client_total, client_billable, notes))

    # Build month display name
    from datetime import date as _date
    month_name = _date(year, month, 1).strftime("%B %Y")

    # Monthly tab name for cross-reference formulas
    month_tab = f"{year:04d}-{month:02d}"

    # Build rows — header row, blank, then subtotals
    rows = [
        [],
        ["OpenDia", "/monthly-billing", "Output for", month_name],
        [],
        ["Company", "Total Minutes", "Hours", "Notes", "Billable OD Hours", "Human Hours", "Total Hours", "Est. Hours"],
    ]
    subtotals_header_row = 3  # 0-indexed

    for client, client_total, client_billable, notes in client_summaries:
        row_num = len(rows) + 1  # 1-indexed sheet row
        # Formula: VLOOKUP col B (Hours) + VLOOKUP col I (Build Hours) from monthly tab
        human_hours_formula = (
            f"=IFERROR(VLOOKUP(A{row_num},'{month_tab}'!A:B,2,FALSE),0)"
            f"+IFERROR(VLOOKUP(A{row_num},'{month_tab}'!A:I,9,FALSE),0)"
        )
        # Total Hours bills only billable OD time + human-tracked hours
        total_hours_formula = f"=E{row_num}+F{row_num}"
        rows.append([
            client,
            client_total,
            math.ceil(client_total / 15) * 0.25,
            notes,
            math.ceil(client_billable / 15) * 0.25,
            human_hours_formula,
            total_hours_formula,
            "",
        ])

    # Grand total row
    total_row_num = len(rows) + 1
    first_data_row = subtotals_header_row + 2  # 1-indexed, first client row
    rows.append([
        "TOTAL",
        grand_total,
        math.ceil(grand_total / 15) * 0.25,
        "",
        math.ceil(grand_billable / 15) * 0.25,
        f"=SUM(F{first_data_row}:F{total_row_num - 1})",
        f"=SUM(G{first_data_row}:G{total_row_num - 1})",
        f"=SUM(H{first_data_row}:H{total_row_num - 1})",
    ])
    subtotals_end_row = len(rows)

    # 2 blank separator rows
    rows.append([])
    rows.append([])

    # Detail table header
    detail_header_row = len(rows)  # 0-indexed
    rows.append(["Date", "Client", "Division", "Task", "Est. Minutes", "Summary", "Billable", "Source"])

    for client, entries in grouped:
        for e in entries:
            bill_str = "Yes" if e["billable"] else "No"
            rows.append([
                e["date"],
                e["client"],
                e["division"],
                e["task"],
                e["estimated_minutes"],
                e.get("summary", ""),
                bill_str,
                "OpenDia",
            ])

    data_end_row = len(rows)

    # Write all rows
    service.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range=f"'{tab_name}'!A1",
        valueInputOption="USER_ENTERED",
        body={"values": rows},
    ).execute()

    # Apply filter + banded coloring to subtotals table (top)
    apply_formatting(service, spreadsheet_id, tab_name, subtotals_header_row, subtotals_end_row, 8)

    # Apply filter + banded coloring to detail table (bottom)
    apply_formatting(service, spreadsheet_id, tab_name, detail_header_row, data_end_row, 8)

    # Apply title row and TOTAL row formatting
    sheet_id = get_sheet_id(service, spreadsheet_id, tab_name)
    total_row = subtotals_end_row - 1  # last row of subtotals table
    title_requests = [
        # A2: "OpenDia" — size 18
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": 1, "endRowIndex": 2,
                    "startColumnIndex": 0, "endColumnIndex": 1,
                },
                "cell": {"userEnteredFormat": {"textFormat": {"fontSize": 18}}},
                "fields": "userEnteredFormat.textFormat.fontSize",
            }
        },
        # B2: "/monthly-billing" — bold
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": 1, "endRowIndex": 2,
                    "startColumnIndex": 1, "endColumnIndex": 2,
                },
                "cell": {"userEnteredFormat": {"textFormat": {"bold": True}}},
                "fields": "userEnteredFormat.textFormat.bold",
            }
        },
        # D2: month name — size 17
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": 1, "endRowIndex": 2,
                    "startColumnIndex": 3, "endColumnIndex": 4,
                },
                "cell": {"userEnteredFormat": {"textFormat": {"fontSize": 17}}},
                "fields": "userEnteredFormat.textFormat.fontSize",
            }
        },
        # TOTAL row — bold, size 12
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": total_row, "endRowIndex": total_row + 1,
                    "startColumnIndex": 0, "endColumnIndex": 4,
                },
                "cell": {"userEnteredFormat": {"textFormat": {"bold": True, "fontSize": 12}}},
                "fields": "userEnteredFormat.textFormat",
            }
        },
    ]
    service.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={"requests": title_requests},
    ).execute()

    print(f"Wrote {len(rows)} rows to '{tab_name}' tab.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate monthly billing summary from OpenDia timer files."
    )
    parser.add_argument(
        "--month",
        type=str,
        default=None,
        help="Month to process as YYYY-MM (defaults to last calendar month)",
    )
    parser.add_argument(
        "--write-sheet",
        action="store_true",
        help="Write data to the OpenDia tab in Google Sheets",
    )
    parser.add_argument(
        "--clear-only",
        action="store_true",
        help="Clear the OpenDia tab without writing any data",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output structured JSON instead of formatted text (dry-run; ignores --write-sheet)",
    )
    return parser.parse_args()


def resolve_month(month_str):
    """Return (year, month) from a YYYY-MM string, or default to last month."""
    if month_str:
        parts = month_str.split("-")
        return int(parts[0]), int(parts[1])

    # Default: last calendar month
    today = datetime.now()
    first_of_this_month = today.replace(day=1)
    last_month = first_of_this_month - timedelta(days=1)
    return last_month.year, last_month.month


def main():
    args = parse_args()
    year, month = resolve_month(args.month)

    if args.clear_only:
        service = get_sheets_service()
        clear_tab(service, SPREADSHEET_ID, TAB_NAME)
        print(f"Cleared '{TAB_NAME}' tab.")
        return

    entries = load_month_entries(year, month)
    if not entries:
        print(f"No entries found for {year:04d}-{month:02d}.")
        return

    entries = normalize_entries(entries)
    grouped = group_by_client(entries)

    if args.json:
        def to_hours(mins):
            return math.ceil(mins / 15) * 0.25 if mins > 0 else 0.0

        output = []
        grand_total_min = 0
        grand_billable_min = 0
        for client, client_entries in grouped:
            billable_min = sum(e.get("estimated_minutes", 0) for e in client_entries if e.get("billable") is True)
            nonbillable_min = sum(e.get("estimated_minutes", 0) for e in client_entries if e.get("billable") is not True)
            total_min = billable_min + nonbillable_min
            grand_total_min += total_min
            grand_billable_min += billable_min

            seen = []
            for e in client_entries:
                task = e.get("task", "")
                summary = e.get("summary", "")
                line = f"{task} — {summary}" if summary else task
                if line and line not in seen:
                    seen.append(line)
            notes_string = "; ".join(seen)

            output.append({
                "client": client,
                "billable_min": billable_min,
                "nonbillable_min": nonbillable_min,
                "total_min": total_min,
                "total_hours": to_hours(total_min),
                "billable_hours": to_hours(billable_min),
                "notes_string": notes_string,
                "entries": [
                    {
                        "start": e.get("start"),
                        "date": e.get("date"),
                        "division": e.get("division"),
                        "task": e.get("task"),
                        "summary": e.get("summary", ""),
                        "estimated_minutes": e.get("estimated_minutes", 0),
                        "hours": to_hours(e.get("estimated_minutes", 0)),
                        "billable": e.get("billable") is True,
                    }
                    for e in client_entries
                ],
            })
        print(json.dumps({
            "month": f"{year:04d}-{month:02d}",
            "grand_total_min": grand_total_min,
            "grand_total_hours": to_hours(grand_total_min),
            "grand_billable_min": grand_billable_min,
            "grand_billable_hours": to_hours(grand_billable_min),
            "clients": output,
        }))
        return

    # Always print to stdout
    print_summary(grouped, year, month)

    if args.write_sheet:
        service = get_sheets_service()
        write_to_sheet(service, SPREADSHEET_ID, TAB_NAME, grouped, year, month)


if __name__ == "__main__":
    main()
