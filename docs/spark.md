# Spark — the next-step tab on a project card

A card's **Details** tab shows stored fields, which are a snapshot rather than
state, and its **Terminal** tab mirrors a tmux session. Neither answers the
question actually being asked when a card is reopened after a gap: *what
changed, whose court is the ball in, and what is the next step?*

**Spark** is a third tab that sweeps every message front for the card, reports
one next step with a self-rated certitude number, and then offers to do the
next two or three things — one approval at a time, without dropping into a
session. Work it performs accrues to the card's timer.

```
  scanning ──▶ proposing ──▶ acting ──▶ proposing ──▶ … ──▶ wrapping ──▶ done
                  │  ▲                     │                    ▲
                  │  └─────────────────────┘                    │
                  └── all skipped / nothing to do ──────────────┘
```

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

## Actions and tiers

Each round proposes at most three actions. Each is approved or skipped
individually, and only the approved ones run.

- **Tier 1 — performed on approval.** Card updates, Notion updates, creating a
  Gmail **draft**, writing a handoff brief, opening a Room, read-only
  diagnostics, appending to the daily log.
- **Tier 2 — the dashboard performs it after a second, explicit click.** Only
  sending a drafted email. The pane renders the recipient, subject and full
  body; the Send button arms for three seconds before firing.
- **Tier 3 — never performed.** Anything over SSH or on a server, any write to
  a live client system, calendar events, anything financial or AR-related, and
  git commits or pushes. These become a **handoff** to a working session.

Handoff is always the last thing a run does: it writes a brief to
`~/OpenDia/handoffs/`, then closes the Spark timer so `/od-go` in that session
starts clean.

## How the tiers are actually held

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

The model therefore never holds the ability to send email. It drafts; a human
reads the exact text; the server sends.

Report text is derived from client email and chat and is rendered as markdown,
so every string is `<`-escaped server-side before it leaves the API — markdown
still works, HTML cannot.

## Timers

A Spark opens a timer on the card at a **15-minute estimate** — the cost of a
human diving back in to refresh themselves — and each completed action adds its
own minutes, up to a 60-minute pause where continuing becomes an explicit
decision. `estimated_minutes` is what bills, per the usual convention.

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
actions, 20 minutes per invocation, and a 30-minute idle wrap so a walked-away
decision never leaves a timer open.

## Known limitations

- **"Discuss in Terminal" only switches tabs.** It does not hand anything over:
  the session on the other side has no knowledge of the run. The findings are
  written to `~/OpenDia/handoffs/` only by the separate **Hand off to session**
  action, which also closes the Spark timer. Merging the two — write the brief,
  ensure a session exists, seed it — is the obvious next improvement.
- **Typing requires Take Control**, which opens a 30-minute timer. That is a
  heavy door for a short follow-up question about the recommendation.
- The email draft-and-send path is implemented but has not yet run end to end;
  no run on an internal card has proposed a draft.
- The non-admin gate is untested from a real non-admin identity — loopback is
  unconditionally admin, so it can only be exercised through Tailscale
  identity headers.

## Layout

| Path | Role |
|---|---|
| `dashboard/server/spark.js` | run registry, brief builder, spawn, stream parsing, SSE, timers, endpoints |
| `dashboard/server/timerfile.js` | the on-disk timer format, shared with `terminal.js` |
| `scripts/chat_helper.py` | read-only Google Chat client (headless) |
| `scripts/spark_guard.py` | PreToolUse guard hook |
| `dashboard/client/src/components/SparkPanel.jsx` | the pane |
| `dashboard/client/src/hooks/useSparkRun.js` | run state, owned by `CardModal` so it survives tab switches |
| `dashboard/client/src/hooks/useTypewriter.js` | the accelerating reveal |
| `~/.claude/commands/spark.md`, `spark-act.md` | the routines (outside this repo — they reference operator-private material) |

Transport is SSE, not a WebSocket: `terminal.js`'s upgrade handler destroys
every socket whose URL is not the terminal route, and approvals are ordinary
POSTs, so the channel genuinely only needs one direction. A connecting client
always receives a full snapshot first, which is why tab switches, modal closes
and page reloads all resume correctly.
