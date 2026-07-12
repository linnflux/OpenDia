#!/usr/bin/env python3
"""oracle_gmail.py — READ-ONLY Gmail signal helper for the Oracle (reader #3).

Bypasses the Gmail MCP (which fails in headless runs on token refresh) by using
the local OAuth token directly via gmail_helper._load_service() — the same path
that reliably sends the Oracle's own summary email.

This tool ONLY READS. It never sends and never drafts. (If the Oracle ever needs
to draft an owed reply, that is done separately via gmail_helper.create_draft —
which creates a DRAFT only and NEVER sends. send_email() must never be called by
the Oracle.)

Usage:
    python3 oracle_gmail.py owed-replies [days]      # inbound threads awaiting a reply (default 21)
    python3 oracle_gmail.py search "<gmail query>" [max]   # read search: from/subject/date/snippet
    python3 oracle_gmail.py volume "<gmail query>"   # approx total matching (resultSizeEstimate)
    python3 oracle_gmail.py thread <threadId>        # full text of a thread (for deep reads)
    python3 oracle_gmail.py labels                   # list labels

Examples:
    python3 oracle_gmail.py owed-replies 30
    python3 oracle_gmail.py volume "in:sent newer_than:90d"
    python3 oracle_gmail.py search "subject:(quote OR proposal OR demo) newer_than:60d" 20
"""

import sys

sys.path.insert(0, "/home/linnflux/OpenDia/scripts")
from gmail_helper import _load_service, get_thread_messages, extract_message_text  # noqa: E402

ME = "nick@linnflux.com"


def _hdr(msg, name):
    for h in msg["payload"]["headers"]:
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


def owed_replies(svc, days=21):
    """Threads in the primary inbox whose newest message is NOT from Nick."""
    q = f"newer_than:{days}d in:inbox category:primary -from:me"
    ids = [m["id"] for m in svc.users().messages().list(
        userId="me", q=q, maxResults=60).execute().get("messages", [])]
    seen, owed = set(), 0
    print(f"# owed-replies scan ({days}d): {len(ids)} candidate inbound msgs\n")
    for mid in ids:
        tid = svc.users().messages().get(
            userId="me", id=mid, format="minimal").execute().get("threadId")
        if tid in seen:
            continue
        seen.add(tid)
        thr = svc.users().threads().get(
            userId="me", id=tid, format="metadata",
            metadataHeaders=["From", "Subject", "Date"]).execute()
        last = thr["messages"][-1]
        frm = _hdr(last, "From")
        if ME in frm.lower():
            continue  # Nick replied last
        owed += 1
        print(f"THREAD {tid}")
        print(f"  from:    {frm}")
        print(f"  subject: {_hdr(last, 'Subject')}")
        print(f"  date:    {_hdr(last, 'Date')}")
        print(f"  snippet: {last.get('snippet', '')[:200]}\n")
    print(f"# {owed} thread(s) awaiting a reply")


def search(svc, query, maxn=20):
    res = svc.users().messages().list(userId="me", q=query, maxResults=maxn).execute()
    ids = [m["id"] for m in res.get("messages", [])]
    print(f"# search: {query!r}  (~{res.get('resultSizeEstimate', '?')} total, showing {len(ids)})\n")
    for mid in ids:
        m = svc.users().messages().get(
            userId="me", id=mid, format="metadata",
            metadataHeaders=["From", "Subject", "Date"]).execute()
        print(f"  {_hdr(m,'Date')[:25]:25} | {_hdr(m,'From')[:40]:40} | {_hdr(m,'Subject')[:60]}")
        print(f"      thread={m.get('threadId')}  {m.get('snippet','')[:120]}")


def volume(svc, query):
    res = svc.users().messages().list(userId="me", q=query, maxResults=1).execute()
    print(f"{res.get('resultSizeEstimate', 0)}\t{query}")


def thread(svc, tid):
    for m in get_thread_messages(svc, tid):
        subj, frm, date, body = extract_message_text(m)
        print(f"--- {date} | {frm} | {subj}")
        print(body[:4000])
        print()


def labels(svc):
    for lb in svc.users().labels().list(userId="me").execute().get("labels", []):
        print(f"  {lb['id']:30} {lb['name']}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    svc = _load_service()
    cmd = sys.argv[1]
    if cmd == "owed-replies":
        owed_replies(svc, int(sys.argv[2]) if len(sys.argv) > 2 else 21)
    elif cmd == "search":
        search(svc, sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 20)
    elif cmd == "volume":
        volume(svc, sys.argv[2])
    elif cmd == "thread":
        thread(svc, sys.argv[2])
    elif cmd == "labels":
        labels(svc)
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
