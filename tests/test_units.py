import pytest
from pydantic import BaseModel

from opendia.connectors.base import Email
from opendia.providers.base import parse_json_object
from opendia.store import AlreadyDecided, Store


def test_decisions_fail_closed(tmp_path):
    s = Store(f"sqlite:///{tmp_path / 'a.sqlite'}")
    aid = s.create_approval(workflow_id="w", kind="reply", context={}, proposal={"body": "x"},
                            timeout_seconds=60)
    # a retried step must not create a second row
    assert s.create_approval(workflow_id="w", kind="reply", context={}, proposal={},
                             timeout_seconds=60) == aid
    assert s.decide(aid, "approve", "a")["final"] == {"body": "x"}
    with pytest.raises(AlreadyDecided):
        s.decide(aid, "reject", "b")
    assert not s.expire(aid)
    assert s.get(aid)["decided_by"] == "a"


def test_edit_requires_content(tmp_path):
    s = Store(f"sqlite:///{tmp_path / 'a.sqlite'}")
    aid = s.create_approval(workflow_id="w", kind="reply", context={}, proposal={},
                            timeout_seconds=60)
    with pytest.raises(ValueError):
        s.decide(aid, "edit", "a", None)


def test_missing_message_id_is_stable():
    raw = b"From: a@example.com\r\nSubject: hi\r\n\r\nbody\r\n"
    assert Email.parse(raw).message_id == Email.parse(raw).message_id


class M(BaseModel):
    ok: bool


def test_parse_json_accepts_fences_rejects_garbage():
    assert parse_json_object('```json\n{"ok": true}\n```', M) == {"ok": True}
    with pytest.raises(ValueError):
        parse_json_object("sure! here you go", M)


def test_openai_compat_retries_invalid_json(monkeypatch):
    import httpx

    from opendia.providers.openai_compat import OpenAICompatProvider

    replies = iter(['not json', '{"ok": true}'])
    sent = []

    def fake_post(url, headers, timeout, json):
        sent.append(json)
        body = {"choices": [{"message": {"content": next(replies)}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 2}}
        return httpx.Response(200, json=body, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    p = OpenAICompatProvider({"model": "llama3.1", "base_url": "http://localhost:11434/v1"})
    res = p.complete_json(system="s", content="c", schema=M)
    assert res.output == {"ok": True}
    assert res.usage == {"input_tokens": 20, "output_tokens": 4}
    assert len(sent) == 2 and sent[1]["messages"][-1]["role"] == "user"
