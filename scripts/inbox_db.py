#!/usr/bin/env python3
"""
inbox_db.py — Python helper for inbox_items and client_aliases tables in opendia.db.
Used by Stage A and Stage B to record inbox pipeline state.
"""

import json
import os
import re
import sqlite3
import subprocess
from datetime import datetime
from pathlib import Path

DB_PATH = Path.home() / "OpenDia" / "opendia.db"

CREATE_INBOX_TABLE = """
CREATE TABLE IF NOT EXISTS inbox_items (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    gmail_id              TEXT UNIQUE,
    thread_id             TEXT,
    from_addr             TEXT,
    subject               TEXT,
    client_hint           TEXT,
    division_hint         TEXT,
    priority              TEXT DEFAULT 'normal',
    short_slug            TEXT,
    prompt_text           TEXT,
    status                TEXT DEFAULT 'classified',
    session_name          TEXT,
    error_text            TEXT,
    notes                 TEXT,
    requires_server_access INTEGER DEFAULT 0,
    estimated_minutes     INTEGER DEFAULT 0,
    timer_marker          TEXT,
    project_hint          TEXT,
    project_id            INTEGER REFERENCES projects(id),
    attachment_meta       TEXT,
    dev_preview_url       TEXT,
    dev_branch            TEXT,
    repo_path             TEXT,
    created_at            DATETIME DEFAULT (datetime('now')),
    updated_at            DATETIME DEFAULT (datetime('now'))
)
"""

CREATE_ALIASES_TABLE = """
CREATE TABLE IF NOT EXISTS client_aliases (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    match_type    TEXT NOT NULL,
    match_value   TEXT NOT NULL,
    client_hint   TEXT NOT NULL,
    division_hint TEXT,
    note          TEXT,
    created_at    DATETIME DEFAULT (datetime('now')),
    UNIQUE(match_type, match_value)
)
"""

CREATE_FLUXCC_SITES_TABLE = """
CREATE TABLE IF NOT EXISTS fluxcc_sites (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    client_hint   TEXT NOT NULL UNIQUE,
    display_name  TEXT,
    slug          TEXT UNIQUE,
    repo_path     TEXT,
    cf_project    TEXT,
    gitlab_repo   TEXT,
    preview_url   TEXT,
    custom_domain TEXT,
    status        TEXT,
    auto_email    INTEGER DEFAULT 0,
    created_at    DATETIME DEFAULT (datetime('now')),
    updated_at    DATETIME DEFAULT (datetime('now'))
)
"""


def _con():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    con.execute(CREATE_INBOX_TABLE)
    con.execute(CREATE_ALIASES_TABLE)
    con.execute(CREATE_FLUXCC_SITES_TABLE)
    # Migrate: add columns if they don't exist yet
    cols = {row[1] for row in con.execute("PRAGMA table_info(inbox_items)")}
    if "notes" not in cols:
        con.execute("ALTER TABLE inbox_items ADD COLUMN notes TEXT")
    if "requires_server_access" not in cols:
        con.execute("ALTER TABLE inbox_items ADD COLUMN requires_server_access INTEGER DEFAULT 0")
    if "estimated_minutes" not in cols:
        con.execute("ALTER TABLE inbox_items ADD COLUMN estimated_minutes INTEGER DEFAULT 0")
    if "timer_marker" not in cols:
        con.execute("ALTER TABLE inbox_items ADD COLUMN timer_marker TEXT")
    if "project_hint" not in cols:
        con.execute("ALTER TABLE inbox_items ADD COLUMN project_hint TEXT")
    if "project_id" not in cols:
        con.execute("ALTER TABLE inbox_items ADD COLUMN project_id INTEGER REFERENCES projects(id)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_inbox_items_project_id ON inbox_items(project_id)")
    if "attachment_meta" not in cols:
        con.execute("ALTER TABLE inbox_items ADD COLUMN attachment_meta TEXT")
    if "dev_preview_url" not in cols:
        con.execute("ALTER TABLE inbox_items ADD COLUMN dev_preview_url TEXT")
    if "dev_branch" not in cols:
        con.execute("ALTER TABLE inbox_items ADD COLUMN dev_branch TEXT")
    if "repo_path" not in cols:
        con.execute("ALTER TABLE inbox_items ADD COLUMN repo_path TEXT")
    if "lead_approved_at" not in cols:
        con.execute("ALTER TABLE inbox_items ADD COLUMN lead_approved_at TEXT")
    con.commit()
    return con


def create_inbox_item(gmail_id, thread_id, from_addr, subject,
                      client_hint, division_hint, priority, short_slug, prompt_text,
                      requires_server_access=False, estimated_minutes=15,
                      project_hint=None, project_id=None, attachment_meta=None) -> int:
    """Insert a new inbox item. Returns the new row id."""
    con = _con()
    try:
        cur = con.execute("""
            INSERT OR IGNORE INTO inbox_items
              (gmail_id, thread_id, from_addr, subject,
               client_hint, division_hint, priority, short_slug, prompt_text, status,
               requires_server_access, estimated_minutes, project_hint, project_id,
               attachment_meta)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'classified', ?, ?, ?, ?, ?)
        """, (gmail_id, thread_id, from_addr, subject,
              client_hint, division_hint, priority, short_slug, prompt_text,
              1 if requires_server_access else 0, estimated_minutes, project_hint, project_id,
              attachment_meta))
        con.commit()
        return cur.lastrowid
    finally:
        con.close()


def get_inbox_item_by_gmail_id(gmail_id: str):
    """Fetch a single inbox item by gmail_id. Returns dict or None."""
    con = _con()
    try:
        row = con.execute(
            "SELECT * FROM inbox_items WHERE gmail_id = ?", (gmail_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        con.close()


INBOX_UPDATABLE = {
    "status", "session_name", "error_text",
    "client_hint", "division_hint", "priority", "notes",
    "requires_server_access", "estimated_minutes", "timer_marker",
    "project_hint", "project_id", "prompt_text", "attachment_meta",
    "dev_preview_url", "dev_branch", "repo_path",
}


def update_inbox_item(gmail_id: str, **fields):
    """Update fields on an inbox item by gmail_id."""
    sets = [(k, v) for k, v in fields.items() if k in INBOX_UPDATABLE]
    if not sets:
        return
    con = _con()
    try:
        placeholders = ", ".join(f"{k} = ?" for k, _ in sets)
        values = [v for _, v in sets]
        values.append(gmail_id)
        con.execute(
            f"UPDATE inbox_items SET {placeholders}, updated_at = datetime('now') WHERE gmail_id = ?",
            values,
        )
        con.commit()
    finally:
        con.close()


def _extract_email_and_domain(from_addr: str):
    """Extract raw email address and domain from a From header."""
    m = re.search(r"<([^>]+)>", from_addr)
    email = m.group(1).strip().lower() if m else from_addr.strip().lower()
    domain = email.split("@", 1)[1] if "@" in email else ""
    return email, domain


def lookup_alias(from_addr: str, subject: str = ""):
    """
    Look up a client alias for a given sender.
    Returns a dict with client_hint (and optionally division_hint) or None.

    Priority: email > domain > substring (in subject).
    """
    email, domain = _extract_email_and_domain(from_addr)
    subject_lower = subject.lower()

    con = _con()
    try:
        rows = con.execute(
            "SELECT * FROM client_aliases ORDER BY CASE match_type "
            "WHEN 'email' THEN 1 WHEN 'domain' THEN 2 ELSE 3 END"
        ).fetchall()
        for row in rows:
            mt, mv = row["match_type"], row["match_value"].lower()
            if mt == "email" and mv == email:
                return dict(row)
            if mt == "domain" and mv == domain:
                return dict(row)
            if mt == "substring" and mv in subject_lower:
                return dict(row)
        return None
    finally:
        con.close()


def upsert_alias(match_type: str, match_value: str, client_hint: str,
                 division_hint=None, note=None):
    """Insert or update a client alias."""
    con = _con()
    try:
        con.execute("""
            INSERT INTO client_aliases (match_type, match_value, client_hint, division_hint, note)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(match_type, match_value)
            DO UPDATE SET client_hint=excluded.client_hint,
                          division_hint=excluded.division_hint,
                          note=excluded.note
        """, (match_type, match_value.lower(), client_hint, division_hint, note))
        con.commit()
    finally:
        con.close()


FLUXCC_SITE_FIELDS = {
    "display_name", "slug", "repo_path", "cf_project", "gitlab_repo",
    "preview_url", "custom_domain", "status", "auto_email",
}


def upsert_fluxcc_site(client_hint: str, **fields):
    """Insert or update a FluxCC site record keyed by client_hint."""
    fields = {k: v for k, v in fields.items() if k in FLUXCC_SITE_FIELDS}
    con = _con()
    try:
        cols = ["client_hint"] + list(fields)
        updates = ", ".join(f"{k}=excluded.{k}" for k in fields)
        con.execute(
            f"INSERT INTO fluxcc_sites ({', '.join(cols)}) "
            f"VALUES ({', '.join('?' * len(cols))}) "
            f"ON CONFLICT(client_hint) DO UPDATE SET {updates}, updated_at=datetime('now')",
            [client_hint] + list(fields.values()),
        )
        con.commit()
    finally:
        con.close()


def get_fluxcc_site(hint: str):
    """
    Resolve a FluxCC site by client_hint, slug, or display name
    (case-insensitive). Returns dict or None.
    """
    if not hint:
        return None
    con = _con()
    try:
        row = con.execute(
            "SELECT * FROM fluxcc_sites WHERE LOWER(client_hint) = LOWER(?) "
            "OR LOWER(slug) = LOWER(?) OR LOWER(display_name) = LOWER(?)",
            (hint, hint, hint),
        ).fetchone()
        return dict(row) if row else None
    finally:
        con.close()


def ensure_project_for_inbox(client_hint: str, division_hint: str, short_slug: str, subject: str) -> int:
    """
    Auto-create a project for an inbox item when no existing project matches.
    Returns the new project's id.
    Status is 'wfhuman' so it needs operator triage before becoming active work.
    """
    name = re.sub(r"[-_]+", " ", re.sub(r"^[-_]+", "", short_slug or "inbox-item")).title().strip() or "Inbox Item"
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA foreign_keys=ON")
    try:
        # Lookup company_id from client_hint
        company_id = None
        if client_hint and client_hint.lower() != "unknown":
            row = con.execute(
                "SELECT id FROM companies WHERE LOWER(name) = LOWER(?) OR LOWER(short_name) = LOWER(?)",
                (client_hint, client_hint),
            ).fetchone()
            if row:
                company_id = row[0]

        # Lookup division_id
        division_id = None
        if division_hint and division_hint.lower() != "unknown":
            row = con.execute(
                "SELECT id FROM divisions WHERE LOWER(name) = LOWER(?)",
                (division_hint,),
            ).fetchone()
            if row:
                division_id = row[0]

        cur = con.execute("""
            INSERT INTO projects (name, company_id, division_id, status, notes, created_at, updated_at)
            VALUES (?, ?, ?, 'wfhuman', ?, datetime('now'), datetime('now'))
        """, (name, company_id, division_id, f"Auto-created from inbox: {subject}"))
        new_id = cur.lastrowid
        con.execute("UPDATE projects SET sort_order = sort_order + 1 WHERE status = 'wfhuman' AND sort_order IS NOT NULL")
        con.execute("UPDATE projects SET sort_order = 0 WHERE id = ?", (new_id,))
        con.commit()
        return new_id
    finally:
        con.close()


def close_inbox_timer_stub(marker: str, state_file: str, ledger_file: str, error_log_path: str):
    """
    Close an inbox timer ledger entry with a stub error note.
    Used when a Claude session exited without closing its own timer.
    Swallows all exceptions to avoid masking the original failure.
    """
    try:
        # Get current Eastern time for end:
        end_result = subprocess.run(
            ["date", "+%Y-%m-%dT%H:%M"],
            env={**os.environ, "TZ": "America/New_York"},
            capture_output=True, text=True,
        )
        end_time = end_result.stdout.strip()

        # Compute duration from marker (start) to end_time
        try:
            start_dt = datetime.strptime(marker, "%Y-%m-%dT%H:%M")
            end_dt = datetime.strptime(end_time, "%Y-%m-%dT%H:%M")
            diff_minutes = max(1, round((end_dt - start_dt).total_seconds() / 60))
            if diff_minutes >= 60:
                hours, mins = divmod(diff_minutes, 60)
                duration_str = f"{hours}h {mins}m" if mins else f"{hours}h"
            else:
                duration_str = f"{diff_minutes}m"
        except Exception:
            duration_str = "?m"

        # Edit ledger file: find the entry block and fill in end/duration/notes
        ledger = Path(ledger_file)
        if not ledger.exists():
            return

        content = ledger.read_text()
        marker_tag = f"<!-- entry:{marker} -->"
        if marker_tag not in content:
            return

        start_idx = content.find(marker_tag)
        end_sep_idx = content.find("\n---", start_idx)
        if end_sep_idx == -1:
            segment_end = len(content)
        else:
            segment_end = end_sep_idx + 4  # include "\n---"

        segment = content[start_idx:segment_end]
        new_segment = re.sub(r'^end:\s*$', f'end: {end_time}', segment, count=1, flags=re.MULTILINE)
        new_segment = re.sub(r'^duration:\s*$', f'duration: {duration_str}', new_segment, count=1, flags=re.MULTILINE)
        stub_note = (
            f"notes: |\n"
            f"  Inbox session errored — see {error_log_path}.\n"
            f"  Stub close written by inbox_db.py; no work product to report."
        )
        new_segment = re.sub(r'^notes:\s*$', stub_note, new_segment, count=1, flags=re.MULTILINE)
        new_content = content[:start_idx] + new_segment + content[segment_end:]
        ledger.write_text(new_content)

        # Delete state file
        try:
            Path(state_file).unlink(missing_ok=True)
        except Exception:
            pass
    except Exception:
        pass


if __name__ == "__main__":
    import sys
    # CLI usage:
    #   python3 inbox_db.py done <gmail_id>
    #   python3 inbox_db.py error <gmail_id> [log_path]
    #   python3 inbox_db.py close-timer-stub <marker> <state_file> <ledger_file> <log>
    #   python3 inbox_db.py dump-aliases
    if len(sys.argv) >= 3 and sys.argv[1] in ("done", "error"):
        action, gid = sys.argv[1], sys.argv[2]
        status = "done" if action == "done" else "error"
        error_text = None
        if action == "error" and len(sys.argv) == 4:
            log_path = sys.argv[3]
            try:
                with open(log_path) as f:
                    lines = f.readlines()
                error_text = "".join(lines[-40:]).strip() or None
            except Exception:
                pass
        fields = {"status": status}
        if action == "done":
            fields["error_text"] = None
        elif error_text:
            fields["error_text"] = error_text
        update_inbox_item(gid, **fields)
    elif len(sys.argv) == 6 and sys.argv[1] == "close-timer-stub":
        _, _, _marker, _state_file, _ledger_file, _log_path = sys.argv
        close_inbox_timer_stub(_marker, _state_file, _ledger_file, _log_path)
    elif len(sys.argv) == 2 and sys.argv[1] == "dump-fluxcc-sites":
        con = _con()
        rows = con.execute(
            "SELECT client_hint, slug, repo_path, cf_project, gitlab_repo, status, auto_email "
            "FROM fluxcc_sites ORDER BY client_hint"
        ).fetchall()
        print(json.dumps([dict(r) for r in rows], indent=2))
        con.close()
    elif len(sys.argv) == 2 and sys.argv[1] == "dump-aliases":
        con = _con()
        rows = con.execute(
            "SELECT match_type, match_value, client_hint, division_hint, note, created_at "
            "FROM client_aliases ORDER BY match_type, match_value"
        ).fetchall()
        print(json.dumps([dict(r) for r in rows], indent=2))
        con.close()
    else:
        print("Usage:", file=sys.stderr)
        print("  python3 inbox_db.py done <gmail_id>", file=sys.stderr)
        print("  python3 inbox_db.py error <gmail_id>", file=sys.stderr)
        print("  python3 inbox_db.py close-timer-stub <marker> <state_file> <ledger_file> <log>", file=sys.stderr)
        print("  python3 inbox_db.py dump-aliases", file=sys.stderr)
