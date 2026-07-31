#!/usr/bin/env python3
"""
inbox_stage_a.py — Stage A: Classify emails from "OpenDia Inbox" label.

For each labeled thread (not per-message):
  1. Fetch full thread via threads.get to get all messages + SENT labels
  2. Find latest inbound (non-SENT) message — that's the one to act on
  3. Build thread history from all prior messages for Haiku context
  4. Classify with classify_email.py (Anthropic Haiku)
  5. Insert one queue item using the latest inbound message's ID
  6. Relabel ALL labeled messages in the thread: OpenDia Inbox → OpenDia Processed
  7. On any failure: move all labeled messages to OpenDia Error, log, continue

Designed to be called by inbox-tick.sh. Exits 0 even on per-thread failures.
"""

import json
import logging
import os
import sys
import traceback
from datetime import datetime
from pathlib import Path

# Allow importing siblings
sys.path.insert(0, str(Path(__file__).parent))

from classify_email import classify_email
from inbox_db import (
    create_inbox_item,
    update_inbox_item,
    ensure_project_for_inbox,
    lookup_alias,
)
from gmail_helper import (
    _load_service,
    create_draft,
    extract_attachment_meta,
    extract_message_text,
    get_message_full,
    get_or_create_label,
    get_thread_messages,
    insert_message,
    list_messages_with_label,
    modify_message_labels,
    send_email,
)

QUEUE_ADDR = "opendia-queue@linnflux.com"

# The public client change-request address. Anything arriving here is untrusted
# input from outside the company, so it is held to a stricter rule than mail sent
# to Nick directly: the sender must already be a known client contact.
CHANGES_ADDR = "changes@flux.cc"
ADDRESSED_TO_HEADERS = ("to", "cc", "delivered-to", "x-original-to", "x-forwarded-to")

LOG_DIR = Path.home() / "OpenDia" / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [stage-a] %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / f"inbox-{datetime.now():%Y-%m-%d}.log"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger(__name__)


def run():
    log.info("Stage A starting")
    service = _load_service()

    # Resolve label IDs (creates them if missing)
    inbox_id = get_or_create_label(service, "OpenDia Inbox")
    processed_id = get_or_create_label(service, "OpenDia Processed")
    error_id = get_or_create_label(service, "OpenDia Error")

    stubs = list_messages_with_label(service, inbox_id, max_results=50)
    log.info(f"Found {len(stubs)} message stub(s) in 'OpenDia Inbox'")

    # Group by threadId — one dispatch per thread regardless of how many
    # messages in the thread carry the "OpenDia Inbox" label.
    thread_map: dict[str, list[dict]] = {}
    for stub in stubs:
        tid = stub.get("threadId") or stub.get("id")
        thread_map.setdefault(tid, []).append(stub)

    log.info(f"Grouped into {len(thread_map)} unique thread(s)")

    for thread_id, thread_stubs in thread_map.items():
        try:
            _process_thread(service, thread_id, thread_stubs, inbox_id, processed_id, error_id)
        except Exception as e:
            log.error(f"Unhandled error on thread {thread_id}: {e}\n{traceback.format_exc()}")
            for stub in thread_stubs:
                try:
                    modify_message_labels(service, stub["id"], [error_id], [inbox_id])
                except Exception:
                    pass

    log.info("Stage A complete")


def _addressed_to_changes(msg: dict) -> bool:
    """True if this message was sent to the public changes@ address."""
    headers = msg.get("payload", {}).get("headers", [])
    for h in headers:
        if h.get("name", "").lower() in ADDRESSED_TO_HEADERS:
            if CHANGES_ADDR in (h.get("value") or "").lower():
                return True
    return False


def _park_unknown_sender(service, thread_id, stubs, msg_id, from_addr, subject,
                         body, inbox_id, processed_id):
    """Record an unrecognised changes@ sender and tell Nick. Never dispatches.

    Anyone on the internet can email changes@flux.cc. Dispatch runs a Claude
    session against a client repo, so an unknown sender must not reach it — the
    message is recorded, surfaced, and left for a human.
    """
    create_inbox_item(
        gmail_id=msg_id, thread_id=thread_id, from_addr=from_addr, subject=subject,
        client_hint="unknown", division_hint="FluxCC", priority="normal",
        short_slug=None, prompt_text=None,
        requires_server_access=False, estimated_minutes=0,
        project_hint="unknown", project_id=None,
    )
    update_inbox_item(msg_id, status="unknown_sender")
    log.warning(f"  UNKNOWN SENDER on {CHANGES_ADDR}: {from_addr!r} — parked, not dispatched")

    excerpt = (body or "").strip()
    if len(excerpt) > 800:
        excerpt = excerpt[:800] + "\n[...truncated]"
    draft_body = (
        f"A message arrived at {CHANGES_ADDR} from an address that is not a known "
        f"client contact. It was NOT dispatched and no work has been done.\n\n"
        f"From:    {from_addr}\n"
        f"Subject: {subject}\n\n"
        f"--- message ---\n{excerpt}\n--- end ---\n\n"
        f"If this is a real client contact, authorize them:\n"
        f"  curl -X POST http://localhost:8038/api/client-aliases \\\n"
        f"    -H 'Content-Type: application/json' \\\n"
        f"    -d '{{\"match_type\":\"email\",\"match_value\":\"{from_addr}\","
        f"\"client_hint\":\"<client-slug>\",\"division_hint\":\"FluxCC\"}}'\n"
        f"then move this Gmail thread's label back to \"OpenDia Inbox\" — Stage A will\n"
        f"reprocess it on the next tick and it will classify normally.\n\n"
        f"If it is not, dismiss the item in the dashboard inbox tab.\n"
    )
    try:
        create_draft(service, "nick@linnflux.com",
                     f"[flux.cc] Unknown sender at changes@: {from_addr}", draft_body)
    except Exception as e:
        log.error(f"  could not draft unknown-sender notice: {e}")

    for stub in stubs:
        try:
            modify_message_labels(service, stub["id"], [processed_id], [inbox_id])
        except Exception:
            pass


def _process_thread(
    service, thread_id: str, stubs: list[dict],
    inbox_id: str, processed_id: str, error_id: str
):
    log.info(f"Processing thread {thread_id} ({len(stubs)} stub(s))")

    # Fetch all messages in the thread with full detail (including labelIds)
    thread_msgs = get_thread_messages(service, thread_id)

    if not thread_msgs:
        # Degrade gracefully: fall back to fetching the first stub's message only
        log.warning(f"  threads.get failed for {thread_id}, falling back to single-message fetch")
        full = get_message_full(service, stubs[0]["id"])
        if not full:
            raise ValueError(f"Could not fetch any message for thread {thread_id}")
        thread_msgs = [full]

    # Identify inbound messages: SENT label = sent by us, absent = received from customer
    inbound_msgs = [m for m in thread_msgs if "SENT" not in m.get("labelIds", [])]

    if not inbound_msgs:
        # Thread is entirely outbound — we sent everything, no customer message to reply to
        log.info(f"  Thread {thread_id} is all-outbound, skipping dispatch")
        for stub in stubs:
            try:
                modify_message_labels(service, stub["id"], [processed_id], [inbox_id])
            except Exception:
                pass
        return

    # Act on the latest customer message; everything else is thread history
    latest_customer_msg = inbound_msgs[-1]
    prior_msgs = [m for m in thread_msgs if m["id"] != latest_customer_msg["id"]]
    thread_history = _format_thread_history(prior_msgs)

    subject, from_addr, date_str, body = extract_message_text(latest_customer_msg)
    log.info(f"  Subject: {subject!r}  From: {from_addr!r}  history_msgs: {len(prior_msgs)}")

    # changes@ is a public address, so the sender must be a known client contact.
    # Checked before classification so an unknown sender costs no model call.
    is_changes_intake = _addressed_to_changes(latest_customer_msg)
    changes_alias = lookup_alias(from_addr, subject) if is_changes_intake else None
    if is_changes_intake and not changes_alias:
        _park_unknown_sender(
            service, thread_id, stubs, latest_customer_msg["id"],
            from_addr, subject, body, inbox_id, processed_id,
        )
        return

    # Extract attachment metadata
    attachments = extract_attachment_meta(latest_customer_msg)
    if attachments:
        log.info(f"  Attachments: {[a['filename'] for a in attachments]}")
    attachment_meta_json = json.dumps(attachments) if attachments else None

    # Build attachments line for classifier
    attachments_line = ""
    if attachments:
        att_strs = []
        for a in attachments:
            size_kb = a.get("size", 0) // 1024
            att_strs.append(f"{a['filename']} ({size_kb}KB, {a['mime_type']})")
        attachments_line = "Attachments: " + ", ".join(att_strs)

    # Classify with full thread context
    result = classify_email(
        subject=subject,
        from_addr=from_addr,
        body=body,
        thread_history=thread_history,
        attachments_line=attachments_line,
    )
    log.info(f"  Classified: {result}")

    if is_changes_intake:
        # The alias table is authoritative for who the client is — not the
        # classifier, which reads attacker-supplied text. And a client change
        # request never legitimately needs server access, so the flag is refused
        # here regardless of what the classifier decided.
        result["client_hint"] = changes_alias["client_hint"]
        result["division_hint"] = changes_alias.get("division_hint") or result["division_hint"]
        if result.get("requires_server_access"):
            log.warning("  refusing requires_server_access on the changes@ path")
        result["requires_server_access"] = False

    # Ensure a project exists — auto-create in wfhuman if no match found
    project_id = result.get("project_id")
    if project_id is None:
        project_id = ensure_project_for_inbox(
            client_hint=result["client_hint"],
            division_hint=result["division_hint"],
            short_slug=result["short_slug"],
            subject=subject,
        )
        log.info(f"  Auto-created project id={project_id} for client={result['client_hint']!r}")

    # canonical gmail_id = latest inbound message ID (unique per thread dispatch)
    canonical_gmail_id = latest_customer_msg["id"]

    # Build queue payload (everything Stage B needs)
    payload = {
        "gmail_id": canonical_gmail_id,
        "thread_id": thread_id,
        "from": from_addr,
        "subject": subject,
        "date": date_str,
        "client_hint": result["client_hint"],
        "division_hint": result["division_hint"],
        "priority": result["priority"],
        "short_slug": result["short_slug"],
        "prompt_text": result["prompt_text"],
        "requires_server_access": result.get("requires_server_access", False),
        "estimated_minutes": result.get("estimated_minutes", 15),
        "project_hint": result.get("project_hint", "unknown"),
        "project_id": project_id,
        "thread_message_count": len(thread_msgs),
        "attachment_meta": attachment_meta_json,
    }

    queue_subject = f"[OD-QUEUE] {result['client_hint']} — {result['short_slug']}"
    queue_body = json.dumps(payload, indent=2)

    # Insert directly into OpenDia Queue label (no Gmail filter needed)
    queue_id = get_or_create_label(service, "OpenDia Queue")
    insert_message(service, subject=queue_subject, body=queue_body, label_ids=[queue_id])
    log.info(f"  Inserted to queue: {queue_subject!r}")

    # Write to DB
    create_inbox_item(
        gmail_id=canonical_gmail_id,
        thread_id=thread_id,
        from_addr=from_addr,
        subject=subject,
        client_hint=result["client_hint"],
        division_hint=result["division_hint"],
        priority=result["priority"],
        short_slug=result["short_slug"],
        prompt_text=result["prompt_text"],
        requires_server_access=result.get("requires_server_access", False),
        estimated_minutes=result.get("estimated_minutes", 15),
        project_hint=result.get("project_hint", "unknown"),
        project_id=project_id,
        attachment_meta=attachment_meta_json,
    )
    log.info(f"  Written to inbox_items DB (gmail_id={canonical_gmail_id})")

    if is_changes_intake:
        # create_inbox_item is INSERT OR IGNORE, so a message that was parked as
        # unknown_sender and is being reprocessed after the sender was authorized
        # would otherwise keep the parked status forever.
        update_inbox_item(canonical_gmail_id, status="classified")

    # Relabel ALL stubs in this thread: remove OpenDia Inbox, add OpenDia Processed
    for stub in stubs:
        try:
            modify_message_labels(service, stub["id"], [processed_id], [inbox_id])
        except Exception:
            pass
    log.info(f"  Relabeled {len(stubs)} stub(s) → OpenDia Processed")


def _format_thread_history(messages: list[dict]) -> str:
    """
    Format prior thread messages as a readable context block for Haiku.
    Oldest first. Caps total output at 3000 chars to stay token-efficient.
    """
    if not messages:
        return ""

    parts = []
    for msg in messages:
        _, from_addr, date_str, body = extract_message_text(msg)
        body_excerpt = body.strip()[:500]
        if len(body.strip()) > 500:
            body_excerpt += " [...]"
        parts.append(f"[From: {from_addr} | Date: {date_str}]\n{body_excerpt}")

    history = "\n\n".join(parts)
    if len(history) > 3000:
        history = history[:3000] + "\n[... history truncated ...]"
    return history


if __name__ == "__main__":
    run()
