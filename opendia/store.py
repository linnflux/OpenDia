"""OpenDia's own tables: the approval inbox and the side-effect ledger.

DBOS owns workflow state (inputs, step outputs, messages). These tables hold what a human
or an external system needs to see, with conditional updates so every transition happens once.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from sqlalchemy import (
    Boolean,
    Column,
    MetaData,
    String,
    Table,
    Text,
    create_engine,
    event,
    insert,
    select,
    update,
)
from sqlalchemy.exc import IntegrityError

md = MetaData()

approvals = Table(
    "od_approvals", md,
    Column("id", String, primary_key=True),          # "<workflow_id>:<kind>", so a replay can't add a second
    Column("workflow_id", String, nullable=False, index=True),
    Column("kind", String, nullable=False),
    Column("status", String, nullable=False),        # pending | approved | edited | rejected | expired
    Column("context", Text, nullable=False),         # JSON the approver sees (email, classification)
    Column("proposal", Text, nullable=False),        # JSON the workflow proposes (the draft)
    Column("final", Text),                           # JSON actually approved (after edits)
    Column("decided_by", String),
    Column("created_at", String, nullable=False),
    Column("expires_at", String, nullable=False),
    Column("decided_at", String),
    Column("delivered", Boolean, nullable=False, default=False),  # decision handed to the workflow
)

effects = Table(
    "od_effects", md,
    Column("key", String, primary_key=True),         # idempotency key, e.g. "send:<workflow_id>"
    Column("kind", String, nullable=False),
    Column("status", String, nullable=False),        # intent | done
    Column("detail", Text),
    Column("created_at", String, nullable=False),
    Column("done_at", String),
)

DECISIONS = {"approve": "approved", "edit": "edited", "reject": "rejected"}


class AlreadyDecided(Exception):
    pass


def now() -> datetime:
    return datetime.now(UTC)


def iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


class Store:
    def __init__(self, url: str):
        self.engine = create_engine(url)
        if url.startswith("sqlite"):
            @event.listens_for(self.engine, "connect")
            def _pragmas(conn, _):
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA busy_timeout=10000")
        md.create_all(self.engine)

    # approvals -------------------------------------------------------------------------------

    def create_approval(self, *, workflow_id: str, kind: str, context: dict, proposal: dict,
                        timeout_seconds: float) -> str:
        aid = f"{workflow_id}:{kind}"
        t = now()
        try:
            with self.engine.begin() as c:
                c.execute(insert(approvals).values(
                    id=aid, workflow_id=workflow_id, kind=kind, status="pending",
                    context=json.dumps(context), proposal=json.dumps(proposal),
                    created_at=iso(t), expires_at=iso(t + timedelta(seconds=timeout_seconds)),
                    delivered=False))
        except IntegrityError:
            pass  # step retried after a crash: the row already exists
        return aid

    def decide(self, approval_id: str, action: str, by: str, edited: dict | None = None) -> dict:
        """Claim the decision. Fails closed if anyone (or expiry) got there first."""
        if action not in DECISIONS:
            raise ValueError(f"action must be one of {sorted(DECISIONS)}")
        row = self.get(approval_id)
        if row is None:
            raise KeyError(approval_id)
        final = row["proposal"] if action == "approve" else (edited if action == "edit" else None)
        if action == "edit" and not edited:
            raise ValueError("edit needs the edited proposal")
        with self.engine.begin() as c:
            res = c.execute(update(approvals)
                            .where(approvals.c.id == approval_id, approvals.c.status == "pending")
                            .values(status=DECISIONS[action], decided_by=by, decided_at=iso(now()),
                                    final=json.dumps(final) if final is not None else None))
        if res.rowcount != 1:
            raise AlreadyDecided(f"{approval_id} is already {self.get(approval_id)['status']}")
        return self.get(approval_id)

    def expire(self, approval_id: str) -> bool:
        with self.engine.begin() as c:
            res = c.execute(update(approvals)
                            .where(approvals.c.id == approval_id, approvals.c.status == "pending")
                            .values(status="expired", decided_at=iso(now()), delivered=True))
        return res.rowcount == 1

    def mark_delivered(self, approval_id: str) -> None:
        with self.engine.begin() as c:
            c.execute(update(approvals).where(approvals.c.id == approval_id).values(delivered=True))

    def undelivered(self) -> list[dict]:
        q = select(approvals).where(approvals.c.status.in_(DECISIONS.values()),
                                    approvals.c.delivered.is_(False))
        return self._rows(q)

    def get(self, approval_id: str) -> dict | None:
        rows = self._rows(select(approvals).where(approvals.c.id == approval_id))
        return rows[0] if rows else None

    def list(self, status: str | None = None, workflow_id: str | None = None) -> list[dict]:
        q = select(approvals).order_by(approvals.c.created_at)
        if status:
            q = q.where(approvals.c.status == status)
        if workflow_id:
            q = q.where(approvals.c.workflow_id == workflow_id)
        return self._rows(q)

    def _rows(self, q) -> list[dict]:
        with self.engine.connect() as c:
            out = []
            for r in c.execute(q).mappings():
                d = dict(r)
                for k in ("context", "proposal", "final"):
                    if k in d and d[k] is not None:
                        d[k] = json.loads(d[k])
                out.append(d)
            return out

    # effects ---------------------------------------------------------------------------------

    def effect(self, key: str) -> dict | None:
        with self.engine.connect() as c:
            r = c.execute(select(effects).where(effects.c.key == key)).mappings().first()
            if not r:
                return None
            d = dict(r)
            d["detail"] = json.loads(d["detail"]) if d["detail"] else None
            return d

    def effect_intent(self, key: str, kind: str, detail: dict) -> None:
        try:
            with self.engine.begin() as c:
                c.execute(insert(effects).values(key=key, kind=kind, status="intent",
                                                 detail=json.dumps(detail), created_at=iso(now())))
        except IntegrityError:
            pass

    def effect_done(self, key: str, detail: dict) -> None:
        with self.engine.begin() as c:
            c.execute(update(effects).where(effects.c.key == key)
                      .values(status="done", done_at=iso(now()), detail=json.dumps(detail)))
