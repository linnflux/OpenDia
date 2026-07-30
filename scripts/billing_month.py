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
        return toggl_hours.monthly_hours(tokens, year, month)

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

    return result  # {toggl_client_name: hours_float}


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


def load_nonprofit_set():
    """Lowercased names + short_names of companies flagged nonprofit in the OpenDia DB.

    The SQLite `companies.nonprofit` flag is the source of truth for nonprofit
    billing (OD hours are not billed) — mirrored by a Notion checkbox for
    visibility, never read from Square at runtime.
    """
    if not os.path.exists(DB_PATH):
        return set()
    try:
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute(
            "SELECT name, short_name FROM companies WHERE nonprofit = 1"
        ).fetchall()
        conn.close()
    except Exception:
        return set()
    out = set()
    for name, short_name in rows:
        if name:
            out.add(name.strip().lower())
        if short_name and short_name.strip().lower() not in _BOGUS_SHORT_NAMES:
            out.add(short_name.strip().lower())
    return out


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


def canonicalize_od(raw, name_idx, short_idx):
    if not raw:
        return raw
    key = raw.strip().lower()
    if key in name_idx:
        return name_idx[key]
    if key in short_idx:
        return short_idx[key]
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

def merge_billing_data(toggl_hours, od_hours, clients_config):
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

    rows = []
    for name in sorted(billing_clients, key=str.lower):
        cfg = clients_config.get(name, {})
        rows.append({
            "name": name,
            "toggl_hrs": math.ceil(toggl_resolved.get(name, 0) * 4) / 4,
            "od_hrs": round(od_resolved.get(name, 0), 2),
            "rate": cfg.get("rate", 0.0),
            "retainer": cfg.get("retainer", 0.0),
            "contact": cfg.get("contact", ""),
            "email": cfg.get("email", ""),
            "nonprofit": is_nonprofit(name, cfg, nonprofit_set),
        })

    return rows, toggl_unmatched, od_unmatched


def print_preview(rows, toggl_unmatched, od_unmatched, year, month):
    from datetime import date as _date
    month_name = _date(year, month, 1).strftime("%B %Y")

    print(f"\n{'='*80}")
    print(f"  Billing Preview — {month_name}")
    print(f"{'='*80}")
    print(f"  {'Client':<38} {'Toggl':>6} {'OD':>5} {'Rate':>7} {'Retainer':>9}  {'Est.Charge':>11}")
    print(f"  {'-'*78}")

    grand_toggl = 0.0
    grand_od = 0.0
    grand_charge = 0.0

    for row in rows:
        billed_hrs = row["toggl_hrs"] if row.get("nonprofit") else row["toggl_hrs"] + row["od_hrs"]
        est = max(0, billed_hrs * row["rate"] - row["retainer"])
        grand_toggl += row["toggl_hrs"]
        grand_od += row["od_hrs"]
        grand_charge += est
        note = ""
        if row["retainer"] > 0 and row["toggl_hrs"] * row["rate"] <= row["retainer"]:
            note = "(retainer)"
        if row.get("nonprofit"):
            note = (note + " " if note else "") + "(nonprofit — OD not billed)"
        charge_str = f"${est:,.2f}" if est else "  $0"
        print(
            f"  {row['name']:<38} {row['toggl_hrs']:>6.2f} {row['od_hrs']:>5.2f}"
            f" {row['rate']:>7.0f} {row['retainer']:>9.0f}  {charge_str:>11} {note}"
        )

    print(f"  {'-'*78}")
    print(f"  {'TOTAL':<38} {grand_toggl:>6.2f} {grand_od:>5.2f} {'':>7} {'':>9}  ${grand_charge:>10,.2f}")
    print(f"  ({len(rows)} clients)")

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
    "Client", "Toggl Hrs", "OD Hrs", "Rate", "Retainer",
    "Additional", "Build Name", "Build Hrs", "Build Milestone", "Build Billed",
    "Grand Total", "Notes", "Sent", "Contact", "Email",
]
# Col letters for formula references (A=0, B=1, ...)
_COL_B = "B"  # Toggl Hrs
_COL_D = "D"  # Rate
_COL_E = "E"  # Retainer
_COL_F = "F"  # Additional Charges
_COL_J = "J"  # Build Billed
_COL_K = "K"  # Grand Total


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
    ret_formula = (
        f"=SUMPRODUCT((E{s}:E{e}>0)*("
        f"((B{s}:B{e}+C{s}:C{e})*D{s}:D{e}<=E{s}:E{e})*(B{s}:B{e}+C{s}:C{e})*D{s}:D{e}"
        f"+((B{s}:B{e}+C{s}:C{e})*D{s}:D{e}>E{s}:E{e})*E{s}:E{e}))"
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
        ["Total Being Billed:", f"=SUM(K{s}:K{e})"],
        ["Total Retainer Used:", ret_formula],
        ["Avg per Hour:", "=IFERROR(B7/B5,0)"],
        ["Total OD Hours:", f"=SUM(C{s}:C{e})"],
        MONTHLY_HEADERS,
    ]

    for i, row in enumerate(rows_data):
        r = DATA_START_ROW + i  # 1-indexed sheet row for formulas
        # Nonprofit clients: OD hours (col C) are never billed
        hours_expr = f"B{r}" if row.get("nonprofit") else f"(B{r}+C{r})"
        sheet_rows.append([
            row["name"],
            row["toggl_hrs"],
            row["od_hrs"],
            row["rate"],
            row["retainer"],
            "",  # Additional Charges — manual
            "",  # Build Name — manual
            "",  # Build Hrs — manual
            "",  # Build Milestone — manual
            "",  # Build Billed — manual
            f"=MAX(0,{hours_expr}*{_COL_D}{r}-{_COL_E}{r})+IF(ISNUMBER({_COL_F}{r}),{_COL_F}{r},0)+IF(ISNUMBER({_COL_J}{r}),{_COL_J}{r},0)",
            "[NP]" if row.get("nonprofit") else "",  # Notes — [NP] marker for nonprofits, rest manual
            "",  # Sent — manual
            row["contact"],
            row["email"],
        ])

    sheet_rows.append([
        "TOTALS",
        f"=SUM({_COL_B}{DATA_START_ROW}:{_COL_B}{last_data_r})",
        f"=SUM(C{DATA_START_ROW}:C{last_data_r})",
        "",
        "",
        f"=SUM({_COL_F}{DATA_START_ROW}:{_COL_F}{last_data_r})",
        "",
        f"=SUM(H{DATA_START_ROW}:H{last_data_r})",
        "",
        f"=SUM({_COL_J}{DATA_START_ROW}:{_COL_J}{last_data_r})",
        f"=SUM({_COL_K}{DATA_START_ROW}:{_COL_K}{last_data_r})",
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
    build_formula = f"=IFERROR(SUM('{tab_name}'!J{DATA_START_ROW}:J{last_data_r}),\"\")"
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
    args = parser.parse_args()

    year, month = resolve_month(args)
    from datetime import date as _date
    month_label = _date(year, month, 1).strftime("%B %Y")
    print(f"\nBilling month: {month_label} ({year:04d}-{month:02d})")

    print("\n[1/4] Toggl billable hours")
    token = get_toggl_token()
    toggl_hours = get_toggl_monthly_hours(token, TOGGL_WORKSPACE, year, month)

    print("\n[2/4] OpenDia timer hours")
    entries = load_month_entries(year, month)
    name_idx, short_idx = load_sqlite_index()
    for e in entries:
        e["client"] = canonicalize_od(e["client"], name_idx, short_idx)
    od_hours = get_od_hours(entries)
    print(f"  {len(entries)} entries across {len(od_hours)} OD clients.")

    print("\n[3/4] Clients config")
    service = get_sheets_service()
    clients_config = read_clients_tab(service)
    active_count = sum(1 for c in clients_config.values() if c["active"])
    print(f"  {active_count} active clients in Clients tab ({len(clients_config)} total).")

    print("\n[4/4] Merging")
    total_toggl_hrs = round(sum(toggl_hours.values()), 2)
    rows_data, toggl_unmatched, od_unmatched = merge_billing_data(toggl_hours, od_hours, clients_config)
    print(f"  {len(rows_data)} billing rows assembled.")

    print_preview(rows_data, toggl_unmatched, od_unmatched, year, month)

    if not args.write_sheet:
        print("Run with --write-sheet to push to Google Sheets.")
        return

    print(f"Writing {year:04d}-{month:02d} tab to new sheet...")
    write_monthly_tab(service, rows_data, entries, year, month, total_toggl_hrs=total_toggl_hrs)
    print(f"Open: https://docs.google.com/spreadsheets/d/{NEW_SHEET_ID}/edit")


if __name__ == "__main__":
    main()
