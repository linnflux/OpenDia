from __future__ import annotations

import hashlib
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from email import message_from_bytes, policy
from email.message import EmailMessage
from email.utils import formatdate
from typing import Protocol


@dataclass
class Email:
    message_id: str
    sender: str
    to: str
    subject: str
    date: str
    body: str

    def as_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def parse(cls, raw: bytes) -> Email:
        m = message_from_bytes(raw, policy=policy.default)
        mid = (m.get("Message-ID") or "").strip()
        if not mid:  # no header: derive a stable id from the bytes so re-reads dedupe
            mid = f"<{hashlib.sha256(raw).hexdigest()[:32]}@opendia.invalid>"
        part = m.get_body(preferencelist=("plain", "html"))
        body = part.get_content() if part else ""
        return cls(mid, str(m.get("From", "")), str(m.get("To", "")), str(m.get("Subject", "")),
                   str(m.get("Date", "")), body)


@dataclass
class Outgoing:
    message_id: str       # deterministic, derived from the effect key
    from_address: str
    to: str
    subject: str
    body: str
    in_reply_to: str

    def to_message(self) -> EmailMessage:
        m = EmailMessage()
        m["Message-ID"] = self.message_id
        m["From"] = self.from_address
        m["To"] = self.to
        m["Subject"] = self.subject
        m["Date"] = formatdate(localtime=True)
        if self.in_reply_to:
            m["In-Reply-To"] = self.in_reply_to
            m["References"] = self.in_reply_to
        m.set_content(self.body)
        return m


class MailSource(Protocol):
    def poll(self) -> Iterable[Email]: ...


class MailSink(Protocol):
    def already_sent(self, message_id: str) -> bool: ...
    def send(self, msg: Outgoing) -> dict: ...
