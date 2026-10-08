"""Plain-language run report: what ran, which model, who approved, what was sent."""

from __future__ import annotations

from datetime import UTC, datetime

from dbos import DBOSClient

from .config import Config
from .store import Store

STEP_LABELS = {
    "classify": "Classified the email",
    "draft_reply": "Drafted a reply",
    "request_approval": "Asked a person to approve",
    "DBOS.recv": "Received the decision",
    "expire_approval": "Approval deadline passed",
    "send_reply": "Sent the reply",
}


def _ts(ms):
    if not ms:
        return "?"
    return datetime.fromtimestamp(ms / 1000, UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


def report(cfg: Config, workflow_id: str) -> str:
    client = DBOSClient(system_database_url=cfg.system_db_url)
    try:
        wfs = client.list_workflows(workflow_ids=[workflow_id])
        if not wfs:
            return f"No run with id {workflow_id}"
        wf = wfs[0]
        steps = client.list_workflow_steps(workflow_id)
    finally:
        client.destroy()
    store = Store(cfg.app_db_url)
    args = (wf.input or {}).get("args") if isinstance(wf.input, dict) else None
    email = args[0] if args and isinstance(args[0], dict) else {}
    lines = [f"Run {workflow_id}",
             f"  Status:   {wf.status}",
             f"  Email:    {email.get('subject', '?')!r} from {email.get('sender', '?')}", ""]
    tokens_in = tokens_out = 0
    for s in sorted(steps, key=lambda s: s["started_at_epoch_ms"] or 0):
        name = s["function_name"]
        if name == "DBOS.sleep":  # internal: the durable approval deadline
            continue
        label = STEP_LABELS.get(name, name)
        line = f"  {_ts(s['completed_at_epoch_ms'])}  {label}"
        out = s["output"] if isinstance(s["output"], dict) else None
        if out and "provider" in out:
            u = out.get("usage", {})
            tokens_in += u.get("input_tokens", 0)
            tokens_out += u.get("output_tokens", 0)
            line += f"  [{out['provider']}/{out['model']}, {u.get('input_tokens', 0)} in / {u.get('output_tokens', 0)} out tokens]"
            o = out["output"]
            if "needs_reply" in o:
                line += f"\n      -> {o['category']}, reply needed: {o['needs_reply']}. {o['rationale']}"
        elif s["error"] is not None:
            line += f"  ERROR: {s['error']}"
        lines.append(line)
    for a in store.list(workflow_id=workflow_id):
        who = f" by {a['decided_by']} at {a['decided_at']}" if a["decided_by"] else ""
        lines += ["", f"  Approval {a['id']}: {a['status'].upper()}{who}"]
        if a["status"] == "edited":
            lines.append("      (the person edited the draft before approving)")
    eff = store.effect(f"send:{workflow_id}")
    if eff:
        d = eff["detail"] or {}
        lines += ["", (f"  Sent:     {eff['status'].upper()} to {d.get('to')} "
                       f"as {d.get('message_id')} at {eff['done_at']}")]
    lines += ["", f"  Model usage: {tokens_in} input / {tokens_out} output tokens"]
    if wf.output:
        lines.append(f"  Outcome:  {wf.output.get('outcome')}")
    return "\n".join(lines)
