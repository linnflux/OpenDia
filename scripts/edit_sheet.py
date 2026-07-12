#!/usr/bin/env python3
"""Write data to Google Spreadsheets.

Uses the same OAuth credentials as the Google Workspace MCP server.

Usage:
    python3 edit_sheet.py clear <spreadsheet_id> <range>
    python3 edit_sheet.py write <spreadsheet_id> <range> <json_values_file>

Examples:
    python3 edit_sheet.py clear 1VowYnK... "'Sheet1'!A6:R1000"
    python3 edit_sheet.py write 1VowYnK... "'Sheet1'!A6" /tmp/rows.json
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
        scopes=[
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/spreadsheets",
        ],
    )


def get_sheets_service():
    return build("sheets", "v4", credentials=get_credentials())


def get_drive_service():
    return build("drive", "v3", credentials=get_credentials())


def clear_range(service, spreadsheet_id, range_str):
    service.spreadsheets().values().clear(
        spreadsheetId=spreadsheet_id,
        range=range_str,
    ).execute()
    print(f"Cleared: {range_str}")


def write_range(service, spreadsheet_id, range_str, values):
    service.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range=range_str,
        valueInputOption="USER_ENTERED",
        body={"values": values},
    ).execute()
    print(f"Wrote {len(values)} rows to {range_str}")


def batch_update(service, spreadsheet_id, requests):
    service.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={"requests": requests},
    ).execute()
    print(f"Batch update: {len(requests)} request(s)")


def move_file(drive_service, file_id, new_parent_id):
    meta = drive_service.files().get(
        fileId=file_id, fields="parents", supportsAllDrives=True
    ).execute()
    old_parents = ",".join(meta.get("parents", []))
    drive_service.files().update(
        fileId=file_id,
        addParents=new_parent_id,
        removeParents=old_parents,
        supportsAllDrives=True,
        fields="id, parents",
    ).execute()
    print(f"Moved {file_id} → folder {new_parent_id}")


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    spreadsheet_id = sys.argv[2]
    range_str = sys.argv[3]
    svc = get_sheets_service()

    if cmd == "clear":
        clear_range(svc, spreadsheet_id, range_str)
    elif cmd == "write":
        if len(sys.argv) < 5:
            print("write requires a JSON values file path")
            sys.exit(1)
        with open(sys.argv[4]) as f:
            values = json.load(f)
        write_range(svc, spreadsheet_id, range_str, values)
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
