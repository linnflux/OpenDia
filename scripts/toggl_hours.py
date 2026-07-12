#!/usr/bin/env python3
"""Toggl hours per client, via the FREE v9 API.

Why this exists: the v2 Reports API (`/reports/api/v2/summary`) that the billing
pipeline has always used now returns

    402 Payment Required — "feature is not included in current subscription
    level of workspace"

on this workspace. It is not throttling; it is a hard gate, and it means anything
depending on it (billing_month.py, monthly_billing.py) silently loses the Toggl
half of its hours. The workspace-scoped v9 endpoints
(`/workspaces/{id}/projects`) are gated the same way.

What IS free on v9:
    GET /api/v9/me/time_entries?start_date=&end_date=   raw entries
    GET /api/v9/me/projects                             project -> client_id
    GET /api/v9/me/clients                              client_id -> name

So we aggregate the raw entries ourselves.

!! IMPORTANT — MULTI-USER COVERAGE !!
`/me/time_entries` returns ONLY the token owner's entries. Measured against the
June 2026 billing sheet (generated while the Reports API still worked), Toggl
logged 234h that month but Nick's token alone sees 134h — ~100h/month belongs to
another user (Tara). A single token therefore UNDERSTATES hours and OVERSTATES
every effective-hourly / margin number computed from them.

Supply one token per user. Tokens are read from, in order:
    1. $TOGGL_TOKENS            comma-separated
    2. ~/.toggl_tokens          one per line ("# comment" and blank lines ok)
    3. ~/.toggl_token           single token (legacy; will warn about coverage)

Each user's token can read that user's own entries; there is no free
workspace-wide endpoint on this plan. `monthly_hours` sums across all tokens
given, and `coverage_warning()` tells you if you are running one-eyed.

Usage:
    from toggl_hours import monthly_hours, load_tokens
    hours = monthly_hours(load_tokens(), 2026, 6)   # {client_name: hours}

    toggl_hours.py 2026 6                           # CLI check
"""

import base64
import calendar
import json
import os
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

API = "https://api.track.toggl.com/api/v9"


def load_tokens():
    """All Toggl user tokens we should aggregate. See module docstring."""
    env = os.environ.get("TOGGL_TOKENS")
    if env:
        return [t.strip() for t in env.split(",") if t.strip()]

    multi = Path.home() / ".toggl_tokens"
    if multi.exists():
        toks = [l.strip() for l in multi.read_text().splitlines()
                if l.strip() and not l.startswith("#")]
        if toks:
            return toks

    single = Path.home() / ".toggl_token"
    if single.exists():
        return [single.read_text().strip()]

    raise RuntimeError(
        "No Toggl token found. Write one token per user to ~/.toggl_tokens "
        "(chmod 600) — a single token only sees that user's own hours."
    )


def coverage_warning(tokens):
    """Return a warning string if we are only seeing one user's time."""
    if len(tokens) > 1:
        return None
    return (
        "Toggl: only ONE user token in use — hours cover that user only. "
        "Another user's time (~100h/month as of June 2026) is NOT included, so "
        "hours are understated and $/hr is overstated. Add each user's token to "
        "~/.toggl_tokens."
    )


CACHE = Path.home() / "OpenDia" / ".toggl-hours-cache.json"


def _load_cache():
    try:
        return json.loads(CACHE.read_text())
    except (OSError, ValueError):
        return {}


def _save_cache(cache):
    try:
        CACHE.write_text(json.dumps(cache, indent=2, sort_keys=True))
    except OSError:
        pass


def _get(token, path):
    """Toggl answers 402 'Payment Required' for BOTH plan gating and quota
    exhaustion on the free tier — including on endpoints that worked minutes
    earlier. Callers must treat 402 as 'back off and use the cache', never as a
    reason to retry in a tight loop."""
    auth = base64.b64encode(f"{token}:api_token".encode()).decode()
    req = urllib.request.Request(f"{API}/{path}", headers={"Authorization": f"Basic {auth}"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read())


def _client_index(token):
    """project_id -> client name (via project.client_id)."""
    projects = _get(token, "me/projects")
    clients = _get(token, "me/clients")
    cid_to_name = {c["id"]: c["name"] for c in clients}
    return {p["id"]: cid_to_name.get(p.get("client_id")) for p in projects}


def _monthly_hours_one(token, year, month, index=None):
    pid_to_client = index if index is not None else _client_index(token)
    nxt_y, nxt_m = (year + 1, 1) if month == 12 else (year, month + 1)
    entries = _get(
        token,
        f"me/time_entries?start_date={year:04d}-{month:02d}-01"
        f"&end_date={nxt_y:04d}-{nxt_m:02d}-01",
    )

    out = defaultdict(float)
    for e in entries:
        dur = e.get("duration", 0)
        if dur is None or dur < 0:      # negative = still running
            continue
        start = (e.get("start") or "")[:10]
        if not start.startswith(f"{year:04d}-{month:02d}"):
            continue                     # guard against range slop at the edges
        name = pid_to_client.get(e.get("project_id"))
        if not name:
            continue
        out[name] += dur / 3600
    return out


def monthly_hours(tokens, year, month, indexes=None, use_cache=True):
    """{client_name: hours} for one month, summed across every user token.

    Results are cached to ~/OpenDia/.toggl-hours-cache.json. Past months never
    change, and the free-tier API quota is small enough that re-fetching them on
    every report run is what exhausts it. On a 402 we fall back to the cache and
    raise only if we have nothing.
    """
    if isinstance(tokens, str):
        tokens = [tokens]
    key = f"{year:04d}-{month:02d}"
    cache = _load_cache() if use_cache else {}

    if use_cache and key in cache:
        return cache[key]

    total = defaultdict(float)
    try:
        for i, tok in enumerate(tokens):
            idx = indexes[i] if indexes else None
            for k, v in _monthly_hours_one(tok, year, month, idx).items():
                total[k] += v
    except urllib.error.HTTPError as e:
        if e.code == 402 and key in cache:
            return cache[key]
        raise

    result = {k: round(v, 4) for k, v in total.items()}
    if use_cache:
        cache[key] = result
        _save_cache(cache)
    return result


def seed_cache(year, month, hours):
    """Write known-good hours into the cache (e.g. from a billing sheet tab that
    was generated while the Reports API still worked)."""
    cache = _load_cache()
    cache[f"{year:04d}-{month:02d}"] = hours
    _save_cache(cache)


def client_index(token):
    return _client_index(token)


if __name__ == "__main__":
    year, month = int(sys.argv[1]), int(sys.argv[2])
    toks = load_tokens()
    warn = coverage_warning(toks)
    if warn:
        print(f"!! {warn}\n", file=sys.stderr)
    h = monthly_hours(toks, year, month)
    print(f"Toggl {year}-{month:02d}: {sum(h.values()):.1f}h across {len(h)} clients "
          f"({len(toks)} user token{'s' if len(toks) != 1 else ''})")
    for k, v in sorted(h.items(), key=lambda x: -x[1]):
        print(f"  {v:7.2f}h  {k}")
