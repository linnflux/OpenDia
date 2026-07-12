#!/usr/bin/env python3
"""
check_mail_ingest.py — Ingest a specific Gmail message into the inbox pipeline
with a known project_id, bypassing Stage A's project-matching guesswork.

Usage: python3 check_mail_ingest.py <gmail_id> <project_id> [tmux_session]

Flow:
  1. Load ANTHROPIC_API_KEY from ~/.config/opendia/inbox.env
  2. Fetch full Gmail message via gmail_helper
  3. Classify via classify_email (Haiku)
  4. Override project_id / client_hint / division_hint with known project values
  5. Insert inbox_item via inbox_db
  6. If requires_server_access: hold (status=classified), exit
  7. If tmux_session provided and alive: inject into session (Mode A)
  8. Otherwise: dispatch via inbox_stage_b._spawn_session (Mode B)
  9. Update status=dispatched, mark seen
"""

import logging
import os
import sqlite3
import subprocess
import sys
import traceback
from datetime import datetime
from pathlib import Path

# Load ANTHROPIC_API_KEY from inbox.env before importing classify_email
_env_file = Path.home() / ".config" / "opendia" / "inbox.env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        if "=" in _line and not _line.startswith("#"):
            _key, _, _val = _line.partition("=")
            os.environ.setdefault(_key.strip(), _val.strip())

sys.path.insert(0, str(Path(__file__).parent))

from classify_email import classify_email
from gmail_helper import _load_service, extract_message_text, get_message_full
from inbox_db import create_inbox_item, update_inbox_item
from inbox_stage_b import _mark_seen, _spawn_session

LOG_DIR = Path.home() / "OpenDia" / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = Path.home() / "OpenDia" / "opendia.db"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [check-mail-ingest] %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / f"inbox-{datetime.now():%Y-%m-%d}.log"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger(__name__)


CONTEXT_DIR = Path.home() / "OpenDia" / "inbox-context"


def _inject_into_session(
    tmux_session: str,
    gmail_id: str,
    from_addr: str,
    subject: str,
    date: str,
    body: str,
    prompt_text: str,
    client_hint: str,
    short_slug: str,
    priority: str,
) -> bool:
    """Write context file and inject a message into an existing tmux session.

    Returns True if injected, False if the session is not alive.
    """
    CONTEXT_DIR.mkdir(parents=True, exist_ok=True)
    context_file = CONTEXT_DIR / f"{gmail_id}.md"
    context_file.write_text(
        f"# Incoming Email\n\n"
        f"- **From**: {from_addr}\n"
        f"- **Subject**: {subject}\n"
        f"- **Client**: {client_hint}\n"
        f"- **Priority**: {priority}\n"
        f"- **Classified as**: {short_slug}\n\n"
        f"## Email Body\n\n{body}\n\n"
        f"## Suggested Action\n\n{prompt_text}\n"
    )

    # Check session is alive
    alive = subprocess.run(
        ["tmux", "has-session", "-t", tmux_session],
        capture_output=True,
    )
    if alive.returncode != 0:
        return False

    message = (
        f"A new client email arrived. "
        f"Read ~/OpenDia/inbox-context/{gmail_id}.md for the full email and suggested action. "
        f"Review and report — do not act without operator approval."
    )
    subprocess.run(
        ["tmux", "send-keys", "-t", tmux_session, message, "Enter"],
        check=True,
    )
    return True


def _load_project(project_id: int) -> dict | None:
    """Load project with company and division info from opendia.db."""
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    try:
        row = con.execute("""
            SELECT p.id, p.name, p.status,
                   c.name AS company_name, c.short_name AS company_short,
                   d.name AS division
            FROM projects p
            LEFT JOIN companies c ON p.company_id = c.id
            LEFT JOIN divisions d ON p.division_id = d.id
            WHERE p.id = ?
        """, (project_id,)).fetchone()
        return dict(row) if row else None
    finally:
        con.close()


def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <gmail_id> <project_id> [tmux_session]", file=sys.stderr)
        sys.exit(1)

    gmail_id = sys.argv[1]
    try:
        project_id = int(sys.argv[2])
    except ValueError:
        print(f"project_id must be an integer, got: {sys.argv[2]}", file=sys.stderr)
        sys.exit(1)

    tmux_session = sys.argv[3] if len(sys.argv) >= 4 and sys.argv[3] else None

    log.info(f"check_mail_ingest: gmail_id={gmail_id} project_id={project_id} tmux_session={tmux_session}")

    # Load project
    project = _load_project(project_id)
    if not project:
        log.error(f"Project {project_id} not found in DB")
        sys.exit(1)

    # Load Gmail service and fetch full message
    try:
        service = _load_service()
    except Exception as e:
        log.error(f"Gmail auth failed: {e}")
        sys.exit(1)

    full = get_message_full(service, gmail_id)
    if not full:
        log.error(f"Could not fetch Gmail message {gmail_id}")
        sys.exit(1)

    thread_id = full.get("threadId", "")
    subject, from_addr, date, body = extract_message_text(full)
    log.info(f"  Subject: {subject!r}  From: {from_addr!r}")

    # Classify via Haiku
    try:
        result = classify_email(subject, from_addr, body)
    except Exception as e:
        log.error(f"Classification failed: {e}\n{traceback.format_exc()}")
        sys.exit(1)

    # Override project fields with known values
    client_hint = project["company_name"] or result["client_hint"]
    division_hint = project["division"] or result["division_hint"]
    project_hint = project["name"]

    result["client_hint"] = client_hint
    result["division_hint"] = division_hint
    result["project_id"] = project_id
    result["project_hint"] = project_hint

    priority = result["priority"]
    short_slug = result["short_slug"]
    prompt_text = result["prompt_text"]
    requires_server_access = result["requires_server_access"]
    estimated_minutes = result["estimated_minutes"]

    # Insert into inbox_items (INSERT OR IGNORE — idempotent)
    row_id = create_inbox_item(
        gmail_id=gmail_id,
        thread_id=thread_id,
        from_addr=from_addr,
        subject=subject,
        client_hint=client_hint,
        division_hint=division_hint,
        priority=priority,
        short_slug=short_slug,
        prompt_text=prompt_text,
        requires_server_access=requires_server_access,
        estimated_minutes=estimated_minutes,
        project_hint=project_hint,
        project_id=project_id,
    )
    log.info(f"  Inserted inbox_item id={row_id}")

    if requires_server_access:
        log.info(f"  requires_server_access=True — holding for operator approval")
        # status is already 'classified' from INSERT; mark seen so cron skips it
        _mark_seen(gmail_id)
        sys.exit(0)

    # Mode A: inject into existing session
    if tmux_session:
        try:
            injected = _inject_into_session(
                tmux_session=tmux_session,
                gmail_id=gmail_id,
                from_addr=from_addr,
                subject=subject,
                date=date,
                body=body,
                prompt_text=prompt_text,
                client_hint=client_hint,
                short_slug=short_slug,
                priority=priority,
            )
        except Exception as e:
            log.warning(f"  Inject failed ({e}), falling back to spawn")
            injected = False

        if injected:
            update_inbox_item(gmail_id, status="dispatched", session_name=tmux_session)
            _mark_seen(gmail_id)
            log.info(f"  Injected into session: {tmux_session}")
            sys.exit(0)
        else:
            log.info(f"  Session {tmux_session} not alive, falling back to spawn")

    # Mode B: spawn new session
    try:
        session_name = _spawn_session(
            gmail_id=gmail_id,
            client_hint=client_hint,
            division_hint=division_hint,
            from_addr=from_addr,
            subject=subject,
            prompt_text=prompt_text,
            short_slug=short_slug,
            estimated_minutes=estimated_minutes,
        )
        update_inbox_item(gmail_id, status="dispatched", session_name=session_name)
        _mark_seen(gmail_id)
        log.info(f"  Dispatched: session={session_name}")
    except Exception as e:
        log.error(f"  Dispatch failed: {e}\n{traceback.format_exc()}")
        update_inbox_item(gmail_id, status="error", error_text=str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
