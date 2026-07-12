#!/usr/bin/env python3
"""Read specific sheets/ranges from Google Spreadsheets.

Uses the same OAuth credentials as the Google Workspace MCP server.

Usage:
    python3 read_sheet.py <spreadsheet_id> [sheet_name] [range]

Examples:
    python3 read_sheet.py 1VowYnK...  # list all sheet tab names
    python3 read_sheet.py 1VowYnK... "2026-02"  # read entire sheet
    python3 read_sheet.py 1VowYnK... "2026-02" "A1:L30"  # read specific range
"""

import json
import sys
import os

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

CREDENTIALS_PATH = os.path.expanduser("~/.claude/mcp-credentials/google-workspace.json")
TOKENS_PATH = os.path.expanduser("~/.claude/mcp-credentials/google-workspace/tokens.json")


def get_credentials():
    with open(CREDENTIALS_PATH) as f:
        creds_data = json.load(f)
    with open(TOKENS_PATH) as f:
        tokens = json.load(f)

    client_config = creds_data["installed"]
    return Credentials(
        token=tokens.get("access_token"),
        refresh_token=tokens.get("refresh_token"),
        token_uri=client_config["token_uri"],
        client_id=client_config["client_id"],
        client_secret=client_config["client_secret"],
        scopes=["https://www.googleapis.com/auth/drive.readonly",
                "https://www.googleapis.com/auth/spreadsheets"],
    )


def list_sheets(service, spreadsheet_id):
    meta = service.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    sheets = meta.get("sheets", [])
    print("Sheet tabs:")
    for s in sheets:
        props = s["properties"]
        print(f"  [{props['index']}] {props['title']}")


def read_range(service, spreadsheet_id, range_str):
    result = service.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id,
        range=range_str,
        valueRenderOption="FORMATTED_VALUE",
    ).execute()
    rows = result.get("values", [])
    if not rows:
        print("(empty)")
        return

    # Calculate column widths for aligned output
    col_count = max(len(r) for r in rows)
    widths = [0] * col_count
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))

    # Cap column widths at 30 chars for readability
    widths = [min(w, 30) for w in widths]

    for row in rows:
        cells = []
        for i in range(col_count):
            val = str(row[i]) if i < len(row) else ""
            if len(val) > 30:
                val = val[:27] + "..."
            cells.append(val.ljust(widths[i]))
        print(" | ".join(cells))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    spreadsheet_id = sys.argv[1]
    sheet_name = sys.argv[2] if len(sys.argv) > 2 else None
    cell_range = sys.argv[3] if len(sys.argv) > 3 else None

    creds = get_credentials()
    service = build("sheets", "v4", credentials=creds)

    if not sheet_name:
        list_sheets(service, spreadsheet_id)
    elif cell_range:
        read_range(service, spreadsheet_id, f"'{sheet_name}'!{cell_range}")
    else:
        read_range(service, spreadsheet_id, f"'{sheet_name}'")


if __name__ == "__main__":
    main()
