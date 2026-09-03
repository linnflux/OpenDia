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


def apply_updates(svc, sheet, row, head, updates):
    """Validate + apply field updates to one row with the lifecycle rule."""
    bad = [f for f in updates if f not in EDITABLE]
    if bad:
        return {"error": f"fields not editable from the dashboard: {bad}"}
    if "Status" in updates and updates["Status"] not in STATUSES:
        return {"error": f"invalid status {updates['Status']!r}"}
    if "Caption" in updates:
        updates["Caption"] = updates["Caption"].replace("—", ",")  # lint: no em dashes
    demoted = False
    if any(f in CONTENT_FIELDS for f in updates) and row["Status"] in APPROVED_STATES \
            and updates.get("Status") is None:
        updates["Status"] = "Ready"
        demoted = True
    guarded_write(svc, sheet, "Calendar", row["_row"], head, updates, {"ID": row["ID"]})
    return {"ok": True, "id": row["ID"], "updated": list(updates),
            "demoted_to_ready": demoted,
            "warning": ("content changed on an approved post; status dropped to Ready — "
                        "it must be re-approved (and re-scheduled if it was already queued)"
                        if demoted else None)}


def cmd_patch(a):
    svc = get_sheets_service()
    head, rows = read_tab_retry(svc, a.sheet, "Calendar")
    row = next((r for r in rows if r.get("ID") == a.id), None)
    if not row:
        return {"error": f"no row with ID {a.id}"}
    return apply_updates(svc, a.sheet, row, head, {a.field: a.value})


INSTRUCT_PROMPT = """You are the operator's assistant for a managed social media calendar. One post row and the client's config are below, followed by an instruction typed by the operator. Decide what field changes carry out the instruction.

Rules you must respect:
- Editable fields ONLY: Caption, Title, Post date (ISO yyyy-mm-dd), Time (HH:MM 24h), Status, Notes, Client comments.
- Valid statuses: {statuses}. The post lifecycle is Draft -> Ready -> Under Review -> Approved -> Scheduled -> Published.
- Captions: plainspoken, 2-4 short sentences, NO em dashes, no relative-time phrases ("tomorrow", "next week"), keep the footer line "{footer}" as the final line if the caption changes.
- Never invent facts about the client. Client voice/context: {highlight}
- If the instruction is unclear or asks something outside these fields, make NO changes and explain in reply.

POST ROW:
{row}

CLIENT CONFIG:
{config}

OPERATOR INSTRUCTION:
{text}

Return ONLY a JSON object, no fences: {{"updates": {{"Field": "new value", ...}}, "reply": "one or two sentences on what you did or why you did nothing"}}"""


def cmd_instruct(a):
    import re as _re
    import subprocess as _sp
    svc = get_sheets_service()
    head, rows = read_tab_retry(svc, a.sheet, "Calendar")
    row = next((r for r in rows if r.get("ID") == a.id), None)
    if not row:
        return {"error": f"no row with ID {a.id}"}
    cfg = read_config(svc, a.sheet)
    row_view = {k: v for k, v in row.items() if k != "_row" and v}
    prompt = INSTRUCT_PROMPT.format(
        statuses=", ".join(STATUSES),
        footer=cfg.get("footer_line", ""),
        highlight=(cfg.get("image_style", "")[:200] or "plainspoken small business"),
        row=json.dumps(row_view, indent=1),
        config=json.dumps({k: cfg.get(k, "") for k in
                           ("client_name", "post_weekday", "footer_line")}, indent=1),
        text=a.text)
    out = _sp.run(["claude", "-p", prompt], capture_output=True, text=True, timeout=300)
    body = _re.sub(r"^```(json)?|```$", "", out.stdout.strip(), flags=_re.M).strip()
    start, end = body.find("{"), body.rfind("}")
    try:
        parsed = json.loads(body[start:end + 1])
    except Exception:
        return {"error": "assistant returned an unreadable answer", "raw": body[:300]}
    updates = parsed.get("updates") or {}
    reply = parsed.get("reply") or ""
    if not updates:
        return {"ok": True, "id": a.id, "updated": [], "reply": reply or "No changes made."}
    if a.dry:
        return {"ok": True, "id": a.id, "dry": True, "updates": updates, "reply": reply}
    res = apply_updates(svc, a.sheet, row, head, dict(updates))
    if res.get("error"):
        return {"error": res["error"], "reply": reply}
    res["reply"] = reply
    return res


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("clients")
    c = sub.add_parser("calendar"); c.add_argument("--sheet", required=True)
    an = sub.add_parser("analytics"); an.add_argument("--page", required=True); an.add_argument("--ig", default="")
    p = sub.add_parser("patch")
    p.add_argument("--sheet", required=True); p.add_argument("--id", required=True)
    p.add_argument("--field", required=True); p.add_argument("--value", required=True)
    i = sub.add_parser("instruct")
    i.add_argument("--sheet", required=True); i.add_argument("--id", required=True)
    i.add_argument("--text", required=True); i.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    fn = {"clients": cmd_clients, "calendar": cmd_calendar,
          "analytics": cmd_analytics, "patch": cmd_patch, "instruct": cmd_instruct}[a.cmd]
    print(json.dumps(fn(a)))


if __name__ == "__main__":
    main()
