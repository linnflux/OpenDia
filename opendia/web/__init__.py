"""One-page approval inbox. Binds to localhost by default; v0.1 has no login."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from .. import runtime
from ..store import AlreadyDecided

PAGE = (Path(__file__).parent / "inbox.html").read_text()


class DecisionIn(BaseModel):
    action: str                 # approve | edit | reject
    to: str | None = None
    subject: str | None = None
    body: str | None = None


def create_app() -> FastAPI:
    app = FastAPI(title="OpenDia inbox", docs_url=None, redoc_url=None)

    @app.get("/", response_class=HTMLResponse)
    def index():
        return PAGE

    @app.get("/api/approvals")
    def list_approvals(status: str | None = "pending"):
        return runtime.rt().store.list(status=status or None)

    @app.post("/api/approvals/{approval_id:path}")
    def decide(approval_id: str, d: DecisionIn):
        r = runtime.rt()
        row = r.store.get(approval_id)
        if row is None:
            raise HTTPException(404, "no such approval")
        action, edited = d.action, None
        if action == "edit":
            edited = {**row["proposal"], **{k: v for k, v in
                                            (("to", d.to), ("subject", d.subject), ("body", d.body))
                                            if v is not None}}
            if edited == row["proposal"]:  # nothing changed: record it as a plain approval
                action, edited = "approve", None
        try:
            row = r.store.decide(approval_id, action, r.cfg.operator, edited)
        except AlreadyDecided as e:
            raise HTTPException(409, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))
        runtime.deliver_decisions()
        return row

    return app
