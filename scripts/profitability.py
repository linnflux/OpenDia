#!/usr/bin/env python3
"""Per-client profitability: what you actually collected vs what it actually took.

The system has always known both halves and never joined them. Revenue lived in
Square; hours lived in Toggl and the OpenDia timer ledger. This puts them in one
table and answers: which clients are worth keeping?

WHAT THIS MEASURES (and what it doesn't)

  Revenue is CASH BASIS — completed Square payments in the window, net of
  Square's processing fee (~2.9%, a real cost nobody was counting). It is money
  that actually landed, not invoices raised. A client who was billed but hasn't
  paid shows as revenue $0 for the period, which is the honest answer to "is
  this client worth keeping."

  Hours are DELIVERY HOURS: Toggl (the primary tracker) + OpenDia timer
  estimated_minutes (human work time, the billing signal — NOT wall-clock, which
  is engagement span; see docs/billing.md).

  The headline metric is EFFECTIVE HOURLY = net revenue / hours delivered. It
  needs no assumptions about your cost of labor, and it is the number that
  actually tells you something: a client paying a $125 nominal rate who is
  realizing $38/hr is being over-serviced, and the gap is the story.

  Pass --cost-rate to also compute margin against an assumed hourly cost of
  delivery. That number is only as good as the rate you supply.

CAVEATS YOU SHOULD KNOW

  - Cash timing is lumpy. A client who pays quarterly looks unprofitable in two
    months out of three. Use a window of 3+ months for anything you'd act on.
  - Retainer clients bank hours in some months and burn them in others.
  - Unmapped Square customers and unmapped time entries are reported separately
    rather than silently dropped — read that section, it is where the lies hide.

Usage:
  profitability.py                          # trailing 6 months
  profitability.py --months 12
  profitability.py --from 2026-01 --to 2026-06
  profitability.py --cost-rate 45           # add margin vs $45/hr cost of delivery
  profitability.py --json
"""

import argparse
import calendar
import json
import os
import sys
import time
from collections import defaultdict
from datetime import date
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import billing_month as bm  # noqa: E402  (Toggl, Sheets config, canonicalization)
from timeentry import load_month_entries  # noqa: E402

SQUARE_API = "https://connect.squareup.com/v2"
LOCATION_ID = "6RGNNJJXK66KR"


# ── Square ────────────────────────────────────────────────────────────────────

def square_token():
    tok = os.environ.get("SQUARE_ACCESS_TOKEN")
    if tok:
        return tok
    cfg = json.load(open(os.path.expanduser("~/.claude.json")))
    return cfg["mcpServers"]["square"]["env"]["SQUARE_ACCESS_TOKEN"]


def square_customers(token):
    """Full customer records — we need several fields to identify the business.

    Square's data is inconsistent: sometimes the business is in company_name,
    sometimes company_name holds the CONTACT PERSON and the business is split
    across given_name + family_name ("A & B Metal" + "Fabrication"). So keep
    every candidate and let the matcher try them all.
    """
    headers = {"Authorization": f"Bearer {token}"}
    out, cursor = {}, None
    while True:
        params = {"limit": 100}
        if cursor:
            params["cursor"] = cursor
        r = requests.get(f"{SQUARE_API}/customers", headers=headers, params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        for c in data.get("customers", []):
            full = " ".join(p for p in [c.get("given_name"), c.get("family_name")] if p).strip()
            out[c["id"]] = {
                "full": full,
                "company": (c.get("company_name") or "").strip(),
                "email": (c.get("email_address") or "").strip().lower(),
                "label": full or c.get("company_name") or "(unnamed)",
            }
        cursor = data.get("cursor")
        if not cursor:
            break
    return out


def square_payments(token, start_iso, end_iso):
    """Completed payments in the window, net of processing fees."""
    headers = {"Authorization": f"Bearer {token}"}
    payments, cursor = [], None
    while True:
        params = {
            "begin_time": start_iso, "end_time": end_iso,
            "location_id": LOCATION_ID, "limit": 100,
        }
        if cursor:
            params["cursor"] = cursor
        r = requests.get(f"{SQUARE_API}/payments", headers=headers, params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        payments.extend(data.get("payments", []))
        cursor = data.get("cursor")
        if not cursor:
            break

    out = []
    for p in payments:
        if p.get("status") != "COMPLETED":
            continue
        gross = p.get("amount_money", {}).get("amount", 0) / 100
        fee = sum(f.get("amount_money", {}).get("amount", 0)
                  for f in p.get("processing_fee") or []) / 100
        out.append({
            "customer_id": p.get("customer_id"),
            "gross": gross,
            "fee": fee,
            "net": gross - fee,
            "date": (p.get("created_at") or "")[:10],
        })
    return out


# ── Name matching ─────────────────────────────────────────────────────────────

RATES_PATH = Path.home() / "OpenDia" / ".labor-rates.json"


def load_rates():
    """Fully-loaded hourly COST of delivery, per person.

    Lives outside the repo (compensation data; this repo is public). Absent
    file just means no margin column — never a failure. Gusto has no API for a
    company to read its own payroll, so this is a hand-maintained config; the
    numbers change roughly once a year.
    """
    try:
        cfg = json.loads(RATES_PATH.read_text())
    except (OSError, ValueError):
        return None
    return {
        "default": float(cfg.get("default_rate") or 0),
        "by_user": {k.lower(): float(v) for k, v in (cfg.get("rates") or {}).items() if v},
    }


def domain_of(email):
    return email.split("@")[-1].lower().lstrip("www.") if "@" in email else ""


def build_matcher():
    """Resolve a Square customer / Toggl client / timer client to a canonical company.

    bm.canonicalize_od returns the RAW string when it can't resolve, which would
    quietly turn every typo into its own "client" — so anything that doesn't land
    on a real company is reported as unmapped instead of inventing a row.

    For Square we try, in order: the name fields (either arrangement), the
    client's email as recorded in the billing Clients tab, then the email's
    domain against the company's website. Square's customer records are too
    inconsistent for any single one of these to work alone.
    """
    name_idx, short_idx = bm.load_sqlite_index()
    known = {n.lower() for n in name_idx.values()}

    # email -> canonical, and website domain -> canonical
    import sqlite3
    email_idx, domain_idx = {}, {}
    db = sqlite3.connect(f"file:{bm.DB_PATH}?mode=ro", uri=True)
    for name, website in db.execute("SELECT name, website FROM companies WHERE website != ''"):
        d = (website or "").lower().replace("https://", "").replace("http://", "")
        d = d.split("/")[0].lstrip("www.")
        if d:
            domain_idx[d] = name
    db.close()

    try:
        clients_tab = bm.read_clients_tab(bm.get_sheets_service())
    except Exception as e:
        print(f"  (Clients tab unavailable: {e})", file=sys.stderr)
        clients_tab = {}

    for cname, cfg in clients_tab.items():
        canon = bm.canonicalize_od(cname, name_idx, short_idx)
        canon = canon if canon.lower() in known else cname
        if cfg.get("email"):
            email_idx[cfg["email"].strip().lower()] = canon
        for alias in cfg.get("aliases", []):
            a = bm.canonicalize_od(alias, name_idx, short_idx)
            if a.lower() not in known:
                name_idx[alias.strip().lower()] = canon

    def by_name(raw):
        if not raw:
            return None
        resolved = bm.canonicalize_od(raw, name_idx, short_idx)
        return resolved if resolved and resolved.lower() in known else None

    def match_customer(cust):
        if not cust:
            return None
        return (by_name(cust.get("full"))
                or by_name(cust.get("company"))
                or email_idx.get(cust.get("email", ""))
                or domain_idx.get(domain_of(cust.get("email", ""))))

    return by_name, match_customer


def months_in(from_ym, to_ym):
    y, m = map(int, from_ym.split("-"))
    ty, tm = map(int, to_ym.split("-"))
    out = []
    while (y, m) <= (ty, tm):
        out.append((y, m))
        m = m + 1 if m < 12 else 1
        if m == 1:
            y += 1
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--months", type=int, default=6, help="trailing months (default 6)")
    ap.add_argument("--from", dest="from_ym", help="start month YYYY-MM")
    ap.add_argument("--to", dest="to_ym", help="end month YYYY-MM")
    ap.add_argument("--cost-rate", type=float, help="assumed $/hr cost of delivery, to compute margin")
    ap.add_argument("--min-hours", type=float, default=0.5, help="hide clients below this many hours AND no revenue")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    today = date.today()
    if args.from_ym:
        to_ym = args.to_ym or f"{today.year:04d}-{today.month:02d}"
        months = months_in(args.from_ym, to_ym)
    else:
        total = today.year * 12 + (today.month - 1) - (args.months - 1)
        months = months_in(f"{total // 12:04d}-{total % 12 + 1:02d}",
                           f"{today.year:04d}-{today.month:02d}")

    y0, m0 = months[0]
    y1, m1 = months[-1]
    start_iso = f"{y0:04d}-{m0:02d}-01T00:00:00Z"
    end_iso = f"{y1:04d}-{m1:02d}-{calendar.monthrange(y1, m1)[1]:02d}T23:59:59Z"

    # The billing helpers print progress to stdout; keep --json output parseable.
    import contextlib
    noise = contextlib.redirect_stdout(sys.stderr) if args.json else contextlib.nullcontext()

    with noise:
        match, match_customer = build_matcher()

        # Revenue -------------------------------------------------------------
        tok = square_token()
        print("  Square: fetching customers...", end=" ", flush=True, file=sys.stderr)
        customers = square_customers(tok)
        print(f"{len(customers)}.", file=sys.stderr)
        print("  Square: fetching payments...", end=" ", flush=True, file=sys.stderr)
        pays = square_payments(tok, start_iso, end_iso)
        print(f"{len(pays)} completed.", file=sys.stderr)

        revenue = defaultdict(lambda: {"gross": 0.0, "fee": 0.0, "net": 0.0, "payments": 0})
        unmapped_rev = defaultdict(float)
        for p in pays:
            cust = customers.get(p["customer_id"]) if p["customer_id"] else None
            client = match_customer(cust)
            if not client:
                unmapped_rev[(cust or {}).get("label") or "(no customer on payment)"] += p["net"]
                continue
            r = revenue[client]
            r["gross"] += p["gross"]
            r["fee"] += p["fee"]
            r["net"] += p["net"]
            r["payments"] += 1

        # Hours ---------------------------------------------------------------
        hours = defaultdict(lambda: {"toggl": 0.0, "od": 0.0})
        unmapped_hours = defaultdict(float)

        import toggl_hours as th
        toggl_failed = []
        tokens = th.load_tokens()
        # Cached months came from the billing tabs — workspace-wide, every user.
        # Only months we have to fetch live are limited to the token owner, so the
        # single-token warning applies to those and only those.
        toggl_coverage = th.coverage_warning(tokens)

        # Token count alone does NOT prove coverage: with two tokens we still found
        # 16h in June logged by a third user. The monthly billing tabs were written
        # from the workspace-wide Reports API, so where a tab exists it is ground
        # truth — reconcile against it and report any hours nobody's token explains.
        unaccounted = {}
        try:
            svc = bm.get_sheets_service()
            meta = svc.spreadsheets().get(spreadsheetId=bm.NEW_SHEET_ID).execute()
            tabs = {sh["properties"]["title"] for sh in meta["sheets"]}
            for y, m in months:
                tab = f"{y:04d}-{m:02d}"
                if tab not in tabs:
                    continue
                vals = svc.spreadsheets().values().get(
                    spreadsheetId=bm.NEW_SHEET_ID, range=f"'{tab}'!A12:C90"
                ).execute().get("values", [])
                sheet_h = 0.0
                for r in vals:
                    if len(r) >= 2 and r[0] and r[0] not in ("Client", "TOTALS"):
                        try:
                            sheet_h += float(r[1] or 0)
                        except ValueError:
                            pass
                ours = sum(v for k, v in th.monthly_hours(tokens, y, m).items()
                           if k.strip().lower() != "linnflux")
                if sheet_h - ours > 1.0:
                    unaccounted[tab] = round(sheet_h - ours, 1)
        except Exception:
            pass  # reconciliation is a bonus check, never a hard failure
        for y, m in months:
            # Toggl's free tier answers 402 for both plan-gating AND quota
            # exhaustion, so hours come from the on-disk cache first (seeded from
            # the monthly billing tabs, which are workspace-wide and include every
            # user). A month we cannot source is reported as MISSING rather than
            # silently counted as zero — zero hours would inflate $/hr to infinity.
            try:
                data = th.monthly_hours(tokens, y, m)
            except Exception as e:
                toggl_failed.append(f"{y:04d}-{m:02d}")
                data = {}
            for raw, h in data.items():
                client = match(raw)
                if client:
                    hours[client]["toggl"] += h
                else:
                    unmapped_hours[raw] += h

        # Per-person hours per client: lets cost be computed from who ACTUALLY did
        # the work (each person at their own rate) rather than a blended average.
        rates = load_rates()
        cost_by_client = defaultdict(float)
        if rates:
            try:
                for y, m in months:
                    for user, per_client in th.monthly_hours_by_user(tokens, y, m).items():
                        rate = rates["by_user"].get(user, rates["default"])
                        for raw, h in per_client.items():
                            client = match(raw)
                            if client:
                                cost_by_client[client] += h * rate
            except Exception as e:
                print(f"  (per-user cost unavailable: {str(e)[:60]})", file=sys.stderr)
                rates = None

        for y, m in months:
            for e in load_month_entries(y, m):
                client = match(e["client"])
                h = e["estimated_minutes"] / 60
                if client:
                    hours[client]["od"] += h
                else:
                    unmapped_hours[e["client"]] += h


    # Join ----------------------------------------------------------------
    rows = []
    for client in set(revenue) | set(hours):
        rev = revenue.get(client, {"gross": 0.0, "fee": 0.0, "net": 0.0, "payments": 0})
        hrs = hours.get(client, {"toggl": 0.0, "od": 0.0})
        total_h = hrs["toggl"] + hrs["od"]
        if total_h < args.min_hours and rev["net"] == 0:
            continue
        eff = rev["net"] / total_h if total_h > 0 else None
        row = {
            "client": client,
            "revenue_net": round(rev["net"], 2),
            "square_fees": round(rev["fee"], 2),
            "payments": rev["payments"],
            "hours": round(total_h, 1),
            "toggl_hours": round(hrs["toggl"], 1),
            "od_hours": round(hrs["od"], 1),
            "effective_hourly": round(eff, 2) if eff is not None else None,
        }
        cost = None
        if rates and client in cost_by_client:
            cost = cost_by_client[client]        # real, per-person
        elif args.cost_rate:
            cost = total_h * args.cost_rate      # flat assumption
        if cost is not None:
            row["cost"] = round(cost, 2)
            row["margin"] = round(rev["net"] - cost, 2)
            row["margin_pct"] = round((rev["net"] - cost) / rev["net"] * 100, 1) if rev["net"] else None
        rows.append(row)

    internal = next((r for r in rows if r["client"].lower() == "linnflux"), None)
    rows = [r for r in rows if r["client"].lower() != "linnflux"]
    rows.sort(key=lambda r: -r["revenue_net"])
    span = f"{y0:04d}-{m0:02d} → {y1:04d}-{m1:02d}"

    if args.json:
        print(json.dumps({
            "span": span,
            "toggl_months_missing": toggl_failed,
            "toggl_coverage_warning": toggl_coverage,
            "rows": rows,
            "unmapped_revenue": {k: round(v, 2) for k, v in sorted(unmapped_rev.items(), key=lambda x: -x[1])},
            "unmapped_hours": {k: round(v, 1) for k, v in sorted(unmapped_hours.items(), key=lambda x: -x[1])},
        }, indent=2))
        return

    tot_rev = sum(r["revenue_net"] for r in rows)
    tot_fee = sum(r["square_fees"] for r in rows)
    tot_h = sum(r["hours"] for r in rows)

    print(f"\n{'='*94}")
    print(f"  Per-client profitability — {span}   (cash basis, net of Square fees)")
    print(f"{'='*94}")
    if toggl_failed:
        print(f"  !! TOGGL HOURS MISSING for: {', '.join(toggl_failed)}")
        print("     Those months contribute revenue but NOT their Toggl hours, so")
        print("     $/hr below is OVERSTATED. Narrow the window to months with data,")
        print("     or seed the cache from a billing tab. Do not act on this as-is.\n")
    elif toggl_coverage:
        print(f"  Note: {toggl_coverage}\n")
    if unaccounted:
        tot = sum(unaccounted.values())
        print(f"  !! {tot:.0f}h logged by a user whose Toggl token we do NOT have "
              f"({', '.join(f'{k}: {v}h' for k, v in sorted(unaccounted.items()))}).")
        print("     Those hours are MISSING below, so $/hr is overstated for the")
        print("     affected clients. Add that user's token to ~/.toggl_tokens.\n")
    show_margin = bool(args.cost_rate) or any("margin" in r for r in rows)
    hdr = f"  {'Client':<30} {'Net rev':>10} {'Hours':>7} {'Eff $/hr':>9}"
    if show_margin:
        hdr += f" {'Margin':>10} {'Margin%':>8}"
    print(hdr)
    print(f"  {'-'*90}")

    for r in rows:
        eff = f"${r['effective_hourly']:,.0f}" if r["effective_hourly"] is not None else "     —"
        line = f"  {r['client'][:30]:<30} {'$'+format(r['revenue_net'], ',.0f'):>10} {r['hours']:>7.1f} {eff:>9}"
        if show_margin:
            m = r.get("margin")
            mp = r.get("margin_pct")
            line += (f" {'$'+format(m, ',.0f'):>10} {(f'{mp:.0f}%' if mp is not None else '—'):>8}"
                     if m is not None else f" {'—':>10} {'—':>8}")
        flag = ""
        if r["revenue_net"] > 0 and r["hours"] == 0:
            flag = "  ++ recurring, no delivery hours"
        elif r["hours"] >= 5 and r["revenue_net"] == 0:
            flag = "  << hours, no cash this window"
        elif r["effective_hourly"] is not None and r["effective_hourly"] < 50 and r["hours"] >= 5:
            flag = "  << low realization"
        print(line + flag)

    print(f"  {'-'*90}")
    overall = tot_rev / tot_h if tot_h else 0
    print(f"  {'TOTAL':<30} {'$'+format(tot_rev, ',.0f'):>10} {tot_h:>7.1f} {'$'+format(overall, ',.0f'):>9}")
    print(f"\n  Square processing fees over the period: ${tot_fee:,.2f} "
          f"({tot_fee / (tot_rev + tot_fee) * 100:.1f}% of gross)" if tot_rev else "")

    if internal:
        print(f"\n  Internal (Linnflux): {internal['hours']:.0f}h — not a client; this is investment in")
        print("  your own tooling/admin. Worth watching as a share of total capacity:")
        print(f"    {internal['hours'] / (tot_h + internal['hours']) * 100:.0f}% of all tracked hours in this window.")

    if unmapped_rev:
        print(f"\n  UNMAPPED REVENUE — collected but not attributable to a known client:")
        for k, v in sorted(unmapped_rev.items(), key=lambda x: -x[1])[:10]:
            print(f"    ${v:>10,.2f}  {k}")
        print("    (add an alias in the billing Clients tab / companies DB to attribute these)")

    if unmapped_hours:
        big = {k: v for k, v in unmapped_hours.items() if v >= 1}
        if big:
            print(f"\n  UNMAPPED HOURS — worked but not attributable to a known client:")
            for k, v in sorted(big.items(), key=lambda x: -x[1])[:10]:
                print(f"    {v:>8.1f}h  {k}")

    print("\n  Cash timing is lumpy — a quarterly payer looks unprofitable 2 months in 3.")
    print("  Use a 3+ month window before acting on any single row.\n")


if __name__ == "__main__":
    main()
