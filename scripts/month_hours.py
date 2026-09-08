#!/usr/bin/env python3
"""Month-to-date hours for the /od-go and /od-stop summaries.

One helper, two callers, so the number can never disagree between the command
that starts work and the command that stops it.

    python3 month_hours.py                  # global: the two printable lines
    python3 month_hours.py "Client Name"    # scoped to one client
    python3 month_hours.py --verify         # the same numbers with their workings

Design notes, each of which is load-bearing:

* **estimated_minutes, never duration.** The ledger carries both. `duration` is
  wall clock and is routinely garbage — a timer left running overnight logged
  18h against 165 minutes of justified work. `estimated_minutes` is the number
  a human stood behind, and it is what billing already uses.

* **The total is rounded once, not each entry.** `billing_month.get_od_hours()`
  rounds every entry up to the next quarter-hour and sums, which is correct for
  an invoice — each line item bills at its own granularity. As a month-to-date
  pulse it inflates badly: 100 short entries carry up to 25 phantom hours.
  Rounding the single total keeps the readout honest.

* **Global mode: billable only, external clients only.** This mirrors what the
  billing pipeline actually produces, so the pulse and the invoice tell the
  same story. Flip SKIP_INTERNAL to False to count internal entries.

* **Client mode: billable only — except the client IS Linnflux.** Internal work
  is never billable, so a billable-only Linnflux readout would be a permanent
  0.00; for Linnflux every entry counts (it is a workload pulse, not an
  invoice). External clients stay billable-only so the number still matches
  what the month would invoice. Client names are matched against the companies
  table (name + short_name, normalized), because the ledger carries both
  "Acme Widgets Co" and "acme-widgets-co" naming styles for the same client.

* **Toggl is fail-soft and never freezes.** `toggl_hours.monthly_hours()`
  already returns per-client hours in ONE call, so client mode costs no extra
  API traffic (the hourly quota is shared across everything — see the Toggl
  memory). The cache stores the whole per-client map; a missing token, a 402,
  or a slow API drops the Toggl line rather than delaying a timer stop.
"""

import json
import math
import re
import sqlite3
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from timeentry import load_month_entries  # noqa: E402

# Entries for our own company are excluded, matching the billing pipeline's
# long-standing behaviour: Linnflux cannot invoice Linnflux.
SKIP_INTERNAL = True
BILLABLE_ONLY = True

DB_PATH = Path.home() / "OpenDia" / "opendia.db"
CACHE = Path.home() / "OpenDia" / ".month-hours-cache.json"
CURRENT_MONTH_TTL_SEC = 20 * 60
# The readout must never be what makes a timer stop feel slow. A cold fetch of
# two tokens measured 2.35s, so a 2.5s budget would fail about as often as it
# succeeded — and a timeout caches nothing, so the Toggl line would then be
# missing every single time rather than occasionally. Only the first call in a
# TTL window pays this at all; cached calls return in ~0.03s.
TOGGL_DEADLINE_SEC = 4.0


def round_up_quarter(minutes: float) -> float:
    """Minutes -> hours, rounded UP to the next .25. Applied to a total, once."""
    return math.ceil(minutes / 15) * 0.25


# ── Client matching ───────────────────────────────────────────────────────────
def _normalize(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def client_terms(client: str) -> set[str]:
    """Normalized names this client answers to: the given string plus the
    companies-table name and short_name of the best-matching row. Fail-soft:
    a missing DB just means we match on the raw string."""
    terms = {_normalize(client)}
    try:
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute("SELECT name, short_name FROM companies").fetchall()
        conn.close()
        want = _normalize(client)
        for name, short in rows:
            cands = {_normalize(name), _normalize(short)}
            if any(c and (c == want or (len(want) >= 4 and want in c) or (len(c) >= 4 and c in want)) for c in cands):
                terms |= cands
                break
    except Exception:
        pass
    return {t for t in terms if t}


def _matches(name: str, terms: set[str]) -> bool:
    n = _normalize(name)
    if not n:
        return False
    return any(n == t or (len(t) >= 4 and t in n) or (len(n) >= 4 and n in t) for t in terms)


# ── OpenDia ───────────────────────────────────────────────────────────────────
def od_month_minutes(year: int, month: int, terms: set[str] = None,
                     internal: bool = False) -> tuple[int, int]:
    """(estimated_minutes summed, entries counted) for the month.

    terms=None keeps the historical global behaviour. With terms, entries are
    filtered to that client; `internal` (the Linnflux case) counts non-billable
    entries too, since internal work is never billable.
    """
    if terms is None:
        entries = load_month_entries(year, month, skip_internal=SKIP_INTERNAL)
        if BILLABLE_ONLY:
            entries = [e for e in entries if e["billable"]]
    else:
        entries = load_month_entries(year, month, skip_internal=False)
        entries = [e for e in entries if _matches(e.get("client", ""), terms)]
        if not internal:
            entries = [e for e in entries if e["billable"]]
    return sum(e["estimated_minutes"] for e in entries), len(entries)


def od_month_hours(year: int, month: int, terms: set[str] = None,
                   internal: bool = False) -> float:
    return round_up_quarter(od_month_minutes(year, month, terms, internal)[0])


# ── Toggl ─────────────────────────────────────────────────────────────────────
def _load_cache() -> dict:
    try:
        return json.loads(CACHE.read_text())
    except (OSError, ValueError):
        return {}


def _save_cache(cache: dict) -> None:
    try:
        CACHE.write_text(json.dumps(cache, indent=2, sort_keys=True))
    except OSError:
        pass


def _toggl_fetch(year: int, month: int, is_current: bool) -> dict:
    """{client_name: hours} summed across every configured user token.

    Closed months go through toggl_hours' permanent cache, which is correct for
    them. The current month deliberately passes use_cache=False so it is never
    written into that cache — once it lands there it would never refresh.
    """
    import toggl_hours

    tokens = toggl_hours.load_tokens()  # raises if none configured
    hours = toggl_hours.monthly_hours(tokens, year, month, use_cache=not is_current)
    return {k: round(v, 2) for k, v in hours.items()}


def toggl_month_map(year: int, month: int, deadline: float = None):
    """{client_name: hours} for the month, or None if unavailable in time.

    `deadline` resolves at call time, not import time: binding the module
    constant as a default argument would freeze it, so raising or lowering
    TOGGL_DEADLINE_SEC later would silently do nothing.

    Every failure mode is the same failure mode: return None and let the caller
    omit the line. A worker thread gives a hard deadline that the upstream
    urlopen timeout (45s) does not — it is a daemon so a hung request can never
    hold up interpreter exit.

    Cache format: {"by_client": {...}, "ts": ...}. Legacy pre-client entries
    ({"hours": total}) are treated as misses and refreshed into the new shape.
    """
    deadline = TOGGL_DEADLINE_SEC if deadline is None else deadline
    now = datetime.now()
    is_current = (year, month) == (now.year, now.month)
    key = f"{year:04d}-{month:02d}"

    cache = _load_cache()
    hit = cache.get(key)
    if hit and "by_client" in hit:
        # Closed months never change; the current month expires.
        if not is_current or (time.time() - hit.get("ts", 0)) < CURRENT_MONTH_TTL_SEC:
            return hit["by_client"]

    box: dict = {}

    def worker():
        try:
            box["by_client"] = _toggl_fetch(year, month, is_current)
        except Exception as exc:  # missing token, 402, HTTP, anything
            box["error"] = exc

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    t.join(deadline)

    if "by_client" not in box:
        # Timed out or errored. A stale cached value beats no value at all.
        return hit.get("by_client") if hit else None

    cache[key] = {"by_client": box["by_client"], "ts": time.time()}
    _save_cache(cache)
    return box["by_client"]


def toggl_month_hours(year: int, month: int, terms: set[str] = None,
                      deadline: float = None):
    """Total Toggl hours (terms=None) or one client's hours, or None."""
    by_client = toggl_month_map(year, month, deadline)
    if by_client is None:
        return None
    if terms is None:
        return round(sum(by_client.values()), 2)
    return round(sum(v for k, v in by_client.items() if _matches(k, terms)), 2)


# ── Presentation ──────────────────────────────────────────────────────────────
def month_hours_lines(year: int = None, month: int = None, indent: str = "  ",
                      client: str = None) -> list[str]:
    """The block both commands print. Two data lines, no prose."""
    now = datetime.now()
    year = year or now.year
    month = month or now.month

    terms = None
    internal = False
    header = f"{indent}Hours this Month"
    if client:
        internal = _normalize(client) == "linnflux"
        terms = client_terms(client)
        header += f" — {client}"

    lines = [header]
    lines.append(f"{indent}  OpenDia: {od_month_hours(year, month, terms, internal):.2f}")
    toggl = toggl_month_hours(year, month, terms)
    lines.append(f"{indent}  Toggl:   {toggl:.2f}" if toggl is not None
                 else f"{indent}  Toggl:   —")
    return lines


def main() -> int:
    args = sys.argv[1:]
    now = datetime.now()
    year, month = now.year, now.month
    client = None
    for a in args:
        if len(a) == 7 and a[4] == "-" and a[:4].isdigit():  # YYYY-MM
            year, month = int(a[:4]), int(a[5:])
        elif not a.startswith("--"):
            client = a

    if "--verify" in args:
        terms = client_terms(client) if client else None
        internal = client is not None and _normalize(client) == "linnflux"
        minutes, count = od_month_minutes(year, month, terms, internal)
        started = time.time()
        toggl = toggl_month_hours(year, month, terms)
        elapsed = time.time() - started
        print(f"{year:04d}-{month:02d}" + (f"  client={client!r} terms={sorted(terms)}" if client else ""))
        print(f"  OpenDia  entries={count}  estimated_minutes={minutes}")
        print(f"           raw hours={minutes / 60:.4f}  ->  rounded up {round_up_quarter(minutes):.2f}")
        if client:
            print(f"           filters: client-scoped, billable_only={not internal} (internal counts everything)")
        else:
            print(f"           filters: billable_only={BILLABLE_ONLY} skip_internal={SKIP_INTERNAL}")
        print(f"  Toggl    {toggl if toggl is not None else '(unavailable)'}   fetched in {elapsed:.2f}s")
        return 0

    print("\n".join(month_hours_lines(year, month, client=client)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
