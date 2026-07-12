#!/usr/bin/env python3
"""
gmail_helper.py — Thin Python Gmail client using existing OAuth token.

Mirrors the logic in repo/dashboard/server/gmail.js, ported to Python.
Uses google-auth + google-api-python-client against the same token file.

Token refresh is handled automatically via google.oauth2.credentials.Credentials.
"""

import json
import os
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

CREDENTIALS_PATH = Path.home() / ".claude" / "mcp-credentials" / "google-workspace.json"
TOKENS_PATH = Path.home() / ".claude" / "mcp-credentials" / "google-workspace" / "tokens.json"

# Scopes must match what was used when the token was originally authorized.
# Read from token file so refreshes don't fail due to scope mismatch.
# To add gmail.modify (needed for messages.modify/label changes), run:
#   python3 ~/OpenDia/scripts/inbox_setup_auth.py
SCOPES = None  # resolved dynamically from token file


def _load_service():
    """Load and return an authorized Gmail API service object."""
    creds_data = json.loads(CREDENTIALS_PATH.read_text())
    tokens_data = json.loads(TOKENS_PATH.read_text())

    installed = creds_data.get("installed") or creds_data.get("web") or creds_data

    # Use scopes from the token file so refresh requests don't fail.
    token_scopes = tokens_data.get("scope", "").split()
    if not token_scopes:
        token_scopes = [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/gmail.compose",
            "https://www.googleapis.com/auth/gmail.labels",
        ]

    creds = Credentials(
        token=tokens_data.get("access_token"),
        refresh_token=tokens_data.get("refresh_token"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=installed["client_id"],
        client_secret=installed["client_secret"],
        scopes=token_scopes,
    )

    # Set expiry if available
    if tokens_data.get("expiry_date"):
        import datetime
        creds.expiry = datetime.datetime.utcfromtimestamp(
            tokens_data["expiry_date"] / 1000
        )

    if not creds.valid:
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            # Persist refreshed token
            tokens_data["access_token"] = creds.token
            if creds.expiry:
                import calendar
                tokens_data["expiry_date"] = int(
                    calendar.timegm(creds.expiry.timetuple()) * 1000
                )
            TOKENS_PATH.write_text(json.dumps(tokens_data, indent=2))
        else:
            raise RuntimeError("Gmail credentials expired and cannot be refreshed")

    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def get_or_create_label(service, label_name: str) -> str:
    """Return the label ID for label_name, creating it if it doesn't exist."""
    result = service.users().labels().list(userId="me").execute()
    for lbl in result.get("labels", []):
        if lbl["name"].lower() == label_name.lower():
            return lbl["id"]
    # Create it
    new_label = service.users().labels().create(
        userId="me",
        body={
            "name": label_name,
            "labelListVisibility": "labelShow",
            "messageListVisibility": "show",
        },
    ).execute()
    return new_label["id"]


def list_messages_with_label(service, label_id: str, max_results: int = 25) -> list[dict]:
    """Return raw message stubs (id, threadId) for all messages with label_id."""
    result = service.users().messages().list(
        userId="me",
        labelIds=[label_id],
        maxResults=max_results,
    ).execute()
    return result.get("messages", [])


def get_message_full(service, message_id: str) -> dict | None:
    """Fetch full message including headers and body."""
    try:
        return service.users().messages().get(
            userId="me",
            id=message_id,
            format="full",
        ).execute()
    except Exception:
        return None


def get_thread_messages(service, thread_id: str) -> list[dict]:
    """
    Fetch all messages in a thread, sorted oldest-first by internalDate.
    Each message includes labelIds and full payload. Returns [] on failure.
    """
    try:
        thread = service.users().threads().get(
            userId="me", id=thread_id, format="full"
        ).execute()
        msgs = thread.get("messages", [])
        return sorted(msgs, key=lambda m: int(m.get("internalDate", 0)))
    except Exception:
        return []


def extract_message_text(msg: dict) -> tuple[str, str, str, str]:
    """
    Extract (subject, from_addr, date, body_text) from a full message dict.
    Returns plain text body (prefers text/plain over text/html).
    """
    import base64

    headers = msg.get("payload", {}).get("headers", [])
    subject = next((h["value"] for h in headers if h["name"] == "Subject"), "(no subject)")
    from_addr = next((h["value"] for h in headers if h["name"] == "From"), "")
    date = next((h["value"] for h in headers if h["name"] == "Date"), "")

    body = _extract_body(msg.get("payload", {}))
    return subject, from_addr, date, body


def _extract_body(payload: dict) -> str:
    """Recursively extract plain text body from message payload."""
    import base64

    mime = payload.get("mimeType", "")

    if mime == "text/plain":
        data = payload.get("body", {}).get("data", "")
        if data:
            return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
        return ""

    if mime == "text/html":
        # Fallback: strip HTML tags
        data = payload.get("body", {}).get("data", "")
        if data:
            html = base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
            import re
            return re.sub(r"<[^>]+>", " ", html)
        return ""

    # multipart: recurse into parts, prefer text/plain
    parts = payload.get("parts", [])
    plain_parts = [p for p in parts if p.get("mimeType") == "text/plain"]
    if plain_parts:
        return _extract_body(plain_parts[0])

    # Fall through all parts
    for part in parts:
        result = _extract_body(part)
        if result.strip():
            return result

    return ""


def modify_message_labels(
    service, message_id: str, add_labels: list[str], remove_labels: list[str]
) -> None:
    """Add and remove label IDs from a message."""
    service.users().messages().modify(
        userId="me",
        id=message_id,
        body={
            "addLabelIds": add_labels,
            "removeLabelIds": remove_labels,
        },
    ).execute()


def insert_message(service, subject: str, body: str, label_ids: list[str]) -> dict:
    """
    Insert a message directly into the mailbox with specific labels applied.
    Does NOT send an email — creates an internal queue entry.
    Requires gmail.modify scope.
    """
    import base64
    from email.mime.text import MIMEText

    msg = MIMEText(body, "plain")
    msg["subject"] = subject
    msg["from"] = "opendia-inbox@internal"
    msg["to"] = "opendia-queue@internal"
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    return service.users().messages().insert(
        userId="me",
        body={"raw": raw, "labelIds": label_ids},
    ).execute()


def send_email(service, to: str, subject: str, body: str, thread_id: str | None = None) -> dict:
    """Send a plain-text email. Returns the sent message dict."""
    import base64
    from email.mime.text import MIMEText

    msg = MIMEText(body, "plain")
    msg["to"] = to
    msg["subject"] = subject
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    payload = {"raw": raw}
    if thread_id:
        payload["threadId"] = thread_id
    return service.users().messages().send(userId="me", body=payload).execute()


def extract_attachment_meta(msg: dict) -> list[dict]:
    """
    Walk the message payload.parts tree and return attachment metadata.
    Returns a list of dicts: {filename, mime_type, size, attachment_id, part_id}.
    """
    attachments = []
    _collect_attachments(msg.get("payload", {}), attachments)
    return attachments


def _collect_attachments(payload: dict, result: list):
    """Recursively collect parts that have a filename and attachmentId."""
    filename = payload.get("filename")
    body = payload.get("body", {})
    if filename and body.get("attachmentId"):
        result.append({
            "filename": filename,
            "mime_type": payload.get("mimeType", "application/octet-stream"),
            "size": body.get("size", 0),
            "attachment_id": body["attachmentId"],
            "part_id": payload.get("partId", ""),
        })
    for part in payload.get("parts", []):
        _collect_attachments(part, result)


def download_attachments(service, msg_id: str, attachments: list[dict], dest_dir: str) -> list[str]:
    """
    Download attachments to dest_dir. Skips files > 25MB.
    Returns list of saved file paths.
    """
    import base64
    import logging
    _log = logging.getLogger(__name__)
    MAX_SIZE = 25 * 1024 * 1024  # 25MB
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    paths = []
    for att in attachments:
        if att.get("size", 0) > MAX_SIZE:
            _log.warning(f"Skipping attachment {att['filename']} ({att['size']} bytes) — exceeds 25MB limit")
            continue
        try:
            result = service.users().messages().attachments().get(
                userId="me", messageId=msg_id, id=att["attachment_id"]
            ).execute()
            data = base64.urlsafe_b64decode(result["data"] + "==")
            out_path = dest / att["filename"]
            out_path.write_bytes(data)
            paths.append(str(out_path))
        except Exception as e:
            _log.warning(f"Failed to download attachment {att['filename']}: {e}")
    return paths


def create_draft(
    service, to: str, subject: str, body: str, thread_id: str | None = None
) -> dict:
    """Create a Gmail draft (does NOT send). Returns draft dict."""
    import base64
    from email.mime.text import MIMEText

    msg = MIMEText(body, "plain")
    msg["to"] = to
    msg["subject"] = subject
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    message_payload = {"raw": raw}
    if thread_id:
        message_payload["threadId"] = thread_id
    return service.users().drafts().create(
        userId="me",
        body={"message": message_payload},
    ).execute()
