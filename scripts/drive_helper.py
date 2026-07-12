#!/usr/bin/env python3
"""Read-only Google Drive helper (shared-drive aware).

Uses the same OAuth credentials as the Google Workspace MCP server. The MCP
drive_* tools don't pass shared-drive params, so this helper exists to reach
Team/Shared drives (e.g. MasterDrive) via Drive v3 with
supportsAllDrives / includeItemsFromAllDrives / corpora=allDrives.

READ-ONLY: never creates, modifies, moves, or deletes anything.

Usage:
    python3 drive_helper.py list-drives
    python3 drive_helper.py tree <folderId> [depth]      # default depth 1
    python3 drive_helper.py find "<query>" [maxResults]   # Drive query syntax
    python3 drive_helper.py ls <folderId> [maxResults]    # children of a folder
    python3 drive_helper.py read <fileId> [maxChars]      # export/download as text

Examples:
    python3 drive_helper.py list-drives
    python3 drive_helper.py find "name = 'MasterDrive'"
    python3 drive_helper.py tree 0ABcDEfGhIjKlUk9PVA 2
    python3 drive_helper.py read 1xY...docId 4000
"""

import io
import json
import os
import sys

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

CREDENTIALS_PATH = os.path.expanduser("~/.claude/mcp-credentials/google-workspace.json")
TOKENS_PATH = os.path.expanduser("~/.claude/mcp-credentials/google-workspace/tokens.json")

# Shared-drive aware list params, applied to every files().list / get call.
ALL_DRIVES = dict(supportsAllDrives=True, includeItemsFromAllDrives=True)

# Google-native mimeTypes -> export mimeType for text extraction.
EXPORT_MAP = {
    "application/vnd.google-apps.document": "text/plain",
    "application/vnd.google-apps.spreadsheet": "text/csv",
    "application/vnd.google-apps.presentation": "text/plain",
}


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
        scopes=["https://www.googleapis.com/auth/drive.readonly"],
    )


def svc():
    return build("drive", "v3", credentials=get_credentials())


def list_drives(service):
    resp = service.drives().list(pageSize=100, fields="drives(id,name)").execute()
    drives = resp.get("drives", [])
    if not drives:
        print("(no shared drives visible)")
        return
    print("Shared drives:")
    for d in drives:
        print(f"  {d['id']}  {d['name']}")


def _query(service, q, page_size=1000, fields=None):
    fields = fields or "files(id,name,mimeType,modifiedTime,size,parents)"
    out = []
    token = None
    while True:
        resp = service.files().list(
            q=q,
            corpora="allDrives",
            spaces="drive",
            pageSize=min(page_size, 1000),
            fields=f"nextPageToken,{fields}",
            orderBy="folder,name",
            pageToken=token,
            **ALL_DRIVES,
        ).execute()
        out.extend(resp.get("files", []))
        token = resp.get("nextPageToken")
        if not token or len(out) >= page_size:
            break
    return out[:page_size]


def find(service, query, max_results=50):
    files = _query(service, query, page_size=max_results)
    for f in files:
        kind = "DIR " if f["mimeType"].endswith(".folder") else "file"
        sz = f.get("size", "")
        print(f"  [{kind}] {f['id']}  {f['name']}  ({f['mimeType']})  {f.get('modifiedTime','')}  {sz}")
    print(f"-- {len(files)} item(s)")


def ls(service, folder_id, max_results=200):
    find(service, f"'{folder_id}' in parents and trashed = false", max_results)


def tree(service, folder_id, depth=1, prefix=""):
    files = _query(service, f"'{folder_id}' in parents and trashed = false", page_size=1000)
    for f in files:
        is_dir = f["mimeType"].endswith(".folder")
        mark = "/" if is_dir else ""
        print(f"{prefix}{f['name']}{mark}  [{f['id']}]  {f.get('modifiedTime','')[:10]}")
        if is_dir and depth > 1:
            tree(service, f["id"], depth - 1, prefix + "  ")


def read(service, file_id, max_chars=6000):
    meta = service.files().get(fileId=file_id, fields="id,name,mimeType", supportsAllDrives=True).execute()
    mt = meta["mimeType"]
    buf = io.BytesIO()
    if mt in EXPORT_MAP:
        request = service.files().export_media(fileId=file_id, mimeType=EXPORT_MAP[mt])
    elif mt.startswith("application/vnd.google-apps"):
        print(f"(cannot export {mt} as text: {meta['name']})")
        return
    else:
        request = service.files().get_media(fileId=file_id, supportsAllDrives=True)
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    try:
        text = buf.getvalue().decode("utf-8", errors="replace")
    except Exception:
        print(f"(binary file, {len(buf.getvalue())} bytes: {meta['name']})")
        return
    print(f"### {meta['name']} ({mt})")
    print(text[:max_chars])
    if len(text) > max_chars:
        print(f"\n... [truncated, {len(text)} chars total]")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    service = svc()
    if cmd == "list-drives":
        list_drives(service)
    elif cmd == "tree":
        tree(service, sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 1)
    elif cmd == "find":
        find(service, sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 50)
    elif cmd == "ls":
        ls(service, sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 200)
    elif cmd == "read":
        read(service, sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 6000)
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
