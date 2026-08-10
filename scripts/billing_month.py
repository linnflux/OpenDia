#!/usr/bin/env python3
"""Monthly billing — unified Toggl + OpenDia → single review tab.

Pulls Toggl billable hours for the month via the Reports API, pulls OpenDia
timer hours from ~/OpenDia/Time/, reads per-client config from the Clients tab
on the new Billing Operations sheet, and writes a single YYYY-MM tab ready
for review.

Usage:
    python3 billing_month.py                      # preview last month
    python3 billing_month.py --month 2026-06      # preview specific month
    python3 billing_month.py --month 2026-06 --write-sheet
    python3 billing_month.py --month 2026-06 --current  # force current month
"""

import argparse
import base64
import calendar
import glob
import json
import math
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta

CREDENTIALS_PATH = os.path.expanduser("~/.claude/mcp-credentials/google-workspace.json")
TOKENS_PATH = os.path.expanduser("~/.claude/mcp-credentials/google-workspace/tokens.json")
DB_PATH = os.path.expanduser("~/OpenDia/opendia.db")
TIMER_BASE = os.path.expanduser("~/OpenDia/Time")

from opendia_config import get_id  # noqa: E402

NEW_SHEET_ID = get_id("BILLING_OPS_SHEET_ID")
CLIENTS_TAB = "Clients"
TOGGL_WORKSPACE = get_id("TOGGL_WORKSPACE_ID")

TOGGL_API_BASE = "https://api.track.toggl.com/api/v9"
TOGGL_REPORTS_BASE = "https://api.track.toggl.com/reports/api/v3"


# ---------------------------------------------------------------------------
# Toggl API
# ---------------------------------------------------------------------------

def get_toggl_token():
    """Locate the Toggl API token from the first available source:
    1. TOGGL_API_TOKEN env var (set in shell before running)
    2. ~/.toggl_token file (single line, no quotes)
    3. ~/.claude.json mcpServers.toggl.env.TOGGL_API_TOKEN (if populated)
    """
    # 1. Environment variable
    env_token = os.environ.get("TOGGL_API_TOKEN", "").strip()
    if env_token and len(env_token) > 10 and env_token not in {"YOUR_API_TOKEN_HERE"}:
        return env_token

    # 2. Dedicated token file
    token_file = os.path.expanduser("~/.toggl_token")
    if os.path.exists(token_file):
        with open(token_file) as f:
            file_token = f.read().strip()
        if file_token and len(file_token) > 10:
            return file_token

    # 3. ~/.claude.json
    try:
        with open(os.path.expanduser("~/.claude.json")) as f:
            config = json.load(f)
        token = (
            config.get("mcpServers", {})
                  .get("toggl", {})
                  .get("env", {})
                  .get("TOGGL_API_TOKEN", "")
                  .strip()
        )
        if token and len(token) > 10 and token not in {"YOUR_API_TOKEN_HERE"}:
            return token
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    raise RuntimeError(
        "Toggl API token not found. To set it:\n"
        "  echo 'YOUR_TOKEN' > ~/.toggl_token\n"
        "  chmod 600 ~/.toggl_token\n"
        "Get your token: https://track.toggl.com/profile → scroll to bottom → API Token"
    )


def _toggl_auth_header(token):
    encoded = base64.b64encode(f"{token}:api_token".encode()).decode()
    return {"Authorization": f"Basic {encoded}", "Content-Type": "application/json"}



def toggl_v2_get(token, path, params=None):
    """GET against the Toggl Reports API v2 (no premium plan required for basic summary)."""
    import urllib.parse
    url = f"https://api.track.toggl.com/reports/api/v2/{path.lstrip('/')}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=_toggl_auth_header(token))
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Toggl v2 GET {url} failed {e.code}: {e.read().decode()}")


def get_toggl_monthly_hours(token, workspace_id, year, month):
    """Return {client_name: hours} for the month.

    Prefers the v2 Reports API (workspace-wide, all users). As of 2026-07-12 that
    endpoint returns 402 "feature is not included in current subscription level"
    on this workspace, so we fall back to aggregating raw v9 time entries.

    The fallback is NOT equivalent: v9 /me/time_entries only sees the token
    owner's time. If ~/.toggl_tokens holds one token per user it covers everyone;
    with a single token it UNDERSTATES hours (~100h/month of Tara's time in June
    2026). The fallback warns on stderr rather than quietly under-reporting.
    """
    last_day = calendar.monthrange(year, month)[1]
    start_date = f"{year:04d}-{month:02d}-01"
    end_date = f"{year:04d}-{month:02d}-{last_day:02d}"

    print(f"  Toggl: fetching v2 summary {start_date} → {end_date}...", end=" ", flush=True)
    try:
        summary = toggl_v2_get(token, "summary", {
            "workspace_id": workspace_id,
            "since": start_date,
            "until": end_date,
            "user_agent": "billing@linnflux.com",
            "grouping": "clients",
        })
    except RuntimeError as e:
        if "402" not in str(e):
            raise
        print("402 (plan-gated) — falling back to v9 time entries.")
        import toggl_hours
        tokens = toggl_hours.load_tokens()
        warn = toggl_hours.coverage_warning(tokens)
        if warn:
            print(f"  !! {warn}", file=sys.stderr)
        # Degraded: v9 is per-token, so any user without a token on file vanishes.
        return toggl_hours.monthly_hours(tokens, year, month), True

    data = summary.get("data", [])
    print(f"{len(data)} client groups.")

    result = {}
    no_client_ms = 0

    for group in data:
        client_name = group.get("title", {}).get("client")
        time_ms = group.get("time", 0)
        if not client_name or client_name == "No client":
            no_client_ms += time_ms
            continue
        hours = round(time_ms / 1000 / 3600, 4)
        result[client_name] = result.get(client_name, 0) + hours

    if no_client_ms:
        hrs = round(no_client_ms / 1000 / 3600, 2)
        print(f"  Note: {hrs}h tracked with no Toggl client assigned — not included.", file=sys.stderr)

    return result, False  # ({toggl_client_name: hours}, degraded?)


def get_workspace_user_emails(token, workspace_id):
    """Return {email: toggl_display_name} for the workspace.

    Needed to line a Toggl entry (which carries a display name) up against an
    OpenDia timer entry (which carries started_by, an email). Returns {} if the
    endpoint is unavailable — overlap detection then degrades to nothing rather
    than guessing at identities.
    """
    url = f"{TOGGL_API_BASE}/workspaces/{workspace_id}/users"
    try:
        req = urllib.request.Request(url, headers=_toggl_auth_header(token))
        with urllib.request.urlopen(req, timeout=30) as resp:
            users = json.loads(resp.read().decode())
    except Exception as e:
        print(f"  !! Could not fetch workspace users ({e}) — overlap detection off.",
              file=sys.stderr)
        return {}
    return {
        (u.get("email") or "").strip().lower(): (u.get("fullname") or "").strip()
        for u in users
        if u.get("email") and u.get("fullname")
    }


def get_toggl_detail_by_person_day(token, workspace_id, year, month):
    """Return {(toggl_client, toggl_user, 'YYYY-MM-DD'): hours}, or None.

    Used only to measure Toggl/OpenDia double-logging. None means the detail
    endpoint was unavailable (402 or error), in which case overlap must be
    treated as unknown — NOT as zero-with-confidence.
    """
    last_day = calendar.monthrange(year, month)[1]
    start_date = f"{year:04d}-{month:02d}-01"
    end_date = f"{year:04d}-{month:02d}-{last_day:02d}"

    detail = defaultdict(float)
    page = 1
    while True:
        try:
            d = toggl_v2_get(token, "details", {
                "workspace_id": workspace_id,
                "since": start_date,
                "until": end_date,
                "user_agent": "billing@linnflux.com",
                "page": page,
            })
        except RuntimeError as e:
            print(f"  !! Toggl detail fetch failed ({e}) — overlap detection off.",
                  file=sys.stderr)
            return None
        rows = d.get("data", [])
        if not rows:
            break
        for r in rows:
            client = (r.get("client") or "").strip()
            user = (r.get("user") or "").strip()
            if not client or not user:
                continue
            day = str(r.get("start") or "")[:10]
            detail[(client, user, day)] += r.get("dur", 0) / 3600000.0
        if len(rows) < d.get("per_page", 50):
            break
        page += 1
    return dict(detail)


# ---------------------------------------------------------------------------
# OpenDia timer file parsing — shared parser (repo/scripts/timeentry.py)
# ---------------------------------------------------------------------------
from timeentry import parse_entries_from_file  # noqa: E402

def load_month_entries(year, month):
    month_dir = os.path.join(TIMER_BASE, f"{year:04d}", f"{month:02d}")
    files = sorted(glob.glob(os.path.join(month_dir, "*.md")))
    if not files:
        print(f"  OD: no timer files in {month_dir}", file=sys.stderr)
        return []
    entries = []
    for fp in files:
        entries.extend(parse_entries_from_file(fp))
    return entries


def get_od_hours(entries):
    """Return {client_name: hours} for all billable OD entries."""
    by_client = defaultdict(float)
    for e in entries:
        if e["billable"]:
            by_client[e["client"]] += math.ceil(e["estimated_minutes"] / 15) * 0.25
    return dict(by_client)


def get_od_detail_by_person_day(entries, email_to_toggl_name):
    """Return {(od_client, toggl_display_name, 'YYYY-MM-DD'): hours}.

    Raw hours, deliberately NOT 15-minute-rounded like get_od_hours(). Overlap is
    subtracted from rounded totals, so keeping the subtrahend un-rounded means any
    error lands on the under-subtracting side — we may bill slightly more than the
    true union, never less.

    Entries with no started_by cannot be attributed to a person and so can never
    be matched. They are counted and reported: unattributed time is a blind spot
    in the overlap number, not an absence of overlap.
    """
    detail = defaultdict(float)
    unattributed = defaultdict(float)
    for e in entries:
        if not e["billable"]:
            continue
        hrs = e["estimated_minutes"] / 60.0
        email = (e.get("started_by") or "").strip().lower()
        name = email_to_toggl_name.get(email)
        if not name:
            unattributed[e["client"]] += hrs
            continue
        detail[(e["client"], name, str(e.get("date") or "")[:10])] += hrs
    return dict(detail), dict(unattributed)


# ---------------------------------------------------------------------------
# SQLite client name canonicalization (for OD timer entries)
# ---------------------------------------------------------------------------

_BOGUS_SHORT_NAMES = {"", "none", "--short-name", "null"}


def load_sqlite_index():
    if not os.path.exists(DB_PATH):
        return {}, {}
    try:
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute("SELECT name, short_name FROM companies").fetchall()
        conn.close()
    except Exception:
        return {}, {}
    name_idx, short_idx = {}, {}
    for name, short_name in rows:
        if name:
            name_idx[name.strip().lower()] = name.strip()
        if short_name and short_name.strip().lower() not in _BOGUS_SHORT_NAMES:
            short_idx[short_name.strip().lower()] = name.strip()
    return name_idx, short_idx


def load_flag_set(column):
    """Lowercased names + short_names of companies whose `column` flag is set.

    SQLite is the source of truth for both billing flags. Set them with
    `db_helper.py set-nonprofit` / `set-full-rate`, never by hand.

    A failure here is never silent. Reading no flags is indistinguishable from
    "no client is flagged", and the two mis-bill in opposite directions: an
    unread nonprofit flag bills OD hours that should be free, an unread
    full_rate flag deducts an overlap that should not be deducted. An absent
    database file stays quiet — that is "not configured", not a failure.
    """
    if not os.path.exists(DB_PATH):
        return set()
    try:
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute(
            f"SELECT name, short_name FROM companies WHERE {column} = 1"
        ).fetchall()
        conn.close()
    except Exception as e:
        print(f"  !! Could not read companies.{column} ({e}) — every client will be "
              f"treated as un-flagged, which mis-bills anyone who is.", file=sys.stderr)
        return set()
    out = set()
    for name, short_name in rows:
        if name:
            out.add(name.strip().lower())
        if short_name and short_name.strip().lower() not in _BOGUS_SHORT_NAMES:
            out.add(short_name.strip().lower())
    return out


def load_nonprofit_set():
    """[NP] — OpenDia platform hours are not billed. Mirrored by a Notion
    checkbox for visibility, never read from Square at runtime."""
    return load_flag_set("nonprofit")


def load_full_rate_set():
    """[FP] — for-profit, full rate. These clients pay Toggl hours AND OpenDia
    platform hours with NO overlap deduction: the human operator and the OpenDia
    session are separately chargeable inputs (rent the machine, pay the driver).

    The mirror of [NP]: nonprofits get OD hours free, [FP] clients get no
    overlap relief, and that spread is what funds the nonprofit subsidy. SQLite
    only — unlike nonprofit, there is no Notion checkbox.
    """
    return load_flag_set("full_rate")


def is_full_rate(canonical_name, cfg, full_rate_set):
    if not full_rate_set:
        return False
    candidates = {canonical_name.strip().lower()}
    short = (cfg or {}).get("short_name")
    if short:
        candidates.add(short.strip().lower())
    return bool(candidates & full_rate_set)


def is_nonprofit(canonical_name, cfg, nonprofit_set):
    """Match a Clients-tab canonical name (or its aliases) against the nonprofit set.

    Exact match first; then unique substring match (Clients-tab names sometimes
    differ from DB names, e.g. 'Acme Corp LLC' vs 'Acme Corp').
    """
    candidates = [canonical_name] + list(cfg.get("aliases", []))
    keys = [c.strip().lower() for c in candidates if c and c.strip()]
    for k in keys:
        if k in nonprofit_set:
            return True
    for k in keys:
        matches = {n for n in nonprofit_set if k in n or n in k}
        if len(matches) == 1:
            return True
    return False


def _flatten_client_key(s):
    """Lowercase and collapse punctuation to single spaces.

    Timer entries are sometimes opened with a slug-form client name
    ('acme-center-for-widgets'), which never matches the canonical
    'Acme Center for Widgets' on an exact or substring test — the hyphens block
    both. That split one client into two rows on the July 2026 tab.
    """
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def canonicalize_od(raw, name_idx, short_idx):
    if not raw:
        return raw
    key = raw.strip().lower()
    if key in name_idx:
        return name_idx[key]
    if key in short_idx:
        return short_idx[key]

    # Separator-insensitive exact match before falling back to substrings.
    flat = _flatten_client_key(raw)
    if flat:
        for idx in (name_idx, short_idx):
            for k, v in idx.items():
                if _flatten_client_key(k) == flat:
                    return v

    all_names = list(name_idx.values())
    matches = {n for n in all_names if key in n.lower() or n.lower() in key}
    return matches.pop() if len(matches) == 1 else raw


# ---------------------------------------------------------------------------
# Clients tab
# ---------------------------------------------------------------------------

def get_sheets_service():
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    with open(CREDENTIALS_PATH) as f:
        creds_data = json.load(f)
    with open(TOKENS_PATH) as f:
        tokens = json.load(f)

    client_config = creds_data["installed"]
    creds = Credentials(
        token=tokens.get("access_token"),
        refresh_token=tokens.get("refresh_token"),
        token_uri=client_config["token_uri"],
        client_id=client_config["client_id"],
        client_secret=client_config["client_secret"],
        scopes=[
            "https://www.googleapis.com/auth/drive.readonly",
            "https://www.googleapis.com/auth/spreadsheets",
        ],
    )
    return build("sheets", "v4", credentials=creds)


def read_clients_tab(service):
    """Return a dict of {canonical_name: {rate, retainer, discount_cap, contact, email, aliases:[...]}}."""
    try:
        result = service.spreadsheets().values().get(
            spreadsheetId=NEW_SHEET_ID,
            range=f"'{CLIENTS_TAB}'!A2:I500",
            valueRenderOption="UNFORMATTED_VALUE",
        ).execute()
    except Exception as e:
        raise RuntimeError(
            f"Cannot read Clients tab: {e}\n"
            "Run billing_seed_clients.py --write first to create it."
        )

    rows = result.get("values", [])
    if not rows:
        raise RuntimeError("Clients tab exists but is empty. Run billing_seed_clients.py --write.")

    clients = {}
    for row in rows:
        while len(row) < 9:
            row.append("")
        name = str(row[0]).strip()
        if not name:
            continue
        aliases_raw = str(row[1]).strip()
        aliases = [a.strip() for a in aliases_raw.split(",") if a.strip()] if aliases_raw else []
        active = str(row[5]).strip().upper() not in {"FALSE", "0", "NO"}
        try:
            rate = float(row[2]) if row[2] != "" else 0.0
        except (TypeError, ValueError):
            rate = 0.0
        try:
            retainer = float(row[3]) if row[3] != "" else 0.0
        except (TypeError, ValueError):
            retainer = 0.0
        try:
            discount_cap = float(row[4]) if row[4] != "" else retainer
        except (TypeError, ValueError):
            discount_cap = retainer
        clients[name] = {
            "rate": rate,
            "retainer": retainer,
            "discount_cap": discount_cap,
            "active": active,
            "plan_notes": str(row[6]).strip(),
            "contact": str(row[7]).strip(),
            "email": str(row[8]).strip(),
            "aliases": aliases,
        }

    return clients


def build_name_lookup(clients_config):
    """Build {lowercased_name_or_alias: canonical_name} for Toggl/OD resolution."""
    lookup = {}
    for canonical, info in clients_config.items():
        lookup[canonical.lower()] = canonical
        for alias in info.get("aliases", []):
            if alias:
                lookup[alias.lower()] = canonical
    return lookup


def resolve_name(raw, lookup, clients_config):
    """Resolve a Toggl/OD client name to canonical form. Returns None if unmatched."""
    if not raw:
        return None
    key = raw.strip().lower()
    if key in lookup:
        return lookup[key]
    matches = {c for c in clients_config if key in c.lower() or c.lower() in key}
    return matches.pop() if len(matches) == 1 else None


# ---------------------------------------------------------------------------
# Merge and output
# ---------------------------------------------------------------------------

OVERLAP_CACHE_PATH = os.path.expanduser("~/OpenDia/.billing-overlap-cache.json")


def load_overlap_cache(year, month):
    """Return cached {client: overlap_hours} for a month, or None."""
    try:
        with open(OVERLAP_CACHE_PATH) as f:
            return json.load(f).get(f"{year:04d}-{month:02d}")
    except Exception:
        return None


def save_overlap_cache(year, month, overlap_by_client):
    """Persist a measured overlap. Past months don't change, and the Toggl
    Reports API 402s unpredictably on this plan — without a cache, one 402 turns
    a correct month into a silently double-counted one."""
    try:
        cache = {}
        if os.path.exists(OVERLAP_CACHE_PATH):
            with open(OVERLAP_CACHE_PATH) as f:
                cache = json.load(f)
        cache[f"{year:04d}-{month:02d}"] = {k: round(v, 2) for k, v in overlap_by_client.items()}
        with open(OVERLAP_CACHE_PATH, "w") as f:
            json.dump(cache, f, indent=1, sort_keys=True)
    except Exception as e:
        print(f"  !! Could not write overlap cache: {e}", file=sys.stderr)


def compute_overlap(toggl_detail, od_detail, name_lookup, clients_config, name_idx, short_idx):
    """Return {canonical_client: overlap_hours}.

    Overlap = the same person logging the same client on the same day in BOTH
    Toggl and the OpenDia timer. Confirmed 2026-08-05 to be genuine
    double-logging of one body of work, not two separate stretches.

    min() of the two is used, which assumes same-day means same work. Where a
    person genuinely worked two distinct blocks that day and logged one in each
    system, this over-subtracts. The column is written to the sheet as a plain
    editable number precisely so those rows can be corrected by hand.
    """
    if not toggl_detail or not od_detail:
        return {}

    def canon_toggl(raw):
        c = resolve_name(raw, name_lookup, clients_config)
        if c:
            return c
        sq = canonicalize_od(raw, name_idx, short_idx)
        return resolve_name(sq, name_lookup, clients_config) if sq != raw else None

    def canon_od(raw):
        return resolve_name(canonicalize_od(raw, name_idx, short_idx), name_lookup, clients_config)

    tog = defaultdict(float)
    for (client, user, day), hrs in toggl_detail.items():
        c = canon_toggl(client)
        if c:
            tog[(c, user, day)] += hrs

    overlap = defaultdict(float)
    for (client, user, day), hrs in od_detail.items():
        c = canon_od(client)
        if not c:
            continue
        key = (c, user, day)
        if key in tog:
            overlap[c] += min(hrs, tog[key])

    return dict(overlap)


def merge_billing_data(toggl_hours, od_hours, clients_config,
                       toggl_detail=None, od_detail=None, overlap_override=None):
    """Produce a list of dicts — one per billing-relevant client.

    Includes:
      - active clients with retainer > 0 (billed even with zero activity)
      - any client with Toggl hours > 0
      - any client with OD hours > 0
    Excludes:
      - inactive Clients tab entries
      - Toggl/OD entries that can't be resolved to any canonical name (returned separately)
    """
    name_lookup = build_name_lookup(clients_config)
    name_idx, short_idx = load_sqlite_index()

    # Clients silently excluded (internal — not a resolution failure)
    _EXCLUDE = {"linnflux"}

    # Canonicalize Toggl names
    toggl_resolved = {}
    toggl_unmatched = {}
    for raw, hrs in toggl_hours.items():
        if raw.strip().lower() in _EXCLUDE:
            continue
        canonical = resolve_name(raw, name_lookup, clients_config)
        if canonical:
            toggl_resolved[canonical] = toggl_resolved.get(canonical, 0) + hrs
        else:
            # Try SQLite as fallback
            sq = canonicalize_od(raw, name_idx, short_idx)
            canonical2 = resolve_name(sq, name_lookup, clients_config) if sq != raw else None
            if canonical2:
                toggl_resolved[canonical2] = toggl_resolved.get(canonical2, 0) + hrs
            else:
                toggl_unmatched[raw] = hrs

    # Canonicalize OD names
    od_resolved = {}
    od_unmatched = {}
    for raw, hrs in od_hours.items():
        sq = canonicalize_od(raw, name_idx, short_idx)
        canonical = resolve_name(sq, name_lookup, clients_config)
        if canonical:
            od_resolved[canonical] = od_resolved.get(canonical, 0) + hrs
        else:
            od_unmatched[raw] = hrs

    # Internal clients excluded from billing output
    _EXCLUDE = {"linnflux"}

    # Only include clients with actual hours this month (Toggl or OD).
    # This keeps the monthly tab to ~20 active rows rather than listing all 100+ configured clients.
    # The Retainer discount still applies for any included client that has a retainer configured.
    billing_clients = (
        (set(toggl_resolved.keys()) | set(od_resolved.keys()))
        - _EXCLUDE
    )

    nonprofit_set = load_nonprofit_set()

    if overlap_override is not None:
        overlap_by_client = overlap_override
    else:
        overlap_by_client = compute_overlap(
            toggl_detail, od_detail, name_lookup, clients_config, name_idx, short_idx
        )

    full_rate_set = load_full_rate_set()

    rows = []
    for name in sorted(billing_clients, key=str.lower):
        cfg = clients_config.get(name, {})
        nonprofit = is_nonprofit(name, cfg, nonprofit_set)
        full_rate = is_full_rate(name, cfg, full_rate_set)
        toggl_hrs = math.ceil(toggl_resolved.get(name, 0) * 4) / 4
        od_hrs = round(od_resolved.get(name, 0), 2)
        # Nonprofits bill Toggl hours only, so their OD hours never entered the
        # total. [FP] clients pay operator AND platform hours in full, so the
        # overlap deduction does not apply to them either.
        if nonprofit or full_rate:
            overlap = 0.0
        else:
            overlap = round(min(overlap_by_client.get(name, 0.0), od_hrs), 2)
        rows.append({
            "name": name,
            "toggl_hrs": toggl_hrs,
            "od_hrs": od_hrs,
            "overlap_hrs": overlap,
            "rate": cfg.get("rate", 0.0),
            "retainer": cfg.get("retainer", 0.0),
            "contact": cfg.get("contact", ""),
            "email": cfg.get("email", ""),
            "nonprofit": nonprofit,
            "full_rate": full_rate,
        })

    return rows, toggl_unmatched, od_unmatched


def print_preview(rows, toggl_unmatched, od_unmatched, year, month):
    from datetime import date as _date
    month_name = _date(year, month, 1).strftime("%B %Y")

    print(f"\n{'='*80}")
    print(f"  Billing Preview — {month_name}")
    print(f"{'='*80}")
    print(f"  {'Client':<36} {'Toggl':>6} {'OD':>5} {'Ovlp':>5} {'Rate':>5} {'Retain':>7}  {'Est.Charge':>11}")
    print(f"  {'-'*84}")

    grand_toggl = 0.0
    grand_od = 0.0
    grand_overlap = 0.0
    grand_charge = 0.0

    for row in rows:
        ovlp = row.get("overlap_hrs", 0.0)
        billed_hrs = (
            row["toggl_hrs"] if row.get("nonprofit")
            else row["toggl_hrs"] + row["od_hrs"] - ovlp
        )
        est = max(0, billed_hrs * row["rate"] - row["retainer"])
        grand_toggl += row["toggl_hrs"]
        grand_od += row["od_hrs"]
        grand_overlap += ovlp
        grand_charge += est
        note = ""
        if row["retainer"] > 0 and row["toggl_hrs"] * row["rate"] <= row["retainer"]:
            note = "(retainer)"
        if row.get("nonprofit"):
            note = (note + " " if note else "") + "(nonprofit — OD not billed)"
        if row.get("full_rate"):
            note = (note + " " if note else "") + "(full rate — no overlap deduction)"
        charge_str = f"${est:,.2f}" if est else "  $0"
        print(
            f"  {row['name'][:35]:<36} {row['toggl_hrs']:>6.2f} {row['od_hrs']:>5.2f}"
            f" {ovlp:>5.2f} {row['rate']:>5.0f} {row['retainer']:>7.0f}  {charge_str:>11} {note}"
        )

    print(f"  {'-'*84}")
    print(f"  {'TOTAL':<36} {grand_toggl:>6.2f} {grand_od:>5.2f} {grand_overlap:>5.2f}"
          f" {'':>5} {'':>7}  ${grand_charge:>10,.2f}")
    print(f"  ({len(rows)} clients)")
    if grand_overlap:
        print(f"  Overlap removed: {grand_overlap:.2f}h of double-logged time "
              f"(same person, same client, same day, in both systems).")

    if toggl_unmatched:
        print(f"\n  ⚠ Toggl clients not in Clients tab ({len(toggl_unmatched)}):")
        for name, hrs in sorted(toggl_unmatched.items()):
            print(f"    {name}: {hrs:.2f}h — add to Clients tab or add alias")

    if od_unmatched:
        print(f"\n  ⚠ OD timer clients not in Clients tab ({len(od_unmatched)}):")
        for name, hrs in sorted(od_unmatched.items()):
            print(f"    {name}: {hrs:.2f}h — add to Clients tab or add alias")

    if not toggl_unmatched and not od_unmatched:
        print("\n  ✓ All client names resolved.")

    print()


# ---------------------------------------------------------------------------
# Sheet writing
# ---------------------------------------------------------------------------

MONTHLY_HEADERS = [
    "Client", "Toggl Hrs", "OD Hrs", "Overlap Hrs", "Rate", "Retainer",
    "Additional", "Build Name", "Build Hrs", "Build Milestone", "Build Billed",
    "Grand Total", "Notes", "Sent", "Contact", "Email",
]
# Col letters for formula references (A=0, B=1, ...)
# NOTE: "Overlap Hrs" was inserted at D on 2026-08-05; everything from Rate
# rightward shifted one column. Month tabs written before that date use the old
# layout and are not backfilled.
_COL_B = "B"  # Toggl Hrs
_COL_C = "C"  # OD Hrs
_COL_D = "D"  # Overlap Hrs (billed hours = B + C - D)
_COL_E = "E"  # Rate
_COL_F = "F"  # Retainer
_COL_G = "G"  # Additional Charges
_COL_K = "K"  # Build Billed
_COL_L = "L"  # Grand Total


def ensure_tab(service, spreadsheet_id, tab_name):
    meta = service.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    for sheet in meta.get("sheets", []):
        if sheet["properties"]["title"] == tab_name:
            return True
    service.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={"requests": [{"addSheet": {"properties": {"title": tab_name}}}]},
    ).execute()
    return False


def get_sheet_id(service, spreadsheet_id, tab_name):
    meta = service.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    for sheet in meta.get("sheets", []):
        if sheet["properties"]["title"] == tab_name:
            return sheet["properties"]["sheetId"]
    return None


def write_monthly_tab(service, rows_data, od_entries, year, month, total_toggl_hrs=None):
    from datetime import date as _date
    month_name = _date(year, month, 1).strftime("%B %Y")
    tab_name = f"{year:04d}-{month:02d}"

    ensure_tab(service, NEW_SHEET_ID, tab_name)
    service.spreadsheets().values().clear(
        spreadsheetId=NEW_SHEET_ID,
        range=f"'{tab_name}'",
        body={},
    ).execute()

    # Remove stale banded ranges / filters
    sheet_id = get_sheet_id(service, NEW_SHEET_ID, tab_name)
    if sheet_id is not None:
        meta = service.spreadsheets().get(spreadsheetId=NEW_SHEET_ID).execute()
        cleanup = []
        for sh in meta.get("sheets", []):
            if sh["properties"]["sheetId"] == sheet_id:
                for br in sh.get("bandedRanges", []):
                    cleanup.append({"deleteBanding": {"bandedRangeId": br["bandedRangeId"]}})
                if sh.get("basicFilter"):
                    cleanup.append({"clearBasicFilter": {"sheetId": sheet_id}})
        if cleanup:
            service.spreadsheets().batchUpdate(
                spreadsheetId=NEW_SHEET_ID, body={"requests": cleanup}
            ).execute()

    # Build the row data
    # Row 1:   title
    # Row 2:   blank
    # Row 3:   blank (stats area)
    # Rows 4–9: stats block (A4:B9)
    # Row 10:  headers
    # Rows 11+: client data
    # TOTALS row
    # 3 blank rows
    # OpenDia detail section

    DATA_START_ROW = 12  # 1-indexed first client row (rows 1-11 = title/blank/stats/headers)

    # Pre-compute row indices (needed by stats formulas before sheet_rows is assembled)
    last_data_r = DATA_START_ROW + len(rows_data) - 1
    totals_r = last_data_r + 1
    totals_row_idx = totals_r - 1  # 0-indexed

    s, e = DATA_START_ROW, last_data_r
    # Billed hours are B + C - D (Toggl + OD - Overlap); rate is E, retainer F.
    _bh = f"(B{s}:B{e}+C{s}:C{e}-D{s}:D{e})"
    ret_formula = (
        f"=SUMPRODUCT((F{s}:F{e}>0)*("
        f"({_bh}*E{s}:E{e}<=F{s}:F{e})*{_bh}*E{s}:E{e}"
        f"+({_bh}*E{s}:E{e}>F{s}:F{e})*F{s}:F{e}))"
    )

    sheet_rows = [
        [
            "Billing Operations",
            tab_name,
            month_name,
            "",
            "Generated:",
            datetime.now().strftime("%Y-%m-%d %H:%M"),
        ],
        [],
        [],  # row 3: blank stats spacer
        ["Total Toggl Hours:", total_toggl_hrs if total_toggl_hrs is not None else f"=SUM(B{s}:B{e})"],
        ["Toggl Billable Hours:", f"=SUM(B{s}:B{e})"],
        ["Percentage Billable:", "=IFERROR(B5/B4,0)"],
        ["Total Being Billed:", f"=SUM(L{s}:L{e})"],
        ["Total Retainer Used:", ret_formula],
        ["Avg per Hour:", "=IFERROR(B7/B5,0)"],
        ["Total OD Hours:", f"=SUM(C{s}:C{e})"],
        MONTHLY_HEADERS,
    ]

    for i, row in enumerate(rows_data):
        r = DATA_START_ROW + i  # 1-indexed sheet row for formulas
        # Nonprofit clients bill Toggl hours only, so OD (col C) never entered the
        # total and there is no overlap (col D) to remove.
        hours_expr = f"B{r}" if row.get("nonprofit") else f"(B{r}+C{r}-D{r})"
        sheet_rows.append([
            row["name"],
            row["toggl_hrs"],
            row["od_hrs"],
            row.get("overlap_hrs", 0.0),
            row["rate"],
            row["retainer"],
            "",  # Additional Charges — manual
            "",  # Build Name — manual
            "",  # Build Hrs — manual
            "",  # Build Milestone — manual
            "",  # Build Billed — manual
            f"=MAX(0,{hours_expr}*{_COL_E}{r}-{_COL_F}{r})+IF(ISNUMBER({_COL_G}{r}),{_COL_G}{r},0)+IF(ISNUMBER({_COL_K}{r}),{_COL_K}{r},0)",
            # Notes — [NP]/[FP] marker written by the script, rest manual
            "[NP]" if row.get("nonprofit") else ("[FP]" if row.get("full_rate") else ""),
            "",  # Sent — manual
            row["contact"],
            row["email"],
        ])

    sheet_rows.append([
        "TOTALS",
        f"=SUM({_COL_B}{DATA_START_ROW}:{_COL_B}{last_data_r})",
        f"=SUM({_COL_C}{DATA_START_ROW}:{_COL_C}{last_data_r})",
        f"=SUM({_COL_D}{DATA_START_ROW}:{_COL_D}{last_data_r})",
        "",
        "",
        f"=SUM({_COL_G}{DATA_START_ROW}:{_COL_G}{last_data_r})",
        "",
        f"=SUM(I{DATA_START_ROW}:I{last_data_r})",
        "",
        f"=SUM({_COL_K}{DATA_START_ROW}:{_COL_K}{last_data_r})",
        f"=SUM({_COL_L}{DATA_START_ROW}:{_COL_L}{last_data_r})",
    ])

    # 3 blank separator rows
    sheet_rows.extend([[], [], []])

    # OpenDia detail section
    od_detail_header_row = len(sheet_rows)
    sheet_rows.append(["OpenDia Timer Detail — " + month_name])
    sheet_rows.append(["Date", "Client", "Division", "Task", "Est. Min", "Summary", "Billable", "Source"])

    od_header_row = len(sheet_rows) - 1  # 0-indexed

    # Group OD entries by client, sort by date
    grouped = defaultdict(list)
    for e in od_entries:
        grouped[e["client"]].append(e)

    for client in sorted(grouped.keys(), key=str.lower):
        for e in sorted(grouped[client], key=lambda x: x["date"]):
            sheet_rows.append([
                e["date"],
                e["client"],
                e["division"],
                e["task"],
                e["estimated_minutes"],
                e.get("summary", ""),
                "Yes" if e["billable"] else "No",
                "OpenDia",
            ])

    od_detail_end_row = len(sheet_rows)

    # Write all rows
    service.spreadsheets().values().update(
        spreadsheetId=NEW_SHEET_ID,
        range=f"'{tab_name}'!A1",
        valueInputOption="USER_ENTERED",
        body={"values": sheet_rows},
    ).execute()

    if sheet_id is None:
        sheet_id = get_sheet_id(service, NEW_SHEET_ID, tab_name)

    # Formatting: freeze header row, bold header, banded client rows, banded OD detail
    col_count_main = len(MONTHLY_HEADERS)
    requests = [
        # Freeze through row 11 (stats + header)
        {
            "updateSheetProperties": {
                "properties": {
                    "sheetId": sheet_id,
                    "gridProperties": {"frozenRowCount": 11},
                },
                "fields": "gridProperties.frozenRowCount",
            }
        },
        # Bold title row
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": 0, "endRowIndex": 1,
                    "startColumnIndex": 0, "endColumnIndex": 6,
                },
                "cell": {"userEnteredFormat": {"textFormat": {"bold": True}}},
                "fields": "userEnteredFormat.textFormat.bold",
            }
        },
        # Stats labels (A4:A10) — italic
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": 3, "endRowIndex": 10,
                    "startColumnIndex": 0, "endColumnIndex": 1,
                },
                "cell": {"userEnteredFormat": {"textFormat": {"italic": True}}},
                "fields": "userEnteredFormat.textFormat.italic",
            }
        },
        # Stats values (B4:B5) — number format
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": 3, "endRowIndex": 5,
                    "startColumnIndex": 1, "endColumnIndex": 2,
                },
                "cell": {"userEnteredFormat": {"numberFormat": {"type": "NUMBER", "pattern": "#,##0.00"}}},
                "fields": "userEnteredFormat.numberFormat",
            }
        },
        # Stats value B6 — percentage
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": 5, "endRowIndex": 6,
                    "startColumnIndex": 1, "endColumnIndex": 2,
                },
                "cell": {"userEnteredFormat": {"numberFormat": {"type": "PERCENT", "pattern": "0.00%"}}},
                "fields": "userEnteredFormat.numberFormat",
            }
        },
        # Stats values B7:B9 — currency
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": 6, "endRowIndex": 9,
                    "startColumnIndex": 1, "endColumnIndex": 2,
                },
                "cell": {"userEnteredFormat": {"numberFormat": {"type": "CURRENCY", "pattern": "$#,##0.00"}}},
                "fields": "userEnteredFormat.numberFormat",
            }
        },
        # Stats value B10 (Total OD Hours) — number format
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": 9, "endRowIndex": 10,
                    "startColumnIndex": 1, "endColumnIndex": 2,
                },
                "cell": {"userEnteredFormat": {"numberFormat": {"type": "NUMBER", "pattern": "#,##0.00"}}},
                "fields": "userEnteredFormat.numberFormat",
            }
        },
        # Header row (row 11) — blue bg + white bold text
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": 10, "endRowIndex": 11,
                    "startColumnIndex": 0, "endColumnIndex": col_count_main,
                },
                "cell": {
                    "userEnteredFormat": {
                        "backgroundColor": {"red": 0.24, "green": 0.52, "blue": 0.78},
                        "textFormat": {
                            "bold": True,
                            "foregroundColor": {"red": 1.0, "green": 1.0, "blue": 1.0},
                        },
                    }
                },
                "fields": "userEnteredFormat(backgroundColor,textFormat)",
            }
        },
        # TOTALS row — bold
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": totals_row_idx,
                    "endRowIndex": totals_row_idx + 1,
                    "startColumnIndex": 0,
                    "endColumnIndex": col_count_main,
                },
                "cell": {"userEnteredFormat": {"textFormat": {"bold": True, "fontSize": 11}}},
                "fields": "userEnteredFormat.textFormat",
            }
        },
        # Banded rows for client data
        {
            "addBanding": {
                "bandedRange": {
                    "range": {
                        "sheetId": sheet_id,
                        "startRowIndex": 10,  # header row (row 11)
                        "endRowIndex": totals_row_idx + 1,
                        "startColumnIndex": 0,
                        "endColumnIndex": col_count_main,
                    },
                    "rowProperties": {
                        "headerColor": {"red": 0.24, "green": 0.52, "blue": 0.78, "alpha": 1.0},
                        "firstBandColor": {"red": 1.0, "green": 1.0, "blue": 1.0, "alpha": 1.0},
                        "secondBandColor": {"red": 0.93, "green": 0.95, "blue": 0.97, "alpha": 1.0},
                    },
                }
            }
        },
        # Filter on client data section
        {
            "setBasicFilter": {
                "filter": {
                    "range": {
                        "sheetId": sheet_id,
                        "startRowIndex": 10,
                        "endRowIndex": totals_row_idx,
                        "startColumnIndex": 0,
                        "endColumnIndex": col_count_main,
                    }
                }
            }
        },
        # OD detail section header — green bg
        {
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": od_detail_header_row,
                    "endRowIndex": od_detail_header_row + 2,
                    "startColumnIndex": 0,
                    "endColumnIndex": 8,
                },
                "cell": {
                    "userEnteredFormat": {
                        "backgroundColor": {"red": 0.20, "green": 0.55, "blue": 0.35},
                        "textFormat": {
                            "bold": True,
                            "foregroundColor": {"red": 1.0, "green": 1.0, "blue": 1.0},
                        },
                    }
                },
                "fields": "userEnteredFormat(backgroundColor,textFormat)",
            }
        },
    ]

    service.spreadsheets().batchUpdate(
        spreadsheetId=NEW_SHEET_ID,
        body={"requests": requests},
    ).execute()

    # Update Home tab Build Revenue for this month — live formula so it reflects
    # manual Build Billed entries as they're filled in throughout the month.
    _month_col = "BCDEFGHIJKLM"[month - 1]
    build_formula = (
        f"=IFERROR(SUM('{tab_name}'!{_COL_K}{DATA_START_ROW}:{_COL_K}{last_data_r}),\"\")"
    )
    service.spreadsheets().values().update(
        spreadsheetId=NEW_SHEET_ID,
        range=f"'Home'!{_month_col}14",
        valueInputOption="USER_ENTERED",
        body={"values": [[build_formula]]},
    ).execute()

    print(f"Wrote {len(rows_data)} client rows + {od_detail_end_row - od_header_row - 1} OD detail rows to '{tab_name}'.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def resolve_month(args):
    if args.month:
        parts = args.month.split("-")
        return int(parts[0]), int(parts[1])
    today = datetime.now()
    if args.current:
        return today.year, today.month
    first_this = today.replace(day=1)
    last_month = first_this - timedelta(days=1)
    return last_month.year, last_month.month


def main():
    parser = argparse.ArgumentParser(description="Generate unified monthly billing tab.")
    parser.add_argument("--month", type=str, default=None, help="YYYY-MM (default: last month)")
    parser.add_argument("--current", action="store_true", help="Use current calendar month")
    parser.add_argument("--write-sheet", action="store_true", help="Write to Google Sheets")
    parser.add_argument("--allow-double-count", action="store_true",
                        help="Write even when Toggl/OD overlap is unmeasured and uncached "
                             "(bills double-logged hours twice — you almost never want this)")
    args = parser.parse_args()

    year, month = resolve_month(args)
    from datetime import date as _date
    month_label = _date(year, month, 1).strftime("%B %Y")
    print(f"\nBilling month: {month_label} ({year:04d}-{month:02d})")

    print("\n[1/4] Toggl billable hours")
    token = get_toggl_token()
    toggl_hours, toggl_degraded = get_toggl_monthly_hours(token, TOGGL_WORKSPACE, year, month)

    print("\n[2/4] OpenDia timer hours")
    entries = load_month_entries(year, month)
    name_idx, short_idx = load_sqlite_index()
    for e in entries:
        e["client"] = canonicalize_od(e["client"], name_idx, short_idx)
    od_hours = get_od_hours(entries)
    print(f"  {len(entries)} entries across {len(od_hours)} OD clients.")

    print("\n[2.5/4] Overlap (work logged in BOTH Toggl and the OD timer)")
    email_map = get_workspace_user_emails(token, TOGGL_WORKSPACE)
    toggl_detail = get_toggl_detail_by_person_day(token, TOGGL_WORKSPACE, year, month)
    od_detail, od_unattributed = get_od_detail_by_person_day(entries, email_map)

    overlap_override = None
    overlap_measured = toggl_detail is not None and bool(email_map)
    if overlap_measured:
        print(f"  {len(toggl_detail)} Toggl person-days vs {len(od_detail)} OD person-days.")
        unattr_total = sum(od_unattributed.values())
        if unattr_total > 0.01:
            print(f"  !! {unattr_total:.2f}h of OD time has no started_by and cannot be "
                  f"overlap-checked — the overlap figure is a floor, not a measurement.",
                  file=sys.stderr)
            for c, h in sorted(od_unattributed.items(), key=lambda kv: -kv[1])[:5]:
                print(f"       {c}: {h:.2f}h", file=sys.stderr)
    else:
        cached = load_overlap_cache(year, month)
        if cached:
            overlap_override = cached
            print(f"  Toggl detail unavailable (402) — using CACHED overlap for "
                  f"{year:04d}-{month:02d} ({sum(cached.values()):.2f}h across "
                  f"{len(cached)} clients).")
        else:
            print("  !! Overlap could not be measured and nothing is cached.",
                  file=sys.stderr)

    print("\n[3/4] Clients config")
    service = get_sheets_service()
    clients_config = read_clients_tab(service)
    active_count = sum(1 for c in clients_config.values() if c["active"])
    print(f"  {active_count} active clients in Clients tab ({len(clients_config)} total).")

    print("\n[4/4] Merging")
    total_toggl_hrs = round(sum(toggl_hours.values()), 2)
    rows_data, toggl_unmatched, od_unmatched = merge_billing_data(
        toggl_hours, od_hours, clients_config,
        toggl_detail=toggl_detail, od_detail=od_detail,
        overlap_override=overlap_override,
    )
    print(f"  {len(rows_data)} billing rows assembled.")

    if overlap_measured:
        save_overlap_cache(year, month, {
            r["name"]: r["overlap_hrs"] for r in rows_data if r.get("overlap_hrs")
        })

    print_preview(rows_data, toggl_unmatched, od_unmatched, year, month)

    if not args.write_sheet:
        print("Run with --write-sheet to push to Google Sheets.")
        return

    # Two ways a 402 can silently corrupt the tab, both of which look completely
    # normal on the sheet:
    #   1. Toggl hours fall back to per-token v9 — every user without a token on
    #      file disappears, and the month simply looks like a slow month.
    #   2. Overlap goes unmeasured — every hour logged in both systems bills twice.
    # Refuse rather than produce either.
    blockers = []
    if toggl_degraded:
        blockers.append(
            "Toggl hours came from the per-token v9 fallback, so any user without a "
            "token in ~/.toggl_tokens is MISSING from these numbers."
        )
    if not overlap_measured and overlap_override is None:
        blockers.append(
            "Overlap is unmeasured and uncached, so hours logged in both Toggl and "
            "the OD timer would be billed twice."
        )
    if blockers:
        print("\nREFUSING TO WRITE:", file=sys.stderr)
        for b in blockers:
            print(f"  - {b}", file=sys.stderr)
        print("Wait for the Toggl Reports API to recover and re-run, or pass "
              "--allow-double-count to override.", file=sys.stderr)
        if not args.allow_double_count:
            sys.exit(1)
        print("  --allow-double-count set; writing degraded numbers anyway.", file=sys.stderr)

    print(f"Writing {year:04d}-{month:02d} tab to new sheet...")
    write_monthly_tab(service, rows_data, entries, year, month, total_toggl_hrs=total_toggl_hrs)
    print(f"Open: https://docs.google.com/spreadsheets/d/{NEW_SHEET_ID}/edit")


if __name__ == "__main__":
    main()
