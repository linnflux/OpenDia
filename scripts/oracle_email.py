#!/usr/bin/env python3
"""oracle_email.py — send an Oracle email via the shared Gmail helper.

Used by the recurring Oracle (oracle_run.sh). Kept deterministic in Python so
delivery does not depend on the Gmail MCP being connected during a headless
cron run. Mirrors the lonely_whistle.py send pattern.

Usage:
    python3 oracle_email.py --subject "Oracle Brief — 2026-07-01" --body-file /path/to/body.txt
    echo "body text" | python3 oracle_email.py --subject "Oracle — alert"

Body must be PLAIN TEXT (no markdown — stars render literally in Gmail).
"""

import argparse
import sys

from gmail_helper import _load_service, send_email

RECIPIENT = "opendia@linnflux.com"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--subject", required=True)
    ap.add_argument("--body-file", help="Path to a plain-text body file; if omitted, reads stdin")
    ap.add_argument("--to", default=RECIPIENT)
    args = ap.parse_args()

    if args.body_file:
        with open(args.body_file, encoding="utf-8") as f:
            body = f.read()
    else:
        body = sys.stdin.read()

    if not body.strip():
        print("oracle_email: empty body, refusing to send", file=sys.stderr)
        sys.exit(2)

    service = _load_service()
    result = send_email(service, args.to, args.subject, body)
    print(f"oracle_email: sent to {args.to} (id={result.get('id', '?')})")


if __name__ == "__main__":
    main()
