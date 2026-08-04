#!/usr/bin/env python3
"""
chat_helper.py — Read-only Google Chat client using the existing OAuth token.

Mirrors gmail_helper.py: same credential files, same dynamic-scopes-from-token
handling, same self-refresh. Exists because the Google Chat MCP server is only
reachable from an interactive session — headless runs (cron, `claude -p`, the
dashboard) hit the same token-refresh failure the Oracle documented for Gmail.

Read-only by construction. The shared token carries chat.spaces.readonly and
chat.messages.readonly only, so there is no send/post surface here and adding
one would require a re-consent (which would replace ALL scopes on the token).

Usage:
    chat_helper.py spaces [--json]
    chat_helper.py messages <space> [n] [--since YYYY-MM-DD] [--json]
    chat_helper.py find "<person>" [--json]

<space> accepts either a full resource name ("spaces/AAAAxxxx") or a person's
name, which is resolved through the person map the same way `find` does.
"""

import argparse
import json
import re
import sys
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

CREDENTIALS_PATH = Path.home() / ".claude" / "mcp-credentials" / "google-workspace.json"
TOKENS_PATH = Path.home() / ".claude" / "mcp-credentials" / "google-workspace" / "tokens.json"

# The person -> space map lives outside the (public) repo, alongside the other
# operator reference material. Never inline its contents here.
SPACE_MAP_PATH = Path.home() / "OpenDia" / "reference" / "chat-spaces.md"

FALLBACK_SCOPES = [
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.messages.readonly",
]


def _load_service():
    """Load and return an authorized Google Chat API service object."""
    creds_data = json.loads(CREDENTIALS_PATH.read_text())
    tokens_data = json.loads(TOKENS_PATH.read_text())

    installed = creds_data.get("installed") or creds_data.get("web") or creds_data

    # Use scopes from the token file so refresh requests don't fail on mismatch.
    token_scopes = tokens_data.get("scope", "").split() or FALLBACK_SCOPES

    creds = Credentials(
        token=tokens_data.get("access_token"),
        refresh_token=tokens_data.get("refresh_token"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=installed["client_id"],
        client_secret=installed["client_secret"],
        scopes=token_scopes,
    )

    if tokens_data.get("expiry_date"):
        import datetime
        # google-auth compares against a naive UTC datetime, so strip tzinfo
        # after converting (utcfromtimestamp itself is deprecated).
        creds.expiry = datetime.datetime.fromtimestamp(
            tokens_data["expiry_date"] / 1000, datetime.timezone.utc
        ).replace(tzinfo=None)

    if not creds.valid:
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            tokens_data["access_token"] = creds.token
            if creds.expiry:
                import calendar
                tokens_data["expiry_date"] = int(
                    calendar.timegm(creds.expiry.timetuple()) * 1000
                )
            TOKENS_PATH.write_text(json.dumps(tokens_data, indent=2))
        else:
            raise RuntimeError("Chat credentials expired and cannot be refreshed")

    return build("chat", "v1", credentials=creds, cache_discovery=False)


# ── Person map ─────────────────────────────────────────────────────────────

def load_space_map() -> list[dict]:
    """Parse the operator's person -> space table.

    Returns [{person, space, user_id}] for every markdown table row carrying a
    `spaces/...` id or a `users/...` id — a row may have only a user id (Nick's
    own outbound messages have no DM space but still need a label). Missing
    file is not an error; callers just fall back to raw ids.
    """
    rows = []
    try:
        text = SPACE_MAP_PATH.read_text()
    except OSError:
        return rows

    for line in text.splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip().strip("`") for c in line.strip("|").split("|")]
        if len(cells) < 2:
            continue
        space = next((c for c in cells if c.startswith("spaces/")), "")
        user_id = next((c for c in cells if c.startswith("users/")), "")
        if not space and not user_id:
            continue
        rows.append({"person": cells[0], "space": space, "user_id": user_id})
    return rows


def resolve_person(needle: str) -> list[dict]:
    """Match a person with a readable space, by any word in their map entry."""
    n = needle.strip().lower()
    if not n:
        return []
    rows = [r for r in load_space_map() if r["space"]]
    hits = [r for r in rows if n in r["person"].lower()]
    if hits:
        return hits
    # Fall back to a first-name / surname token match.
    return [r for r in rows if any(tok and tok in r["person"].lower() for tok in n.split())]


def _sender_label(sender: dict, by_user_id: dict) -> str:
    """Human-readable sender: API display name, else the person map, else the id."""
    name = (sender or {}).get("displayName") or ""
    if name:
        return name
    uid = (sender or {}).get("name") or ""
    mapped = by_user_id.get(uid)
    return mapped or uid or "unknown"


def _resolve_space_arg(value: str) -> str:
    """Accept a raw space id or a person's name."""
    if value.startswith("spaces/"):
        return value
    hits = resolve_person(value)
    if not hits:
        sys.exit(f"no space mapped for {value!r} — add a row to {SPACE_MAP_PATH}")
    if len(hits) > 1:
        names = ", ".join(h["person"] for h in hits)
        sys.exit(f"{value!r} matches multiple people ({names}) — be more specific")
    return hits[0]["space"]


# ── Commands ───────────────────────────────────────────────────────────────

def cmd_spaces(args):
    svc = _load_service()
    by_space = {r["space"]: r["person"] for r in load_space_map()}
    out, token = [], None
    while True:
        kwargs = {"pageSize": 100}
        if token:
            kwargs["pageToken"] = token
        resp = svc.spaces().list(**kwargs).execute()
        for s in resp.get("spaces", []):
            out.append({
                "space": s.get("name", ""),
                "type": s.get("spaceType") or s.get("type") or "",
                "display_name": s.get("displayName") or "",
                "person": by_space.get(s.get("name", ""), ""),
            })
        token = resp.get("nextPageToken")
        if not token:
            break

    if args.json:
        print(json.dumps(out, indent=2))
        return
    for s in out:
        label = s["display_name"] or s["person"] or "(direct message)"
        mapped = "" if s["person"] or s["display_name"] else "  UNMAPPED"
        print(f"{s['space']:24} {s['type']:14} {label}{mapped}")


def cmd_messages(args):
    svc = _load_service()
    space = _resolve_space_arg(args.space)
    by_user_id = {r["user_id"]: r["person"] for r in load_space_map() if r["user_id"]}

    kwargs = {"parent": space, "pageSize": args.n, "orderBy": "createTime desc"}
    if args.since:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.since):
            sys.exit("--since must be YYYY-MM-DD")
        kwargs["filter"] = f'createTime > "{args.since}T00:00:00Z"'

    resp = svc.spaces().messages().list(**kwargs).execute()
    msgs = [
        {
            "sender": _sender_label(m.get("sender"), by_user_id),
            "createTime": m.get("createTime", ""),
            "text": m.get("text") or m.get("formattedText") or "",
            "thread": (m.get("thread") or {}).get("name", ""),
        }
        for m in resp.get("messages", [])
    ]
    # The API returns newest-first; read oldest-first like a conversation.
    msgs.reverse()

    if args.json:
        print(json.dumps({"space": space, "messages": msgs}, indent=2))
        return
    if not msgs:
        print(f"No messages in {space}" + (f" since {args.since}" if args.since else ""))
        return
    for m in msgs:
        print(f"[{m['createTime'][:16]}] {m['sender']}:")
        for line in (m["text"] or "(no text)").splitlines():
            print(f"    {line}")
        print()


def cmd_find(args):
    hits = resolve_person(args.person)
    if args.json:
        print(json.dumps(hits, indent=2))
        return
    if not hits:
        print(f"no space mapped for {args.person!r} — add a row to {SPACE_MAP_PATH}")
        return
    for h in hits:
        print(f"{h['space']:24} {h['user_id']:34} {h['person']}")


def main():
    p = argparse.ArgumentParser(
        prog="chat_helper",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    # --json is accepted on either side of the subcommand. SUPPRESS on the
    # subparser copy is load-bearing: without it, an unpassed subparser default
    # would clobber a --json given before the subcommand.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS,
                        help="emit JSON instead of text")
    p.add_argument("--json", action="store_true", help="emit JSON instead of text")
    sub = p.add_subparsers(dest="cmd", required=True)

    ps = sub.add_parser("spaces", parents=[common],
                        help="list every space this account can read")
    ps.set_defaults(fn=cmd_spaces)

    pm = sub.add_parser("messages", parents=[common],
                        help="read recent messages in a space")
    pm.add_argument("space", help='"spaces/AAAA..." or a person\'s name')
    pm.add_argument("n", nargs="?", type=int, default=20, help="how many (default 20)")
    pm.add_argument("--since", help="only messages after YYYY-MM-DD")
    pm.set_defaults(fn=cmd_messages)

    pf = sub.add_parser("find", parents=[common],
                        help="resolve a person to their space id")
    pf.add_argument("person")
    pf.set_defaults(fn=cmd_find)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
