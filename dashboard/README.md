# OpenDia Dashboard

A Kanban-style project board for OpenDia. Displays projects from the SQLite database as draggable cards across status columns, with detail modals for editing and viewing associated time entries.

## Stack

- **Frontend:** React 18, Vite, @dnd-kit (drag-and-drop), @xterm/xterm (terminal)
- **Backend:** Express, better-sqlite3, ws (WebSocket), node-pty (tmux pty streams)
- **Port:** 8038 (serves API + static files + WebSocket upgrades in production)

## Setup

```bash
cd ~/OpenDia/repo/dashboard

# Install dependencies
npm install
npm install --prefix client

# Create .env (gitignored)
cat > .env <<EOF
DB_PATH=/home/$USER/OpenDia/opendia.db
PORT=8038
EOF

# Build and start
npm run build
npm start
```

The dashboard is then available at `http://opendia:8038` from any Tailscale peer.

### Running as a systemd User Service (Production)

The dashboard runs as a systemd user service on the OpenDia server so it starts at boot and auto-recovers from crashes.

```bash
# Service file location
~/.config/systemd/user/opendia-dashboard.service

# Status / logs
systemctl --user status opendia-dashboard
journalctl --user -u opendia-dashboard -f

# Manual restart / stop
systemctl --user restart opendia-dashboard
systemctl --user stop opendia-dashboard   # e.g. before running npm run dev
```

Linger must be enabled once so the service starts at boot without an active login session:

```bash
sudo loginctl enable-linger linnflux
```

### Development

```bash
npm run dev
```

Runs Express on port 8038 and Vite dev server on port 5173 concurrently. Vite proxies `/api` requests to Express.

## Kanban Columns

| Column | Status Key | Color |
|--------|-----------|-------|
| In Progress | `in_progress` | blue |
| WFHuman | `wfhuman` | orange |
| Ice | `ice` | gray |
| Completed | `completed` | green |

Drag a card between columns to update its status.

## Card Detail Modal

Click a card to open a detail modal with:

The modal has two tabs:

**Details tab** (default):
- **Status** — click to change column
- **Name** — click to edit inline
- **Tmux Session** — click to edit
- **Next Step** — click to edit
- **Notes** — click to edit (persisted to the database)
- **Inbox Items** — linked inbox emails (status dot, subject, sender, age). Clicking an item opens the inbox modal. Only shown when at least one item exists.
- **Time Entries** — matched from `~/OpenDia/Time/` by company+division or project name. Expandable to show full notes.
- **Attachments** — inline image previews from linked files
- **Sync** — pulls Notion task data, recent Gmail threads, and runs AI analysis to suggest next steps and surface change requests
- **Footer** — shows inbox-origin subject if the project was auto-created by the inbox pipeline

**Terminal tab** (enabled only when `tmux_session` is set — see below).

## Active Timer Indicators

Cards with a running timer display a Linnflux green (`#54af4d`) border. The board fetches active timer state from `/api/timers/active` on mount and on window focus, so the indicators update when switching back to the dashboard after starting or stopping a timer.

Timer state is read from `.timer-*.json` files in `~/OpenDia/Time/`. Files without an `end` field are considered active.

Opening a card with an active timer shows a subtle rotating conic-gradient border on the modal, built with a CSS `@property`-registered angle and a 6s linear animation. Users with `prefers-reduced-motion: reduce` get a static solid green border instead.

## Terminal Tab

The Terminal tab embeds the project's live tmux session directly in the card modal using a browser-based xterm.js terminal streamed over WebSocket.

### States

| Pill | Meaning |
|------|---------|
| Watching · read-only | Connected; pty spawned with `tmux attach -r` — keystrokes cannot reach the session even if WS code is bypassed |
| Interactive · live | This tab holds the control lock; input is forwarded to tmux |
| Locked by another tab | Another browser session holds control — pill shows `By user@linnflux.com · Taken HH:MM` |
| Connecting | Transient state during lock acquire |
| Disconnected | WS closed; auto-reconnects with 1s → 2s → 5s → 10s backoff |

### Take Control

Clicking **Take Control** (with an optional one-line task description):
1. `POST /api/projects/:id/terminal/take-control` — acquires the server-side lock.
2. If no timer is already running for the session, one is started automatically (pulls client, division, and next_step from the card — same as `/od-go`).
3. The pty is upgraded from `tmux attach -r` to `tmux attach` (read-write) and a `claim-control` WS message binds the socket to the lock.
4. A second tab trying to Take Control receives a 409 and shows "Locked by another tab."

The lock auto-releases after 5 minutes of keyboard inactivity, with a warning at 4:00 remaining.

### Stop & Exit

Clicking **Stop & Exit** and confirming:
1. `POST /api/projects/:id/terminal/send-od-stop` — injects `/od-stop\n` into the tmux session via `tmux send-keys`.
2. The server polls for the timer state file to be deleted (proof that the embedded Claude Code session finished `/od-stop`) — 2s interval, 3-minute timeout.
3. On success, the control lock is released and all viewers drop back to Watching.
4. On timeout, a fallback dialog appears — the operator can enter notes manually to close the timer without Notion sync.

**Release** discards the control lock without stopping the timer, for context-switching between sessions.

### Redraw

The **Redraw** button (always visible) fixes display corruption that can occur when an external `tmux attach` client was open at a different terminal size. It sets `aggressive-resize on` for the session, calls `tmux refresh-client`, and nudges the pty dimensions to force a full frame repaint.

### Security

- `tmux attach -r` provides pty-level read-only in watch mode — no input reaches the session from this pty regardless of frontend state.
- The server-side control lock (`controlHolder.ws`) is the single source of truth; `{type:"input"}` WS messages are silently dropped unless the sending socket holds the lock.
- Only one socket can hold the interactive lock at a time.
- All take/release/od-stop events are appended to `dashboard/server/terminal-audit.log` with timestamp, event type, project_id, session, Tailscale user identity, and IP.

## Authentication

The dashboard uses **Tailscale identity headers** for access control. The server binds to `127.0.0.1` (loopback only) and must be exposed via `tailscale serve`, which injects trusted identity headers on every request.

### Setup (one-time)

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8038
```

This exposes the dashboard at `https://opendia.taild43937.ts.net/` (MagicDNS hostname) with auto-issued TLS. Tailscale persists this config across reboots. To remove: `tailscale serve reset`.

After this, the dashboard is only reachable from Tailscale-enrolled devices. Direct TCP to port 8038 from the LAN is blocked (loopback bind).

### How it works

`tailscale serve` strips any client-supplied `Tailscale-User-*` headers and re-injects its own from the enrolled device's identity. The Express middleware (`server/auth.js`) reads `Tailscale-User-Login` and verifies the domain matches `AUTH_ALLOWED_DOMAINS` (default: `linnflux.com`). Unauthorized requests get a 403. WebSocket upgrades (Terminal tab) go through the same check before the upgrade completes.

The allowed domain list is configured in `.env`:
```
AUTH_ALLOWED_DOMAINS=linnflux.com
```

### Loopback bypass

Requests from `127.0.0.1` / `::1` skip the Tailscale check. This keeps local scripts (`/od-go`, `/od-stop`, server-to-server curl calls) working without Tailscale headers.

### Adding a user

1. Create `user@linnflux.com` in Google Workspace admin.
2. Invite their device to the tailnet (Tailscale admin console → Users → Invite).
3. They sign into Tailscale with their Workspace account — their device joins the tailnet.
4. They visit `https://opendia.taild43937.ts.net/` — access is granted automatically.

No per-user configuration needed. All `@linnflux.com` accounts get equal full access.

### `GET /api/me`

Returns the current user's identity as seen by the server:

```json
{ "login": "nick@linnflux.com", "name": "Nick Linn", "source": "tailscale" }
```

Returns `{ "source": "loopback" }` for local script requests.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects` | All projects with company and division joins + `inbox_count`. `?include_completed=true` to include completed. |
| `POST` | `/api/projects` | Create a new project card. Body: `{ name, companyName, divisionName, status, notionId }` |
| `PATCH` | `/api/projects/:id` | Update fields: `name`, `status`, `notes`, `tmux_session`, `next_step`, `notion_id` |
| `PUT` | `/api/projects/reorder` | Reorder cards within a column. Body: `{ status, ids[] }` |
| `GET` | `/api/projects/match` | Find a project by `?client=&division=&task=`. Returns 404 if no match. Used by timers/active, backfill, and inbox re-link. |
| `GET` | `/api/projects/match-candidates` | Return top N ranked project matches as a JSON array (always 200, empty if none). `?client=&division=&task=&limit=3`. Each element: `{ id, name, status, company_name, company_short, division, score }`. Used by `/od-go` Step 5.5. |
| `POST` | `/api/projects/:id/sync` | Sync project with Notion + Gmail + AI analysis |
| `GET` | `/api/projects/:id/timers` | Time entries matching the project |
| `GET` | `/api/projects/:id/inbox` | Inbox items linked to this project via `project_id` FK |
| `GET` | `/api/projects/:id/notion-title` | Lightweight Notion title fetch |
| `GET` | `/api/timers/active` | Returns array of project IDs with running timers |
| `POST` | `/api/projects/:id/log-timer` | Append a single timer entry to the project's Notion task as a toggle block. Body: `{ start, task, duration, notes }`. Silently no-ops if the project has no `notion_id`. |
| `POST` | `/api/timers/backfill` | One-shot sync of all historical daily `.md` entries to their matching Notion tasks. Idempotent (dedupes by start-time marker in existing toggle titles). Throttled to stay under Notion's rate limit. |
| `WS`  | `/api/projects/:id/terminal` | Stream pty output; send input/resize/ping when holding control lock |
| `GET` | `/api/projects/:id/terminal/status` | `{ session, alive, watchers, controlHolder }` |
| `POST` | `/api/projects/:id/terminal/take-control` | Acquire interactive lock; starts timer if none running; writes `started_by` (Tailscale identity) to timer state file. Body: `{ task? }` |
| `POST` | `/api/projects/:id/terminal/release-control` | Release lock; writes `ended_by` to timer state file; downgrade pty to read-only |
| `POST` | `/api/projects/:id/terminal/send-od-stop` | Writes `ended_by` to timer state file, injects `/od-stop` into tmux session; polls for state-file deletion (3-min timeout) |
| `POST` | `/api/projects/:id/terminal/stop-local` | Fallback: write notes directly to daily file + delete state file. Body: `{ notes }` |
| `POST` | `/api/projects/:id/terminal/redraw` | Force `tmux refresh-client` + resize-nudge to fix multi-client display corruption |
| `GET` | `/api/inbox` | All inbox items (joined with project name). |
| `PATCH` | `/api/inbox/:id` | Update classification fields. Re-links `project_id` automatically when `client_hint` or `division_hint` changes. |
| `DELETE` | `/api/inbox/:id` | Soft-delete: sets `status = dismissed` (preserves project FK and audit trail). |
| `POST` | `/api/inbox/:id/redispatch` | Re-run Stage B for the item. |
| `POST` | `/api/inbox/:id/approve-server` | Approve and dispatch a server-work item through the safety gate. |
| `GET` | `/api/client-aliases` | All learned sender → client mappings. |
| `POST` | `/api/client-aliases` | Add or update an alias. Body: `{ match_type, match_value, client_hint, division_hint, note }` |
| `GET` | `/api/file` | Serve files under `~/OpenDia/` by `?path=` |

## `/od-go` and `/od-stop` Integration

**`/od-go`** (Step 5.5) calls `GET /api/projects/match-candidates` to fetch ranked candidate cards for the resolved client/division/task. It presents a numbered list — existing cards first, then "Create new" and "Skip" — so the operator always sees and chooses what gets linked. The top result is marked "recommended" when its score is ≥ 10 (strong task-text match). The linked or created project name is written into the `project:` field of both the timer ledger entry and state file, so `/api/timers/active` can do an exact-name first-pass match and the correct card gets the green border.

**`/od-stop`** is the mirror — it stops the running timer, writes justified notes to the daily `.md`, updates the card's `next_step`, and logs a toggle block to the linked Notion task via `POST /api/projects/:id/log-timer`. Running `/od-stop backfill` does a one-shot historical sync of all prior entries.

### The Justification Rule

Timer entry notes are a **billing ledger**, not a changelog. Every bullet must correspond to real work done during the timed period, and together they must plausibly account for the billed duration (~1 bullet per 10-15 minutes as a rule of thumb). The dashboard card's time entries, the daily `.md` files, and the Notion task's toggle blocks all share the same note body, so consistency is maintained at write time by `/od-stop`.

Toggle block title format in Notion: `YYYY-MM-DD HH:MM — Task Title (1h 30m)`. The start-time prefix doubles as a dedupe key for backfill re-runs.

## Security

- `.env` and `*.db` files are gitignored — no credentials or business data in the repo
- The frontend is a pure shell; all data comes from the API at runtime
- Server binds to `127.0.0.1` — only reachable via `tailscale serve` (see Authentication above); direct LAN access to port 8038 is blocked
- `tailscale serve` strips and re-injects identity headers — header spoofing is not possible from outside the local process
- Loopback requests (local scripts) bypass the identity check but cannot be forged from non-local sockets
