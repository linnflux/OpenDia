#!/usr/bin/env python3
"""
recover_session.py — Reconstruct work context from a disconnected tmux session.

Given a session name (full or partial), looks up:
  1. inbox_items row  → subject, client, division, project, prompt_text, status
  2. timer_marker     → timer file entry → notes, NEXT step
  3. Live tmux        → whether the session is still alive

Usage:
    python3 recover_session.py                          # list recent sessions
    python3 recover_session.py inbox-20260412-1607-...  # full or partial name
"""

import re
import sqlite3
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPTS_DIR))

OPENDIA_DIR = Path.home() / "OpenDia"
DB_PATH = OPENDIA_DIR / "opendia.db"
TIME_DIR = OPENDIA_DIR / "Time"


# ── DB lookup ──────────────────────────────────────────────────────────────────

def _find_inbox_item(session_fragment: str) -> dict | None:
    if not DB_PATH.exists():
        return None
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    try:
        # Try exact match first, then LIKE
        row = con.execute(
            "SELECT * FROM inbox_items WHERE session_name = ? ORDER BY id DESC LIMIT 1",
            (session_fragment,),
        ).fetchone()
        if not row:
            row = con.execute(
                "SELECT * FROM inbox_items WHERE session_name LIKE ? ORDER BY id DESC LIMIT 1",
                (f"%{session_fragment}%",),
            ).fetchone()
        return dict(row) if row else None
    finally:
        con.close()


def _list_recent_sessions(n: int = 10) -> list[dict]:
    if not DB_PATH.exists():
        return []
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT id, session_name, client_hint, subject, status, created_at "
            "FROM inbox_items WHERE session_name IS NOT NULL "
            "ORDER BY id DESC LIMIT ?",
            (n,),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        con.close()


# ── Timer file lookup ──────────────────────────────────────────────────────────

def _read_timer_entry(marker: str) -> str | None:
    """
    Given a marker like '2026-04-12T16:07', find and return the full entry block
    from the corresponding daily timer file.
    """
    try:
        dt_date = marker[:10]  # '2026-04-12'
        year, month, _ = dt_date.split("-")
        path = TIME_DIR / year / month / f"{dt_date}.md"
        if not path.exists():
            return None
        text = path.read_text(encoding="utf-8")
        tag = f"<!-- entry:{marker} -->"
        if tag not in text:
            return None
        start = text.find(tag)
        # Entry ends at next '---' separator or EOF
        next_sep = text.find("\n---", start + len(tag))
        end = next_sep if next_sep != -1 else len(text)
        return text[start:end].strip()
    except Exception:
        return None


def _scan_timer_by_task(task_slug: str, days: int = 14) -> list[tuple[str, str]]:
    """
    Fallback: scan recent timer files for entries whose task field contains task_slug.
    Returns list of (marker, entry_text) tuples, newest first.
    """
    today = date.today()
    results = []
    for offset in range(days):
        d = today - timedelta(days=offset)
        path = TIME_DIR / str(d.year) / f"{d.month:02d}" / f"{d.isoformat()}.md"
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        blocks = re.split(r"\n---\s*\n", text)
        for block in blocks:
            m = re.search(r"<!-- entry:([^>]+) -->", block)
            if not m:
                continue
            marker = m.group(1)
            task_line = re.search(r"^task:\s*(.+)$", block, re.MULTILINE)
            if task_line and task_slug.lower() in task_line.group(1).lower():
                results.append((marker, block.strip()))
    return results


# ── tmux check ────────────────────────────────────────────────────────────────

def _tmux_session_alive(session_name: str) -> bool:
    try:
        result = subprocess.run(
            ["tmux", "has-session", "-t", session_name],
            capture_output=True,
        )
        return result.returncode == 0
    except FileNotFoundError:
        return False


def _list_tmux_sessions() -> list[str]:
    try:
        result = subprocess.run(
            ["tmux", "list-sessions", "-F", "#{session_name}"],
            capture_output=True, text=True,
        )
        return result.stdout.strip().splitlines() if result.returncode == 0 else []
    except FileNotFoundError:
        return []


# ── Formatter ─────────────────────────────────────────────────────────────────

def _format_recovery(item: dict, timer_entry: str | None, alive: bool) -> str:
    lines = ["## Session Recovery Context", ""]

    session = item.get("session_name") or "(unknown)"
    lines.append(f"**Session:** `{session}`")
    lines.append(f"**Status:** {'ALIVE — still running in tmux' if alive else 'DISCONNECTED'}")
    lines.append("")

    lines.append("### Email")
    lines.append(f"- **Subject:** {item.get('subject', '(none)')}")
    lines.append(f"- **Client:** {item.get('client_hint', 'unknown')}")
    lines.append(f"- **Division:** {item.get('division_hint', 'unknown')}")
    if item.get("project_hint") and item["project_hint"] != "unknown":
        lines.append(f"- **Project:** {item['project_hint']}")
    lines.append(f"- **Priority:** {item.get('priority', 'normal')}")
    lines.append(f"- **Est. minutes:** {item.get('estimated_minutes', '?')}")
    lines.append(f"- **Inbox status:** {item.get('status', '?')}")
    lines.append("")

    lines.append("### Original Directive")
    lines.append(item.get("prompt_text") or "(none)")
    lines.append("")

    if timer_entry:
        lines.append("### Timer Notes")
        # Extract just the notes block for readability
        notes_match = re.search(r"^notes:\s*\|?\s*\n((?:[ \t]+.+\n?)*)", timer_entry, re.MULTILINE)
        if notes_match:
            notes = re.sub(r"^[ \t]{2}", "", notes_match.group(1), flags=re.MULTILINE).strip()
            lines.append(notes)
        else:
            lines.append(timer_entry)
        lines.append("")
    else:
        lines.append("### Timer Notes")
        lines.append("*(No timer entry found for this session)*")
        lines.append("")

    if alive:
        lines.append(f"**To reattach:** `tmux attach -t {session}`")
    else:
        lines.append("**Session is gone.** Use the directive above to resume in a new session.")
        if item.get("status") not in ("done", "error"):
            lines.append(f"**Re-dispatch:** `python3 {SCRIPTS_DIR}/inbox_stage_b.py --redispatch {item.get('gmail_id', '')}`")

    lines.append("")
    return "\n".join(lines)


# ── Main ───────────────────────────────────────────────────────────────────────

def recover(session_fragment: str) -> str:
    item = _find_inbox_item(session_fragment)

    if not item:
        # Maybe it's a raw task slug — scan timer files directly
        timer_hits = _scan_timer_by_task(session_fragment)
        if timer_hits:
            marker, entry = timer_hits[0]
            lines = [
                "## Session Recovery Context",
                "",
                f"**No inbox_items row found** for `{session_fragment}`",
                "**Found matching timer entry:**",
                "",
                entry,
            ]
            return "\n".join(lines)
        return f"No session or timer entry found matching: {session_fragment!r}"

    marker = item.get("timer_marker")
    timer_entry = _read_timer_entry(marker) if marker else None

    # Fallback: scan by task slug extracted from session name
    if not timer_entry:
        slug = re.sub(r"^inbox-\d{8}-\d{4}-", "", item.get("session_name") or "")
        if slug:
            hits = _scan_timer_by_task(slug)
            if hits:
                timer_entry = hits[0][1]

    alive = _tmux_session_alive(item.get("session_name", ""))
    return _format_recovery(item, timer_entry, alive)


def list_sessions() -> str:
    sessions = _list_recent_sessions()
    tmux_live = set(_list_tmux_sessions())

    if not sessions:
        return "No sessions found in inbox_items."

    lines = ["## Recent Inbox Sessions", ""]
    lines.append(f"{'ID':<4} {'Status':<12} {'Live':<5} {'Client':<30} {'Session Name'}")
    lines.append("-" * 90)
    for s in sessions:
        sname = s.get("session_name") or ""
        live = "yes" if sname in tmux_live else "-"
        client = (s.get("client_hint") or "unknown")[:28]
        lines.append(f"{s['id']:<4} {s['status']:<12} {live:<5} {client:<30} {sname}")

    lines.append("")
    lines.append("Usage: python3 recover_session.py <session-name-or-fragment>")
    return "\n".join(lines)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(list_sessions())
    else:
        print(recover(" ".join(sys.argv[1:])))
