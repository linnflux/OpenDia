#!/usr/bin/env python3
"""Shared parser for OpenDia timer entries (~/OpenDia/Time/YYYY/MM/*.md).

One parser, one format. Three hand-rolled copies of this logic previously
existed (billing_month.py, monthly_billing.py, lonely_whistle.py) and they
disagreed: the billing pair never handled the `notes: |` YAML block scalar
that every real entry uses, so `notes` came back as the literal "|" and the
Summary column of the billing sheet shipped empty for every line item.

Entry format (delimited by `---`, anchored by an HTML comment):

    <!-- entry:2026-07-10T09:22 -->
    client: Acme
    project: Website
    division: WordFlux
    task: Fix the thing
    estimated_minutes: 60
    start: 2026-07-10T09:22
    end: 2026-07-10T10:22
    duration: 60m
    billable: true
    started_by: nick@linnflux.com
    notes: |
      Did a thing
      Did another thing
      NEXT: do the next thing
"""

import re
from pathlib import Path

__all__ = ["parse_entries_from_file", "load_month_entries", "summarize_notes"]

SUMMARY_MAX = 240


def _notes_block(block: str) -> str:
    """Extract note text, handling both `notes: |` block scalars and inline."""
    m = re.search(r"^notes:\s*\|?\s*\n((?:[ \t]+.*\n?)*)", block, re.MULTILINE)
    if m:
        lines = [re.sub(r"^  ", "", line) for line in m.group(1).splitlines()]
        return "\n".join(lines).strip()
    m = re.search(r"^notes:[ \t]+(.+)$", block, re.MULTILINE)
    return m.group(1).strip() if m else ""


def summarize_notes(notes: str, limit: int = SUMMARY_MAX) -> str:
    """Flatten note bullets into one line for the billing sheet's Summary column."""
    lines = [l.strip(" -•\t") for l in notes.splitlines()]
    lines = [l for l in lines if l and not l.startswith("NEXT:")]
    summary = "; ".join(lines)
    if len(summary) > limit:
        summary = summary[: limit - 3].rstrip() + "..."
    return summary


def parse_entries_from_file(filepath, skip_internal: bool = True) -> list[dict]:
    """Parse every timer entry in one daily file.

    skip_internal drops entries with no client or client == "Linnflux" (the
    billing scripts' long-standing behavior). Pass False to get everything.
    """
    content = Path(filepath).read_text()
    entries = []

    for block in re.split(r"^---\s*$", content, flags=re.MULTILINE):
        if "<!-- entry:" not in block:
            continue

        # Scalar fields: a top-level `key: value` line. Note bodies are indented,
        # so they cannot be mistaken for fields (the old parsers' bug).
        fields = {}
        for m in re.finditer(r"^([a-z_]+):[ \t]*(.*)$", block, re.MULTILINE):
            fields[m.group(1)] = m.group(2).strip()

        client = fields.get("client", "").strip()
        if skip_internal and (not client or client.lower() == "linnflux"):
            continue

        notes = _notes_block(block)
        next_step = ""
        for line in notes.splitlines():
            if line.startswith("NEXT:"):
                next_step = line[5:].strip()

        try:
            est_minutes = int(fields.get("estimated_minutes", "").strip() or 0)
        except (ValueError, TypeError):
            est_minutes = 0

        dur_match = re.match(r"(\d+)\s*h\s*(\d+)?", fields.get("duration", "").strip())
        if dur_match:
            duration_minutes = int(dur_match.group(1)) * 60 + int(dur_match.group(2) or 0)
        else:
            m = re.match(r"(\d+)", fields.get("duration", "0m").strip())
            duration_minutes = int(m.group(1)) if m else 0

        start = fields.get("start", "")
        entries.append({
            "date": start[:10] if len(start) >= 10 else "",
            "start": start,
            "end": fields.get("end", "").strip(),
            "client": client,
            "project": fields.get("project", "").strip(),
            "division": fields.get("division", "").strip(),
            "task": fields.get("task", "").strip(),
            "estimated_minutes": est_minutes,
            "duration_minutes": duration_minutes,
            "billable": fields.get("billable", "false").strip().lower() == "true",
            "started_by": fields.get("started_by", "").strip(),
            "ended_by": fields.get("ended_by", "").strip(),
            "notes": notes,
            "next_step": next_step,
            "summary": summarize_notes(notes),
        })

    return entries


def load_month_entries(year: int, month: int, root=None, skip_internal: bool = True) -> list[dict]:
    """Parse every daily file in one month."""
    root = Path(root) if root else Path.home() / "OpenDia" / "Time"
    month_dir = root / f"{year:04d}" / f"{month:02d}"
    if not month_dir.is_dir():
        return []
    entries = []
    for f in sorted(month_dir.glob("*.md")):
        entries.extend(parse_entries_from_file(f, skip_internal=skip_internal))
    return entries


if __name__ == "__main__":
    import sys, json
    for e in parse_entries_from_file(sys.argv[1], skip_internal=False):
        print(json.dumps(e, indent=2))
