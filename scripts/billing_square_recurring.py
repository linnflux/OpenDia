#!/usr/bin/env python3
"""Pull Square recurring (paid -R- invoices) for a given month.

Usage:
    python3 billing_square_recurring.py --month 2026-05            # print only
    python3 billing_square_recurring.py --month 2026-05 --write    # write to Home tab

Filter logic (mirrors manual CSV export):
  - status == PAID
  - invoice_number contains '-R-'
  - updated_at falls within the target month (proxy for paid date)
"""

import argparse
import json
import os
import sys

import requests

SQUARE_TOKEN_ENV = "SQUARE_ACCESS_TOKEN"
SQUARE_TOKEN_FILE = os.path.expanduser("~/.claude.json")
LOCATION_ID = "6RGNNJJXK66KR"
SQUARE_API_BASE = "https://connect.squareup.com/v2"

NEW_SHEET_ID = "1irjs6n2XoG_FDDQiE7_7V5Buvo0btbEUS5_roVEOoOY"
CREDENTIALS_PATH = os.path.expanduser("~/.claude/mcp-credentials/google-workspace.json")
TOKENS_PATH = os.path.expanduser("~/.claude/mcp-credentials/google-workspace/tokens.json")

MONTH_TO_COL = {
    "01": "B", "02": "C", "03": "D", "04": "E",
    "05": "F", "06": "G", "07": "H", "08": "I",
    "09": "J", "10": "K", "11": "L", "12": "M",
}


def get_square_token():
    token = os.environ.get(SQUARE_TOKEN_ENV)
    if token:
        return token
    try:
        with open(SQUARE_TOKEN_FILE) as f:
            cfg = json.load(f)
        return cfg["mcpServers"]["square"]["env"][SQUARE_TOKEN_ENV]
    except Exception as e:
        sys.exit(f"Could not load Square token: {e}")


def fetch_invoices_for_month(token, year_month):
    """Fetch invoices, stopping early once we've cleared the target month.

    Since INVOICE_SORT_DATE doesn't sort by updated_at, we can't stop on first
    page with no matches. Instead: stop after 3 consecutive pages where every
    PAID invoice has updated_at < target_month_start. This avoids fetching the
    entire invoice history when the target month is recent.
    """
    month_start = year_month + "-01"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Square-Version": "2024-01-18",
    }
    invoices = []
    cursor = None
    page = 0
    cold_pages = 0  # consecutive pages with no paid invoices updated in target month

    while True:
        page += 1
        body = {
            "query": {
                "filter": {"location_ids": [LOCATION_ID]},
                "sort": {"field": "INVOICE_SORT_DATE", "order": "DESC"},
            },
            "limit": 200,
        }
        if cursor:
            body["cursor"] = cursor

        resp = requests.post(f"{SQUARE_API_BASE}/invoices/search", headers=headers, json=body, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        batch = data.get("invoices", [])
        invoices.extend(batch)
        cursor = data.get("cursor")
        print(f"  page {page}: {len(batch)} invoices (total so far: {len(invoices)})", flush=True)

        if not cursor or not batch:
            break

        # Early exit: check if any PAID invoice on this page was updated in target month
        paid_in_month = any(
            i.get("status") == "PAID" and i.get("updated_at", "").startswith(year_month)
            for i in batch
        )
        if paid_in_month:
            cold_pages = 0
        else:
            # Only count as a cold page if we've already passed the target month
            # (oldest PAID updated_at on page is before month_start)
            oldest_paid = min(
                (i.get("updated_at", "9999") for i in batch if i.get("status") == "PAID"),
                default="9999",
            )
            if oldest_paid < month_start:
                cold_pages += 1
                if cold_pages >= 3:
                    print(f"  (early exit after {cold_pages} cold pages)")
                    break

    return invoices


def filter_recurring(invoices, year_month):
    """Return (matching_invoices, total_cents) for paid -R- invoices in year_month."""
    prefix = year_month  # e.g. "2026-05"
    matching = []
    for inv in invoices:
        if inv.get("status") != "PAID":
            continue
        updated = inv.get("updated_at", "")
        if not updated.startswith(prefix):
            continue
        invnum = inv.get("invoice_number") or ""
        if "-R-" not in invnum:
            continue
        matching.append(inv)

    total_cents = 0
    for inv in matching:
        for pr in inv.get("payment_requests", []):
            total_cents += pr.get("total_completed_amount_money", {}).get("amount", 0)

    return matching, total_cents


def get_sheets_service():
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
        scopes=["https://www.googleapis.com/auth/spreadsheets"],
    )
    return build("sheets", "v4", credentials=creds)


def write_to_home(month, total_dollars):
    mm = month.split("-")[1]
    col = MONTH_TO_COL.get(mm)
    if not col:
        sys.exit(f"Unknown month: {mm}")
    cell = f"Home!{col}15"

    service = get_sheets_service()
    service.spreadsheets().values().update(
        spreadsheetId=NEW_SHEET_ID,
        range=cell,
        valueInputOption="USER_ENTERED",
        body={"values": [[total_dollars]]},
    ).execute()
    print(f"Wrote ${total_dollars:.2f} to {cell}")


def main():
    parser = argparse.ArgumentParser(description="Square recurring revenue for a billing month.")
    parser.add_argument("--month", required=True, help="Target month, e.g. 2026-05")
    parser.add_argument("--write", action="store_true", help="Write total to Home tab")
    args = parser.parse_args()

    month = args.month
    if len(month) != 7 or month[4] != "-":
        sys.exit("--month must be in YYYY-MM format")

    token = get_square_token()

    print(f"Fetching Square invoices for {month}...")
    invoices = fetch_invoices_for_month(token, month)
    print(f"Total invoices fetched: {len(invoices)}")

    matching, total_cents = filter_recurring(invoices, month)
    total = total_cents / 100

    print(f"\n{'Invoice #':<28} {'Paid Date':<12} {'Amount':>10}  Title")
    print("-" * 72)
    for inv in sorted(matching, key=lambda i: i.get("updated_at", "")):
        amt = sum(
            pr.get("total_completed_amount_money", {}).get("amount", 0)
            for pr in inv.get("payment_requests", [])
        ) / 100
        print(f"{inv.get('invoice_number', ''):<28} {inv.get('updated_at','')[:10]:<12} ${amt:>9.2f}  {inv.get('title','')[:30]}")

    print(f"\n{'─'*72}")
    print(f"  {month} Recurring Revenue ({len(matching)} invoices): ${total:,.2f}")

    if args.write:
        print()
        write_to_home(month, total)
        print(f"Home tab updated. Review: https://docs.google.com/spreadsheets/d/{NEW_SHEET_ID}/edit")


if __name__ == "__main__":
    main()
