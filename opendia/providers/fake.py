"""Deterministic stand-in for a model. Lets the demo and the test suite run with no keys."""

from __future__ import annotations

import os
import re

from .base import LLMResult


class FakeProvider:
    name = "fake"

    def __init__(self, conf: dict):
        self.model = conf.get("model") or "fake-1"

    def complete_json(self, *, system, content, schema):
        log = os.environ.get("OPENDIA_FAKE_CALL_LOG")
        if log:  # tests count real model calls to prove replays never re-invoke the model
            with open(log, "a") as f:
                f.write(schema.__name__ + "\n")
        fields = schema.model_fields
        if "needs_reply" in fields:
            out = _classify(content)
        elif "body" in fields:
            out = _draft(content)
        else:
            raise ValueError(f"FakeProvider has no canned answer for {schema.__name__}")
        out = schema.model_validate(out).model_dump()
        return LLMResult(out, self.name, self.model, {"input_tokens": len(content) // 4,
                                                       "output_tokens": len(str(out)) // 4})


def _field(content: str, name: str) -> str:
    m = re.search(rf"^{name}: (.*)$", content, re.MULTILINE)
    return m.group(1).strip() if m else ""


def _classify(content: str) -> dict:
    body = content.split("<body>", 1)[-1].lower()
    unsubscribe = "unsubscribe" in body
    asks = "?" in body or "please" in body or "could you" in body
    needs = asks and not unsubscribe
    return {
        "category": "newsletter" if unsubscribe else ("request" if needs else "fyi"),
        "needs_reply": needs,
        "priority": "normal",
        "rationale": "Asks a direct question." if needs else "Informational; no reply needed.",
    }


def _draft(content: str) -> dict:
    sender = _field(content, "From")
    name = sender.split("<")[0].strip().strip('"').split(" ")[0] or "there"
    addr = re.search(r"<([^>]+)>", sender)
    subject = _field(content, "Subject")
    return {
        "to": addr.group(1) if addr else sender,
        "subject": subject if subject.lower().startswith("re:") else f"Re: {subject}",
        "body": (f"Hi {name},\n\nThanks for reaching out about \"{subject}\". "
                 "I'll look into this and follow up shortly.\n\nBest regards"),
    }
