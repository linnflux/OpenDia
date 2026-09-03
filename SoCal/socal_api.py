#!/usr/bin/env python3
"""JSON bridge for the SoCal admin dashboard view.

The dashboard server shells out to this instead of reimplementing Sheets or
Graph API access in Node — the same sheet.py guarded writes and the same Meta
token serve every surface, so there is exactly one implementation of each.

    socal_api.py clients                      registry + per-client summary
    socal_api.py calendar  --sheet SID        all Calendar rows + config subset
    socal_api.py analytics --page ID --ig ID  followers + recent post metrics
    socal_api.py patch --sheet SID --id POSTID --field F --value V
                                              guarded write with lifecycle rule

All output is a single JSON object on stdout. Registry lives OUTSIDE the repo
(~/OpenDia/socal-clients.json) because it names clients.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.expanduser("~/OpenDia/scripts"))
from sheet import get_sheets_service, read_tab, read_config, guarded_write, STATUSES  # noqa: E402

REGISTRY = os.path.expanduser("~/OpenDia/socal-clients.json")
TOKEN_PATH = os.path.expanduser("~/.claude/mcp-credentials/meta/access_token")
GRAPH = "https://graph.facebook.com/v21.0"

# fields a dashboard edit may touch, and the lifecycle rule: changing the
# CONTENT of a post that was already approved un-approves it — an edited post
# is no longer the approved post.
EDITABLE = {"Caption", "Post date", "Time", "Title", "Status", "Notes", "Client comments"}
CONTENT_FIELDS = {"Caption", "Title"}
APPROVED_STATES = {"Approved", "Scheduled"}


def load_registry():
    with open(REGISTRY) as fh:
        return json.load(fh)


def read_tab_retry(svc, sid, tab, tries=3):
    """Sheets returns transient 503s often enough to matter for a dashboard."""
    import time
    for i in range(tries):
        try:
            return read_tab(svc, sid, tab)
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))


def meta_get(path, tok, **params):
    import requests
    r = requests.get(f"{GRAPH}/{path}", params=params,
                     headers={"Authorization": f"Bearer {tok}"}, timeout=30)
    return r.json()


def cmd_clients(_a):
    svc = get_sheets_service()
    out = []
    for c in load_registry():
        entry = dict(c)
        try:
            _, rows = read_tab_retry(svc, c["sheet"], "Calendar")
            rows = [r for r in rows if r.get("ID")]
            by = {}
            for r in rows:
                by[r["Status"]] = by.get(r["Status"], 0) + 1
            upcoming = sorted((r for r in rows if r["Status"] in ("Approved", "Scheduled", "Under Review", "Ready")),
                              key=lambda r: r["Post date"] or "9999")
            published = sorted((r for r in rows if r["Status"] == "Published"),
                               key=lambda r: r.get("Published date") or "")
            entry["counts"] = by
            entry["total"] = len(rows)
            entry["next_post"] = ({"id": upcoming[0]["ID"], "date": upcoming[0]["Post date"],
                                   "title": upcoming[0]["Title"], "status": upcoming[0]["Status"]}
                                  if upcoming else None)
            entry["last_published"] = ({"id": published[-1]["ID"], "date": published[-1].get("Published date"),
                                        "title": published[-1]["Title"]} if published else None)
        except Exception as e:
            entry["error"] = str(e)
        out.append(entry)
    return {"clients": out}


def cmd_calendar(a):
    svc = get_sheets_service()
    head, rows = read_tab_retry(svc, a.sheet, "Calendar")
    cfg = read_config(svc, a.sheet)
    rows = [{k: v for k, v in r.items() if k != "_row"} for r in rows if r.get("ID")]
    return {"rows": rows, "statuses": STATUSES,
            "config": {k: cfg.get(k, "") for k in
                       ("client_name", "post_weekday", "posts_per_month", "footer_line", "image_style")}}


def cmd_analytics(a):
    tok = open(TOKEN_PATH).read().strip()
    out = {"page": {}, "fb_posts": [], "ig_posts": []}
    # page token for page-level reads
    ptok = tok
    for p in meta_get("me/accounts", tok, fields="id,access_token").get("data", []):
        if p["id"] == a.page:
            ptok = p["access_token"]
            break
    fol = meta_get(f"{a.page}/insights", ptok, metric="page_follows", period="day")
    try:
        out["page"]["followers"] = fol["data"][0]["values"][-1]["value"]
    except Exception:
        out["page"]["followers"] = None
    posts = meta_get(f"{a.page}/published_posts", ptok, limit=10,
                     fields="id,message,permalink_url,created_time,shares,"
                            "reactions.summary(true).limit(0),comments.summary(true).limit(0)")
    for p in posts.get("data", []):
        out["fb_posts"].append({
            "id": p["id"], "created": p.get("created_time"),
            "permalink": p.get("permalink_url"),
            "message": (p.get("message") or "")[:120],
            "reactions": (p.get("reactions") or {}).get("summary", {}).get("total_count"),
            "comments": (p.get("comments") or {}).get("summary", {}).get("total_count"),
            "shares": (p.get("shares") or {}).get("count", 0),
        })
    if a.ig:
        media = meta_get(f"{a.ig}/media", tok, limit=10,
                         fields="id,caption,permalink,timestamp,like_count,comments_count")
        for m in media.get("data", []):
            out["ig_posts"].append({
                "id": m["id"], "created": m.get("timestamp"),
                "permalink": m.get("permalink"),
                "message": (m.get("caption") or "")[:120],
                "likes": m.get("like_count"), "comments": m.get("comments_count"),
            })
        try:
            igf = meta_get(a.ig, tok, fields="followers_count")
            out["page"]["ig_followers"] = igf.get("followers_count")
        except Exception:
            pass
    return out


def cmd_patch(a):
    if a.field not in EDITABLE:
        return {"error": f"field {a.field!r} is not editable from the dashboard"}
    if a.field == "Status" and a.value not in STATUSES:
        return {"error": f"invalid status {a.value!r}"}
    svc = get_sheets_service()
    head, rows = read_tab_retry(svc, a.sheet, "Calendar")
    row = next((r for r in rows if r.get("ID") == a.id), None)
    if not row:
        return {"error": f"no row with ID {a.id}"}
    updates = {a.field: a.value}
    demoted = False
    if a.field in CONTENT_FIELDS and row["Status"] in APPROVED_STATES:
        updates["Status"] = "Ready"
        demoted = True
    guarded_write(svc, a.sheet, "Calendar", row["_row"], head, updates, {"ID": a.id})
    return {"ok": True, "id": a.id, "updated": list(updates),
            "demoted_to_ready": demoted,
            "warning": ("content changed on an approved post; status dropped to Ready — "
                        "it must be re-approved (and re-scheduled if it was already queued)"
                        if demoted else None)}


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("clients")
    c = sub.add_parser("calendar"); c.add_argument("--sheet", required=True)
    an = sub.add_parser("analytics"); an.add_argument("--page", required=True); an.add_argument("--ig", default="")
    p = sub.add_parser("patch")
    p.add_argument("--sheet", required=True); p.add_argument("--id", required=True)
    p.add_argument("--field", required=True); p.add_argument("--value", required=True)
    a = ap.parse_args()
    fn = {"clients": cmd_clients, "calendar": cmd_calendar,
          "analytics": cmd_analytics, "patch": cmd_patch}[a.cmd]
    print(json.dumps(fn(a)))


if __name__ == "__main__":
    main()
