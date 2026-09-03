"""Sheet I/O for the Linnflux Social framework.

One spreadsheet per client, three tabs (Calendar, Batches, Config). The sheet is
the only source of truth; everything else is derived. Code keys on post ID and
reads columns by header name, never by position or row number.

All writes go through guarded_write: assert the current value first, write, then
read back. A guard failure exits rather than risking a blind overwrite.
"""
import os
import re
import sys

sys.path.insert(0, os.path.expanduser("~/OpenDia/scripts"))
from edit_sheet import get_sheets_service  # noqa: E402,F401  (re-exported)

# ---------------------------------------------------------------- schema
CAL_HEADERS = ["ID", "Batch", "Post date", "Day", "Time", "Title", "Type", "Page",
               "Channels", "Status", "Caption", "Image", "Image state",
               "Client comments", "Approved by", "Approved date", "Compliance",
               "Compliance date", "Permalink", "Published date", "Notes"]
BATCH_HEADERS = ["Batch", "First post date", "Facts confirmed by", "Facts confirmed date",
                 "PDF version", "PDF link", "Sent date", "Thread subject", "Stakeholders",
                 "Approved date", "Compliance cleared date", "Notes"]
TYPES = ["Holiday", "Education", "Security", "Product", "Local", "Community", "Hiring", "Rate"]
STATUSES = ["Draft", "Ready", "Under Review", "Changes Requested", "Approved",
            "Scheduled", "Published", "Do Not Run"]
IMAGE_STATES = ["Final", "Placeholder"]
COMPLIANCE = ["N/A", "Pending", "Pass", "Fail"]

REVIEW_STATUSES = {"Ready", "Under Review", "Changes Requested", "Approved"}
SKIP_STATUSES = {"Scheduled", "Published", "Do Not Run"}

# The client style guide lives in Config alongside the operational keys. These
# are the keys that describe the brand itself — researched from the client's
# website at onboarding (styleguide.py), then human-curated. Every surface that
# renders or generates for the client should read from here.
STYLE_KEYS = ["brand_primary", "brand_secondary", "brand_ink", "brand_bg",
              "heading_font", "body_font", "logo_url", "motif",
              "image_style", "imagery_notes", "voice"]

DRIVE_ID = re.compile(r"(?:/d/|id=)([\w-]{20,})|^([\w-]{20,})$")


def drive_id(link: str) -> str:
    """File id from a Drive link (or a bare id), else ''."""
    m = DRIVE_ID.search(link.strip())
    return (m.group(1) or m.group(2)) if m else ""


def col_letter(i: int) -> str:
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def read_tab(svc, sid, tab):
    """(headers, rows) for one tab; each row is a dict by header plus _row (1-based)."""
    vals = svc.spreadsheets().values().get(
        spreadsheetId=sid, range=f"'{tab}'!A1:Z").execute().get("values", [])
    if not vals:
        sys.exit(f"tab {tab!r} is empty or missing")
    head = vals[0]
    rows = []
    for i, r in enumerate(vals[1:], start=2):
        r = (r + [""] * len(head))[:len(head)]
        d = dict(zip(head, r))
        d["_row"] = i
        rows.append(d)
    return head, rows


def read_config(svc, sid):
    _, rows = read_tab(svc, sid, "Config")
    return {r["key"].strip(): r["value"].strip() for r in rows if r.get("key", "").strip()}


def write_config(svc, sid, key, value):
    """Set one Config key (guarded on the key cell). Appends the row if the
    key does not exist yet, so schema additions self-heal on older sheets."""
    head, rows = read_tab(svc, sid, "Config")
    row = next((r for r in rows if r.get("key", "").strip() == key), None)
    if row is None:
        svc.spreadsheets().values().append(
            spreadsheetId=sid, range="'Config'!A:B",
            valueInputOption="USER_ENTERED", insertDataOption="INSERT_ROWS",
            body={"values": [[key, value]]}).execute()
        return
    guarded_write(svc, sid, "Config", row["_row"], head, {"value": value}, {"key": key})


def guarded_write(svc, sid, tab, row, head, updates: dict, expect: dict):
    """Write cells on one row by header name, asserting the current value first."""
    for k, exp in expect.items():
        rng = f"'{tab}'!{col_letter(head.index(k))}{row}"
        cur = svc.spreadsheets().values().get(spreadsheetId=sid, range=rng).execute().get("values", [[""]])[0][0]
        if cur != exp:
            sys.exit(f"guard: {tab}!{rng} is {cur!r}, expected {exp!r}; not writing")
    data = [{"range": f"'{tab}'!{col_letter(head.index(k))}{row}", "values": [[v]]} for k, v in updates.items()]
    svc.spreadsheets().values().batchUpdate(spreadsheetId=sid, body={
        "valueInputOption": "USER_ENTERED", "data": data}).execute()
    for k, v in updates.items():
        rng = f"'{tab}'!{col_letter(head.index(k))}{row}"
        back = svc.spreadsheets().values().get(spreadsheetId=sid, range=rng).execute().get("values", [[""]])[0][0]
        if back != v:
            sys.exit(f"read-back mismatch at {rng}: {back!r} != {v!r}")
