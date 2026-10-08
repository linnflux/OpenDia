"""Generic IMAP in, SMTP out. Works with Gmail and Microsoft 365 app passwords, Fastmail, Dovecot, etc.

Exactly-once on SMTP: every reply carries a Message-ID derived from its effect key. Before
sending (including on a retry after a crash), the sink searches the Sent folder for that
Message-ID. The one gap: a crash after the server accepts the message but before it shows up
in Sent. Providers that save to Sent on submit (Gmail) make that window very small; for the
rest, set `append_to_sent = true` and OpenDia appends the copy itself.
"""

from __future__ import annotations

import imaplib
import os
import smtplib
import time
from datetime import UTC, datetime, timedelta

from .. import _failpoints
from .base import Email, Outgoing


def _password(conf: dict) -> str:
    env = conf.get("password_env")
    if not env or not os.environ.get(env):
        raise RuntimeError(f"Set password_env in config and export it (got {env!r}).")
    return os.environ[env]


def _imap(conf: dict) -> imaplib.IMAP4_SSL:
    c = imaplib.IMAP4_SSL(conf["host"], int(conf.get("port", 993)))
    c.login(conf["username"], _password(conf))
    return c


class ImapSource:
    def __init__(self, cfg):
        self.conf = cfg.mail["imap"]
        self.seen: set[bytes] = set()  # workflow ids dedupe across restarts; this just saves refetches

    def poll(self):
        days = int(self.conf.get("since_days", 2))
        since = (datetime.now(UTC).date() - timedelta(days=days)).strftime("%d-%b-%Y")
        c = _imap(self.conf)
        try:
            c.select(self.conf.get("folder", "INBOX"), readonly=True)
            _, data = c.uid("SEARCH", None, "SINCE", since)
            for uid in data[0].split():
                if uid in self.seen:
                    continue
                _, parts = c.uid("FETCH", uid, "(BODY.PEEK[])")  # PEEK: never marks mail as read
                raw = next((p[1] for p in parts if isinstance(p, tuple)), None)
                self.seen.add(uid)
                if raw:
                    yield Email.parse(raw)
        finally:
            c.logout()


class SmtpSink:
    def __init__(self, cfg):
        self.smtp = cfg.mail["smtp"]
        self.imap = cfg.mail.get("imap")
        self.sent_folder = (self.imap or {}).get("sent_folder", "Sent")
        if not self.imap:
            raise RuntimeError("smtp sink needs [mail.imap] to check the Sent folder before sending")

    def already_sent(self, message_id: str) -> bool:
        c = _imap(self.imap)
        try:
            c.select(f'"{self.sent_folder}"', readonly=True)
            _, data = c.search(None, "HEADER", "Message-ID", f'"{message_id}"')
            return bool(data and data[0].split())
        finally:
            c.logout()

    def send(self, msg: Outgoing) -> dict:
        m = msg.to_message()
        port = int(self.smtp.get("port", 587))
        cls = smtplib.SMTP_SSL if port == 465 else smtplib.SMTP
        with cls(self.smtp["host"], port, timeout=60) as s:
            if port != 465:
                s.starttls()
            s.login(self.smtp["username"], _password(self.smtp))
            s.send_message(m)
        _failpoints.hit("mid_send")
        if self.smtp.get("append_to_sent", False):
            c = _imap(self.imap)
            try:
                c.append(f'"{self.sent_folder}"', r"(\Seen)", imaplib.Time2Internaldate(time.time()),
                         bytes(m))
            finally:
                c.logout()
        return {"smtp_host": self.smtp["host"], "message_id": msg.message_id}
