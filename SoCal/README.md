# Linnflux SoCal

Sheet-driven social media framework: one Google Sheet per client is the single
source of truth for a monthly batch-approval calendar; everything else — review
PDFs, graphics, scheduled posts, permalinks — is derived from it by the tools in
this directory.

Born from a one-off campaign approval flow that took a batch from draft to full
client sign-off in under a day. The design goal is that the approval step stays
that easy and the rest of the process is boring.

## Architecture

One spreadsheet per client, three tabs:

- **Calendar** — one row per post, keyed by a stable sequential ID (never a row
  number). 21 columns: dates (ISO only; weekday is a protected formula), title,
  type, page, channels, status, caption, image link, approval and compliance
  stamps, permalink.
- **Batches** — one row per approval cycle (`YYYY-MM`), carrying the PDF
  version/link, send date, stakeholders, approval dates.
- **Config** (hidden) — every client fact the tools need: names, footer line,
  pages, channels, brand colors, Drive folder ids, cadence, Meta asset ids,
  and `image_style` (the house description of what this client's post imagery
  looks like — a stock-photo brief for one client, an art-direction prompt for
  another). The code reads this tab, never hardcoded constants.

Status lifecycle: `Draft → Ready → Under Review → Changes Requested/Approved →
Scheduled → Published`, plus `Do Not Run`. `Published` requires a permalink and
a date.

## Tools

| File | Job |
|---|---|
| `sheet.py` | Schema constants, tab reads by header name, `guarded_write` (assert current value, write, read back — no blind overwrites) |
| `lint.py` | The build gate (see below) |
| `init_sheet.py` | Idempotent tab creator for a new client sheet: `--sheet ID --pages "..." --channels "..."` |
| `review_pdf.py` | Builds the client review PDF for one batch: `--sheet ID --batch YYYY-MM --out DIR [--upload]`. Uploads to Drive IN PLACE (same file id forever) and records version+link on Batches |
| `publish.py` | `schedule`: turns Approved rows into natively scheduled Facebook posts. `tick`: timer-driven; publishes Instagram at post time, backfills permalinks, flips rows to Published |
| `sampler.py` | Sales samples from nothing but a prospect's domain: brand extraction (rendered-page + logo pixel dominants; CSS is fallback only), model-drafted captions, finished cards in their palette/logo. `--accent/--ink/--bg` operator overrides. Every card is audited before a prospect sees it |

Per-client wrappers, output dirs, and graphics templates live OUTSIDE this repo
(this repo is public and carries zero client identifiers; a pre-commit guard
enforces it).

## Lint (a gate, not advice — the build refuses on any error)

Missing fields; non-ISO dates; a caption weekday that doesn't match its date;
em dashes; a missing footer line; rate/APY language outside a dedicated rate
batch; relative-time phrases that go stale ("one week to go"); duplicate dates
in a batch; placeholder images heading to Scheduled; rows still in Draft.

## Publishing (Meta Graph API)

- Auth: a Business Manager **system user token** (never expires), app kept
  permanently in dev mode — own-asset automation needs no app review. Token
  path comes from Config (`meta_token_path`), default
  `~/.claude/mcp-credentials/meta/access_token`.
- Facebook: photo posts scheduled natively (`published=false` +
  `scheduled_publish_time`; the API accepts 10 minutes to 75 days out).
- Instagram: the API has no scheduler and accepts **JPEG only** via a
  **public image URL** — so every PNG master gets a JPEG twin, and a 5-minute
  timer (`tick`) publishes at the scheduled moment, then writes the permalink
  and Published status back to the sheet.
- PDF integrity guard counts embedded image XObjects against the post count
  (a byte-size floor false-alarms on flat-color graphics).

## Rules the code assumes

1. The sheet wins every disagreement; derived artifacts are rebuilt, never edited.
2. All sheet writes go through `guarded_write`.
3. Drive files update in place by id; links already shared keep resolving.
4. Post IDs are sequential and never reused.
5. Nothing here sends email. Approval happens on a human's email thread (or in
   person); the operator relays verdicts into the sheet.
