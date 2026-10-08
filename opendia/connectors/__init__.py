from __future__ import annotations

from ..plugins import load_object
from .base import Email, MailSink, MailSource, Outgoing


def load_source(cfg) -> MailSource:
    kind = cfg.mail.get("source", "maildir")
    if kind == "maildir":
        from .maildir import MaildirSource
        return MaildirSource(cfg)
    if kind == "imap":
        from .imap_smtp import ImapSource
        return ImapSource(cfg)
    return load_object(kind)(cfg)


def load_sink(cfg) -> MailSink:
    kind = cfg.mail.get("sink", "file")
    if kind == "file":
        from .maildir import FileSink
        return FileSink(cfg)
    if kind == "smtp":
        from .imap_smtp import SmtpSink
        return SmtpSink(cfg)
    return load_object(kind)(cfg)


__all__ = ["Email", "MailSink", "MailSource", "Outgoing", "load_sink", "load_source"]
