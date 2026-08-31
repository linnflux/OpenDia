"""Lint for Linnflux Social calendar rows. A failure is a gate, not advice.

Runs at Ready and again at PDF build; the build refuses on any error. Every rule
here cost someone real time once: stale relative-time phrases, a caption weekday
that did not match its date, rate language riding a brand post, a missing footer
line, two posts colliding on one date.
"""
import datetime as dt
import re

from sheet import drive_id

RATE_WORDS = re.compile(r"(%|\bAPY\b|\bAPR\b|\brates?\b)", re.I)
RELATIVE_TIME = re.compile(
    r"\b(tomorrow|yesterday|next (mon|tues|wednes|thurs|fri|satur|sun)day|"
    r"(one|two|three|\d+) (week|day)s? (to go|away|left)|week to go)\b", re.I)
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December"]
DATED_WEEKDAY = re.compile(r"\b(" + "|".join(WEEKDAYS) + r"),? (" + "|".join(MONTHS) + r") (\d{1,2})\b")


def lint(rows, cfg, include_rate):
    errs = []
    foot = cfg.get("footer_line", "").strip()
    seen_dates = {}
    for r in rows:
        tag = f"{r['ID'] or 'row ' + str(r['_row'])}"
        for f in ("Title", "Caption", "Post date", "Page", "Image", "Image state"):
            if not r[f].strip():
                errs.append(f"{tag}: {f} is empty")
        try:
            d = dt.date.fromisoformat(r["Post date"])
        except ValueError:
            errs.append(f"{tag}: Post date {r['Post date']!r} is not ISO (yyyy-mm-dd)")
            d = None
        if d:
            seen_dates.setdefault(d, []).append(tag)
            for wd, mon, day in DATED_WEEKDAY.findall(r["Caption"]):
                try:
                    said = dt.date(d.year, MONTHS.index(mon) + 1, int(day))
                except ValueError:
                    errs.append(f"{tag}: caption date '{mon} {day}' does not exist")
                    continue
                if WEEKDAYS[said.weekday()] != wd:
                    errs.append(f"{tag}: caption says '{wd}, {mon} {day}' but that date is a "
                                f"{WEEKDAYS[said.weekday()]}")
        cap = r["Caption"]
        if "—" in cap:
            errs.append(f"{tag}: caption contains an em dash")
        if foot and foot not in cap:
            errs.append(f"{tag}: caption is missing the footer line {foot!r}")
        if r["Type"] != "Rate" and RATE_WORDS.search(cap):
            errs.append(f"{tag}: non-Rate row uses rate language ({RATE_WORDS.search(cap).group(0)!r})")
        if r["Type"] == "Rate" and not include_rate:
            errs.append(f"{tag}: Type is Rate; rate posts ship in their own batch (or pass --include-rate)")
        m = RELATIVE_TIME.search(cap)
        if m:
            errs.append(f"{tag}: relative time phrase {m.group(0)!r} will go stale if the schedule moves")
        if r["Image state"] not in ("Final", "Placeholder"):
            errs.append(f"{tag}: Image state must be Final or Placeholder")
        if not drive_id(r["Image"]):
            errs.append(f"{tag}: Image is not a Drive link or file id")
        if r["Status"] == "Draft":
            errs.append(f"{tag}: still Draft; mark Ready (or Do Not Run) before building")
    for d, tags in seen_dates.items():
        if len(tags) > 1:
            errs.append(f"{d}: more than one post on the same date ({', '.join(tags)})")
    return errs
