#!/usr/bin/env python3
"""Month-to-date hours for the /od-go and /od-stop summaries.

One helper, two callers, so the number can never disagree between the command
that starts work and the command that stops it.

    python3 month_hours.py            # the two printable lines
    python3 month_hours.py --verify   # the same numbers with their workings

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

* **Billable only, external clients only.** This mirrors what the billing
  pipeline actually produces, so the pulse and the invoice tell the same story.
  Ten Linnflux entries in August 2026 are flagged billable while being internal
  build work; counting them would have overstated the month by ~14h. Flip
  SKIP_INTERNAL to False to count them.

* **Toggl is fail-soft and never freezes.** `toggl_hours.monthly_hours()` caches
  forever, which is right for closed months and wrong for the current one — the
  first value cached would be returned for the rest of the month. Current-month
  figures go through a short TTL cache here instead, and the upstream permanent
  cache is deliberately left unwritten for the current month. A missing token,
  a 402, or a slow API drops the Toggl line rather than delaying a timer stop.
"""

import json
import math
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


# ── OpenDia ───────────────────────────────────────────────────────────────────
def od_month_minutes(year: int, month: int) -> tuple[int, int]:
    """(estimated_minutes summed, entries counted) for the month."""
    entries = load_month_entries(year, month, skip_internal=SKIP_INTERNAL)
    if BILLABLE_ONLY:
        entries = [e for e in entries if e["billable"]]
    return sum(e["estimated_minutes"] for e in entries), len(entries)


def od_month_hours(year: int, month: int) -> float:
    return round_up_quarter(od_month_minutes(year, month)[0])


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


def _toggl_fetch(year: int, month: int, is_current: bool) -> float:
    """Sum Toggl hours across every configured user token.

    Closed months go through toggl_hours' permanent cache, which is correct for
    them. The current month deliberately passes use_cache=False so it is never
    written into that cache — once it lands there it would never refresh.
    """
    import toggl_hours

    tokens = toggl_hours.load_tokens()  # raises if none configured
    hours = toggl_hours.monthly_hours(tokens, year, month, use_cache=not is_current)
    return round(sum(hours.values()), 2)


def toggl_month_hours(year: int, month: int, deadline: float = None):
    """Total Toggl hours, or None if unavailable within the deadline.

    `deadline` resolves at call time, not import time: binding the module
    constant as a default argument would freeze it, so raising or lowering
    TOGGL_DEADLINE_SEC later would silently do nothing.

    Every failure mode is the same failure mode: return None and let the caller
    omit the line. A worker thread gives a hard deadline that the upstream
    urlopen timeout (45s) does not — it is a daemon so a hung request can never
    hold up interpreter exit.
    """
    deadline = TOGGL_DEADLINE_SEC if deadline is None else deadline
    now = datetime.now()
    is_current = (year, month) == (now.year, now.month)
    key = f"{year:04d}-{month:02d}"

    cache = _load_cache()
    hit = cache.get(key)
    if hit:
        # Closed months never change; the current month expires.
        if not is_current or (time.time() - hit.get("ts", 0)) < CURRENT_MONTH_TTL_SEC:
            return hit["hours"]

    box: dict = {}

    def worker():
        try:
            box["hours"] = _toggl_fetch(year, month, is_current)
        except Exception as exc:  # missing token, 402, HTTP, anything
            box["error"] = exc

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    t.join(deadline)

    if "hours" not in box:
        # Timed out or errored. A stale cached value beats no value at all.
        return hit["hours"] if hit else None

    cache[key] = {"hours": box["hours"], "ts": time.time()}
    _save_cache(cache)
    return box["hours"]


# ── Presentation ──────────────────────────────────────────────────────────────
def month_hours_lines(year: int = None, month: int = None, indent: str = "  ") -> list[str]:
    """The block both commands print. Two data lines, no prose."""
    now = datetime.now()
    year = year or now.year
    month = month or now.month

    lines = [f"{indent}Hours this Month"]
    lines.append(f"{indent}  OpenDia: {od_month_hours(year, month):.2f}")
    toggl = toggl_month_hours(year, month)
    lines.append(f"{indent}  Toggl:   {toggl:.2f}" if toggl is not None
                 else f"{indent}  Toggl:   —")
    return lines


def main() -> int:
    args = sys.argv[1:]
    now = datetime.now()
    year, month = now.year, now.month
    for a in args:
        if len(a) == 7 and a[4] == "-":  # YYYY-MM
            year, month = int(a[:4]), int(a[5:])

    if "--verify" in args:
        minutes, count = od_month_minutes(year, month)
        started = time.time()
        toggl = toggl_month_hours(year, month)
        elapsed = time.time() - started
        print(f"{year:04d}-{month:02d}")
        print(f"  OpenDia  entries={count}  estimated_minutes={minutes}")
        print(f"           raw hours={minutes / 60:.4f}  ->  rounded up {round_up_quarter(minutes):.2f}")
        print(f"           filters: billable_only={BILLABLE_ONLY} skip_internal={SKIP_INTERNAL}")
        print(f"  Toggl    {toggl if toggl is not None else '(unavailable)'}   fetched in {elapsed:.2f}s")
        return 0

    print("\n".join(month_hours_lines(year, month)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
