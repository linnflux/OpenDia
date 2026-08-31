#!/usr/bin/env python3
"""Build a client review PDF for one approval batch from a Linnflux Social sheet.

Client-agnostic. Every client fact comes from the sheet's hidden Config tab, every
post from the Calendar tab, and the batch record from the Batches tab. Nothing is
retyped here: if the PDF and the sheet ever disagree, the sheet wins and this
script simply was not re-run.

    review_pdf.py --sheet SHEET_ID --batch 2026-09 --out DIR [--upload] [--include-rate]

Refuses to build on any lint failure: missing fields, non-ISO dates, rate language
in a non-Rate row, relative-time phrases, a weekday written in a caption that does
not match its date, em dashes, a missing footer line, two posts on one date, or a
row still in Draft. Guards the PDF size so unembedded graphics fail loudly.

--upload creates the PDF in the client's Reviews folder on Drive the first time and
updates it IN PLACE (same file id, same link) every time after, then records the
version and link on the Batches row. The Reviews folder is created beside the
images folder on first use and its id written back to Config.
"""
import argparse
import base64
import datetime as dt
import html
import io
import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.expanduser("~/OpenDia/scripts"))
from sheet import (get_sheets_service, read_tab, read_config, guarded_write,  # noqa: E402
                   drive_id, REVIEW_STATUSES, SKIP_STATUSES)
from lint import lint  # noqa: E402
from drive_upload import get_credentials as drive_creds  # noqa: E402
from googleapiclient.discovery import build as gbuild  # noqa: E402
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload  # noqa: E402


# ---------------------------------------------------------------- drive
def fetch_image(drive, file_id: str, cache_dir: str) -> str:
    meta = drive.files().get(fileId=file_id, fields="id,name,mimeType,modifiedTime",
                             supportsAllDrives=True).execute()
    if not meta["mimeType"].startswith("image/"):
        sys.exit(f"Drive file {file_id} ({meta['name']}) is {meta['mimeType']}, not an image")
    ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}.get(meta["mimeType"], "")
    path = os.path.join(cache_dir, f"{file_id}{ext}")
    stamp = path + ".mtime"
    if os.path.exists(path) and os.path.exists(stamp) and open(stamp).read() == meta["modifiedTime"]:
        return path
    buf = io.BytesIO()
    dl = MediaIoBaseDownload(buf, drive.files().get_media(fileId=file_id, supportsAllDrives=True))
    done = False
    while not done:
        _, done = dl.next_chunk()
    with open(path, "wb") as fh:
        fh.write(buf.getvalue())
    with open(stamp, "w") as fh:
        fh.write(meta["modifiedTime"])
    return path


def data_uri(path: str) -> str:
    mime = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}[path.rsplit(".", 1)[-1]]
    with open(path, "rb") as fh:
        return f"data:{mime};base64," + base64.b64encode(fh.read()).decode()


def ensure_reviews_folder(drive, svc, sid, cfg):
    fid = cfg.get("drive_reviews_folder_id", "")
    if fid:
        return fid
    images = cfg.get("drive_images_folder_id")
    if not images:
        sys.exit("Config needs drive_images_folder_id or drive_reviews_folder_id")
    parent = drive.files().get(fileId=images, fields="parents", supportsAllDrives=True).execute()["parents"][0]
    hit = drive.files().list(q=f"'{parent}' in parents and name='Reviews' and trashed=false",
                             fields="files(id)", supportsAllDrives=True, includeItemsFromAllDrives=True,
                             corpora="allDrives").execute()["files"]
    if hit:
        fid = hit[0]["id"]
    else:
        fid = drive.files().create(body={"name": "Reviews", "parents": [parent],
                                         "mimeType": "application/vnd.google-apps.folder"},
                                   fields="id", supportsAllDrives=True).execute()["id"]
        # match the images folder: anyone with the link can read
        drive.permissions().create(fileId=fid, body={"type": "anyone", "role": "reader"},
                                   supportsAllDrives=True).execute()
        print(f"created Drive folder Reviews ({fid}) beside the images folder, link-readable")
    head, rows = read_tab(svc, sid, "Config")
    row = next((r for r in rows if r["key"] == "drive_reviews_folder_id"), None)
    if row:
        guarded_write(svc, sid, "Config", row["_row"], head, {"value": fid}, {"key": "drive_reviews_folder_id"})
    else:
        svc.spreadsheets().values().append(spreadsheetId=sid, range="Config!A1", valueInputOption="USER_ENTERED",
                                           body={"values": [["drive_reviews_folder_id", fid]]}).execute()
    return fid


# ---------------------------------------------------------------- html
def weekday(iso):  return dt.date.fromisoformat(iso).strftime("%A")
def long_date(iso):
    d = dt.date.fromisoformat(iso)
    return f"{d.strftime('%A, %B')} {d.day}, {d.year}"
def short_date(iso):
    d = dt.date.fromisoformat(iso)
    return f"{d.strftime('%B')} {d.day}"


def caption_html(copy, foot):
    blocks = [b.strip() for b in copy.replace("\r\n", "\n").split("\n\n")]
    out = []
    for b in blocks:
        if not b:
            continue
        cls = " class='tags'" if foot and b.startswith(foot) else ""
        out.append(f"<p{cls}>{html.escape(b).replace(chr(10), '<br>')}</p>")
    return "\n".join(out)


def chip(status):
    if status == "Approved":
        return '<span class="chip ok">Approved</span>'
    return '<span class="chip rev">Under Review</span>'


def page_label(page, cfg):
    return cfg["client_name"] if page == "Parent" else f"{cfg['client_name']} - {page}"


def build_html(rows, cfg, batch, version, images):
    name, short = cfg["client_name"], cfg.get("client_short", cfg["client_name"])
    red, ink, mute = cfg.get("brand_primary", "#B4141C"), cfg.get("brand_ink", "#1c1c1e"), "#6b6b70"
    foot = cfg.get("footer_line", "")
    n = len(rows)
    first, last = rows[0]["Post date"], rows[-1]["Post date"]
    today = dt.date.today().isoformat()
    channels_all = sorted({c.strip() for r in rows for c in r["Channels"].split(",") if c.strip()})

    schedule = "\n".join(
        f"<tr><td class='d'>{weekday(r['Post date'])}, {r['Post date']}</td>"
        f"<td>{html.escape(r['Title'])}</td>"
        f"<td class='m'>{html.escape(page_label(r['Page'], cfg))}</td>"
        f"<td class='m'>{html.escape(r['Channels'])}</td>"
        f"<td class='c'>{chip(r['Status'])}</td></tr>" for r in rows)

    pages = []
    for idx, r in enumerate(rows, 1):
        note = ""
        if r["Image state"] == "Placeholder":
            note = ('<div class="note"><b>Placeholder graphic.</b> The image shown is a stand-in. '
                    'Please review the text; the final image will come back to you before this post runs.</div>')
        pages.append(f"""
        <section class="page post">
          <div class="bar"></div>
          <div class="phead">
            <div>
              <div class="pnum">Post {idx} of {n}</div>
              <h2>{html.escape(r['Title'])}</h2>
              <div class="pdate">Scheduled: {weekday(r['Post date'])}, {r['Post date']}
                &nbsp;·&nbsp; {html.escape(r['Channels'])}
                &nbsp;·&nbsp; Page: {html.escape(page_label(r['Page'], cfg))}
                &nbsp;·&nbsp; {html.escape(r['ID'])}</div>
            </div>
            {chip(r['Status'])}
          </div>
          <div class="grid">
            <div class="art"><img src="{data_uri(images[r['ID']])}">
              <div class="dims">{'Placeholder' if r['Image state'] == 'Placeholder' else 'Final graphic'}</div></div>
            <div class="cap">
              <div class="caplabel">Post text</div>
              {caption_html(r['Caption'], foot)}
              {note}
            </div>
          </div>
          <div class="foot"><span>{html.escape(short)} social review &nbsp;·&nbsp; {batch} &nbsp;·&nbsp; v{version}</span>
            <span>Page {idx + 1} of {n + 1}</span></div>
        </section>""")

    return f"""<!doctype html><meta charset="utf-8">
<title>{html.escape(name)} Social Posts for Review, {batch}</title>
<style>
  @page {{ size: letter; margin: 0; }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;
          color:{ink}; -webkit-print-color-adjust:exact; print-color-adjust:exact; }}
  .page {{ width:8.5in; height:11in; padding:0.72in 0.75in; position:relative;
           page-break-after:always; overflow:hidden; }}
  .page:last-child {{ page-break-after:auto; }}
  .bar {{ position:absolute; left:0; top:0; width:100%; height:14px; background:{red}; }}
  .foot {{ position:absolute; left:0.75in; right:0.75in; bottom:0.45in;
           font-size:8.5pt; color:{mute}; border-top:1px solid #e3e3e6;
           padding-top:8px; display:flex; justify-content:space-between; }}
  .cover h1 {{ font-size:31pt; line-height:1.1; margin:0 0 6px; letter-spacing:-.5px; }}
  .cover .sub {{ font-size:13pt; color:{mute}; margin:0 0 30px; }}
  .cover .lede {{ font-size:10.5pt; line-height:1.65; max-width:6in; }}
  .facts {{ margin:26px 0 8px; border:1px solid #e3e3e6; border-left:5px solid {red}; padding:16px 20px; }}
  .facts dl {{ margin:0; display:grid; grid-template-columns:1.35in 1fr; row-gap:7px; font-size:10pt; }}
  .facts dt {{ color:{mute}; }}
  .facts dd {{ margin:0; font-weight:600; }}
  h3 {{ font-size:10pt; text-transform:uppercase; letter-spacing:1.3px; color:{red}; margin:28px 0 10px; }}
  table {{ width:100%; border-collapse:collapse; font-size:10pt; }}
  td {{ padding:8px 6px 8px 0; border-bottom:1px solid #ededf0; vertical-align:top; }}
  td.d {{ width:1.9in; color:{mute}; }}
  td.m {{ color:{mute}; font-size:9pt; }}
  ol {{ font-size:10pt; line-height:1.7; padding-left:18px; margin:0; }}
  .phead {{ border-bottom:2px solid {red}; padding-bottom:12px; margin-bottom:22px;
            display:flex; justify-content:space-between; align-items:flex-start; gap:14px; }}
  .phead .chip {{ margin-top:22px; }}
  .pnum {{ font-size:8.5pt; text-transform:uppercase; letter-spacing:1.5px; color:{mute}; margin-bottom:5px; }}
  .post h2 {{ font-size:17pt; margin:0 0 6px; letter-spacing:-.2px; }}
  .pdate {{ font-size:9.5pt; color:{mute}; }}
  .grid {{ display:grid; grid-template-columns:4.15in 1fr; gap:0.3in; }}
  .art img {{ width:4.15in; height:4.15in; display:block; border:1px solid #e3e3e6; object-fit:cover; }}
  .dims {{ font-size:8pt; color:{mute}; margin-top:6px; letter-spacing:.4px; }}
  .chip {{ display:inline-block; font-size:8.5pt; font-weight:700; letter-spacing:.8px;
           text-transform:uppercase; padding:5px 13px; border-radius:999px; color:#fff;
           white-space:nowrap; }}
  .chip.ok {{ background:#1e8e3e; }}
  .chip.rev {{ background:#1a73e8; }}
  td.c {{ text-align:right; width:1.3in; }}
  td.c .chip {{ font-size:7.5pt; padding:4px 10px; }}
  .caplabel {{ font-size:8.5pt; text-transform:uppercase; letter-spacing:1.4px; color:{mute}; margin-bottom:9px; }}
  .cap p {{ font-size:10pt; line-height:1.6; margin:0 0 11px; }}
  .cap p.tags {{ color:{mute}; font-size:9pt; }}
  .note {{ margin-top:16px; background:#fdf3f3; border-left:3px solid {red}; padding:11px 13px; font-size:9pt; line-height:1.55; }}
</style>

<section class="page cover">
  <div class="bar"></div>
  <h1>Social Posts<br>for Review</h1>
  <p class="sub">{html.escape(name)} &nbsp;·&nbsp; {n} post{'s' if n != 1 else ''}, {short_date(first)} to {short_date(last)}</p>

  <p class="lede">Below are the {n} posts proposed for {html.escape(name)}'s social channels,
  each with its graphic and its final post text exactly as it will appear. Every caption carries
  the {html.escape(foot) if foot else 'standard'} line. The chip on each post shows where it stands;
  everything marked Under Review is waiting on your word.</p>

  <div class="facts">
    <dl>
      <dt>Batch</dt><dd>{batch} &nbsp;·&nbsp; version {version}</dd>
      <dt>First post</dt><dd>{long_date(first)}</dd>
      <dt>Last post</dt><dd>{long_date(last)}</dd>
      <dt>Channels</dt><dd>{html.escape(', '.join(channels_all))}</dd>
      <dt>Prepared by</dt><dd>Linnflux</dd>
    </dl>
  </div>

  <h3>Posting schedule</h3>
  <table>{schedule}</table>

  <h3>What we need back</h3>
  <ol>
    <li>Look over each post's text and graphic.</li>
    <li>Reply on this email thread with approvals or changes. One reply covering all posts is ideal.</li>
    <li>Anything Compliance needs changed: same thread, before the first post runs.</li>
  </ol>
  <p class="lede" style="margin-top:16px">Post 1 is scheduled for {long_date(first)},
  so approval before then holds the schedule. Anything not approved by its date moves to the next open slot.</p>

  <div class="foot"><span>Prepared by Linnflux for {html.escape(name)}</span>
    <span>Generated {today} &nbsp;·&nbsp; v{version}</span></div>
</section>
{''.join(pages)}
"""


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", required=True)
    ap.add_argument("--batch", required=True)
    ap.add_argument("--out", required=True, help="local output dir (client dir, outside the repo)")
    ap.add_argument("--upload", action="store_true", help="create/update the Drive PDF and record it on Batches")
    ap.add_argument("--include-rate", action="store_true")
    ap.add_argument("--version", type=int, help="override the version number")
    a = ap.parse_args()

    chrome = next((shutil.which(e) for e in ("chromium", "chromium-browser", "google-chrome") if shutil.which(e)), None)
    if not chrome:
        sys.exit("no chromium on PATH")

    svc = get_sheets_service()
    cfg = read_config(svc, a.sheet)
    for k in ("client_name",):
        if k not in cfg:
            sys.exit(f"Config is missing {k}")
    _, cal = read_tab(svc, a.sheet, "Calendar")
    bhead, batches = read_tab(svc, a.sheet, "Batches")
    brow = next((b for b in batches if b["Batch"] == a.batch), None)
    if not brow:
        sys.exit(f"no Batches row for {a.batch!r}; add one first")

    in_batch = [r for r in cal if r["Batch"] == a.batch]
    if not in_batch:
        sys.exit(f"no Calendar rows with Batch = {a.batch!r}")
    skipped = [r for r in in_batch if r["Status"] in SKIP_STATUSES]
    rows = [r for r in in_batch if r["Status"] not in SKIP_STATUSES]
    for r in skipped:
        print(f"  skipping {r['ID']} ({r['Status']})")
    bad = [r for r in rows if r["Status"] not in REVIEW_STATUSES and r["Status"] != "Draft"]
    if bad:
        sys.exit("unknown Status on: " + ", ".join(f"{r['ID']}={r['Status']!r}" for r in bad))

    errs = lint(rows, cfg, a.include_rate)
    if errs:
        print("LINT FAILED, not building:")
        for e in errs:
            print("  -", e)
        sys.exit(1)
    rows.sort(key=lambda r: (r["Post date"], r["ID"]))

    cur_v = int(re.sub(r"\D", "", brow.get("PDF version", "") or "0") or 0)
    version = a.version or cur_v + 1

    drive = gbuild("drive", "v3", credentials=drive_creds())
    os.makedirs(a.out, exist_ok=True)
    cache = os.path.join(a.out, ".image-cache")
    os.makedirs(cache, exist_ok=True)
    images = {r["ID"]: fetch_image(drive, drive_id(r["Image"]), cache) for r in rows}

    short = cfg.get("client_short", cfg["client_name"]).replace(" ", "")
    stem = f"{short}-Social-Review-{a.batch}"
    html_path = os.path.join(a.out, f"_{stem}.html")
    pdf_path = os.path.join(a.out, f"{stem}-v{version}.pdf")
    with open(html_path, "w") as fh:
        fh.write(build_html(rows, cfg, a.batch, version, images))
    subprocess.run([chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=8000",
                    "--no-pdf-header-footer", f"--print-to-pdf={pdf_path}", "file://" + html_path],
                   check=True, capture_output=True)
    os.remove(html_path)
    size = os.path.getsize(pdf_path)
    if size < 150_000 * len(rows):
        sys.exit(f"PDF is only {size}B for {len(rows)} posts; the graphics almost certainly did not embed")
    print(f"Wrote {pdf_path}  ({size/1e6:.1f} MB, {len(rows)+1} pages, v{version})")

    if not a.upload:
        print("(not uploaded; pass --upload to publish to Drive and record on Batches)")
        return
    folder = ensure_reviews_folder(drive, svc, a.sheet, cfg)
    media = MediaFileUpload(pdf_path, mimetype="application/pdf", resumable=False)
    existing = drive_id(brow.get("PDF link", ""))
    if existing:
        f = drive.files().update(fileId=existing, media_body=media, fields="id,webViewLink,name",
                                 supportsAllDrives=True).execute()
        print(f"updated in place: {f['name']} ({f['id']})")
    else:
        f = drive.files().create(body={"name": f"{stem}.pdf", "parents": [folder]}, media_body=media,
                                 fields="id,webViewLink,name", supportsAllDrives=True).execute()
        print(f"created on Drive: {f['name']} ({f['id']})")
    guarded_write(svc, a.sheet, "Batches", brow["_row"], bhead,
                  {"PDF version": f"v{version}", "PDF link": f["webViewLink"]},
                  {"Batch": a.batch, "PDF version": brow.get("PDF version", "")})
    print(f"Batches {a.batch}: PDF version v{version}, link {f['webViewLink']}")


if __name__ == "__main__":
    main()
