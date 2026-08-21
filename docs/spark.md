# Spark and the Planroom — the Plan stage of PlanRunMail

OpenDia's working loop is **Plan → Run → Mail**, with mail arriving restarting
it. A **Runroom** is a plan walked by a live session (Run). The **Mailroom** is
where mail lands and turns back into plans (Mail). **Spark** is the verb that
produces a plan, and the **Planroom** is where that plan stands: one per card,
in the room layout, beside Runrooms in the nav. "Spark a planroom."

## Spark — the next-step scan on a project card

A card's **Details** tab shows stored fields, which are a snapshot rather than
state, and its **Terminal** tab mirrors a tmux session. Neither answers the
question actually being asked when a card is reopened after a gap: *what
changed, whose court is the ball in, and what is the next step?*

**Spark** is a third tab that sweeps every message front for the card and
answers exactly that, in four parts: where the project stands, what has happened
lately, **one** next step, and how much to trust it. Then it offers to get that
step done — carrying it out here, or opening a runroom for a human. Work it
performs accrues to the card's timer.

One step, not a menu. An earlier version proposed up to three tiered actions,
which left the operator doing the deciding Spark was supposed to do. With a
single recommendation there is nothing to rank, and the only open question is
who carries it out — which is one field, not a per-action tier.

```
  scanning ──▶ proposing ──▶ acting ──▶ proposing ──▶ … ──▶ wrapping ──▶ done
                  │  ▲                     │                    ▲
                  │  └── do / adjust ──────┘                    │
                  └── not now / runroom / nothing left ─────────┘
```

The report also **writes its recommendation to the card**. `card_next_step` goes
straight into `projects.next_step` when the scan finishes, and again after every
round. That used to require a human clicking Apply at the bottom of a long
scroll, which meant a report that named the right next step routinely failed to
put it anywhere anyone would see it.

## What it checks

Six fronts, each ending in an explicit state — `checked`, `skipped` or
`unavailable`. A front is never silently omitted, because an unread front costs
certitude.

| Front | Source |
|---|---|
| Work sessions | the card's recent timer entries |
| Notion task | status, due date, last edit, Responsible, the to-do tree |
| Email | an adaptive-lookback company search, plus a real-address bidirectional read and an `in:draft` check |
| Google Voice | Gmail relay mail, gated on the card notes with a fallback probe |
| Google Chat | read through `scripts/chat_helper.py`, gated on a named teammate |
| Artifacts | working-directory mtimes against the last-touch date |

The server pre-fetches the first three into a brief before the model starts —
about two seconds of Node instead of ninety seconds of agent turns, and it
keeps the MCP servers off the critical path. If every MCP on the box is broken,
Spark still produces four of six fronts.

## Certitude

Rated 0-100 with a reason that must name the specific unknown. The rubric is
banded (90+ verified in a dated artifact, 70-89 one stale front or an inferred
fact, 45-69 fronts disagree or a decisive one is unreadable, under 45 inference
from the card alone), and at least 15 points come off for every front that
could not be read. Without an anchor like that, a model returns 80 for
everything.

## The decision: one step, one route

The step carries a `route`, **named rather than numbered** — the model has to
emit the field from a routine it read once, and `"human"` is self-describing
where `3` was a mapping it had to recall. Anything unrecognised resolves to
`"human"`, since guessing toward `"opendia"` would point automation at work that
should have had a person in front of it.

- **`"opendia"` — the dashboard does it on approval.** Card updates, Notion
  updates, creating a Gmail **draft**, writing a handoff brief, opening a Room,
  read-only diagnostics, appending to the daily log.
- **`"human"` — becomes a runroom.** Anything over SSH or on a server, any write
  to a live client system, calendar events, anything financial or AR-related,
  git commits or pushes, and anything needing a judgement call.

The route decides which button appears, so the panel never offers a choice about
*how* on top of the choice about *whether*:

| Button | When | What happens |
|---|---|---|
| **Do it** | `route: "opendia"` | An act round carries the step out; its minutes accrue to the timer. |
| **Open a runroom** | `route: "human"` | §Runrooms below. |
| **Adjust** | always | Nothing is performed. The typed correction outranks the recommendation, and a revised step comes back. |
| **Not now** | always | Closes the run, billing what it accrued. |

**Certitude changes the emphasis.** Below 60 — where the rubric says fronts
disagreed or a decisive one could not be read — the panel demotes the acting
button and makes **Adjust** primary, because a step Spark is not confident in is
one to correct rather than point automation at. It is a visual gate, not a lock;
the server ships the threshold so both surfaces agree on one number.

Sending email is not a route. Spark's outbound responsibility ends at the Gmail
draft; the pane renders recipient, subject and body only as a read-back, and a
human sends from Gmail. An earlier version had a middle tier for exactly that
and it was removed rather than kept.

Runs archived before schema 2 carry per-action tiers (`performed`/`handoff`, or
integers `1`/`2`/`3` from before that). They are coerced on read — `performed`
and `1` to `opendia`, everything else to `human` — so old reports still render.

## The Planroom — one standing plan per card

Every validated scan writes `~/OpenDia/planrooms/<cardId>/plan.json` — and
rewrites it after every round — so the file always says what Spark believes
right now. ODA sweeps call the same scan, so every card an agent touches gets a
planroom for free (`sparked_by: "agent:<slug>"`).

- **Own root, keyed by card.** Not under `~/OpenDia/spark/<card>/` — the ODA
  "last scanned" signal is the mtime of everything there. Not under
  `~/OpenDia/runrooms/` — that root means "one dir = one tmux session".
- **Runroom-v1 schema plus an extension.** The room renderers draw it untouched;
  `room_type: "planroom"` and a `planroom: {spark_run_id, sparked_at, sparked_by,
  certitude, where_it_stands, recent[], risk, fronts[], route, …}` block carry
  the report. `status` is `active` or `adopted`.
- **A scan replaces the plan; rounds within a run accumulate.** `steps[]` is a
  pure function of the run — each outcome a round produced, then the open next
  step as `current`. Spark's claim is *what to do next, now*; a step from last
  week's scan was not re-verified by this one. The previous plan is archived as
  `plan-<created>.json`; history is `recent[]` plus the run archive.
- **No session, no composer.** A room's entire read surface works from
  `plan.json` alone; only buttons, composer and dialog need tmux. A planroom is
  plan-only until handed to Run.
- The **card-modal Spark tab is a doorway**: certitude, the open step, "Open
  Planroom", "Spark now". All decisions happen in the Planroom. `?tab=spark`
  still lands there; `?planroom=<id>` lands on the view directly.

Routes (`dashboard/server/planrooms.js`, read-only like `runrooms.js`):
`GET /api/planrooms` (the working set — live cards sparked within 7 days;
`?all=1` for everything), `GET /api/planrooms/:cardId` (plan + live run +
runroom read-through), `POST /api/planrooms/:cardId/adopt` (open a runroom
from the standing plan with nothing live), `POST /api/planrooms/:cardId/park`
(dismiss until a date). The only writer is `planroom_build.js`, mirroring
`runroom_build.js`.

### Recheck mode — a scheduled card is not re-litigated

A card whose `next_step` date has not arrived — or whose plan is parked — has
a standing plan that was approved as-is. `startScan` flips such a run to
**recheck mode** automatically (the gate lives in the server, so the tab, ODA
sweeps and the mailroom edge all obey it): the brief carries
`mode: "recheck"` plus the standing plan's summary, the email lookback narrows
to "since the last spark", and the run's only question is *did anything
change?* Nothing new → the run writes `{no_change: true}` and ends: **no plan
rewrite, no card write, no proposal, no timer entry**. The only trace is a
`planroom.checked` stamp. Something genuinely new → the run escalates into a
full scan and the fresh result replaces the plan as usual.

### Parked — "nothing to do before then"

**Park until \<date\>** (the next_step's own date — parking never needs a date
picker) sets the plan to `status: "parked"` with `parked: {until, at, by}` and
removes it from the working set. If a proposal is live, parking closes it the
way "Not now" does, folded into the one gesture. Three things wake a parked
plan: the date arriving (the **Planroom Wake** ODA duty — `roster_mode:
"parked"` — rechecks each parked plan on its due date, so it reappears
verified rather than stale; it rides Carlos's supervisor heartbeats, which
now fall through to the duty loop when the review queue is quiet), a recheck
finding new communication, or a full scan replacing the plan. A wake that
comes back clean unparks the plan in place with a "rechecked, no change"
note.

## Runrooms — a runroom adopts the plan

A `human` step is not a dead end. **Open a runroom** — from a live spark or from
the standing plan — makes a runroom **adopt** the card's plan, opens a session
on it, and gets out of the way:

1. Resolve a free tmux session name (the card's, or a slug of its name, with
   dispatch_spawn.sh's `-2, -3` collision convention).
2. Write the handoff brief to `~/OpenDia/handoffs/<session>.md` — including
   the **`## On start`** section: `Run: /od-go <card>` then "read plan.json,
   you are adopting it, not seeding it". (`dispatch_spawn.sh` prompts every
   session with "start with the On start command"; before this the brief had
   no such section and Spark-opened sessions booted with no timer and no
   instruction.)
3. **Copy** the planroom plan into `~/OpenDia/runrooms/<session>/plan.json`
   with `tmux_session` set and `adopted_from: {planroom_card_id, spark_run_id,
   at}`, archiving any existing plan first. Rewrite the planroom file as a
   **pointer**: `status: "adopted"`, `adopted_by`. The runroom file is now the
   only live document; the Planroom page **reads through** to its steps.
4. **Close the Spark timer** (if the run had one), committing its accrued
   minutes.
5. Spawn the session via `scripts/dispatch_spawn.sh` (opusplan, plan mode).
6. Point the card's `tmux_session` at it.

Copy, not move — a move makes the card vanish from the Planroom list and leaves
the next spark nothing to archive. Copy, not symlink — a symlink would let the
next spark overwrite the *live* runroom plan through it. A rescan on an adopted
card archives the pointer and writes a fresh plan, but **carries `adopted_by`
forward while that runroom is still active** — an ODA scan must not sever the
link to a room someone is working in.

**Step 4 comes before step 5 and that ordering is the whole function.** The
`/runroom` contract says room work bills to the timer the session already runs
and never opens a second one, so Spark's entry has to be closed before a session
exists that could start one of its own. Spawn first and every runroom
double-bills the card. The cost of that ordering is that a spawn failure leaves
the run already wrapped up — which is the right way round: the report is on disk
in history, the minutes are billed honestly, and retrying costs one click.

The name is resolved *before* anything is written because the plan lives in a
directory named after the session. If something claims the name between the
check and the spawn, `relocatePlan` moves the plan to the name the spawn
actually took, and refuses if that would overwrite a live plan.

`runrooms.js` stays read-only — the writer lives in its own
`dashboard/server/runroom_build.js`.

## How the routes are actually held

Prompt instructions are not enforcement. Two mechanisms, both verified against
the CLI on this machine:

1. **`--disallowedTools`** removes a tool from the session outright, and it
   holds even under `--permission-mode bypassPermissions`. (`--allowedTools`
   does *not* restrict — it is additive to `settings.json`, which already
   permits Bash.) `Agent` and `Workflow` are always denied too, because a
   subagent is otherwise a way to recover a blocked tool.
2. **A PreToolUse guard hook** (`scripts/spark_guard.py`, injected per run via
   `--settings`) fences the shell, which has no tool name to deny. It refuses
   outbound mail, remote systems, client infrastructure, service changes, git
   writes, destructive local commands, and any file write outside the run
   directory. Every refusal is logged to the run's `guard.log`.

The model therefore never holds the ability to send email — and neither does
the dashboard. `gmail_send` is denied in both phases, the guard hook blocks the
shell equivalents, and there is no send route on the server. The only outbound
artifact Spark produces is a Gmail draft.

Report text is derived from client email and chat, so it is treated as data
throughout. It is **not** escaped server-side: the panel renders every field as
a JSX text node, which React escapes, while the report's other consumers are all
plain text — the handoff brief, the runroom plan's detail pane, the timer notes,
and `next_step` on its way into SQLite. Escaping at the source corrupted every
one of those (a brief once read `~/OpenDia/runrooms/&lt;session>/plan.json`).
Escape at the render boundary, not at the source; if a future surface renders a
report as HTML, that surface escapes it.

## Timers

A Spark opens a timer on the card at a **15-minute estimate** — the cost of a
human diving back in to refresh themselves — and each step carried out adds its
own minutes, up to a 60-minute pause where continuing becomes an explicit
decision. `estimated_minutes` is what bills, per the usual convention, and
`setEntryEstimate` rewrites it in **both** the markdown entry and the state
file, so a run recovered after a restart does not fall back to the base estimate
and lose what it accrued.

Two details that matter:

- The timer starts **lazily**, on the first completed front. A run that dies in
  its first twenty seconds leaves no entry in the ledger at all.
- Its state file carries an **empty `tmux_session`** on purpose.
  `findTimerForSession` matches on that field, so a named session would make
  the Terminal tab's Take Control skip starting its own timer and let real work
  bill against the Spark entry. The card still shows as active, because
  `/api/timers/active` reconciles by client/division/task.

A card that already has a running timer never gets a second one — the accrual
goes to the existing entry instead.

## Configuration

| Env (dashboard `.env`) | Default | Meaning |
|---|---|---|
| `SPARK_MODEL` | `opus` | model for both phases |
| `SPARK_BUDGET_USD` | `3.00` | per-invocation ceiling |
| `SPARK_MAX_CONCURRENT` | `2` | concurrent runs across all cards |
| `SPARK_LOG_NOTION` | `true` | append the timer to the linked Notion task |

Runs cost roughly $0.90-1.00 each on Opus. Hard limits: 4 rounds, 8 executed
steps, 20 minutes per invocation, and a 30-minute idle wrap so a walked-away
decision never leaves a timer open.

## Closing a run, and never being stranded

A Spark holds the card's timer open while it waits for a decision, which is
correct — the engagement is not over until the proposals are answered. But
because the state file carries a blank `tmux_session`, **`/od-stop` in a
terminal can never close it.** Three things make that safe:

- The result pane says plainly that it is holding an *N*-minute timer and
  counts down to when it lets go, with a **Done — close timer** button beside
  it. Closing a run that already produced its report bills what it accrued;
  abandoning a sweep mid-flight is a cancel and rewrites the estimate down to
  actual.
- **Discuss in Terminal writes the handoff brief and closes the timer** before
  switching tabs. Moving the conversation to a session means Spark is finished.
- If nothing is decided, the run wraps itself up after 30 minutes.

If the dashboard stops while a run is open, the run is **recovered at boot**
rather than lost: the report is already on disk and the Claude session is
resumable by id, so the pending proposals come back and can still be approved.

A run that died mid-sweep cannot be recovered — there is no report — so it is
recorded instead. At boot, every run directory holding a brief but no outcome
gets an `interrupted.json` reconstructed from the `@@SPARK` markers still in
its own log, which is how history can say *"interrupted after 2 of 6 fronts"*.
That sweep is deliberately **not** driven by timer files: a run that starts
while the card already has a timer never opens one of its own, so a
timer-driven sweep would leave exactly those runs invisible.

An interrupted run **bills nothing**. It produced no recommendation, so the
entry stays in the ledger at zero as a record of what happened.

The pane notices too. The SSE keepalive is a named `ping` event rather than a
bare comment — comments keep the socket warm but fire nothing in
`EventSource`, so a dead stream used to be indistinguishable from a quiet one
and the checklist would sit frozen looking like a hang. Any frame resets a
50-second watchdog; a reconnect that finds no run, a terminal socket close, or
watchdog expiry all flip the pane to an explicit *interrupted* state showing
how far it got.

## History

Every run is kept forever under `~/OpenDia/spark/<card>/<run>/` — the brief,
the raw stream, the round files, and `result.json`. The idle pane shows the
most recent report and lists the earlier ones; any of them can be reopened, and
the footer's **History** button reaches the same list from a finished run.

`result.json` is rewritten after every round, so a run's file records what it
**concluded** rather than what it first guessed — which is also what recovery
re-offers after a restart. The round files are read back at the same time, so a
recovered run does not get four fresh rounds on top of the ones already spent,
and its timer notes keep the bullet for every step actually carried out.

## Known limitations

- **Typing in the Terminal tab requires Take Control**, which opens a
  30-minute timer. That is a heavy door for a short follow-up question about a
  recommendation.
- The non-admin gate is untested from a real non-admin identity — loopback is
  unconditionally admin, so it can only be exercised through Tailscale
  identity headers.
- A spawned runroom session's brief now ends with a **Runroom contract**: on
  plan approval the session rewrites the seeded `plan.json` into its real
  steps and keeps the file current at every transition (file before prose),
  setting `status: "done"` at wrap-up. The room also surfaces drift — a
  "steps updated N ago" readout warns when a working session isn't keeping
  the file current — and the dialog card can expand the pane content behind
  any approval, so a plan is never approved sight-unseen.

## Layout

| Path | Role |
|---|---|
| `dashboard/server/spark.js` | run registry, brief builder, spawn, stream parsing, SSE, timers, endpoints |
| `dashboard/server/timerfile.js` | the on-disk timer format, shared with `terminal.js` |
| `scripts/chat_helper.py` | read-only Google Chat client (headless) |
| `scripts/spark_guard.py` | PreToolUse guard hook |
| `dashboard/client/src/components/SparkPanel.jsx` | the pane |
| `dashboard/server/planroom_build.js` | the only writer of a planroom; `adoptIntoRunroom` moves a plan into a room |
| `dashboard/server/planrooms.js` | planroom routes (read-only + adopt) |
| `dashboard/client/src/components/Planroom.jsx` | the Planroom view — runroom shell around the spark report |
| `dashboard/client/src/components/SparkDoorway.jsx` | the card-modal tab, reduced to a doorway |
| `dashboard/server/runroom_build.js` | session resolution + spawn; `writeSeedPlan` superseded by adoption |
| `scripts/dispatch_spawn.sh` | spawns the tmux session a runroom binds to |
| `dashboard/client/src/hooks/useSparkRun.js` | run state, owned by `CardModal` so it survives tab switches |
| `~/.claude/commands/spark.md`, `spark-act.md` | the routines (outside this repo — they reference operator-private material) |

Transport is SSE, not a WebSocket: `terminal.js`'s upgrade handler destroys
every socket whose URL is not the terminal route, and approvals are ordinary
POSTs, so the channel genuinely only needs one direction. A connecting client
always receives a full snapshot first, which is why tab switches, modal closes
and page reloads all resume correctly.
