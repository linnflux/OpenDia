#!/usr/bin/env python3
"""
inbox_stage_b.py — Stage B: Dispatch emails from "OpenDia Queue" label.

For each queued message:
  1. Parse JSON payload
  2. Build context header (timers + project match)
  3. Spawn a fresh detached tmux session running: claude '<full_prompt>'
  4. Move message: OpenDia Queue → OpenDia Dispatched
  5. Append to daily log: timestamp | session | gmail_id | client

Deduplication via ~/.opendia-seen.txt (gmail_id append-only list).

Re-dispatch mode:
  python3 inbox_stage_b.py --redispatch <gmail_id>

  Reads the inbox_items row, kills any existing session, rebuilds the prompt
  using corrected classification fields from the DB, prepends operator notes
  as a correction block, and spawns a fresh session.
"""

import json
import logging
import os
import re
import shlex
import shutil
import subprocess
import sys
import traceback
from datetime import datetime
from pathlib import Path

# Resolve at startup so tmux sessions inherit the correct absolute path even
# when spawned from a minimal-PATH environment (e.g. dashboard systemd unit).
CLAUDE_BIN = shutil.which("claude") or str(Path.home() / ".local/bin/claude")

sys.path.insert(0, str(Path(__file__).parent))

from context_header import build_context_header
from inbox_db import (
    close_inbox_timer_stub,
    get_fluxcc_site,
    get_inbox_item_by_gmail_id,
    update_inbox_item,
)
from gmail_helper import (
    _load_service,
    download_attachments,
    extract_message_text,
    get_message_full,
    get_or_create_label,
    list_messages_with_label,
    modify_message_labels,
)

LOG_DIR = Path.home() / "OpenDia" / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

SEEN_FILE = Path.home() / "OpenDia" / ".inbox-seen.txt"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [stage-b] %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / f"inbox-{datetime.now():%Y-%m-%d}.log"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger(__name__)


def _load_seen() -> set:
    if not SEEN_FILE.exists():
        return set()
    return set(SEEN_FILE.read_text().splitlines())


def _mark_seen(gmail_id: str):
    with SEEN_FILE.open("a") as f:
        f.write(gmail_id + "\n")


def _make_session_name(ts: datetime, short_slug: str) -> str:
    slug = re.sub(r"[^a-z0-9\-]", "-", short_slug.lower())[:30].strip("-")
    return f"inbox-{ts:%Y%m%d-%H%M}-{slug}"


PREAMBLE = """\
## Inbox Session — Execution Mode

This session was dispatched automatically from a labeled Gmail message. \
You are authorized to proceed without plan mode or permission prompts.

Rules for this session:
- Do NOT enter plan mode. Execute directly.
- Do NOT ask for confirmation before using tools.
- The only write allowed outside of research is creating a Gmail draft reply.
- Do not send any email — draft only.
- Gmail draft formatting: use PLAIN TEXT only. Do NOT use markdown (**bold**, _italic_,
  # headings) — Gmail renders these as literal characters, not formatting.
- When replacing, updating, or removing a file on a website, search exhaustively for ALL
  references to the old file (grep the entire site directory, check the database for URLs/paths)
  before considering the task complete. Do not stop after finding the first instance.
- When done, stop and wait.

"""

FLUXCC_PREAMBLE = """\
## Inbox Session — FluxCC Change Request Mode

This session was dispatched to make changes to a FluxCC (Astro) client site.
You are authorized to proceed without plan mode or permission prompts.

Hosting model (important):
- FluxCC sites are Astro static sites deployed to Cloudflare Pages (NOT WordPress/Lightsail).
- Content lives in markdown frontmatter at src/content/pages/. Styles in src/styles/global.css.
- There is no server, database, or CMS. All changes are file edits committed to git.

Rules for this session:
- Do NOT enter plan mode. Execute directly.
- Do NOT push to the main branch. All changes go on a dev branch.
- Work in ~/FluxCC/<client-repo>/ — the CLAUDE.md there has the full workflow.
- After pushing the dev branch, report the preview URL back to the dashboard
  using the PATCH /api/inbox/:id/preview endpoint (see instructions in CLAUDE.md).
- Do not send any email — draft only.
- Gmail draft formatting: use PLAIN TEXT only. No markdown.
- Include the preview URL prominently in the Gmail draft.
- When replacing or removing files, search exhaustively for ALL references.
- When done, stop and wait.

"""

SERVER_WORK_PREAMBLE = """\
## Inbox Session — Server Work Mode

This session was dispatched after the operator reviewed and approved the task.

Rules for this session:
- Do NOT enter plan mode. Execute directly.
- Do NOT ask for confirmation before using tools.
- Before making any write to a server, STATE which Lightsail instance you are targeting
  and confirm it matches the client context in the directive below. If you are not certain
  which instance to target, STOP and draft a clarification reply instead of guessing.
- Before making ANY server write, take a Lightsail snapshot:
  1. Identify the correct Lightsail instance name for the client.
  2. Run: bash ~/OpenDia/scripts/lightsail_snapshot.sh <instance-name> <short-slug>
  3. Wait for the snapshot to complete successfully before proceeding.
  4. If the snapshot fails, STOP immediately and draft a reply explaining the failure
     instead of proceeding with server work.
- The only additional write allowed outside of server work is creating a Gmail draft reply.
- Do not send any email — draft only.
- Gmail draft formatting: use PLAIN TEXT only. Do NOT use markdown (**bold**, _italic_,
  # headings) — Gmail renders these as literal characters, not formatting.
- When replacing, updating, or removing a file on a website, search exhaustively for ALL
  references to the old file (grep the entire site directory, check the database for URLs/paths)
  before considering the task complete. Do not stop after finding the first instance.
- When done, stop and wait.

"""

OUTRO_TEMPLATE = """\
## Finish

When you have completed the work above, do these steps IN ORDER:

1. Close the timer for this session.
   - Ledger file: {ledger_file}
   - Marker: <!-- entry:{marker} -->
   - State file: {state_file}
   - Initial estimate: {estimated_minutes} minutes

   Use your Edit tool on the ledger file to replace the empty `end:`,
   `duration:`, and `notes:` lines under that marker with:
     end: <current Eastern time, format YYYY-MM-DDTHH:MM>
     duration: <Nm, or Nh Mm, rounded up>
     notes: | (YAML block scalar, 2-space indent)
       <justified bullets — roughly 1 per 10-15 minutes of billed time;
        describe what you did, files touched, commands run, decisions made>
       NEXT: <one-line next step if applicable>

   Then delete the state file: rm {state_file}

   If the work ended up substantively smaller or larger than the initial
   estimate, you MAY revise `estimated_minutes:` on the entry block to match
   reality — but the justified notes must prove out whatever number you
   leave behind. This matches the /od-stop convention.

2. Log your work to the dashboard project card.
   - Project ID: {project_id}
   - Dashboard API: http://localhost:8038

   If project_id is 0, skip this step.
   If the dashboard is unreachable, continue to the next step.

   a) Log the timer entry:
      curl -s -X POST http://localhost:8038/api/projects/{project_id}/log-timer \\
        -H 'Content-Type: application/json' \\
        -d '{{"start": "{marker}", "task": "{short_slug}", "duration": "<duration>", "notes": "<your justified notes>"}}'

   b) Update the next step. It must ALWAYS lead with a date — "YYYY-MM-DD: action"
      (or "YYYY-MM-DD HH:MM: action", 24h ET, when a real clock time is known);
      undated next_steps never reach the calendar. Waiting on someone -> today + 7
      days; scheduled event -> that date; work continuation -> next business day.
      curl -s -X PATCH http://localhost:8038/api/projects/{project_id} \\
        -H 'Content-Type: application/json' \\
        -d '{{"next_step": "<YYYY-MM-DD: your NEXT: line>"}}'

3. If you pushed a dev branch with a preview URL (FluxCC sessions), report it
   to the dashboard. Skip this step for all other task types.
   - Inbox item ID: {inbox_id}
   curl -s -X PATCH http://localhost:8038/api/inbox/{inbox_id}/preview \\
     -H 'Content-Type: application/json' \\
     -d '{{"dev_preview_url": "<preview_url>", "dev_branch": "<branch_name>", "repo_path": "<repo_dir_name>"}}'

4. Create the Gmail draft reply to {from_addr} (re: "{subject}") summarizing
   what you did and any next steps for the operator to review. Use the
   gmail_create_draft MCP tool. DO NOT SEND — draft only. Plain text only,
   no markdown (see rule in the preamble above).

5. Stop.
"""

OPERATOR_CORRECTION_TEMPLATE = """\
## Operator Correction

The automated classifier got something wrong. The operator has provided the following
correction — apply it to everything below:

{notes}

"""


def open_inbox_timer(client: str, division: str, task: str, estimated_minutes: int, billable: bool) -> dict:
    """
    Open a timer ledger entry for an inbox dispatch.
    Returns {"marker": str, "state_file": str, "ledger_file": str}.
    """
    result = subprocess.run(
        ["date", "+%Y-%m-%dT%H:%M"],
        env={**os.environ, "TZ": "America/New_York"},
        capture_output=True, text=True,
    )
    marker = result.stdout.strip()

    date_part = marker[:10]  # YYYY-MM-DD
    year = date_part[:4]
    month = date_part[5:7]
    time_dir = Path.home() / "OpenDia" / "Time" / year / month
    time_dir.mkdir(parents=True, exist_ok=True)
    ledger_path = time_dir / f"{date_part}.md"

    if not ledger_path.exists():
        ledger_path.write_text(f"# Time Entries - {date_part}\n\n")

    billable_str = "true" if billable else "false"
    entry_block = (
        f"\n---\n"
        f"<!-- entry:{marker} -->\n"
        f"client: {client}\n"
        f"project:\n"
        f"division: {division}\n"
        f"task: {task}\n"
        f"estimated_minutes: {estimated_minutes}\n"
        f"start: {marker}\n"
        f"end:\n"
        f"duration:\n"
        f"billable: {billable_str}\n"
        f"notes:\n"
        f"---\n"
    )
    with ledger_path.open("a") as f:
        f.write(entry_block)

    marker_safe = marker.replace(":", "-")
    state_path = Path.home() / "OpenDia" / "Time" / f".timer-{marker_safe}.json"

    # Guard against same-minute collisions (two threads in the same cron tick)
    counter = 2
    base_marker = marker
    base_marker_safe = marker_safe
    while state_path.exists():
        marker = f"{base_marker}-{counter}"
        marker_safe = f"{base_marker_safe}-{counter}"
        state_path = Path.home() / "OpenDia" / "Time" / f".timer-{marker_safe}.json"
        counter += 1

    # If marker changed, patch the ledger entry we already appended
    if marker != base_marker:
        content = ledger_path.read_text()
        content = content.replace(f"<!-- entry:{base_marker} -->", f"<!-- entry:{marker} -->", 1)
        content = content.replace(f"start: {base_marker}", f"start: {marker}", 1)
        ledger_path.write_text(content)
        log.info(f"  Timer collision at {base_marker}, renamed to {marker}")

    state_data = {
        "client": client,
        "project": "",
        "division": division,
        "task": task,
        "billable": billable,
        "start": marker,
        "file": str(ledger_path),
        "marker": marker,
    }
    state_path.write_text(json.dumps(state_data, indent=2))

    log.info(f"  Timer opened: {marker} ({ledger_path})")
    return {
        "marker": marker,
        "state_file": str(state_path),
        "ledger_file": str(ledger_path),
    }


def _close_stale_timer(marker: str, reason: str):
    """Close a stale timer state file from a prior run. Silently ignores missing files."""
    try:
        marker_safe = marker.replace(":", "-")
        state_file_path = Path.home() / "OpenDia" / "Time" / f".timer-{marker_safe}.json"
        if not state_file_path.exists():
            return
        state_data = json.loads(state_file_path.read_text())
        ledger_file = state_data.get("file", "")
        close_inbox_timer_stub(marker, str(state_file_path), ledger_file, reason)
    except Exception:
        pass


def _spawn_session(gmail_id: str, client_hint: str, division_hint: str,
                   from_addr: str, subject: str, prompt_text: str,
                   short_slug: str, estimated_minutes: int = 15,
                   operator_notes: str = None,
                   preamble: str = None,
                   attachment_meta_json: str = None,
                   project_id: int = 0,
                   inbox_id: int = 0,
                   working_dir: Path = None) -> str:
    """
    Open a timer, build the full prompt, spawn a detached tmux session, return session name.
    Pass preamble to override the default PREAMBLE (e.g. for server-work sessions).
    Pass working_dir to change the tmux session's starting directory (default: ~/OpenDia).
    """
    effective_preamble = preamble if preamble is not None else PREAMBLE
    context = build_context_header(client_hint, division_hint, days=7)

    # Open timer before spawning — writes ledger entry and state file
    billable = client_hint.strip().lower() != "linnflux"
    timer_info = open_inbox_timer(client_hint, division_hint, short_slug, estimated_minutes, billable)
    marker = timer_info["marker"]
    state_file = timer_info["state_file"]
    ledger_file = timer_info["ledger_file"]

    # Store timer_marker so redispatch/server-dispatch can find and close this entry
    update_inbox_item(gmail_id, timer_marker=marker)

    outro = OUTRO_TEMPLATE.format(
        from_addr=from_addr,
        subject=subject,
        ledger_file=ledger_file,
        marker=marker,
        state_file=state_file,
        estimated_minutes=estimated_minutes,
        project_id=project_id,
        short_slug=short_slug,
        inbox_id=inbox_id,
    )

    correction_block = ""
    if operator_notes and operator_notes.strip():
        correction_block = OPERATOR_CORRECTION_TEMPLATE.format(notes=operator_notes.strip())

    # Download attachments if present
    attachment_section = ""
    if attachment_meta_json:
        try:
            att_list = json.loads(attachment_meta_json) if isinstance(attachment_meta_json, str) else attachment_meta_json
            if att_list:
                service = _load_service()
                dest_dir = Path.home() / "OpenDia" / "inbox-attachments" / gmail_id
                paths = download_attachments(service, gmail_id, att_list, str(dest_dir))
                if paths:
                    attachment_section = "\n## Attachments\n\nThe following files have been downloaded for this task:\n"
                    for p in paths:
                        attachment_section += f"- {p}\n"
                    attachment_section += "\n"
                    log.info(f"  Downloaded {len(paths)} attachment(s) to {dest_dir}")
        except Exception as e:
            log.warning(f"  Attachment download failed: {e}")

    full_prompt = (
        f"{effective_preamble}"
        f"{correction_block}"
        f"{context}\n\n"
        f"## Directive\n\n{prompt_text}\n\n"
        f"{attachment_section}"
        f"---\n\n"
        f"{outro}"
    )

    ts = datetime.now()
    session_name = _make_session_name(ts, short_slug)
    work_dir = str(working_dir) if working_dir is not None else str(Path.home() / "OpenDia")
    escaped_prompt = shlex.quote(full_prompt)

    # Per-session output log so errors are diagnosable after the session exits
    session_log_dir = LOG_DIR / "sessions"
    session_log_dir.mkdir(parents=True, exist_ok=True)
    session_log = session_log_dir / f"{session_name}.log"
    escaped_log = shlex.quote(str(session_log))

    scripts_dir = shlex.quote(str(Path(__file__).parent))
    db_script = f"python3 {scripts_dir}/inbox_db.py"
    escaped_marker = shlex.quote(marker)
    escaped_state = shlex.quote(state_file)
    escaped_ledger = shlex.quote(ledger_file)
    shell_cmd = (
        f"{shlex.quote(CLAUDE_BIN)} --print --dangerously-skip-permissions {escaped_prompt} "
        f"> {escaped_log} 2>&1 ; "
        f"EXIT=$? ; cat {escaped_log} ; "
        f"if [ $EXIT -eq 0 ] ; then {db_script} done {shlex.quote(gmail_id)} ; "
        f"else {db_script} close-timer-stub {escaped_marker} {escaped_state} {escaped_ledger} {escaped_log} ; "
        f"{db_script} error {shlex.quote(gmail_id)} {escaped_log} ; fi"
    )

    cmd = [
        "tmux", "new-session", "-d",
        "-s", session_name,
        "-c", work_dir,
        shell_cmd,
    ]

    log.info(f"  Spawning tmux session: {session_name}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"tmux failed: {result.stderr}")

    # Add log viewer window (window 1, named "log")
    subprocess.run([
        "tmux", "new-window", "-t", f"{session_name}:1",
        "-n", "log",
        "-c", work_dir,
        f"tail -f {str(session_log)} 2>/dev/null; less +G {str(session_log)}",
    ], capture_output=True, text=True)
    # Return focus to window 0 so attaching lands on the main Claude window
    subprocess.run(["tmux", "select-window", "-t", f"{session_name}:0"],
                   capture_output=True, text=True)

    return session_name


def run():
    log.info("Stage B starting")
    service = _load_service()

    queue_id = get_or_create_label(service, "OpenDia Queue")
    dispatched_id = get_or_create_label(service, "OpenDia Dispatched")
    error_id = get_or_create_label(service, "OpenDia Error")

    messages = list_messages_with_label(service, queue_id, max_results=25)
    log.info(f"Found {len(messages)} message(s) in 'OpenDia Queue'")

    seen = _load_seen()

    for stub in messages:
        msg_id = stub["id"]
        try:
            _dispatch_one(service, msg_id, seen, queue_id, dispatched_id, error_id)
        except Exception as e:
            log.error(f"Unhandled error on message {msg_id}: {e}\n{traceback.format_exc()}")
            try:
                modify_message_labels(service, msg_id, [error_id], [queue_id])
            except Exception:
                pass

    log.info("Stage B complete")


FLUXCC_RESOLVED_TEMPLATE = """\
## Resolved Site (authoritative — do NOT guess or pick a different repo/branch)

- Repo: ~/FluxCC/{repo_path}
- Work branch: {dev_branch} — create it from main if it doesn't exist;
  check it out and build on it if it does. Never any other branch name.
- CF Pages project: {cf_project} (preview will appear at a
  https://<branch-prefix>.{cf_project}.pages.dev URL after push)

"""


def _fluxcc_kwargs(division_hint: str, inbox_id: int, client_hint: str = "",
                   gmail_id: str = "") -> dict:
    """FluxCC items get the dev-branch preview workflow: preamble + ~/FluxCC cwd.

    Used by every dispatch path so redispatched items keep the workflow
    (previously only _dispatch_one selected it — see inbox-pipeline.md).

    When the client resolves in fluxcc_sites, repo_path and dev_branch are
    assigned deterministically here and written to the inbox item BEFORE the
    session spawns — the session is told which repo/branch to use rather than
    trusted to pick one.
    """
    if division_hint != "FluxCC":
        return {}
    kwargs = {
        "preamble": FLUXCC_PREAMBLE,
        "working_dir": Path.home() / "FluxCC",
        "inbox_id": inbox_id,
    }
    site = get_fluxcc_site(client_hint)
    if site and site.get("repo_path") and inbox_id:
        item = get_inbox_item_by_gmail_id(gmail_id) if gmail_id else None
        repo_path = (item or {}).get("repo_path") or site["repo_path"]
        dev_branch = (item or {}).get("dev_branch") or f"change/{site['slug']}-{inbox_id}"
        if gmail_id:
            update_inbox_item(gmail_id, repo_path=repo_path, dev_branch=dev_branch)
        kwargs["preamble"] = FLUXCC_PREAMBLE + FLUXCC_RESOLVED_TEMPLATE.format(
            repo_path=repo_path,
            dev_branch=dev_branch,
            cf_project=site.get("cf_project") or site["slug"],
        )
    return kwargs


def _dispatch_one(
    service, msg_id: str, seen: set, queue_id: str, dispatched_id: str, error_id: str
):
    log.info(f"Dispatching message {msg_id}")

    full = get_message_full(service, msg_id)
    if not full:
        raise ValueError("Could not fetch message")

    _, _, _, body = extract_message_text(full)

    try:
        payload = json.loads(body.strip())
    except json.JSONDecodeError as e:
        raise ValueError(f"Could not parse queue payload JSON: {e}")

    gmail_id = payload.get("gmail_id", msg_id)

    if gmail_id in seen:
        log.info(f"  Already dispatched {gmail_id}, skipping")
        modify_message_labels(service, msg_id, [dispatched_id], [queue_id])
        return

    # Server-work items require operator approval — hold in DB, move out of queue
    if payload.get("requires_server_access"):
        log.info(f"  requires_server_access=True — holding for operator approval: {gmail_id}")
        modify_message_labels(service, msg_id, [dispatched_id], [queue_id])
        return

    client_hint = payload.get("client_hint", "unknown")
    division_hint = payload.get("division_hint", "")
    prompt_text = payload.get("prompt_text", "")
    short_slug = payload.get("short_slug", "task")
    from_addr = payload.get("from", "")
    subject = payload.get("subject", "")
    estimated_minutes = payload.get("estimated_minutes", 15)
    project_id = payload.get("project_id", 0)

    # Look up inbox_id (DB primary key) for the outro preview URL step
    inbox_item = get_inbox_item_by_gmail_id(gmail_id)
    inbox_id = inbox_item["id"] if inbox_item else 0

    session_name = _spawn_session(
        gmail_id=gmail_id,
        client_hint=client_hint,
        division_hint=division_hint,
        from_addr=from_addr,
        subject=subject,
        prompt_text=prompt_text,
        short_slug=short_slug,
        estimated_minutes=estimated_minutes,
        project_id=project_id,
        **_fluxcc_kwargs(division_hint, inbox_id, client_hint, gmail_id),
    )

    log.info(f"  Session spawned: {session_name}")

    update_inbox_item(gmail_id, status="dispatched", session_name=session_name)
    _mark_seen(gmail_id)
    seen.add(gmail_id)
    modify_message_labels(service, msg_id, [dispatched_id], [queue_id])
    log.info(f"  Relabeled → OpenDia Dispatched")

    ts = datetime.now()
    log_line = f"{ts.isoformat()} | {session_name} | {gmail_id} | {client_hint}\n"
    with (LOG_DIR / f"inbox-{ts:%Y-%m-%d}.log").open("a") as f:
        f.write(log_line)
    log.info(f"  Logged: {log_line.strip()}")


def redispatch(gmail_id: str):
    """
    Re-dispatch an inbox item by gmail_id. Reads corrected fields from inbox_items,
    kills any existing session, spawns a fresh one with operator notes prepended.
    """
    log.info(f"Re-dispatching gmail_id={gmail_id}")

    item = get_inbox_item_by_gmail_id(gmail_id)
    if not item:
        raise ValueError(f"No inbox item found for gmail_id={gmail_id}")

    # Kill the old session if it still exists
    old_session = item.get("session_name")
    if old_session:
        kill = subprocess.run(
            ["tmux", "kill-session", "-t", old_session],
            capture_output=True, text=True
        )
        if kill.returncode == 0:
            log.info(f"  Killed old session: {old_session}")
        else:
            log.info(f"  Old session already gone: {old_session}")

    # Close stale timer left open by the prior run (if any)
    old_marker = item.get("timer_marker")
    if old_marker:
        _close_stale_timer(old_marker, "Superseded by re-dispatch")
        log.info(f"  Closed stale timer: {old_marker}")

    estimated_minutes = item.get("estimated_minutes") or 15

    session_name = _spawn_session(
        gmail_id=gmail_id,
        client_hint=item.get("client_hint", "unknown"),
        division_hint=item.get("division_hint", ""),
        from_addr=item.get("from_addr", ""),
        subject=item.get("subject", ""),
        prompt_text=item.get("prompt_text", ""),
        short_slug=item.get("short_slug", "task"),
        estimated_minutes=estimated_minutes,
        operator_notes=item.get("notes"),
        attachment_meta_json=item.get("attachment_meta"),
        project_id=item.get("project_id") or 0,
        **_fluxcc_kwargs(item.get("division_hint", ""), item.get("id") or 0,
                         item.get("client_hint", ""), gmail_id),
    )

    log.info(f"  New session spawned: {session_name}")

    ts = datetime.now()
    redispatch_note = f"\n[redispatched {ts:%H:%M}]"
    existing_notes = item.get("notes") or ""
    new_notes = existing_notes + redispatch_note

    update_inbox_item(
        gmail_id,
        status="dispatched",
        session_name=session_name,
        notes=new_notes,
        error_text=None,
    )

    log_line = f"{ts.isoformat()} | {session_name} | {gmail_id} | {item.get('client_hint')} [redispatch]\n"
    with (LOG_DIR / f"inbox-{ts:%Y-%m-%d}.log").open("a") as f:
        f.write(log_line)
    log.info(f"  Logged: {log_line.strip()}")


def server_work_dispatch(gmail_id: str):
    """
    Dispatch a server-work inbox item with a dedicated server preamble.
    Called via --server-dispatch after the operator approves via the dashboard.
    """
    log.info(f"Server-work dispatch gmail_id={gmail_id}")

    item = get_inbox_item_by_gmail_id(gmail_id)
    if not item:
        raise ValueError(f"No inbox item found for gmail_id={gmail_id}")

    # Kill old session if it still exists
    old_session = item.get("session_name")
    if old_session:
        kill = subprocess.run(
            ["tmux", "kill-session", "-t", old_session],
            capture_output=True, text=True
        )
        if kill.returncode == 0:
            log.info(f"  Killed old session: {old_session}")
        else:
            log.info(f"  Old session already gone: {old_session}")

    # Close stale timer left open by the prior run (if any)
    old_marker = item.get("timer_marker")
    if old_marker:
        _close_stale_timer(old_marker, "Superseded by server-dispatch")
        log.info(f"  Closed stale timer: {old_marker}")

    estimated_minutes = item.get("estimated_minutes") or 15

    session_name = _spawn_session(
        gmail_id=gmail_id,
        client_hint=item.get("client_hint", "unknown"),
        division_hint=item.get("division_hint", ""),
        from_addr=item.get("from_addr", ""),
        subject=item.get("subject", ""),
        prompt_text=item.get("prompt_text", ""),
        short_slug=item.get("short_slug", "task"),
        estimated_minutes=estimated_minutes,
        operator_notes=item.get("notes"),
        preamble=SERVER_WORK_PREAMBLE,
        attachment_meta_json=item.get("attachment_meta"),
        project_id=item.get("project_id") or 0,
    )

    log.info(f"  Server-work session spawned: {session_name}")

    ts = datetime.now()
    server_note = f"\n[server-dispatch {ts:%H:%M}]"
    existing_notes = item.get("notes") or ""
    new_notes = existing_notes + server_note

    update_inbox_item(
        gmail_id,
        status="dispatched",
        session_name=session_name,
        notes=new_notes,
        error_text=None,
    )

    log_line = (
        f"{ts.isoformat()} | {session_name} | {gmail_id} | "
        f"{item.get('client_hint')} [server-dispatch]\n"
    )
    with (LOG_DIR / f"inbox-{ts:%Y-%m-%d}.log").open("a") as f:
        f.write(log_line)
    log.info(f"  Logged: {log_line.strip()}")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--redispatch":
        redispatch(sys.argv[2])
    elif len(sys.argv) == 3 and sys.argv[1] == "--server-dispatch":
        server_work_dispatch(sys.argv[2])
    else:
        run()
