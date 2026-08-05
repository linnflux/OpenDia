# Claude Session Reaper — Operations

Kills interactive Claude Code TUI sessions untouched for 72h to reclaim
memory (~450MB per TUI). Sessions predating the move to [shared MCP
daemons](mcp-daemons.md) also carry ~350MB of stdio MCP children; sessions
started after it carry none, so reaping them frees correspondingly less.
Nothing is lost: transcripts are written incrementally, so any reaped
session comes back in full with:

```bash
claude --resume SESSION_NAME
```

## Moving parts

| Component | What | Runs |
|---|---|---|
| `scripts/claude_session_reaper.py` | Detection + kill + tmux breadcrumb | cron `45 */6 * * *` → `logs/session-reaper.log`; manual anytime |
| `~/OpenDia/.reaper-keep` | Optional pin file — one session name per line, `#` comments | read each run |
| Lonely Whistle `reaper_warnings()` | Alerts if no run in >8h or last run crashed | daily 5 PM email |

## Detection

A session's idle age is `now − max(session-json updatedAt, transcript
mtime)`. The transcript mtime matters: a session with a live background job
gets notifications appended to its transcript, which keeps it "fresh" —
that's deliberate (don't reap a parent whose bg work is still reporting in).

Sources: `~/.claude/sessions/<pid>.json` (name, kind, status, updatedAt)
and `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` (transcript).

## Protections (never reaped)

- `kind != interactive` — bg jobs, daemon, bg-spare/pty-host processes
- `status` busy/shell — actively working (logged as `POSSIBLY-HUNG` if
  that status is itself >72h old, but never killed)
- name referenced by an active timer state file (`Time/.timer-*.json`) —
  open engagement
- its tmux session is currently attached
- name listed in `~/OpenDia/.reaper-keep`
- the reaper's own ancestor processes
- pid-reuse guard: `/proc` starttime must match the session file's
  `procStart`

## Kill behavior

SIGTERM (15s grace) → SIGKILL. Any stdio MCP children exit with the parent;
shared MCP daemons are separate services and are untouched. The tmux
session is kept (a bare shell is ~5MB) and gets an echoed breadcrumb:
`# claude session reaped after Nh idle — resume: claude --resume NAME`.
`--kill-tmux` kills the tmux session too; default leaves tmux pruning to
`/tmux-cleanup`.

## Usage

```bash
claude_session_reaper.py --dry-run                 # who would be reaped, and why others are skipped
claude_session_reaper.py --dry-run --threshold-hours 24
claude_session_reaper.py --only NAME               # reap one session NOW (ignores idle age, keeps guards)
```

## Health checks

```bash
tail -5 ~/OpenDia/logs/session-reaper.log    # one summary line per run
crontab -l | grep reaper                     # cron installed?
```

If sessions pile up but the log always says `reaped=0` with everything
`fresh`, check whether transcript mtimes are being refreshed by something
other than real use (`stat` the jsonl of a session you know is idle) — the
idle signal depends on them going quiet.

## Disaster recovery

Script + doc are in the repo. The keep file and log are disposable. There
is no state — every run re-derives everything from `/proc`, tmux, and the
session/timer files.
