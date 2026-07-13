# OpenDia Billing — Operations

Two monthly billing pipelines exist and **both run every month through end
of 2026, by deliberate choice** — this is not a migration-in-progress with
a stale leftover. `/monthly-billing` is the older, simpler pipeline; the
richer `/billing-month` was added alongside it, not as a replacement.
Neither is scheduled to be retired this year.

| | `/monthly-billing` | `/billing-month` |
|---|---|---|
| Script | `scripts/monthly_billing.py` | `scripts/billing_month.py` |
| Sheet | **Billing Master 2026** (`1VowYnKQG...LFY`, `OpenDia` tab) | **Billing Operations** (`1irjs6n2X...OoOY`, `YYYY-MM` tab) |
| Data source | OpenDia timer files only | OpenDia timer files **+** Toggl Reports API (unified) |
| Extras | none | Square recurring revenue pulled into the Home tab; per-client customer-facing Notes column (AI-summarized) |
| Config source | none (client names resolved ad hoc) | `Clients` tab on the Billing Operations sheet (rate, retainer, aliases, contact) |
| In-dashboard push | Yes — Ctrl+K → Billing → *Push to Billing Master* (see below) | No — terminal only |

## Where time entries come from

Every billing run reads daily markdown files at
`~/OpenDia/Time/YYYY/MM/YYYY-MM-DD.md`. Each file holds one or more
`---`-delimited entry blocks, anchored by an HTML comment marker:

```yaml
<!-- entry:2026-07-10T09:22 -->
client: Acme Corp
project: Acme Website
division: WordFlux
task: WooCommerce product updates
estimated_minutes: 60
start: 2026-07-10T09:22
end: 2026-07-10T10:22
duration: 60m
billable: true
notes: |
  Updated variable product attributes via WP-CLI
  NEXT: confirm pricing with client
```

These files are written by `/od-go` + `/od-stop`, the dashboard's embedded
terminal (Take Control / Stop & Exit), and the inbox pipeline's automatic
timer entries (see [`inbox-pipeline.md`](inbox-pipeline.md)) — same format
regardless of origin.

**Billing is based on `estimated_minutes`, not wall-clock `duration`.**
`estimated_minutes` is what a competent professional would need for the
work described — the number that's actually billed. `duration` is the raw
elapsed time between `start` and `end` and is kept for internal reference
only (spotting under/over-estimation patterns, not for invoicing). Every
aggregation in both billing scripts, the dashboard's Analytics view, and
the `/api/analytics/week` endpoint sums `estimated_minutes`.

## The shared parser

Both scripts, plus `lonely_whistle.py`'s daily-summary logic, now import
`parse_entries_from_file` / `load_month_entries` from a single module,
**`repo/scripts/timeentry.py`** (symlinked into `~/OpenDia/scripts/`).

**Fixed 2026-07-12:** before this, `billing_month.py` and
`monthly_billing.py` each had their own hand-rolled line-by-line regex
parser (`^([a-z_]+):\s*(.*)`), and neither one handled the `notes: |` YAML
block scalar that every real timer entry uses — `entry['notes']` captured
the literal `"|"` token and nothing else. Every OpenDia timer line item
billed before that date shipped with an **empty Summary column** on both
sheets; the justified notes `/od-stop` and the inbox pipeline work hard to
produce never reached the client-facing audit trail.
`lonely_whistle.py` had its own correct implementation of the same parsing
logic the whole time — three copies of one format, disagreeing. There is
now exactly one parser; if you're adding a fourth consumer of timer files,
import `timeentry`, don't write a fifth regex.

If you need historical Summary data for months billed before the fix,
re-run the affected month(s) with `--write-sheet` (both scripts are
idempotent — they clear and rewrite their target tab).

## `/monthly-billing` flow

1. Preview: `python3 scripts/monthly_billing.py --month YYYY-MM` (stdout only)
2. Confirm with the Operator — **never writes without explicit confirmation**
3. Write: `python3 scripts/monthly_billing.py --month YYYY-MM --write-sheet`
4. AI fills the "Est. Hours" column (H) by reasoning over the Notes and Build
   Notes columns — the script can't generate this column itself
5. Verify by reading the tab back (`scripts/read_sheet.py`)

## `/billing-month` flow

1. Preview: `python3 scripts/billing_month.py --month YYYY-MM`
   — flags unmatched client names (need an alias added to the `Clients` tab
   before writing) and nonprofit rows (`companies.nonprofit` in SQLite,
   never derived from Square at runtime)
2. Confirm, then write: `python3 scripts/billing_month.py --month YYYY-MM --write-sheet`
3. Pull Square recurring revenue onto the Home tab:
   `python3 scripts/billing_square_recurring.py --month YYYY-MM --write`
   (all paid invoices with `-R-` in the invoice number, paid during the month)
4. AI generates customer-facing Notes (col L) from the OD timer detail table
   — strips internal jargon, merges duplicate tasks, excludes non-billable
   work, prepends `[NP]` for nonprofit rows
5. Operator fills in manually: Additional charges (col F), Build hours (cols
   G–J), reviews AI notes (col L), marks Sent (col M)

Re-running either script clears and rewrites its target tab/tab-set —
`/billing-month` re-runs also wipe the manual columns (F–J, L–M), so redo
Step 4's notes and warn the Operator about lost manual fills.

## In-dashboard billing (Ctrl+K → Billing, admin only)

- `GET /api/billing/preview` — shells out to
  `monthly_billing.py --month YYYY-MM --json` (dry-run) and returns
  per-client billable/non-billable minutes plus entry-level detail.
- `POST /api/billing/push` — **no longer a stub.** It shells out to
  `monthly_billing.py --month YYYY-MM --write-sheet` and returns the row
  count plus a link to the Billing Master 2026 sheet. The button in the UI
  is labeled *Push to Billing Master* — it only writes the **older**
  pipeline's sheet. There is no equivalent in-dashboard push for
  `/billing-month`'s Billing Operations sheet (Toggl unification, Square
  recurring, and the AI notes column all still require running
  `/billing-month` from a terminal).
- `PATCH /api/billing/entry` — toggles the `billable:` flag on a single
  timer entry directly from the Billing view (writes the daily `.md` file
  in place, matched by the `start:` marker). Useful for last-minute
  billable/non-billable corrections without opening the file by hand.

## Key rules

- **Always preview, always confirm before writing** — both CLI skills and
  the dashboard push are guarded; nothing writes silently.
- **`estimated_minutes` is the billing number.** Never bill off `duration`.
- **Both pipelines stay active through end of 2026.** Don't propose
  retiring `/monthly-billing` — Memory (`feedback_billing_dual_runs_2026.md`)
  and this doc both say run both.
- **One parser.** Any new script or dashboard route that reads timer files
  imports `timeentry.py` — do not add a sixth regex for this format.

## Toggl: the Reports API is gone (2026-07-13)

`/reports/api/v2/summary` — the endpoint both billing pipelines used for Toggl
hours — now returns **402 "feature is not included in current subscription
level"** on this workspace. Toggl also answers 402 when the free-tier quota is
exhausted, including on endpoints that worked minutes earlier, so **402 means
back off, never retry in a loop.**

Billing no longer dies on this. `get_toggl_monthly_hours()` falls back to
`scripts/toggl_hours.py`, which aggregates raw `/api/v9/me/time_entries` (free)
and caches results to `~/OpenDia/.toggl-hours-cache.json`. Past months never
change, so the cache is authoritative once written; it can be seeded from the
monthly billing tabs, which are workspace-wide.

**The catch, and it matters for billing:** `/me/time_entries` returns only the
token owner's entries. Against the June 2026 sheet, Toggl logged 234h that month
while a single token sees 134h — **roughly 100h/month belongs to another user.**
With one token, Toggl hours are UNDERSTATED and any $/hr or margin derived from
them is overstated.

Fix one of two ways:

1. Put **one token per user**, one per line, in `~/.toggl_tokens` (chmod 600).
   `toggl_hours.load_tokens()` sums across all of them.
2. Upgrade the Toggl plan to restore the workspace-wide Reports API.

Until then the code warns on every run rather than silently under-reporting.
Check coverage before a billing run:

```bash
python3 ~/OpenDia/scripts/toggl_hours.py 2026 06   # prints token count + warning
```

## Estimate audit — do the notes justify the bill?

`estimated_minutes` is the billing number: an approximation of how long the
completed work would take a competent human developer. Wall-clock is irrelevant.
What makes an estimate defensible is the NOTES.

```bash
python3 ~/OpenDia/scripts/estimate_audit.py --month 2026-06 --only thin
```

Grades each entry's notes against its billed minutes, three passes, reporting
only verdicts the passes agree on (a single pass is NOT stable). Flags `thin`
(notes don't account for the minutes — a billing risk) and `underbilled`. Run it
before a billing batch. A `thin` verdict means *go look at that entry*, not
*you over-billed* — often the work happened and the notes undersold it.
