"""The guarantees OpenDia makes, each proven by crashing the worker at the worst moment."""

WID = "email:<demo-001@example.org>"
AID = f"{WID}:reply"


def pending(h, n=1):
    return lambda: len(h.approvals("pending")) == n


def test_full_demo_and_idempotent_ingest(harness):
    h = harness
    for f in ("01-question.eml", "02-newsletter.eml", "03-injection.eml"):
        h.add_email(f)
    h.serve_until(pending(h, 2))
    assert h.run_outcome("email:<demo-002@news.example.net>") == "no_reply_needed"
    h.cli("approve", AID)
    h.cli("reject", "email:<demo-003@example.com>:reply")
    h.serve_until(lambda: h.run_outcome(WID) == "sent"
                  and h.run_outcome("email:<demo-003@example.com>") == "rejected")
    assert len(h.outbox()) == 1
    calls = h.model_calls()
    # Same inbox, another start: no new runs, no new model calls, no new mail.
    h.serve_until(lambda: True)
    assert len(h.outbox()) == 1
    assert h.model_calls() == calls


def test_replay_never_recalls_the_model(harness):
    h = harness
    h.add_email("01-question.eml")
    assert h.serve_until(lambda: False, failpoint="after_draft") == 137
    assert h.model_calls() == 2  # classify + draft, then the crash
    h.serve_until(pending(h))
    assert h.model_calls() == 2  # recovery replayed both recorded outputs


def test_crash_after_send_does_not_resend(harness):
    h = harness
    h.add_email("01-question.eml")
    h.serve_until(pending(h))
    h.cli("approve", AID)
    assert h.serve_until(lambda: False, failpoint="after_send") == 137
    assert len(h.outbox()) == 1
    h.serve_until(lambda: h.run_outcome(WID) == "sent")
    assert len(h.outbox()) == 1


def test_crash_mid_send_does_not_resend(harness):
    h = harness
    h.add_email("01-question.eml")
    h.serve_until(pending(h))
    h.cli("approve", AID)
    # Dies after the mail is out but before the ledger or DBOS records it.
    assert h.serve_until(lambda: False, failpoint="mid_send") == 137
    assert len(h.outbox()) == 1
    assert h.store().effect(f"send:{WID}")["status"] == "intent"
    h.serve_until(lambda: h.run_outcome(WID) == "sent")
    assert len(h.outbox()) == 1
    eff = h.store().effect(f"send:{WID}")
    assert eff["status"] == "done" and eff["detail"]["deduplicated"] == "sink"


def test_approval_survives_kill9_and_offline_decision(harness):
    h = harness
    h.add_email("01-question.eml")
    h.kill9_when(pending(h))
    h.cli("edit", AID, "--body", "Friday at 2pm works. See you then.")
    h.serve_until(lambda: h.run_outcome(WID) == "sent")
    (sent,) = h.outbox()
    assert "Friday at 2pm works." in sent.read_text()
    assert h.approvals()[0]["status"] == "edited"


def test_unanswered_approval_expires_and_cannot_be_approved_late(fast_expiry):
    h = fast_expiry
    h.add_email("01-question.eml")
    h.serve_until(lambda: h.run_outcome(WID) == "expired", timeout=40)
    assert h.approvals()[0]["status"] == "expired"
    late = h.cli("approve", AID, check=False)
    assert late.returncode == 1 and "already expired" in late.stdout
    assert h.outbox() == []
