# OpenDia Dashboard

A Kanban-style project board for OpenDia. Displays projects from the SQLite database as draggable cards across status columns, with detail modals for editing and viewing associated time entries.

## Stack

- **Frontend:** React 18, Vite, @dnd-kit (drag-and-drop)
- **Backend:** Express, better-sqlite3
- **Port:** 8038 (serves API + static files in production)

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

## Active Timer Indicators

Cards with a running timer display a Linnflux green (`#54af4d`) border. The board fetches active timer state from `/api/timers/active` on mount and on window focus, so the indicators update when switching back to the dashboard after starting or stopping a timer.

Timer state is read from `.timer-*.json` files in `~/OpenDia/Time/`. Files without an `end` field are considered active.

Opening a card with an active timer shows a subtle rotating conic-gradient border on the modal, built with a CSS `@property`-registered angle and a 6s linear animation. Users with `prefers-reduced-motion: reduce` get a static solid green border instead.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects` | All projects with company and division joins + `inbox_count`. `?include_completed=true` to include completed. |
| `POST` | `/api/projects` | Create a new project card. Body: `{ name, companyName, divisionName, status, notionId }` |
| `PATCH` | `/api/projects/:id` | Update fields: `name`, `status`, `notes`, `tmux_session`, `next_step`, `notion_id` |
| `PUT` | `/api/projects/reorder` | Reorder cards within a column. Body: `{ status, ids[] }` |
| `GET` | `/api/projects/match` | Find a project by `?client=&division=&task=`. Returns 404 if no match. |
| `POST` | `/api/projects/:id/sync` | Sync project with Notion + Gmail + AI analysis |
| `GET` | `/api/projects/:id/timers` | Time entries matching the project |
| `GET` | `/api/projects/:id/inbox` | Inbox items linked to this project via `project_id` FK |
| `GET` | `/api/projects/:id/notion-title` | Lightweight Notion title fetch |
| `GET` | `/api/timers/active` | Returns array of project IDs with running timers |
| `POST` | `/api/projects/:id/log-timer` | Append a single timer entry to the project's Notion task as a toggle block. Body: `{ start, task, duration, notes }`. Silently no-ops if the project has no `notion_id`. |
| `POST` | `/api/timers/backfill` | One-shot sync of all historical daily `.md` entries to their matching Notion tasks. Idempotent (dedupes by start-time marker in existing toggle titles). Throttled to stay under Notion's rate limit. |
| `GET` | `/api/inbox` | All inbox items (joined with project name). |
| `PATCH` | `/api/inbox/:id` | Update classification fields. Re-links `project_id` automatically when `client_hint` or `division_hint` changes. |
| `DELETE` | `/api/inbox/:id` | Soft-delete: sets `status = dismissed` (preserves project FK and audit trail). |
| `POST` | `/api/inbox/:id/redispatch` | Re-run Stage B for the item. |
| `POST` | `/api/inbox/:id/approve-server` | Approve and dispatch a server-work item through the safety gate. |
| `GET` | `/api/client-aliases` | All learned sender → client mappings. |
| `POST` | `/api/client-aliases` | Add or update an alias. Body: `{ match_type, match_value, client_hint, division_hint, note }` |
| `GET` | `/api/file` | Serve files under `~/OpenDia/` by `?path=` |

## `/od-go` and `/od-stop` Integration

**`/od-go`** (Step 5.5) checks for a matching dashboard card after resolving client and division. If no card exists, it prompts to create one via `POST /api/projects` before starting the timer.

**`/od-stop`** is the mirror — it stops the running timer, writes justified notes to the daily `.md`, updates the card's `next_step`, and logs a toggle block to the linked Notion task via `POST /api/projects/:id/log-timer`. Running `/od-stop backfill` does a one-shot historical sync of all prior entries.

### The Justification Rule

Timer entry notes are a **billing ledger**, not a changelog. Every bullet must correspond to real work done during the timed period, and together they must plausibly account for the billed duration (~1 bullet per 10-15 minutes as a rule of thumb). The dashboard card's time entries, the daily `.md` files, and the Notion task's toggle blocks all share the same note body, so consistency is maintained at write time by `/od-stop`.

Toggle block title format in Notion: `YYYY-MM-DD HH:MM — Task Title (1h 30m)`. The start-time prefix doubles as a dedupe key for backfill re-runs.

## Security

- `.env` and `*.db` files are gitignored — no credentials or business data in the repo
- The frontend is a pure shell; all data comes from the API at runtime
- Bind address is `0.0.0.0` for Tailscale access — ensure the server is not exposed to the public internet
