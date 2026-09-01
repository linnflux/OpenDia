#!/usr/bin/env python3
"""Schedule and publish approved social posts from a Linnflux Social sheet.

    publish.py --sheet SHEET_ID schedule [--batch YYYY-MM] [--dry-run]
    publish.py --sheet SHEET_ID tick

schedule: every Approved row (optionally one batch) gets a natively scheduled
Facebook photo post (published=false + scheduled_publish_time, which Meta
accepts 10 minutes to 75 days out), then flips to Scheduled. Instagram has no
native scheduling in the Graph API, so IG is handled by `tick`.

tick: run from a timer every few minutes. For each Scheduled row whose moment
has passed: publish the IG copy (JPEG twin of the sheet's PNG — the IG API
only accepts JPEG), collect both permalinks, then flip to Published with
Permalink + Published date filled. Rows finish independently; a row that is
not ready yet is retried on the next tick.

Client facts come from the sheet Config tab: meta_page_id, meta_ig_user_id,
drive_images_folder_id, default_post_time, timezone, and optionally
meta_token_path (default ~/.claude/mcp-credentials/meta/access_token).
The sheet stays the source of truth: state lives in Status/Notes, written
with guarded writes only.
"""
import argparse
import datetime as dt
import os
import re
import sys
import time
from zoneinfo import ZoneInfo

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.expanduser("~/OpenDia/scripts"))
from sheet import get_sheets_service, read_tab, read_config, guarded_write, drive_id  # noqa: E402

GRAPH = "https://graph.facebook.com/v21.0"
DEFAULT_TOKEN = "~/.claude/mcp-credentials/meta/access_token"


def sys_token(cfg):
    path = os.path.expanduser(cfg.get("meta_token_path") or DEFAULT_TOKEN)
    return open(path).read().strip()


def api(method, path, tok, **kw):
    r = requests.request(method, f"{GRAPH}/{path}",
                         headers={"Authorization": f"Bearer {tok}"}, timeout=60, **kw)
    body = r.json()
    if "error" in body:
        raise RuntimeError(f"{method} {path}: {body['error'].get('message')}")
    return body


def page_token(tok, page_id):
    for p in api("GET", "me/accounts", tok, params={"fields": "id,access_token"}).get("data", []):
        if p["id"] == page_id:
            return p["access_token"]
    raise RuntimeError(f"system user cannot see page {page_id}")


def post_when(r, cfg):
    t = (r.get("Time") or cfg.get("default_post_time") or "09:00").strip()
    tz = ZoneInfo(cfg.get("timezone") or "America/New_York")
    return dt.datetime.fromisoformat(f"{r['Post date']} {t}").replace(tzinfo=tz)


def notes_kv(notes):
    return dict(re.findall(r"\b([a-z_]+)=(\S+)", notes or ""))


def public_url(file_id):
    return f"https://lh3.googleusercontent.com/d/{file_id}=s0"


def jpeg_twin_url(png_id, cfg):
    """Public URL of the JPEG sibling of the sheet's PNG (IG accepts only JPEG)."""
    from drive_upload import get_credentials
    from googleapiclient.discovery import build as gbuild
    drive = gbuild("drive", "v3", credentials=get_credentials())
    kw = dict(supportsAllDrives=True)
    name = drive.files().get(fileId=png_id, fields="name", **kw).execute()["name"]
    if not name.lower().endswith(".png"):
        return public_url(png_id)  # already not a PNG; trust it
    want = name[:-4] + ".jpg"
    folder = cfg["drive_images_folder_id"]
    hits = drive.files().list(q=f"'{folder}' in parents and name='{want}' and trashed=false",
                              fields="files(id)", includeItemsFromAllDrives=True,
                              corpora="allDrives", **kw).execute()["files"]
    if not hits:
        raise RuntimeError(f"no JPEG twin {want!r} in the images folder; build/upload it first")
    return public_url(hits[0]["id"])


def append_note(svc, sid, head, r, extra):
    new = (r["Notes"].rstrip() + " | " + extra).strip(" |")
    guarded_write(svc, sid, "Calendar", r["_row"], head,
                  {"Notes": new}, {"ID": r["ID"]})
    r["Notes"] = new


# ---------------------------------------------------------------- schedule
def schedule(svc, sid, cfg, batch, dry):
    tok = sys_token(cfg)
    ptok = page_token(tok, cfg["meta_page_id"])
    head, cal = read_tab(svc, sid, "Calendar")
    rows = [r for r in cal if r["Status"] == "Approved" and (not batch or r["Batch"] == batch)]
    if not rows:
        print("nothing Approved to schedule")
        return
    now = dt.datetime.now(dt.timezone.utc)
    for r in rows:
        when = post_when(r, cfg)
        if when < now + dt.timedelta(minutes=11):
            sys.exit(f"{r['ID']}: {when} is inside Facebook's 10-minute scheduling floor")
        if when > now + dt.timedelta(days=75):
            sys.exit(f"{r['ID']}: {when} is past Facebook's 75-day scheduling ceiling")
        if dry:
            print(f"DRY {r['ID']}: would schedule FB for {when}")
            continue
        img = requests.get(public_url(drive_id(r["Image"])), timeout=60)
        img.raise_for_status()
        resp = api("POST", f"{cfg['meta_page_id']}/photos", ptok,
                   data={"message": r["Caption"], "published": "false",
                         "scheduled_publish_time": int(when.timestamp())},
                   files={"source": ("post.png", img.content, "image/png")})
        append_note(svc, sid, head, r, f"fb_photo_id={resp['id']}")
        guarded_write(svc, sid, "Calendar", r["_row"], head,
                      {"Status": "Scheduled"}, {"ID": r["ID"], "Status": "Approved"})
        print(f"{r['ID']}: FB scheduled for {when} (photo {resp['id']}); IG publishes via tick")


# ---------------------------------------------------------------- tick
def tick(svc, sid, cfg):
    tok = sys_token(cfg)
    head, cal = read_tab(svc, sid, "Calendar")
    due = [r for r in cal if r["Status"] == "Scheduled"
           and post_when(r, cfg) <= dt.datetime.now(dt.timezone.utc)]
    if not due:
        return
    ptok = page_token(tok, cfg["meta_page_id"])
    for r in due:
        try:
            kv = notes_kv(r["Notes"])
            ig_id = kv.get("ig_media_id")
            if not ig_id and cfg.get("meta_ig_user_id"):
                url = jpeg_twin_url(drive_id(r["Image"]), cfg)
                c = api("POST", f"{cfg['meta_ig_user_id']}/media", tok,
                        data={"image_url": url, "caption": r["Caption"]})
                for _ in range(12):
                    st = api("GET", c["id"], tok, params={"fields": "status_code"})
                    if st.get("status_code") == "FINISHED":
                        break
                    time.sleep(5)
                pub = api("POST", f"{cfg['meta_ig_user_id']}/media_publish", tok,
                          data={"creation_id": c["id"]})
                ig_id = pub["id"]
                append_note(svc, sid, head, r, f"ig_media_id={ig_id}")
            ig_link = api("GET", ig_id, tok, params={"fields": "permalink"}).get("permalink", "") if ig_id else ""

            fb_link = ""
            if kv.get("fb_photo_id"):
                photo = api("GET", kv["fb_photo_id"], ptok, params={"fields": "page_story_id"})
                story = photo.get("page_story_id")
                if story:
                    fb_link = api("GET", story, ptok, params={"fields": "permalink_url"}).get("permalink_url", "")
            if not fb_link:
                print(f"{r['ID']}: FB post not live yet; will retry next tick")
                continue

            updates = {"Permalink": fb_link, "Published date": dt.date.today().isoformat(),
                       "Status": "Published"}
            guarded_write(svc, sid, "Calendar", r["_row"], head, updates,
                          {"ID": r["ID"], "Status": "Scheduled"})
            if ig_link:
                append_note(svc, sid, head, r, f"ig_permalink={ig_link}")
            print(f"{r['ID']}: Published (FB {fb_link}" + (f", IG {ig_link})" if ig_link else ")"))
        except Exception as e:  # one bad row must not strand the others
            print(f"{r['ID']}: tick error: {e}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", required=True)
    ap.add_argument("mode", choices=["schedule", "tick"])
    ap.add_argument("--batch")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    svc = get_sheets_service()
    cfg = read_config(svc, a.sheet)
    for k in ("meta_page_id", "drive_images_folder_id"):
        if not cfg.get(k):
            sys.exit(f"Config is missing {k}")
    if a.mode == "schedule":
        schedule(svc, a.sheet, cfg, a.batch, a.dry_run)
    else:
        tick(svc, a.sheet, cfg)


if __name__ == "__main__":
    main()
