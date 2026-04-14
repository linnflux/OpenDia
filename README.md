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
| `projects` | Work projects per company | name, company_id, division_id, status, sort_order, tmux_session, next_step |
| `tasks` | Tasks per project | title, project_id, status, notion_url |
| `inbox_items` | Inbox pipeline items | gmail_id, client_hint, division_hint, project_id (FK → projects), short_slug, prompt_text, status (`classified→dispatched→done\|error\|dismissed`), session_name, estimated_minutes, timer_marker |
| `client_aliases` | Learned sender → client mappings | match_type, match_value, client_hint, division_hint |

### Internal Time Tracking

Time entries live in daily markdown files with YAML frontmatter. Each running timer has a companion `.json` state file that persists until the work is complete — timers represent open engagements, not stopwatch sessions. A timer might stay open for hours, days, or weeks as work progresses across multiple sessions.

Every entry records: client, project, division, task, estimated minutes, start/end, duration, billable flag, and notes. The `estimated_minutes` field drives billing — it captures how long the task *should* take a professional developer, not the wall-clock time. Actual elapsed time is tracked for internal reference. If a second timer is started for the same client, Claude flags it as a potential duplicate. This runs alongside your external time tracker, not instead of it — it's your own internal record with fields external tools don't track.

**The Justification Rule.** Notes on a completed entry are a **billing ledger**, not a changelog. Every bullet must correspond to real work performed during the timed period, and together the bullets must plausibly account for the billed duration (rule of thumb: ~1 bullet per 10–15 minutes). `/od-stop` enforces this at write time — if conversation context is thin relative to the duration, it prompts the Operator for the missing detail instead of auto-generating filler. The daily `.md` entry, the dashboard card's time entries, and the linked Notion task's toggle blocks all share the same note body, so the ledger is consistent across every surface.

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

One example is `scripts/nano_banana.py`, a stdlib-only Python wrapper around Google's Gemini 2.5 Flash Image model (marketing name "Nano Banana"). It reads an API key from `~/.claude/mcp-credentials/gemini/api_key`, takes a text prompt (and optional reference images for edit-style generation), and writes a PNG to `~/OpenDia/Debug/` by default. Because the dashboard card modal already auto-renders images referenced in a card's notes, attaching a generated visual to a project is as simple as appending the output path to the card via `PATCH /api/projects/:id` — no dashboard changes required. Typical use: client mockups, hero imagery, section illustrations (~$0.039 per image on the paid Gemini tier).

### Credential Security

No API tokens, keys, or secrets are stored in:
- Memory files (loaded into AI context every session)
- Source code or the git repository
- Plaintext config files within `~/OpenDia/`

Credentials live outside the project directory, managed by MCP server configs, environment variables, or external tooling (IAM, CLI auth) depending on the integration pattern.

## Dashboard

A lightweight Kanban board that provides a visual interface to the SQLite database. Built with React and Express, served on a single port, accessible from any machine on the Tailscale network. See [`dashboard/README.md`](dashboard/README.md) for setup and usage details.

- **Board view:** Projects appear as draggable cards organized into status columns (`In Progress`, `WFHuman`, `Ice`, `Completed`). Cards show company, division, notes, tmux session, and next step at a glance. A blue badge shows the count of active inbox items linked to the project. Projects auto-created by the inbox pipeline show the OpenDia mark at 50% opacity in the top-right corner (brightens to 85% on hover; tooltip shows the originating email subject).
- **Next Step:** Each project carries a `next_step` field — a short, actionable description of what to do next. Auto-populated when a timer is stopped via `/od-stop` (via `NEXT:` convention in notes), and refreshable on demand with `/od-next-steps`. Displayed on cards with a purple arrow indicator.
- **Card modal:** Click a card to open a detail modal with editable fields (name, status, notes, tmux session, next step) and a scrollable list of associated time entries pulled from the internal timer system. Company names link to their Notion page when available. Linked Notion tasks show an icon and title in the header. An **Inbox Items** section lists all classified emails linked to the project (status dot, subject, sender, age) — clicking an item opens the inbox modal for that item. If the project was auto-created by the inbox pipeline, the footer shows the originating email subject.
- **Card sync:** The refresh button in each card modal triggers an AI-powered sync that: auto-discovers and links a Notion task if none is set (searches by project name, then company name), fetches the linked Notion task (todos, comments, status), searches Gmail for recent client emails (exact phrase match, scoped to inbox and client label), runs Claude Haiku to analyze the context, auto-updates the project's next step, and appends any detected change requests to the Notion task as dated toggle blocks. Email threads are shown as clickable links to Gmail. Each email in the sync results also shows an **Ingest** button (grayed out with a ✓ if already ingested) to push the email directly into the inbox pipeline without re-opening Check Mail.
- **Check Mail / dual-mode ingest:** The envelope button searches Gmail for recent unprocessed emails matching the project's client and surfaces them as ingest candidates. Clicking **Ingest** on a candidate classifies the email (Haiku) and either: **(A) injects** it as context into the project's existing tmux session (writes `~/OpenDia/inbox-context/<gmail_id>.md`, sends a `tmux send-keys` prompt into the active Claude session — no new session, no timer) when `tmux_session` is set and alive, or **(B) spawns** a new `inbox-*` session as usual when there is no active session. Toast confirms which mode was used. Falls back to spawn if the named session is dead at dispatch time.
- **Inline attachments:** Image paths (`~/OpenDia/.../*.png`, `.jpg`, etc.) found in notes or next step fields are automatically detected and rendered as clickable thumbnail previews in an Attachments section. Clicking opens the full image. Files are served through a scoped API endpoint restricted to `~/OpenDia/`.
- **Tmux Launch:** Cards with a tmux session show a "Launch" button in the modal. If the `opendia://` protocol handler is registered on the client machine, it opens a terminal and SSHs directly into the tmux session. Otherwise, it copies the SSH command to clipboard. See [installation step 9](#9-dashboard-tmux-launcher-recommended) for setup.
- **Command palette (Ctrl+K):** Search projects by name, company, division, or next step — selecting a result opens the card modal. Also provides board actions like refresh and background image upload.
- **Theme toggle:** Switch between dark and light mode via the header button. Preference persists in `localStorage`.
- **Division filter pills:** Header shows clickable pill buttons for each division (with brand colors) plus All, Deliverable, and Internal filters. Click a division to filter the board; click again to deselect.
- **Project matching API:** `GET /api/projects/match?client=X&division=Y` resolves timer fields to a dashboard project, enabling automatic next-step updates when timers end.
- **Filtered responses:** The projects API excludes completed projects by default for performance at scale (`?include_completed=true` to override).

## Custom Commands

Custom commands are markdown prompt files that define repeatable workflows. The Operator types a slash command, and Claude executes the full routine.

| Command | What it does |
|---------|-------------|
| `/checkin` | Hourly check-in. Loads today's log, scans recent Gmail, numbers tasks for quick selection. Refreshes the active project's next step. |
| `/hello` | Morning routine. Creates daily log, carries over unchecked items from the prior day. |
| `/monthly-billing` | Generate and push billing data for the previous month to the Billing Master sheet. |
| `/notion-new` | Creates a Notion task and starts a Toggl timer in one flow. |
| `/notion-now` | Set the current Notion task's due date to now (rounded to previous half-hour, 1-hour window). |
| `/od-go` | Unified work start. Resolves client via fuzzy match, searches Notion for related tasks, starts internal timer. |
| `/od-stop` | Unified work stop. Stops the running timer, writes justified notes (bullets must account for billed duration), updates the dashboard card's next step, and logs a dated toggle block to the linked Notion task. `backfill` mode does a one-shot historical sync of all prior entries. |
| `/card-update` | Update a project card from the CLI. Auto-detects project from the current tmux session, shows card state, accepts freeform updates ("next step is X, status wfhuman"). Optional `--sync` flag triggers full AI-powered sync (Gmail + Notion + analysis) before prompting. |
| `/od-next-steps` | Research and set a project's next step from timers, Notion, and notes. Accepts a project name/ID, or `--all` for a full scan. |
| `/od-sync` | Sync all Claude Code configs and settings to Google Drive for backup. |
| `/roundup` | Project priority roundup. Scores and ranks open projects by urgency, refreshes next steps for top picks, lets you start via `/od-go`. |
| `/timer-merge` | Merge duplicate timers for the same client/project into one consolidated entry. |
| `/timer-start` | Start an internal time entry with client, task, division, and billable prompts. (Primitive — `/od-go` is the preferred entrypoint.) |
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

### Card Sync

The dashboard's per-card sync button (or `/card-update --sync`) triggers an AI-powered refresh that pulls from multiple sources, analyzes the context, and pushes updates back:

```
  Sync triggered (per card)
      |
      +---> If no notion_id: search Notion for matching task
      |     (by project name, then company name as fallback)
      |     Auto-link if found
      |
      +---> Notion API: fetch task status, todos, comments
      +---> Gmail API: search recent emails (exact phrase match on
      |     company name + sender domain, scoped to inbox and
      |     ~Linnflux Cloud Solutions label)
      |
      v
  Claude Haiku: analyze project context + emails + Notion
      |
      +---> Update next_step in SQLite if AI recommends a change
      +---> Append change requests to Notion task as dated toggle blocks
      |
      v
  Return results to dashboard (email links, change requests, reasoning)
```

The Gmail search uses a multi-query strategy with exact phrase matching: quoted company name, quoted short name (if 5+ characters), and a derived sender domain pattern. All queries are scoped to `{in:inbox label:~linnflux-cloud-solutions}` to match the Operator's email workflow. OAuth credentials are shared with the Google Workspace MCP server — no separate auth setup required.

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

## Email Handling

OpenDia treats outbound email with the same care as destructive shell commands — every message goes through a draft-first workflow with explicit AI disclosure and a pinned signature.

**Drafts only.** Claude never calls `gmail_send` directly. All composition goes through `gmail_create_draft`, which saves to Gmail Drafts for Operator review and manual send from the Gmail UI. This keeps a human in the loop on every outbound message, preserves last-minute editing, and prevents accidental sends.

**AI disclosure.** Every draft carries the line *"AI was used in the drafting of this message."* rendered as small italic text at the top of the signature block. Recipients of a Linnflux message always know when AI participated in the drafting.

**Pinned signature.** The Gmail v1 API only returns the current default new-message signature for the primary `sendAs` alias — it cannot enumerate named alternates. To decouple Claude's output from whatever the Operator has set as the Gmail Web compose default, the signature HTML is pinned to a local file (`~/.claude/mcp-credentials/google-workspace/signature.html`) that the Google Workspace MCP reads directly. The Operator can switch their Gmail default signature freely without affecting what Claude applies to drafts. If the file is missing, drafts are created with no signature block at all — no silent fallback to the wrong signature.

### Inbox Pipeline

Labeling a Gmail message **"OpenDia Inbox"** is all it takes to kick off a fully automated work session. A cron job runs every 5 minutes and handles everything from there.

```
Operator labels email "OpenDia Inbox"
          │
          ▼
  ┌── cron (*/5 min) ──────────────────────────────────────────────┐
  │  Stage A — Classify (one dispatch per thread, not per message) │
  │    Groups labeled messages by threadId. For each unique thread:│
  │      Fetches full thread (threads.get) to get all messages     │
  │      Identifies latest inbound msg (no SENT label = customer)  │
  │      Builds thread history from prior messages for context     │
  │    Claude Haiku classifies the latest customer message and     │
  │    extracts: client, division, priority, directive, short slug,│
  │      requires_server_access (bool),                            │
  │      estimated_minutes (int — Haiku's work-time estimate)      │
  │    Thread history is passed to Haiku so prompt_text reflects   │
  │      the full conversation, not just the last message          │
  │    Checks client alias table first (learned mappings           │
  │      override Haiku — e.g. @deanvaughnlearning.com →           │
  │      "Memory Sports")                                          │
  │    Matches result to an existing project via match_project()   │
  │      → sets project_id FK. If no match, auto-creates a new    │
  │      project in wfhuman status ("Auto-created from inbox: …") │
  │    Writes one inbox_items row, relabels ALL thread messages     │
  │      to "OpenDia Processed" (prevents duplicate dispatches)    │
  │                                                                │
  │  Stage B — Dispatch                                            │
  │    ┌─ requires_server_access? ──────────────────────────────┐  │
  │    │  YES → hold at "Classified", move out of queue         │  │
  │    │         SERVER badge on dashboard card                  │  │
  │    │         Operator approves via "Approve & Dispatch"      │  │
  │    │           → dashboard verifies Lightsail instance       │  │
  │    │           → takes pre-work snapshot (AWS CLI)           │  │
  │    │           → spawns session with SERVER_WORK_PREAMBLE    │  │
  │    └─ NO  → Opens time ledger entry (Eastern-time marker,   │  │
  │             estimated_minutes from Stage A, billable flag)    │  │
  │             Stores timer_marker on inbox_items row            │  │
  │             Builds context header (timers + project match)    │  │
  │             Assembles full prompt (context + directive)        │  │
  │             Spawns detached tmux session: claude --print       │  │
  │             Output → ~/OpenDia/logs/sessions/<session>.log    │  │
  │             On exit 0: DB status → done                       │  │
  │             On exit ≠0: stub-close timer + DB status → error  │  │
  └────────────────────────────────────────────────────────────────┘
          │
          ▼
  Claude session finish steps (IN ORDER):
    1. Edit ledger file — fill in end:, duration:, notes:
       (justified bullets ~1 per 10-15 min; may revise estimated_minutes)
    2. Delete timer state file
    3. Create Gmail DRAFT reply to original sender
  (draft never sent — Operator reviews and sends manually)
```

**Dashboard Inbox view.** Every processed email appears as a card in the OpenDia dashboard under the Inbox tab. Cards show sender, subject, client/division badges, priority, status (Classified → Running → Done / Error / Dismissed), the extracted directive, and the name of the linked project. Clicking a card opens a modal with full detail, including a clickable "→ Project Name" link that jumps to the project's card modal. Dismissing an inbox item soft-deletes it (sets `status = dismissed`) rather than hard-deleting, preserving the project link and audit trail.

**Operator correction.** Classification isn't always right — a sender's email domain may not match the client name in the working relationship. The modal makes every classification field editable: client, division, priority, and a notes textarea. Saving a corrected client name offers a one-click **"Save as alias"** prompt that writes to a `client_aliases` table so all future emails from that domain are classified correctly without touching Haiku.

**Re-dispatch.** If Claude's first attempt was wrong (bad context, wrong client, or just a task that needs more guidance), add operator notes in the modal and click **↺ Re-dispatch**. The old session is killed, any open timer is stub-closed with a "Superseded by re-dispatch" note, a fresh one spawns with the corrected classification and your notes prepended as an `## Operator correction` block, and the card updates with the new session name. Re-dispatch is not available for server-work items — those must go through the approval gate.

**Server-work safety gate.** Emails that require SSH or website changes are flagged with an amber **SERVER** badge and held at "Classified" — they never auto-dispatch. To release one, open the card, enter the Lightsail instance name, and click **Approve & Dispatch**. The dashboard verifies the instance exists via AWS CLI, takes a Lightsail snapshot, then spawns the Claude session with a stricter preamble that names the verified instance and snapshot and requires Claude to confirm the target before any write. This enforces the pre-work snapshot requirement from the server safety policy.

**Error diagnosis.** When a session fails, the last 40 lines of Claude's output are stored in the DB and shown directly on the card — no need to dig through logs or attach to a dead tmux session.

**Session lifecycle.** Completed `inbox-*` tmux sessions stay alive so the Operator can attach and review or continue the conversation. A weekly cron (`inbox-sweep.sh`) kills sessions that have been inactive for more than 7 days. Attaching to a session resets its activity clock.

**Time tracking.** Every dispatch opens a time ledger entry identical in format to entries created by `/od-go`. The entry uses `estimated_minutes` from Stage A as the initial bill duration; Claude may revise it at close time (the justified notes must support whatever number is left). Internal work (`client_hint: "Linnflux"`) is flagged `billable: false` and excluded from the monthly billing run automatically — same filter as `/od-go` internal work. If the Claude session exits non-zero, a stub entry is written automatically so no open timer is left dangling.

**Controls.**
- Pause the pipeline: `touch ~/OpenDia/inbox.disabled`
- Resume: `rm ~/OpenDia/inbox.disabled`
- Replay a failed item: re-apply the `OpenDia Inbox` label in Gmail
- View session logs: `~/OpenDia/logs/sessions/<session-name>.log`
- View alias table: `python3 ~/OpenDia/scripts/inbox_db.py dump-aliases`
- Stub-close a stale timer manually: `python3 ~/OpenDia/scripts/inbox_db.py close-timer-stub <marker> <state_file> <ledger_file> <note>`

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

### 9. Dashboard tmux launcher (recommended)

The dashboard's "Launch" button on project cards can open a terminal on your local machine and SSH directly into the project's tmux session. Without this setup, it falls back to copying the SSH command to your clipboard.

**On each client machine:**

1. Copy the handler script from the server (or repo) and install the desktop file:

```bash
# If your local machine has the repo cloned:
cp ~/OpenDia/repo/scripts/opendia-handler.sh ~/OpenDia/scripts/
cp ~/OpenDia/repo/scripts/opendia-handler.desktop ~/.local/share/applications/

# Or copy directly from the server:
scp youruser@opendia:~/OpenDia/repo/scripts/opendia-handler.sh ~/OpenDia/scripts/
scp youruser@opendia:~/OpenDia/repo/scripts/opendia-handler.desktop ~/.local/share/applications/

chmod +x ~/OpenDia/scripts/opendia-handler.sh
```

2. Edit `~/.local/share/applications/opendia-handler.desktop` and update the `Exec` path if your OpenDia directory or username differs from the default:

```bash
# Automatically fix the path for your user
sed -i "s|/home/linnflux/OpenDia/scripts/|$HOME/OpenDia/scripts/|" ~/.local/share/applications/opendia-handler.desktop
```

3. Register the protocol handler and rebuild the MIME database:

```bash
xdg-mime default opendia-handler.desktop x-scheme-handler/opendia
update-desktop-database ~/.local/share/applications/
```

4. Optionally set environment variables if your username or hostname differ from the defaults (`linnflux` / `opendia`):

```bash
# Add to ~/.bashrc or ~/.profile
export OPENDIA_USER="youruser"
export OPENDIA_HOST="opendia"
```

5. **Browser setup** — the first time you click Launch, your browser will ask how to handle `opendia://` links:

   **Chromium / Chrome:** A dialog will ask to open the link with the handler. Check **"Always allow"** and confirm. Works out of the box.

   **Firefox / Firefox-based browsers (Zen, LibreWolf, etc.):** Firefox may not recognize the system protocol handler automatically. If clicking Launch does nothing:
   - Open `about:config` in Firefox
   - Search for `network.protocol-handler.expose.opendia`
   - If it doesn't exist, create a new **Boolean** entry: `network.protocol-handler.expose.opendia` = `false`
   - Click Launch again — Firefox will now prompt you to choose an application
   - Browse to `~/OpenDia/scripts/opendia-handler.sh`, select it, and check **"Always use this application"**

   > **Tip:** After changing browser handler settings, fully close and reopen the browser (not just refresh). Browsers cache protocol handler associations aggressively.

**Verify from terminal:** Run `xdg-open 'opendia://tmux/test'` — a terminal should open and attempt to SSH into the `test` tmux session.

**Verify from browser:** Open the dashboard, click a project card with a tmux session, and click Launch. If no protocol handler is registered, the button falls back to copying the SSH command to your clipboard.

### Full bootstrap

If you're migrating from an existing OpenDia instance that has already run `migrate-export.sh`, you can bootstrap everything at once:

```bash
bash ~/OpenDia/scripts/migrate-setup.sh
```

This installs all packages, pulls configs and data from Google Drive, builds MCP servers, creates the Python environment, and runs verification checks.

---

*Built by [Linnflux](https://linnflux.com) — a [Bedford AI](https://bedford.ai) project.*
