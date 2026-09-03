#!/usr/bin/env python3
"""Spin up a new SoCal client: Drive folders, calendar sheet, Config, wrapper.

    onboard.py --name "Acme Hardware" --url https://acme.com --slug acme \
               --parent DRIVE_FOLDER_ID --approver "Jo Smith <jo@acme.com>" \
               [--shared-drive ID] [--weekday Thursday] [--posts 4] \
               [--footer acme.com] [--phone "(555) 555-5555"] [--dry-run]

One command turns a signed client into running infrastructure:
  1. <parent>/<YEAR>_Images Drive folder, link-readable (Instagram's publish
     API needs public image URLs).
  2. "<Name> Social Calendar" spreadsheet beside it, tabs via init_sheet.py.
  3. Config tab filled with everything known at signup (the rest gets filled
     at the brand brief: image_style, brand colors, meta ids).
  4. ~/OpenDia/clients/<slug>/social/ scaffold: review.sh wrapper + graphics/.
  5. A printed checklist of the human steps that remain.

Client identifiers live in the sheet and the clients/ dir, never in this repo.
"""
import argparse
import datetime as dt
import json
import os
import stat
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.expanduser("~/OpenDia/scripts"))
from sheet import get_sheets_service, read_tab, guarded_write  # noqa: E402

REVIEW_SH = """#!/usr/bin/env bash
# Build (and with --upload, publish) the {name} review PDF for one batch.
#   ./review.sh YYYY-MM            local build only
#   ./review.sh YYYY-MM --upload   build, push to Drive in place, record on Batches
set -euo pipefail
BATCH="${{1:?batch, e.g. {batch}}}"; shift || true
exec python3 ~/OpenDia/repo/SoCal/review_pdf.py \\
  --sheet {sid} \\
  --batch "$BATCH" --out "$(dirname "$0")/out" "$@"
"""

CHECKLIST = """
Remaining human steps for {name}:
  1. Meta access: send docs/meta-access.md (filled with our Business ID); client
     partner-shares their FB Page + IG account; assign both to the system user;
     then add meta_page_id + meta_ig_user_id to Config.
  2. Brand brief: fill image_style, brand_primary, brand_ink in Config
     (run sampler.py against their site for a head start).
  3. Standing instructions from the intake form -> Config rows.
  4. Dashboard card + Notion task for the engagement (od-new).
  5. First batch: rows -> graphics -> ./review.sh -> approval email -> publish.
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--slug", required=True, help="clients/<slug>/social/ dir name")
    ap.add_argument("--parent", required=True, help="Drive folder id to create inside")
    ap.add_argument("--approver", required=True, help='e.g. "Jo Smith <jo@acme.com>"')
    ap.add_argument("--shared-drive", default="", help="shared drive id if parent is on one")
    ap.add_argument("--weekday", default="Thursday")
    ap.add_argument("--posts", type=int, default=4)
    ap.add_argument("--footer", default="", help="footer line required in every caption")
    ap.add_argument("--phone", default="")
    ap.add_argument("--pages", default="Parent")
    ap.add_argument("--channels", default="Facebook, Instagram")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    year = dt.date.today().year
    images_name = f"{year}_Images"
    sheet_name = f"{a.name} Social Calendar"
    client_dir = os.path.expanduser(f"~/OpenDia/clients/{a.slug}/social")
    footer = a.footer or a.url.split("//")[-1].strip("/").replace("www.", "")

    if a.dry_run:
        print("DRY RUN — would do:")
        print(f"  Drive: create folder {images_name!r} in {a.parent} (link-readable)")
        print(f"  Drive: create spreadsheet {sheet_name!r} in {a.parent}")
        print(f"  init_sheet.py --pages {a.pages!r} --channels {a.channels!r}")
        print(f"  Config fill: name/short/footer={footer!r}/approver/{a.weekday}/{a.posts}/mo"
              f"/phone={a.phone!r}/folder ids")
        print(f"  scaffold {client_dir}/review.sh + graphics/ + out/")
        print(CHECKLIST.format(name=a.name))
        return

    from drive_upload import get_credentials
    from googleapiclient.discovery import build as gbuild
    drive = gbuild("drive", "v3", credentials=get_credentials())
    kw = dict(supportsAllDrives=True)

    img = drive.files().create(body={"name": images_name, "parents": [a.parent],
                                     "mimeType": "application/vnd.google-apps.folder"},
                               fields="id", **kw).execute()["id"]
    drive.permissions().create(fileId=img, body={"type": "anyone", "role": "reader"}, **kw).execute()
    ss = drive.files().create(body={"name": sheet_name, "parents": [a.parent],
                                    "mimeType": "application/vnd.google-apps.spreadsheet"},
                              fields="id,webViewLink", **kw).execute()
    print(f"images folder: {img} (link-readable)")
    print(f"sheet: {ss['id']}  {ss['webViewLink']}")

    subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "init_sheet.py"),
                    "--sheet", ss["id"], "--pages", a.pages, "--channels", a.channels], check=True)

    svc = get_sheets_service()
    cfg = {
        "client_name": a.name,
        "client_short": "".join(w[0] for w in a.name.split()).upper()[:4],
        "footer_line": footer,
        "approver": a.approver,
        "lead_time_days": "11",
        "post_weekday": a.weekday,
        "posts_per_month": str(a.posts),
        "drive_images_folder_id": img,
        "shared_drive_id": a.shared_drive,
        "main_phone": a.phone,
    }
    head, rows = read_tab(svc, ss["id"], "Config")
    for r in rows:
        k = r["key"].strip()
        if k in cfg and cfg[k]:
            guarded_write(svc, ss["id"], "Config", r["_row"], head, {"value": cfg[k]}, {"key": k})
    print("config filled:", ", ".join(k for k, v in cfg.items() if v))

    os.makedirs(os.path.join(client_dir, "out"), exist_ok=True)
    os.makedirs(os.path.join(client_dir, "graphics"), exist_ok=True)
    batch_example = f"{year}-{dt.date.today().month:02d}"
    wrapper = os.path.join(client_dir, "review.sh")
    with open(wrapper, "w") as fh:
        fh.write(REVIEW_SH.format(name=a.name, sid=ss["id"], batch=batch_example))
    os.chmod(wrapper, os.stat(wrapper).st_mode | stat.S_IXUSR | stat.S_IXGRP)
    print(f"scaffolded {client_dir}")

    # register for the SoCal admin dashboard
    reg_path = os.path.expanduser("~/OpenDia/socal-clients.json")
    try:
        reg = json.load(open(reg_path)) if os.path.exists(reg_path) else []
    except Exception:
        reg = []
    if not any(c.get("slug") == a.slug for c in reg):
        reg.append({"slug": a.slug, "name": a.name, "sheet": ss["id"],
                    "page_id": "", "ig_id": "", "since": dt.date.today().isoformat()})
        with open(reg_path, "w") as fh:
            json.dump(reg, fh, indent=2)
        print("registered in socal-clients.json (fill page_id/ig_id after Meta access)")
    print(CHECKLIST.format(name=a.name))


if __name__ == "__main__":
    main()
