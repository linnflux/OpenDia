#!/usr/bin/env python3
"""Audit billed estimates against the notes that are supposed to prove them.

THE MODEL THIS ENFORCES

  `estimated_minutes` is the billing number: an approximation of how long the
  completed work would take a competent human developer. Wall-clock elapsed time
  is irrelevant — an AI-assisted session compresses real time and says nothing
  about the value delivered.

  What makes an estimate defensible is the NOTES: the list of things actually
  done. If a client ever asks "what did I pay for," the bullets are the receipt.
  So estimate accuracy is not a clock question. It is: do the notes plausibly
  account for the minutes billed?

  That is a judgment, so we ask a model to make it — one entry at a time, with
  the same standard /od-stop is supposed to apply (roughly one substantive bullet
  per 10-15 minutes of billed work; no filler; named files, systems, outcomes).

WHAT IT FLAGS

  THIN        notes don't support the minutes billed — a billing risk. This is
              the one that matters: it is the entry you could not defend.
  UNDERBILLED notes describe materially more work than was billed — you left
              money on the table.
  OK          the bullets account for the estimate.

  A verdict is a prompt for YOU to look, not an accusation. Read the entry.

Usage:
  estimate_audit.py --month 2026-06
  estimate_audit.py --month 2026-06 --client "Acme Corp"
  estimate_audit.py --from 2026-05 --to 2026-06 --only thin
  estimate_audit.py --month 2026-06 --json
"""

import argparse
import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from timeentry import load_month_entries  # noqa: E402

CLAUDE = Path.home() / ".local" / "bin" / "claude"
BATCH = 8          # entries per model call — keeps prompts small and cheap
MODEL = "haiku"

PROMPT = """You are auditing time-entry billing integrity for a web-services firm.

Each entry has: the task, `estimated_minutes` (the number BILLED to the client),
and the notes (bullets describing work actually done).

`estimated_minutes` is NOT wall-clock time. It is an estimate of how long the
completed work would take a competent human developer. The notes must justify it.

Standard: roughly one substantive bullet per 10-15 minutes billed. A bullet like
"Investigated X, traced to Y, ruled out Z" can carry 15-20 minutes. A bullet like
"Fixed typo" carries ~2. Filler ("worked on the site"), restating the task, or
padding does NOT justify anything.

For EACH entry return a verdict:
  "ok"          — the bullets plausibly account for the minutes billed
  "thin"        — the notes do NOT support the minutes billed (billing risk)
  "underbilled" — the notes describe materially MORE work than was billed

Be conservative. Real engineering work is often denser than it reads; if the
bullets are specific and technical, lean "ok". Reserve "thin" for entries where
a client reading the notes would reasonably ask what they paid for. Entries with
NO notes at all are always "thin".

Also give `suggested_minutes`: what the notes actually justify, in your judgment.

Return ONLY a JSON array, one object per entry, in the same order:
[{"n": <entry number>, "verdict": "ok|thin|underbilled", "suggested_minutes": <int>,
  "reason": "<one short sentence>"}]

ENTRIES:
"""


def run_claude(prompt):
    p = subprocess.run(
        [str(CLAUDE), "-p", prompt, "--model", MODEL,
         "--permission-mode", "bypassPermissions", "--output-format", "json"],
        capture_output=True, text=True, timeout=300,
    )
    if p.returncode != 0:
        raise RuntimeError(f"claude exited {p.returncode}: {p.stderr[:200]}")
    envelope = json.loads(p.stdout)
    text = envelope.get("result", "")
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end == -1:
        raise RuntimeError(f"no JSON array in model output: {text[:200]}")
    blob = text[start:end + 1]
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        # A single malformed reason string used to lose the whole batch (8
        # entries silently unaudited). Salvage every object that does parse.
        salvaged = []
        for m in re.finditer(r"\{[^{}]*\}", blob):
            try:
                salvaged.append(json.loads(m.group(0)))
            except json.JSONDecodeError:
                continue
        if not salvaged:
            raise
        return salvaged


def audit_batch(entries, offset):
    lines = []
    for i, e in enumerate(entries, start=1):
        notes = e["notes"].strip() or "(NO NOTES)"
        lines.append(
            f"--- ENTRY {i}\n"
            f"client: {e['client']}\n"
            f"task: {e['task']}\n"
            f"estimated_minutes (BILLED): {e['estimated_minutes']}\n"
            f"notes:\n{notes}\n"
        )
    verdicts = run_claude(PROMPT + "\n".join(lines))
    out = {}
    for v in verdicts:
        idx = int(v.get("n", 0)) - 1
        if 0 <= idx < len(entries):
            out[offset + idx] = v
    return out


def months_in(a, b):
    y, m = map(int, a.split("-"))
    ty, tm = map(int, b.split("-"))
    out = []
    while (y, m) <= (ty, tm):
        out.append((y, m))
        m = m + 1 if m < 12 else 1
        if m == 1:
            y += 1
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--month", help="YYYY-MM")
    ap.add_argument("--from", dest="from_ym")
    ap.add_argument("--to", dest="to_ym")
    ap.add_argument("--client", help="only this client")
    ap.add_argument("--only", choices=["thin", "underbilled"], help="show only this verdict")
    ap.add_argument("--passes", type=int, default=3,
                    help="grade each entry N times; only agreed verdicts are reported (default 3)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    today = date.today()
    if args.month:
        months = months_in(args.month, args.month)
    elif args.from_ym:
        months = months_in(args.from_ym, args.to_ym or f"{today.year:04d}-{today.month:02d}")
    else:
        months = months_in(f"{today.year:04d}-{today.month:02d}", f"{today.year:04d}-{today.month:02d}")

    entries = []
    for y, m in months:
        entries.extend(load_month_entries(y, m, skip_internal=False))
    entries = [e for e in entries if e["estimated_minutes"] > 0]
    if args.client:
        needle = args.client.lower()
        entries = [e for e in entries if needle in e["client"].lower()]

    if not entries:
        print("No billed entries in that range.")
        return

    print(f"  Auditing {len(entries)} entries × {args.passes} passes "
          f"({(len(entries) + BATCH - 1) // BATCH * args.passes} model calls)...", file=sys.stderr)

    # A single grading pass is NOT stable: re-running the same entries with the
    # same prompt produced materially different verdicts (36 vs 40 thin, and not
    # the same entries). So grade each entry several times and only report a
    # verdict the passes AGREE on. Entries where the passes disagree are
    # "unsure" — reported as such, never counted as a finding.
    passes = []
    for pass_n in range(args.passes):
        got = {}
        for i in range(0, len(entries), BATCH):
            chunk = entries[i:i + BATCH]
            try:
                got.update(audit_batch(chunk, i))
            except Exception as e:
                print(f"  pass {pass_n + 1}, batch at {i} failed: {str(e)[:100]}", file=sys.stderr)
        passes.append(got)
        print(f"  pass {pass_n + 1}/{args.passes}: {len(got)}/{len(entries)} graded", file=sys.stderr)

    verdicts, unsure = {}, 0
    for i in range(len(entries)):
        got = [p[i] for p in passes if i in p]
        if not got:
            continue
        votes = [g.get("verdict") for g in got]
        winner = max(set(votes), key=votes.count)
        if votes.count(winner) < (len(votes) // 2 + 1) or (
                len(votes) > 1 and votes.count(winner) == len(votes) - votes.count(winner)):
            unsure += 1
            continue
        agreeing = [g for g in got if g.get("verdict") == winner]
        mins = sorted(g.get("suggested_minutes") or 0 for g in agreeing)
        verdicts[i] = {
            "verdict": winner,
            "suggested_minutes": mins[len(mins) // 2],
            "reason": agreeing[0].get("reason", ""),
            "agreement": f"{votes.count(winner)}/{len(votes)}",
        }

    unaudited = len(entries) - len(verdicts) - unsure

    rows = []
    for i, e in enumerate(entries):
        v = verdicts.get(i)
        if not v:
            continue
        rows.append({
            "date": e["date"], "client": e["client"], "task": e["task"],
            "billed_minutes": e["estimated_minutes"],
            "suggested_minutes": v.get("suggested_minutes"),
            "verdict": v.get("verdict", "?"),
            "reason": v.get("reason", ""),
            "agreement": v.get("agreement", ""),
            "internal": e["client"].strip().lower() == "linnflux",
        })

    if args.only:
        rows = [r for r in rows if r["verdict"] == args.only]

    if args.json:
        print(json.dumps(rows, indent=2))
        return

    span = f"{months[0][0]}-{months[0][1]:02d}" + (
        f" → {months[-1][0]}-{months[-1][1]:02d}" if len(months) > 1 else "")
    thin = [r for r in rows if r["verdict"] == "thin"]
    under = [r for r in rows if r["verdict"] == "underbilled"]
    ok = [r for r in rows if r["verdict"] == "ok"]

    print(f"\n{'='*92}")
    print(f"  Estimate audit — {span}   (do the notes justify what was billed?)")
    print(f"{'='*92}")
    print(f"  {len(ok)} defensible · {len(thin)} thin · {len(under)} underbilled "
          f"(of {len(rows)} audited)")
    if unsure:
        print(f"  {unsure} entr{'y' if unsure == 1 else 'ies'} the passes disagreed on — "
              f"not counted either way (re-run or read them yourself).")
    if unaudited:
        print(f"  !! {unaudited} entr{'y' if unaudited == 1 else 'ies'} could NOT be audited "
              f"(model error) — not counted above.")
    print()

    def show(title, group, note):
        if not group:
            return
        print(f"  {title}")
        print(f"  {note}")
        print(f"  {'-'*88}")
        for r in sorted(group, key=lambda r: -(r["billed_minutes"])):
            sug = r["suggested_minutes"]
            delta = f"{r['billed_minutes']}m billed → notes support ~{sug}m" if sug is not None else f"{r['billed_minutes']}m billed"
            agree = f"  [{r['agreement']} passes]" if r.get("agreement") else ""
            print(f"   {r['date']}  {r['client'][:24]:<24} {delta}{agree}")
            print(f"              {r['task'][:70]}")
            print(f"              → {r['reason']}")
        print()

    show("THIN — could you defend these to the client?",
         thin, "The notes do not account for the minutes billed. Look before the next invoice.")
    show("UNDERBILLED — you left money on the table",
         under, "The notes describe more work than was billed.")

    # Internal work is not billed to anyone, so mixing it into the totals hides
    # the only number that matters: whether CLIENT hours are defensible.
    print(f"  {'':<22} {'entries':>7} {'ok':>4} {'thin':>5} {'under':>6} {'billed':>8} {'supported':>10}")
    print(f"  {'-'*72}")
    for label, group in (("CLIENT-BILLED", [r for r in rows if not r["internal"]]),
                         ("INTERNAL (not billed)", [r for r in rows if r["internal"]])):
        if not group:
            continue
        b = sum(r["billed_minutes"] for r in group) / 60
        sp = sum((r["suggested_minutes"] or r["billed_minutes"]) for r in group) / 60
        print(f"  {label:<22} {len(group):>7} "
              f"{sum(1 for r in group if r['verdict']=='ok'):>4} "
              f"{sum(1 for r in group if r['verdict']=='thin'):>5} "
              f"{sum(1 for r in group if r['verdict']=='underbilled'):>6} "
              f"{b:>7.1f}h {sp:>9.1f}h  ({sp-b:+.1f}h)")
    print("\n  A verdict is a prompt to look, not a verdict on you. Read the entry.")
    print("  Only verdicts the passes agreed on are shown.\n")


if __name__ == "__main__":
    main()
