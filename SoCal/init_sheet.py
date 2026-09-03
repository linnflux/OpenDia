#!/usr/bin/env python3
"""Create the Linnflux Social tabs (Calendar, Batches, Config) on a client sheet.

    init_sheet.py --sheet SHEET_ID [--pages "Parent"] [--channels "Facebook, Instagram"]

Idempotent: a tab that already exists is left alone (no re-format, no re-seed).
Never touches any other tab. Config is seeded with the template keys and blank
values (pages/channels from the flags); fill it in before the first build —
review_pdf.py refuses to run without client_name.
"""
import argparse
import itertools
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sheet import (get_sheets_service, CAL_HEADERS, BATCH_HEADERS,  # noqa: E402
                   TYPES, STATUSES, IMAGE_STATES, COMPLIANCE)

CONFIG_KEYS = ["client_name", "client_short", "footer_line", "pages", "channels",
               "approver", "compliance_contact", "cc_list", "lead_time_days",
               "post_weekday", "posts_per_month", "drive_images_folder_id",
               "drive_reviews_folder_id", "shared_drive_id", "brand_primary",
               "brand_secondary", "brand_ink", "brand_bg", "heading_font",
               "body_font", "logo_url", "motif", "imagery_notes", "voice",
               "main_phone", "image_style", "archive_tab"]


def one_of(values):
    return {"condition": {"type": "ONE_OF_LIST",
                          "values": [{"userEnteredValue": v} for v in values]},
            "strict": True, "showCustomUi": True}


def rng(sid, r0, r1, c0, c1):
    return {"sheetId": sid, "startRowIndex": r0, "endRowIndex": r1,
            "startColumnIndex": c0, "endColumnIndex": c1}


def fmt_requests(sid, ncols, date_cols, time_cols=(), wrap_cols=(), widths=None, rows=500):
    req = [
        {"repeatCell": {"range": rng(sid, 0, 1, 0, ncols),
                        "cell": {"userEnteredFormat": {"textFormat": {"bold": True},
                                 "backgroundColor": {"red": .93, "green": .93, "blue": .93},
                                 "wrapStrategy": "WRAP"}},
                        "fields": "userEnteredFormat(textFormat,backgroundColor,wrapStrategy)"}},
    ]
    for c in date_cols:
        req.append({"repeatCell": {"range": rng(sid, 1, rows, c, c + 1),
                    "cell": {"userEnteredFormat": {"numberFormat": {"type": "DATE", "pattern": "yyyy-mm-dd"}}},
                    "fields": "userEnteredFormat.numberFormat"}})
        req.append({"setDataValidation": {"range": rng(sid, 1, rows, c, c + 1),
                    "rule": {"condition": {"type": "DATE_IS_VALID"}, "strict": True}}})
    for c in time_cols:
        req.append({"repeatCell": {"range": rng(sid, 1, rows, c, c + 1),
                    "cell": {"userEnteredFormat": {"numberFormat": {"type": "TIME", "pattern": "hh:mm"}}},
                    "fields": "userEnteredFormat.numberFormat"}})
    for c in wrap_cols:
        req.append({"repeatCell": {"range": rng(sid, 1, rows, c, c + 1),
                    "cell": {"userEnteredFormat": {"wrapStrategy": "WRAP", "verticalAlignment": "TOP"}},
                    "fields": "userEnteredFormat(wrapStrategy,verticalAlignment)"}})
    for c, w in (widths or {}).items():
        req.append({"updateDimensionProperties": {"range": {"sheetId": sid, "dimension": "COLUMNS",
                    "startIndex": c, "endIndex": c + 1}, "properties": {"pixelSize": w}, "fields": "pixelSize"}})
    return req


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", required=True)
    ap.add_argument("--pages", default="Parent", help="comma list for the Page dropdown")
    ap.add_argument("--channels", default="Facebook, Instagram", help="comma list for the Channels dropdown")
    a = ap.parse_args()

    pages = [p.strip() for p in a.pages.split(",") if p.strip()]
    channels = [c.strip() for c in a.channels.split(",") if c.strip()]
    channel_combos = [", ".join(c) for n in range(1, len(channels) + 1)
                      for c in itertools.combinations(channels, n)]

    svc = get_sheets_service()
    meta = svc.spreadsheets().get(spreadsheetId=a.sheet, fields="sheets.properties").execute()
    existing = {s["properties"]["title"]: s["properties"]["sheetId"] for s in meta["sheets"]}
    print("existing tabs:", existing)

    # ---- 1. create missing tabs -------------------------------------------
    want = {"Calendar": (500, len(CAL_HEADERS)), "Batches": (100, len(BATCH_HEADERS)), "Config": (60, 2)}
    adds = [{"addSheet": {"properties": {"title": t, "gridProperties": {
                "rowCount": r, "columnCount": c, "frozenRowCount": 1}}}}
            for t, (r, c) in want.items() if t not in existing]
    created = set()
    if adds:
        rep = svc.spreadsheets().batchUpdate(spreadsheetId=a.sheet, body={"requests": adds}).execute()
        for r in rep["replies"]:
            p = r["addSheet"]["properties"]
            existing[p["title"]] = p["sheetId"]
            created.add(p["title"])
    print("created:", sorted(created) or "nothing (all tabs already existed)")
    CAL, BAT, CFG = existing["Calendar"], existing["Batches"], existing["Config"]

    # ---- 2. headers + config template (only on tabs created this run) -----
    seeded = {"pages": ", ".join(pages), "channels": ", ".join(channels)}
    vals = []
    if "Calendar" in created:
        vals.append({"range": "Calendar!A1", "values": [CAL_HEADERS]})
        vals.append({"range": "Calendar!D2", "values": [['=ARRAYFORMULA(IF(C2:C="","",TEXT(C2:C,"ddd")))']]})
    if "Batches" in created:
        vals.append({"range": "Batches!A1", "values": [BATCH_HEADERS]})
    if "Config" in created:
        vals.append({"range": "Config!A1", "values": [["key", "value"]] +
                     [[k, seeded.get(k, "")] for k in CONFIG_KEYS]})
    if vals:
        svc.spreadsheets().values().batchUpdate(spreadsheetId=a.sheet, body={
            "valueInputOption": "USER_ENTERED", "data": vals}).execute()

    # ---- 3. formatting, validation, protection ----------------------------
    reqs = []
    if "Calendar" in created:
        H = {h: i for i, h in enumerate(CAL_HEADERS)}
        reqs += fmt_requests(CAL, len(CAL_HEADERS),
                             date_cols=[H["Post date"], H["Approved date"], H["Compliance date"], H["Published date"]],
                             time_cols=[H["Time"]],
                             wrap_cols=[H["Caption"], H["Client comments"], H["Notes"]],
                             widths={H["ID"]: 80, H["Batch"]: 80, H["Post date"]: 95, H["Day"]: 50, H["Time"]: 55,
                                     H["Title"]: 200, H["Type"]: 95, H["Page"]: 90, H["Channels"]: 170,
                                     H["Status"]: 130, H["Caption"]: 420, H["Image"]: 220, H["Image state"]: 100,
                                     H["Client comments"]: 260, H["Permalink"]: 220, H["Notes"]: 220})
        for col, values in ((H["Type"], TYPES), (H["Page"], pages), (H["Channels"], channel_combos),
                            (H["Status"], STATUSES), (H["Image state"], IMAGE_STATES), (H["Compliance"], COMPLIANCE)):
            reqs.append({"setDataValidation": {"range": rng(CAL, 1, 500, col, col + 1), "rule": one_of(values)}})
        # Day column: formula, protected (warning only so a mistake is recoverable)
        reqs.append({"addProtectedRange": {"protectedRange": {
            "range": rng(CAL, 1, 500, H["Day"], H["Day"] + 1),
            "description": "Day is derived from Post date. Do not type here.", "warningOnly": True}}})
    if "Batches" in created:
        B = {h: i for i, h in enumerate(BATCH_HEADERS)}
        reqs += fmt_requests(BAT, len(BATCH_HEADERS), rows=100,
                             date_cols=[B["First post date"], B["Facts confirmed date"], B["Sent date"],
                                        B["Approved date"], B["Compliance cleared date"]],
                             wrap_cols=[B["Stakeholders"], B["Notes"], B["Thread subject"]],
                             widths={B["Batch"]: 90, B["PDF link"]: 220, B["Thread subject"]: 260,
                                     B["Stakeholders"]: 300, B["Notes"]: 260})
    if "Config" in created:
        reqs += fmt_requests(CFG, 2, date_cols=[], rows=60, wrap_cols=[1], widths={0: 200, 1: 620})
        reqs.append({"updateSheetProperties": {"properties": {"sheetId": CFG, "hidden": True}, "fields": "hidden"}})
        reqs.append({"addProtectedRange": {"protectedRange": {
            "range": {"sheetId": CFG}, "description": "Client config; edit deliberately.", "warningOnly": True}}})
    if reqs:
        svc.spreadsheets().batchUpdate(spreadsheetId=a.sheet, body={"requests": reqs}).execute()
        print("formatting/validation applied:", len(reqs), "requests")

    # ---- 4. verify --------------------------------------------------------
    got = svc.spreadsheets().values().batchGet(spreadsheetId=a.sheet, ranges=[
        "Calendar!A1:U1", "Batches!A1:L1", "Config!A1:B20"]).execute()["valueRanges"]
    print("\nCalendar header ok:", got[0].get("values", [[]])[0] == CAL_HEADERS)
    print("Batches header ok:", got[1].get("values", [[]])[0] == BATCH_HEADERS)
    print("Config keys:", [r[0] for r in got[2].get("values", [])[1:]])
    meta = svc.spreadsheets().get(spreadsheetId=a.sheet, fields="sheets.properties").execute()
    print("tabs now:", [(s["properties"]["title"], s["properties"].get("hidden", False)) for s in meta["sheets"]])


if __name__ == "__main__":
    main()
