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
- **Time Entries** — matched from `~/OpenDia/Time/` by company+division or project name. Expandable to show full notes.
- **Attachments** — inline image previews from linked files
- **Sync** — pulls Notion task data, recent Gmail threads, and runs AI analysis to suggest next steps and surface change requests

## Active Timer Indicators

Cards with a running timer display a Linnflux green (`#54af4d`) border. The board fetches active timer state from `/api/timers/active` on mount and on window focus, so the indicators update when switching back to the dashboard after starting or stopping a timer.

Timer state is read from `.timer-*.json` files in `~/OpenDia/Time/`. Files without an `end` field are considered active.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects` | All projects with company and division joins. `?include_completed=true` to include completed. |
| `POST` | `/api/projects` | Create a new project card. Body: `{ name, companyName, divisionName, status, notionId }` |
| `PATCH` | `/api/projects/:id` | Update fields: `name`, `status`, `notes`, `tmux_session`, `next_step`, `notion_id` |
| `PUT` | `/api/projects/reorder` | Reorder cards within a column. Body: `{ status, ids[] }` |
| `GET` | `/api/projects/match` | Find a project by `?client=&division=&task=`. Returns 404 if no match. |
| `POST` | `/api/projects/:id/sync` | Sync project with Notion + Gmail + AI analysis |
| `GET` | `/api/projects/:id/timers` | Time entries matching the project |
| `GET` | `/api/projects/:id/notion-title` | Lightweight Notion title fetch |
| `GET` | `/api/timers/active` | Returns array of project IDs with running timers |
| `GET` | `/api/file` | Serve files under `~/OpenDia/` by `?path=` |

## `/od-go` Integration

The `/od-go` command (Step 5.5) checks for a matching dashboard card after resolving client and division. If no card exists, it prompts to create one via `POST /api/projects` before starting the timer.

## Security

- `.env` and `*.db` files are gitignored — no credentials or business data in the repo
- The frontend is a pure shell; all data comes from the API at runtime
- Bind address is `0.0.0.0` for Tailscale access — ensure the server is not exposed to the public internet
