#!/usr/bin/env python3
"""
migrate_inbox_project_ids.py — One-time backfill: set project_id on all inbox_items where it's NULL.

For each item without a project_id:
  - Run match_project() using client_hint + division_hint + short_slug
  - If match found → set project_id to matched project
  - If no match → call ensure_project_for_inbox() to auto-create in wfhuman status

Usage:
    python3 scripts/migrate_inbox_project_ids.py
"""

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from inbox_db import DB_PATH, ensure_project_for_inbox, _con
from context_header import match_project


def run():
    con = _con()
    rows = con.execute(
        "SELECT id, client_hint, division_hint, short_slug, subject "
        "FROM inbox_items WHERE project_id IS NULL"
    ).fetchall()
    con.close()

    total = len(rows)
    print(f"Found {total} inbox item(s) without project_id")
    if total == 0:
        return

    matched_count = 0
    created_count = 0

    for row in rows:
        row = dict(row)
        matched = match_project(
            row["client_hint"] or "",
            row["division_hint"] or "",
            task_hint=row["short_slug"] or "",
        )

        if matched:
            project_id = matched["id"]
            print(f"  Item {row['id']}: matched project {project_id} ({matched['name']})")
            matched_count += 1
        else:
            project_id = ensure_project_for_inbox(
                client_hint=row["client_hint"] or "",
                division_hint=row["division_hint"] or "",
                short_slug=row["short_slug"] or "inbox-item",
                subject=row["subject"] or "",
            )
            print(f"  Item {row['id']}: auto-created project {project_id} (wfhuman)")
            created_count += 1

        con = sqlite3.connect(DB_PATH)
        con.execute(
            "UPDATE inbox_items SET project_id = ?, updated_at = datetime('now') WHERE id = ?",
            (project_id, row["id"]),
        )
        con.commit()
        con.close()

    print(f"\nDone. {matched_count} matched existing projects, {created_count} auto-created.")


if __name__ == "__main__":
    run()
