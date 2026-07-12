#!/usr/bin/env python3
"""Guard: no real client identifier may enter this PUBLIC repo.

Cross-references every tracked/staged file against the company names in the
local OpenDia SQLite DB. Linnflux's own names and its division names are
allowed; anything else that matches a real client is a hard fail.

This exists because a bulk "put the scripts in git" step nearly published a
script containing a client owner's name, email, phone, and mailing address.
Automation is cheaper than remembering.

Usage:
  check_no_client_names.py            # scan tracked + staged files
  check_no_client_names.py --staged   # staged only (pre-commit hook)
"""

import argparse
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

DB = Path.home() / "OpenDia" / "opendia.db"
# Linnflux's own identity + division names, which legitimately appear in code.
ALLOWED = {
    "linnflux", "wordflux", "watchthreat", "ampen", "bedford ai",
    "ada web work", "fluxcc", "admin", "onboarding", "opendia",
}
SKIP_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".lock"}


def client_names():
    if not DB.exists():
        print("check_no_client_names: DB not found, skipping", file=sys.stderr)
        return set()
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    names = set()
    for q in ("SELECT name FROM companies", "SELECT short_name FROM companies"):
        for (n,) in db.execute(q):
            if n and len(n.strip()) > 4 and n.strip().lower() not in ALLOWED:
                names.add(n.strip())
    db.close()
    return names


def files_to_scan(staged_only):
    cmd = ["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"] if staged_only \
        else ["git", "ls-files"]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout.split("\n")
    return [f for f in out if f and Path(f).suffix not in SKIP_SUFFIXES and Path(f).is_file()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--staged", action="store_true")
    args = ap.parse_args()

    names = client_names()
    if not names:
        return 0

    hits = []
    for f in files_to_scan(args.staged):
        try:
            text = Path(f).read_text(errors="ignore")
        except OSError:
            continue
        for n in names:
            for i, line in enumerate(text.splitlines(), 1):
                # Case-sensitive: client names are proper nouns. A case-insensitive
                # match false-positives on ordinary words that happen to collide
                # with a company name in the DB.
                if re.search(r"\b" + re.escape(n) + r"\b", line):
                    hits.append((f, i, n))

    if hits:
        print("BLOCKED: real client identifiers found in a PUBLIC repo:\n", file=sys.stderr)
        for f, line, _ in hits:
            print(f"  {f}:{line}  (matches a client name in opendia.db)", file=sys.stderr)
        print("\nScrub these, or add the file to .gitignore if it's a client one-off.", file=sys.stderr)
        return 1

    print(f"OK — no client identifiers in {'staged' if args.staged else 'tracked'} files.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
