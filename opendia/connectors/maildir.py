"""Local folders: .eml files in, .eml files out. The no-credentials demo path."""

from __future__ import annotations

import hashlib

from .. import _failpoints
from .base import Email, Outgoing


class MaildirSource:
    def __init__(self, cfg):
        self.dir = cfg.resolve(cfg.mail.get("inbox_dir", "inbox"))
        self.dir.mkdir(parents=True, exist_ok=True)

    def poll(self):
        for p in sorted(self.dir.glob("*.eml")):
            yield Email.parse(p.read_bytes())


class FileSink:
    def __init__(self, cfg):
        self.dir = cfg.resolve(cfg.mail.get("outbox_dir", "outbox"))
        self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, message_id: str):
        return self.dir / f"{hashlib.sha256(message_id.encode()).hexdigest()[:16]}.eml"

    def already_sent(self, message_id: str) -> bool:
        return self._path(message_id).exists()

    def send(self, msg: Outgoing) -> dict:
        path = self._path(msg.message_id)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(bytes(msg.to_message()))
        tmp.rename(path)  # atomic: a file in the outbox is a completed send
        _failpoints.hit("mid_send")
        return {"path": str(path)}
