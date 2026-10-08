"""Process-wide wiring: config, store, provider, connectors, and the DBOS engine."""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass

from dbos import DBOS, SetWorkflowID

from .config import Config
from .connectors import MailSink, MailSource, load_sink, load_source
from .providers import Provider, load_provider
from .store import Store

log = logging.getLogger("opendia")

# Bump only when a workflow's step sequence changes. DBOS recovers pending workflows only for
# the matching version, so a hash-based default would strand approvals on every code edit.
WORKFLOW_VERSION = "email_triage-1"


@dataclass
class Runtime:
    cfg: Config
    store: Store
    provider: Provider
    sink: MailSink
    source: MailSource | None = None


_rt: Runtime | None = None


def rt() -> Runtime:
    if _rt is None:
        raise RuntimeError("OpenDia runtime not started")
    return _rt


def start(cfg: Config) -> Runtime:
    """Build the runtime and launch DBOS, which resumes every interrupted workflow."""
    global _rt
    _rt = Runtime(cfg, Store(cfg.app_db_url), load_provider(cfg.provider), load_sink(cfg))
    DBOS(config={
        "name": "opendia",
        "system_database_url": cfg.system_db_url,
        "application_version": WORKFLOW_VERSION,
        "console_log_level": "WARNING",
    })
    from . import workflows  # noqa: F401  (registers workflows with DBOS)
    DBOS.launch()
    return _rt


def stop() -> None:
    global _rt
    DBOS.destroy(destroy_registry=False)
    _rt = None


def ingest_once() -> list[str]:
    """Start one workflow per new email. The workflow id is the Message-ID, so re-reading the
    same message, in this process or after a restart, never starts a second run."""
    from .workflows import email_triage
    r = rt()
    if r.source is None:
        r.source = load_source(r.cfg)
    started = []
    for email in r.source.poll():
        wid = f"email:{email.message_id}"
        if wid in _known:
            continue
        # Starting an existing id is harmless (DBOS returns the same run) but noisy; skip it.
        if not DBOS.list_workflows(workflow_ids=[wid], load_input=False, load_output=False):
            with SetWorkflowID(wid):
                DBOS.start_workflow(email_triage, email.as_dict())
            started.append(wid)
        _known.add(wid)
    return started


_known: set[str] = set()


def deliver_decisions() -> int:
    """Hand decided approvals to their workflows. Safe to repeat: DBOS dedupes on the key."""
    r = rt()
    n = 0
    for row in r.store.undelivered():
        DBOS.send(row["workflow_id"], decision_message(row), "decision",
                  idempotency_key=f"decision:{row['id']}")
        r.store.mark_delivered(row["id"])
        n += 1
    return n


def decision_message(row: dict) -> dict:
    return {"approval_id": row["id"], "status": row["status"], "final": row["final"],
            "by": row["decided_by"]}


def worker_loop(stop_event: threading.Event) -> None:
    poll = float(rt().cfg.mail.get("poll_seconds", 5))
    while not stop_event.is_set():
        try:
            ingest_once()
            deliver_decisions()
        except Exception:
            log.exception("worker tick failed; retrying next tick")
        stop_event.wait(poll)
