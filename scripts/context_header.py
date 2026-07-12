#!/usr/bin/env python3
"""
context_header.py — Pure function: client_hint → context string for Claude Code sessions.

Reads recent timer entries from ~/OpenDia/Time/YYYY/MM/YYYY-MM-DD.md and
runs a lightweight matchProject() against opendia.db.

Usage:
    python3 context_header.py "Acme Corp"
    python3 context_header.py --days 14 "Example Client"
"""

import argparse
import os
import re
import sqlite3
from datetime import date, timedelta
from pathlib import Path

OPENDIA_DIR = Path(os.environ.get("OPENDIA_DIR", Path.home() / "OpenDia"))
DB_PATH = OPENDIA_DIR / "opendia.db"
TIME_DIR = OPENDIA_DIR / "Time"


# ── Timer parsing ──────────────────────────────────────────────────────────────

def _read_timer_file(path: Path) -> list[dict]:
    """Parse one daily timer markdown file, return list of entry dicts."""
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8")
    entries = []
    # Split on entry markers
    blocks = re.split(r"---\s*\n<!-- entry:[^>]+-->\n", text)
    for block in blocks[1:]:  # skip header before first entry
        entry = {}
        for line in block.splitlines():
            m = re.match(r"^(\w+(?:_\w+)*):\s*(.*)$", line)
            if m:
                key, val = m.group(1), m.group(2).strip()
                entry[key] = val
        if entry.get("client"):
            entries.append(entry)
    return entries


def _recent_timers(days: int = 7) -> list[dict]:
    """Return timer entries from the last N days, newest first."""
    today = date.today()
    entries = []
    for offset in range(days):
        d = today - timedelta(days=offset)
        path = TIME_DIR / str(d.year) / f"{d.month:02d}" / f"{d.isoformat()}.md"
        entries.extend(_read_timer_file(path))
    return entries


def _client_matches(entry_client: str, hint: str) -> bool:
    """Fuzzy client match between a timer entry and the hint string."""
    ec = entry_client.lower().strip()
    h = hint.lower().strip()
    if not ec or not h:
        return False
    return ec == h or ec in h or h in ec


# ── Project matching (port of db.js matchProject) ─────────────────────────────

_STOP_TOKENS = {
    "the", "and", "for", "with", "of", "in", "on", "at", "to", "a",
    "inc", "llc", "corp", "co", "ltd", "group", "services", "company",
}


def _tokenize(s: str) -> set[str]:
    tokens = re.findall(r"[a-z]+", s.lower())
    return {t for t in tokens if len(t) > 2 and t not in _STOP_TOKENS}


def match_project(client_hint: str, division_hint: str = "", task_hint: str = "") -> dict | None:
    """
    Python port of db.js matchProject(). Returns best matching project row or None.
    """
    if not DB_PATH.exists():
        return None

    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute("""
            SELECT p.id, p.name, p.status, p.next_step, p.notes,
                   c.name AS company_name, c.short_name AS company_short,
                   d.name AS division
            FROM projects p
            LEFT JOIN companies c ON p.company_id = c.id
            LEFT JOIN divisions d ON p.division_id = d.id
        """).fetchall()
    finally:
        con.close()

    client_lower = client_hint.lower().strip()
    div_lower = division_hint.lower().strip()
    task_lower = task_hint.lower().strip()

    # Exact project name match
    for r in rows:
        if (r["name"] or "").lower() == task_lower and task_lower:
            return dict(r)

    best = None
    best_score = 0

    for r in rows:
        comp = (r["company_name"] or "").lower()
        short = (r["company_short"] or "").lower()
        p_div = (r["division"] or "").lower()
        p_name = (r["name"] or "").lower()

        client_match = client_lower and (
            comp == client_lower
            or short == client_lower
            or (comp and (comp in client_lower or client_lower in comp))
            or (short and (short in client_lower or client_lower in short))
        )
        if not client_match:
            continue

        div_match = div_lower and p_div == div_lower
        task_substr = task_lower and p_name and (p_name in task_lower or task_lower in p_name)
        shared = len(_tokenize(task_lower) & _tokenize(p_name)) if task_lower and p_name else 0
        next_step_text = (r["next_step"] or "").lower()
        shared_next = len(_tokenize(task_lower) & _tokenize(next_step_text)) if task_lower and next_step_text else 0

        if not div_match and not task_substr and shared == 0 and shared_next == 0:
            continue

        score = 0
        if task_substr:
            score += 10
        score += shared * 3
        score += shared_next * 2
        if div_match:
            score += 2
        if r["status"] != "completed":
            score += 1

        if score > best_score:
            best = dict(r)
            best_score = score

    return best


# ── Context header builder ─────────────────────────────────────────────────────

def build_context_header(client_hint: str, division_hint: str = "", days: int = 7) -> str:
    """
    Build a context header string for injection into a Claude Code session prompt.
    Returns a multi-line string with recent timer context and matched project info.
    """
    lines = ["## Inbox Session Context", ""]

    # --- Recent timers for this client ---
    all_timers = _recent_timers(days)
    client_timers = [e for e in all_timers if _client_matches(e.get("client", ""), client_hint)]

    if client_hint and client_hint.lower() not in ("unknown", ""):
        lines.append(f"**Client hint:** {client_hint}")
        if division_hint and division_hint.lower() != "unknown":
            lines.append(f"**Division hint:** {division_hint}")
        lines.append("")

    if client_timers:
        lines.append(f"**Recent timer entries for {client_hint} (last {days} days):**")
        for e in client_timers[:5]:  # cap at 5
            task = e.get("task", "(no task)")
            start = e.get("start", "")[:10]
            div = e.get("division", "")
            status = "OPEN" if not e.get("end") else "closed"
            lines.append(f"  - [{start}] [{div}] {task} ({status})")
        lines.append("")

        # Check for open timers (no end time)
        open_timers = [e for e in client_timers if not e.get("end")]
        if open_timers:
            lines.append(f"**Note:** {len(open_timers)} open timer(s) for this client.")
            lines.append("")
    else:
        if client_hint and client_hint.lower() not in ("unknown", ""):
            lines.append(f"**No recent timer activity found for {client_hint}.**")
            lines.append("")

    # --- Matched project ---
    if client_hint and client_hint.lower() not in ("unknown", ""):
        project = match_project(client_hint, division_hint)
        if project:
            lines.append(f"**Matched project:** {project['name']} (status: {project['status'] or 'unknown'})")
            if project.get("division"):
                lines.append(f"**Project division:** {project['division']}")
            lines.append("")
        else:
            lines.append("**No existing project matched in opendia.db.** You may need to create one.")
            lines.append("")

    lines.append("---")
    lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build context header for inbox sessions")
    parser.add_argument("client_hint", nargs="?", default="unknown")
    parser.add_argument("--division", default="")
    parser.add_argument("--days", type=int, default=7)
    args = parser.parse_args()

    print(build_context_header(args.client_hint, args.division, args.days))
