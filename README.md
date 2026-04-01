# OpenDia

![Active](https://img.shields.io/badge/status-active-brightgreen) ![CLI-First](https://img.shields.io/badge/CLI--first-blue) ![AI-Orchestrated](https://img.shields.io/badge/AI--orchestrated-purple)

OpenDia is a business orchestration framework that connects your existing tools into a unified, AI-driven workflow. Your email, calendars, task management, billing, and time tracking all working together. It doesn't replace your systems. It makes them work together.

OpenDia is designed to be run by an **Operator**: a trained professional inside your organization who understands your processes, your clients, and your goals. The Operator directs OpenDia, not the other way around. This information was published in its initial state on March 12, 2026.

**[Installation instructions](#installation)** are at the bottom of this document.

## What OpenDia says about itself

- **Not a SaaS product you hand logins to.** OpenDia runs on your infrastructure, with your data, under your control. No third-party dashboards where your business lives on someone else's server.
- **No rip-and-replace.** You keep your existing email, project management, time tracking, and invoicing tools. OpenDia is the layer that ties them together.
- **Human-in-the-loop by design.** AI handles the tedious coordination. The Operator makes the decisions. This isn't "set it and forget it" automation. It's augmented operations.
- **Built for service businesses.** Agencies, consultancies, MSPs, and anyone juggling multiple clients, tools, and workflows.

## Architecture

### Remote Server + tmux

Claude Code runs on a persistent Linux Mint server (`opendia`) on a [Tailscale](https://tailscale.com) mesh network. The Operator SSHs in from any machine — desktop, laptop, or mobile — and attaches to long-running `tmux` sessions, one per project or client context. Sessions survive disconnects, sleep, and machine switches. The server is the single point of execution; client machines are just terminals.

```
laptop ~$ ssh youruser@opendia
opendia ~$ tmux attach -t acme
```

> **Note:** The server and tmux layer is the foundation. Everything below it — the database, time tracking, MCP integrations — is flexible and designed to adapt to your current tools. Swap in a different project manager, time tracker, or email provider and the architecture still holds. The goal is to meet you where you already are, not force a migration.

### SQLite Database

A local SQLite database stores the canonical list of companies, people, projects, tasks, and Linnflux divisions. Each record can carry a `notion_id` and `toggl_client_id`, creating a lightweight bridge between external services without depending on any single one. Foreign keys are enforced. The schema is initialized idempotently, and all CRUD is handled through a CLI helper that doubles as an importable Python module.

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `divisions` | Linnflux business units | name, description |
| `companies` | Client companies | name, short_name, notion_id, toggl_client_id |
| `people` | Contacts at companies | name, email, role, company_id |
| `projects` | Work projects per company | name, company_id, division_id, toggl_project_id |
| `tasks` | Tasks per project | title, project_id, status, notion_url |

### Internal Time Tracking

Time entries live in daily markdown files with YAML frontmatter. Each running timer has a companion `.json` state file that persists until the work is complete — timers represent open engagements, not stopwatch sessions. A timer might stay open for hours, days, or weeks as work progresses across multiple sessions.

Every entry records: client, project, division, task, estimated minutes, start/end, duration, billable flag, and notes. The `estimated_minutes` field drives billing — it captures how long the task *should* take a professional developer, not the wall-clock time. Actual elapsed time is tracked for internal reference. If a second timer is started for the same client, Claude flags it as a potential duplicate. This runs alongside your external time tracker, not instead of it — it's your own internal record with fields external tools don't track.

```yaml
~/OpenDia/Time/2026/03/2026-03-12.md

---
<!-- entry:2026-03-12T09:15 -->
client: ACME Corp
project: ACME Website
division: WordFlux
task: WooCommerce product updates
estimated_minutes: 60
start: 2026-03-12T09:15
end: 2026-03-12T09:22
duration: 7m
billable: true
notes: Updated variable product attributes via WP-CLI
---
```

### External Integrations

OpenDia connects to external services through three patterns, chosen based on scope and frequency of use:

#### MCP Servers (structured tools)

Services Claude interacts with frequently get a dedicated [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server — a lightweight API bridge that exposes typed tool functions Claude can call directly. This covers things like task management, time tracking, email, and invoicing. Humans keep using their normal UIs; Claude participates in those same systems via MCP without replacing them.

#### CLI Tools (scoped commands)

Services with narrow, infrequent use run through their native CLI — things like cloud snapshots and DNS management. Credentials are managed by the CLI's own auth mechanism or scoped IAM policies, not stored in OpenDia.

#### Raw API (env var auth)

Services used occasionally via direct API calls. Tokens are stored as environment variables, referenced at runtime — never hardcoded in memory files or source code.

### Credential Security

No API tokens, keys, or secrets are stored in:
- Memory files (loaded into AI context every session)
- Source code or the git repository
- Plaintext config files within `~/OpenDia/`

Credentials live outside the project directory, managed by MCP server configs, environment variables, or external tooling (IAM, CLI auth) depending on the integration pattern.

## Custom Commands

Custom commands are markdown prompt files that define repeatable workflows. The Operator types a slash command, and Claude executes the full routine.

| Command | What it does |
|---------|-------------|
| `/checkin` | Hourly check-in. Loads today's log, scans recent Gmail, numbers tasks for quick selection. |
| `/hello` | Morning routine. Creates daily log, carries over unchecked items from the prior day. |
| `/notion-new` | Creates a Notion task and starts a Toggl timer in one flow. |
| `/notion-now` | Set the current Notion task's due date to now (rounded to previous half-hour, 1-hour window). |
| `/od-go` | Unified work start. Resolves client via fuzzy match, searches Notion for related tasks, starts internal timer. |
| `/od-sync` | Sync all Claude Code configs and settings to Google Drive for backup. |
| `/roundup` | Project priority roundup. Scores and ranks open projects by urgency, lets you pick one to start via `/od-go`. |
| `/timer-end` | End a running timer, prompt for notes, calculate duration, finalize the entry. |
| `/timer-pause` | Pause with auto-generated notes and project summary. |
| `/timer-start` | Start an internal time entry with client, task, division, and billable prompts. |
| `/timer-status` | Show all active timers across all sessions. |
| `/zero` | Inbox Zero. Scans primary inbox, groups by thread, extracts action items. |

## Data Flow

The SQLite database acts as the local index that ties external systems together. A company record might have:

- An external ID linking to its project management page
- A client ID linking to its time tracking entry
- Internal time entries referencing it by name in the markdown files

When Claude resolves a client context — from an email sender, a task description, or a spoken name — it looks up the company in SQLite, finds related tasks, checks for running timers, and starts an internal time entry. All in one flow. No single service owns the data; SQLite is the glue.

```
Email from client
      |
      v
  SQLite lookup (fuzzy match company name)
      |
      +---> Project manager: find open tasks for this client
      +---> Time tracker: check for running timers
      +---> Internal: start time entry
      |
      v
  Ready to work
```

## Infrastructure

The system is designed to be portable. Two scripts handle migration:

- `migrate-export.sh` — Backs up `~/.claude/` configs and `~/OpenDia/` (scripts, time entries, database) to Google Drive via rclone. Runs automatically every night via cron.
- `migrate-setup.sh` — Bootstraps a fresh machine: installs packages, pulls configs from Drive, builds MCP servers, creates the Python environment, and runs 8 verification phases.
- `cron` — Runs `migrate-export.sh` daily at 2:00 AM ET, automatically backing up all configs, time entries, and the database to Google Drive. Logs to `~/OpenDia/logs/backup.log`.

The entire OpenDia environment can be rebuilt on a new server from a single script. The database, time entries, commands, memory files, and all configs travel with it.

## Persistent Memory

Claude Code maintains a memory directory that persists across conversations. A lean index file (`MEMORY.md`) is loaded at session start, pointing to topic-specific files that hold deeper notes — client-specific knowledge, operational rules, workflow corrections, and reference data. Topic files load on demand, keeping the context window efficient.

This gives Claude institutional knowledge that accumulates over time rather than resetting each session. When a mistake is corrected, the correction is saved so it never happens again. When the index grows past ~120 lines, Claude proactively refactors it — moving detail into topic files and keeping the index as a slim directory of pointers.

## SSH Write Guard

OpenDia manages remote servers via SSH — WordPress instances, infrastructure, client environments. A belt-and-suspenders approach prevents accidental destructive operations:

**Hard gate (PreToolUse hook):** A Bash hook (`~/.claude/hooks/ssh-write-guard.sh`) intercepts every shell command before execution. If the command contains SSH, scp, or rsync combined with a writable operation, it prompts the Operator for confirmation before proceeding. This catches:

- File modifications: `sed -i`, `rm`, `mv`, `cp`, `chmod`, `chown`, `tee`, `truncate`, `dd`, `shred`
- Output redirects: `>`, `>>`, `2>`, `&>`
- System operations: `systemctl restart`, `kill`, package managers, user management, firewall rules
- Dangerous flags: `--force`, `--hard`, `-rf`, `--delete`
- WordPress writes: `wp ... delete|update|install|deactivate|activate|create|drop`

Read-only commands (`ls`, `cat`, `grep`, `wp option get`, etc.) pass through without interruption.

**Soft gate (CLAUDE.md rules):** In Plan Mode, Claude is instructed to never execute writable SSH commands at all — not even with confirmation. The Operator must exit Plan Mode first and explicitly approve the action. This ensures planning stays read-only and execution is always intentional.

The hook returns `{"decision": "ask"}` rather than `{"decision": "block"}`, so the Operator can always override. The goal is verification, not obstruction.

## Divisions

| Division | Focus |
|----------|-------|
| **WordFlux** | WordPress Design, Development & Hosting |
| **WatchThreat** | Security, Backups & Hardware |
| **AmPen** | Penetration Testing |
| **Bedford AI** | AI & Automation |
| **ADA Web Work** | Accessibility Compliance |

## Design Principles

1. **CLI-first, human-optional.** Claude handles orchestration; humans interact through familiar UIs or drop into the terminal when needed.
2. **No single source of truth.** SQLite bridges services but doesn't replace them. Each system holds its own authoritative data; SQLite holds the cross-references.
3. **Portable and rebuildable.** Everything syncs to Google Drive. A new server can be fully provisioned from a single bootstrap script.
4. **Concurrent by default.** Multiple tmux sessions, multiple timers, multiple client contexts — all running simultaneously on one server.
5. **Safety guardrails.** No emails sent without explicit confirmation. No destructive AWS operations. No force pushes. Claude asks before acting on anything irreversible. SSH write operations require explicit Operator confirmation via a PreToolUse hook (see below).
6. **Accumulating intelligence.** Memory files capture corrections, patterns, and client-specific knowledge. Claude gets smarter about Linnflux operations with every session.

## The Mark

The mark was designed through a reverse-AI process: Claude described the concept, and a human drew it by hand on a [reMarkable 2](https://remarkable.com) tablet. Through 14 sketches, the form evolved from a rigid geometric diamond into something more organic — a single continuous shape that reads as a horizon at dawn, an eye opening, or a lens looking forward.

The name OpenDia means "Open Day" — your day is open because OpenDia handles the work. The outer shape opens at the top, echoing the "open" in the name. The sunrise inside stays open too. Everything is open.

<p align="center">
  <img src="opendia_mark.svg" alt="OpenDia Mark" width="240">
  <br>
  <sub>Open<b>Dia</b> — Set in <a href="https://fonts.google.com/specimen/Space+Grotesk">Space Grotesk</a> Light 300 / Bold 700</sub>
</p>

Claude selected [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk) for the wordmark — a geometric typeface with just enough humanist character to feel approachable without losing its technical edge. "Open" is set in Light (300) and "Dia" in Bold (700), letting the weight contrast carry the emphasis rather than color or size. The typeface's distinctive letterforms — particularly the "O" and "D" — complement the organic geometry of the mark.

## Installation

> **Note:** This has only been tested on a fresh [Linux Mint](https://linuxmint.com/) server (LMDE). These steps set up the **remote server** that runs Claude Code persistently. Once the server is running, install [Tailscale](https://tailscale.com/) on both the server and your devices (laptop, desktop, phone), then SSH into the server from anywhere to work.

### 1. Prerequisites

Install [Tailscale](https://tailscale.com/download) on the server and connect it to your tailnet:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

A terminal multiplexer like [tmux](https://github.com/tmux/tmux) is highly recommended — it lets you maintain separate sessions per client or project, survive SSH disconnects, and switch contexts without losing state.

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip nodejs npm git curl tmux
```

Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code):

```bash
sudo npm install -g @anthropic-ai/claude-code
```

### 2. Clone and set up

```bash
git clone https://github.com/linnflux/OpenDia.git ~/OpenDia/repo
cd ~/OpenDia
```

Create the runtime directories (these hold live data and are not tracked in git):

```bash
mkdir -p ~/OpenDia/{Time,Projects,Debug,logs,scripts}
```

Copy the scripts into the live location:

```bash
cp ~/OpenDia/repo/scripts/* ~/OpenDia/scripts/
```

### 3. Initialize the database

```bash
python3 -m venv ~/OpenDia/venv
source ~/OpenDia/venv/bin/activate
python3 ~/OpenDia/scripts/init_db.py
```

This creates `~/OpenDia/opendia.db` with the schema and seeds the divisions table.

Verify it works:

```bash
python3 ~/OpenDia/scripts/db_helper.py list-divisions
```

### 4. Configure Claude Code

Launch Claude Code and authenticate:

```bash
claude
```

Create a project-level `CLAUDE.md` at `~/.claude/projects/-home-$USER-OpenDia/CLAUDE.md` with your operational instructions — this is what tells Claude about your directory structure, tools, and workflows.

### 5. MCP servers (optional)

Connect external services by configuring MCP servers in `~/.claude.json`. OpenDia is designed to work with any combination of project management, time tracking, email, and invoicing services that have MCP server implementations. Each is optional. The core system (database, time tracking, scripts) works without any MCP servers.

### 6. Backups (optional)

If you use Google Drive for backups, install and configure [rclone](https://rclone.org/):

```bash
sudo apt install -y rclone
rclone config  # set up a remote named "gdrive"
```

Then use `migrate-export.sh` to back up configs and data:

```bash
bash ~/OpenDia/scripts/migrate-export.sh
```

To automate nightly backups:

```bash
crontab -e
# Add: 0 2 * * * /home/$USER/OpenDia/scripts/migrate-export.sh >> /home/$USER/OpenDia/logs/backup.log 2>&1
```

### 7. Client machine aliases (recommended)

Add these to `~/.bashrc` on any machine you SSH from:

```bash
# Quick SSH into the OpenDia server
alias od='ssh youruser@opendia -t'

# SSH in, start a new tmux session in ~/OpenDia, and launch Claude Code
odt() {
  ssh youruser@opendia -t 'tmux new-session -c ~/OpenDia \; send-keys claude Enter'
}

# Send a screenshot from clipboard to the server for Claude to analyze
odscreen() {
  local file="/tmp/screenshot-$(date +%s).png"
  xclip -selection clipboard -t image/png -o > "$file" 2>/dev/null
  if [ ! -s "$file" ]; then
    echo "No image in clipboard"
    rm -f "$file"
    return 1
  fi
  scp "$file" youruser@opendia:~/OpenDia/Debug/
  echo "Uploaded: ~/OpenDia/Debug/$(basename "$file")"
  rm -f "$file"
}
```

Replace `youruser@opendia` with your username and server's Tailscale hostname.

### 8. Terminal bell notification (recommended)

Claude Code uses hooks to send a terminal bell character (`\a`) through the SSH+tmux chain to your local terminal — useful when you step away or switch windows. Two events trigger a bell:

- **`Stop`** — fires when Claude finishes responding
- **`PermissionRequest`** — fires when Claude pauses for tool approval (e.g., allowing access to a URL or running a command)

Both are configured in `~/.claude/settings.json` on the server:

```json
"PermissionRequest": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "printf '\\a' > /dev/tty"
      }
    ]
  }
],
"Stop": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "printf '\\a' > /dev/tty"
      }
    ]
  }
]
```

**Client machine setup (Linux Mint / Cinnamon):**

Enable audible bell in the Cinnamon window manager — this is the setting that actually routes the bell character to your sound system:

```bash
gsettings set org.cinnamon.desktop.wm.preferences audible-bell true
```

Also ensure event sounds are enabled:

```bash
gsettings set org.cinnamon.desktop.sound event-sounds true
```

**GNOME Terminal** must have audible bell enabled in its profile settings (Edit > Preferences > Profile > "Terminal bell").

**tmux** on the server must pass bells through (these are the defaults):

```bash
tmux set-option -g visual-bell off
tmux set-option -g bell-action any
```

**Verify:** Run `printf '\a'` on your local machine. If you hear a sound, the full chain will work.

> **Note:** The `org.gnome.desktop.wm.preferences audible-bell` setting does **not** work on Cinnamon — you must use the `org.cinnamon.desktop.wm.preferences` schema. The `printf '\a' > /dev/tty` redirect is required in the hook because Claude Code captures stdout from hook subprocesses; writing directly to `/dev/tty` bypasses that and reaches the terminal.

### Full bootstrap

If you're migrating from an existing OpenDia instance that has already run `migrate-export.sh`, you can bootstrap everything at once:

```bash
bash ~/OpenDia/scripts/migrate-setup.sh
```

This installs all packages, pulls configs and data from Google Drive, builds MCP servers, creates the Python environment, and runs verification checks.

---

*Built by [Linnflux](https://linnflux.com) — a [Bedford AI](https://bedford.ai) project.*
