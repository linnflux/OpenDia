# OpenDia Inbox Pipeline — Operations

Labeling a Gmail message **"OpenDia Inbox"** classifies it automatically. A
human then decides whether it actually runs — dispatch is an operator-gated
action from the dashboard, not an unattended cron step. This is a deliberate
change from the pipeline's original design: Stage A (classify) still runs
unattended every 5 minutes, but Stage B (spawn a Claude session) now only
runs when the Operator clicks Dispatch / Re-dispatch / Approve & Dispatch.

A second, unrelated pipeline (FluxCC lead intake, `intake-tick.sh` /
`intake_pipeline.py`) shares the same cron cadence and env file but has
nothing to do with Gmail — see [FluxCC intake](#fluxcc-intake-a-separate-pipeline)
below.

## Moving parts

| Component | What | Runs |
|---|---|---|
| `scripts/inbox-tick.sh` | Cron entry point. Loads `~/.config/opendia/inbox.env`, checks the `gmail.modify` OAuth scope, flock-guards against overlap, calls Stage A only | cron `*/5 * * * *` → `logs/inbox-YYYY-MM-DD.log` |
| `scripts/inbox_stage_a.py` | **Classify.** One dispatch unit per Gmail thread (not per message). Fetches the full thread, isolates the latest inbound (non-`SENT`) message, classifies it with Haiku (`classify_email.py`), matches or auto-creates a dashboard project, writes one `inbox_items` row (`status=classified`), inserts a JSON payload message under the `OpenDia Queue` Gmail label, and relabels the source thread `OpenDia Inbox` → `OpenDia Processed` | called by `inbox-tick.sh` |
| `scripts/inbox_stage_b.py` | **Dispatch.** Reads a queued item, builds the full prompt (context header + directive + preamble), spawns a detached `claude` tmux session, opens a time ledger entry, relabels `OpenDia Queue` → `OpenDia Dispatched`. Has a bare `run()` that would auto-dispatch everything in the queue, but **nothing calls it on a schedule** — see [Dispatch is manual](#dispatch-is-manual-not-automatic) | invoked only via `--redispatch <gmail_id>` or `--server-dispatch <gmail_id>`, both from dashboard routes |
| `scripts/check_mail_ingest.py` | On-demand ingest for a *specific* email the Operator already picked from the dashboard's Check Mail button — classifies and immediately dispatches (Mode A: inject into a live tmux session if `tmux_session` is set and alive; Mode B: spawn a new session otherwise). Bypasses Stage A's project-matching guesswork by using the project the Operator clicked from | `POST /api/projects/:id/ingest-email` (admin only) |
| `scripts/inbox-sweep.sh` | Kills `inbox-*` tmux sessions inactive >7 days (`session_activity`); attaching resets the clock | cron `0 3 * * 0` (Sun 3 AM) → `logs/inbox-sweep-YYYY-MM-DD.log` |
| Dashboard Inbox view | Triage queue for `inbox_items`; card modal exposes correction, Dispatch/Re-dispatch, Approve & Dispatch (server work), Dismiss | always (dashboard service) |

## Behavior rules

- **Classification is per-thread, not per-message.** All prior messages in a
  thread are passed to Haiku as context (capped at 3000 chars) so
  `prompt_text` reflects the whole conversation, not just the latest reply.
  All labeled messages in a thread relabel together — no duplicate dispatch
  from a multi-message thread.
- **Alias table overrides Haiku.** `client_aliases` (learned sender →
  client mappings) is checked before classification; corrections saved from
  the Inbox modal as "Save as alias" apply to all future mail from that
  sender without touching the model.
- **No match → auto-create.** If Stage A can't match an existing dashboard
  project, it creates one in `wfhuman` status ("Auto-created from inbox: …")
  and links the new `inbox_items` row to it.

### Dispatch is manual, not automatic

Stage A's job ends at `status=classified` plus a queued Gmail message. Stage
B's session-spawning code (`_dispatch_one` inside the bare `run()`) is fully
implemented and *would* auto-dispatch non-server items straight off the
`OpenDia Queue` label — but no cron job or webhook calls `run()`. In
production, every dispatch — first dispatch, re-dispatch, and server-work
approval — goes through one of two `requireAdmin` dashboard routes:

- **Non-server item:** Inbox modal shows **▶ Dispatch** while
  `status=classified`, or **↺ Re-dispatch** afterward. Both hit the same
  route, `POST /api/inbox/:id/redispatch` → `inbox_stage_b.py --redispatch
  <gmail_id>`. This kills any existing session, stub-closes a stale timer if
  one is open, and spawns fresh.
- **Server-work item:** flagged `requires_server_access` at classification
  time; the card shows an amber **SERVER** badge and never appears in the
  auto-dispatch path even if it existed. The Operator enters the target
  Lightsail instance and clicks **Approve & Dispatch** →
  `POST /api/inbox/:id/approve-server` (admin only) →
  `inbox_stage_b.py --server-dispatch <gmail_id>`, which runs with the
  stricter `SERVER_WORK_PREAMBLE` (must state and confirm the target
  instance, must take a Lightsail snapshot via `lightsail_snapshot.sh`
  before any write, stops and drafts a clarification reply instead of
  guessing).
- **FluxCC item:** `_fluxcc_kwargs()` selects the `FLUXCC_PREAMBLE` and a
  `~/FluxCC` working directory when `division_hint == "FluxCC"`, on every
  dispatch path (`_dispatch_one` and `--redispatch`). Server-access items
  still get `SERVER_WORK_PREAMBLE` regardless of division.
## OAuth scopes — the shared-token trap

The pipeline authenticates with the **same token file** as the Google Workspace
MCP (`~/.claude/mcp-credentials/google-workspace/tokens.json`). Two separate
consent flows write it:

- `scripts/inbox_setup_auth.py` → `NEW_SCOPES`
- the MCP's `src/google-client.ts` → `SCOPES`

**A consent from either side REPLACES the token's scopes wholesale.** Any scope
missing from the list that runs last is silently revoked. The two lists must stay
byte-identical unions; both carry a comment saying so.

This failed on **2026-07-27**: the MCP list lacked `gmail.modify`, a re-consent
dropped it, and Stage A could not relabel threads to `OpenDia Processed`. Every
tick failed for three days — 288 logged errors a day — and it surfaced only when
a labeled email visibly failed to appear. The same event downgraded `drive` to
`drive.readonly`.

`inbox_pipeline_warnings()` in `lonely_whistle.py` now checks the granted scopes
directly, so this class of failure is reported the same day even if no email is
labeled.

- **Approval gates in general:** `redispatch`, `approve-server`, `preview`
  (records a dev-branch preview URL), `approve-deploy` (merges a FluxCC dev
  branch to main and deletes it), and the Check Mail `ingest-email` route
  are all gated by `requireAdmin` — none of them are reachable by a
  non-admin `@linnflux.com` account, and none are reachable by an
  unauthenticated request except over loopback (local scripts).
- **`approve-deploy` is the highest-stakes route in this pipeline** — it
  runs `git merge`/`git branch -d`/`git push --delete` against
  Operator-approved input. Treat it as equivalent to a server-work approval:
  only click it once you've reviewed the preview URL.

### Time tracking

Every dispatch opens a time ledger entry identical in format to entries
created by `/od-go`, using Stage A's `estimated_minutes` as the initial
billed duration (revisable at close time; the justified notes must support
whatever number is left). Internal work (`client_hint: "Linnflux"`) is
`billable: false` and excluded from both monthly billing runs, same as
`/od-go` internal work. A non-zero exit from the spawned Claude session
stub-closes the timer automatically so nothing is left dangling.

### Error diagnosis and re-dispatch

The last 40 lines of a failed session's output are stored on the
`inbox_items` row and shown directly on the card. Re-dispatching prepends
any Operator notes as an `## Operator Correction` block ahead of the
original directive — the new session sees the correction as authoritative
context, not a footnote.

## Controls

- Pause Stage A: `touch ~/OpenDia/inbox.disabled` — messages stay labeled
  `OpenDia Inbox` and process on the next tick after the file is removed
- Resume: `rm ~/OpenDia/inbox.disabled`
- Replay a failed/skipped item: re-apply the `OpenDia Inbox` label in Gmail
- View session logs: `~/OpenDia/logs/sessions/<session-name>.log`
- View alias table: `python3 ~/OpenDia/scripts/inbox_db.py dump-aliases`
- Stub-close a stale timer manually:
  `python3 ~/OpenDia/scripts/inbox_db.py close-timer-stub <marker> <state_file> <ledger_file> <note>`

## Health checks

```bash
tail -30 ~/OpenDia/logs/inbox-$(date +%F).log     # today's Stage A activity
grep ERROR ~/OpenDia/logs/inbox-*.log | tail       # classification failures
crontab -l | grep inbox-tick                       # cron installed?
python3 -c "
import json
t = json.load(open('$HOME/.claude/mcp-credentials/google-workspace/tokens.json'))
print('gmail.modify' in t.get('scope',''))
"                                                    # OAuth scope still present?
```

A healthy tick logs `=== Tick start ===` / `Stage A: classify` /
`=== Tick complete ===` with no `ERROR` lines. Items stuck at
`status=classified` for a long time are not a failure signal by themselves —
they're waiting on the Operator to click Dispatch.

## Disaster recovery

1. Scripts (`inbox-tick.sh`, `inbox_stage_a.py`, `inbox_stage_b.py`,
   `inbox_db.py`, `gmail_helper.py`, `classify_email.py`,
   `check_mail_ingest.py`, `inbox-sweep.sh`) are unversioned in
   `~/OpenDia/scripts/` — survive box loss only via the nightly Drive backup
   (`migrate-export.sh`). They are not yet symlinked into the git repo the
   way `calendar_sync.py` is.
2. `~/.config/opendia/inbox.env` (holds `ANTHROPIC_API_KEY`) and OAuth
   tokens at `~/.claude/mcp-credentials/google-workspace/` ride the same
   nightly backup.
3. `ANTHROPIC_API_KEY` missing or `gmail.modify` scope missing: `inbox-tick.sh`
   exits 1 immediately and logs the fix (`inbox_setup_auth.py` for the OAuth
   case).
4. Stuck queue: an item can be re-run at any time by re-applying the
   `OpenDia Inbox` Gmail label (re-classifies from scratch) or, if already
   classified, by clicking Dispatch/Re-dispatch from the dashboard — no data
   is lost by a stalled tick, since nothing auto-expires out of the queue.
5. Crontab itself: `migrate-export.sh` backs it up; **`migrate-setup.sh`
   does not restore it** — after a full rebuild, re-add the inbox/intake/
   sweep cron lines by hand from the backed-up `crontab.backup`.

## FluxCC intake, a separate pipeline

`intake-tick.sh` / `intake_pipeline.py` runs on the same `*/5 * * * *` cadence
and shares `~/.config/opendia/inbox.env` for `ANTHROPIC_API_KEY`, but it has
no Gmail label trigger — it polls two Tally forms (`68QDQA` triage/lead,
`QKBRQl` deep intake) and runs an 8-stage new-client onboarding flow (design
research, Nick notification draft, git scaffold, Cloudflare Pages deploy,
hero image, final notification). Pause with `touch ~/OpenDia/intake.disabled`.
It does not touch the `inbox_items` table or the Gmail-based Inbox view —
don't conflate the two when troubleshooting either.
