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
- **Tmux Session** — click to edit
- **Notes** — click to edit (persisted to the database)
- **Time Entries** — matched from `~/OpenDia/Time/` by company+division or project name. Expandable to show full notes.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects` | All projects with company and division joins |
| `PATCH` | `/api/projects/:id` | Update status, notes, or tmux_session |
| `GET` | `/api/projects/:id/timers` | Time entries matching the project |

The PATCH endpoint accepts any combination of `status`, `notes`, and `tmux_session` fields. Status values are validated against the four column keys.

## Security

- `.env` and `*.db` files are gitignored — no credentials or business data in the repo
- The frontend is a pure shell; all data comes from the API at runtime
- Bind address is `0.0.0.0` for Tailscale access — ensure the server is not exposed to the public internet
