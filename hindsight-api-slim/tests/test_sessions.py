"""Sessions: the append protocol, the watcher's checks and notes, and saving into the document.

The task backend is synchronous here, so a check or save an append queues runs before the append
returns. Reflect and retain are stubbed: what they do with a moment is tested elsewhere; this is
about what the session does around them.
"""

import json
import uuid

import pytest

from hindsight_api.engine.response_models import LLMCallTrace, MemoryFact, ReflectResult, TokenUsage
from hindsight_api.engine.sessions.models import SessionAppendRequest, SessionEventIn, SessionOptions


def _bank() -> str:
    return f"sess-{uuid.uuid4().hex[:10]}"


def _req(*events: dict, ack: int | None = None, **session) -> SessionAppendRequest:
    return SessionAppendRequest(
        events=[SessionEventIn(**e) for e in events],
        ack=ack,
        session=SessionOptions(**session) if session else None,
    )


def _reflect_stub(answers: list[tuple[str, list[str]]], calls: list[dict]):
    """reflect_async that answers in order; each answer is (text, memory ids)."""

    async def reflect_async(**kwargs):
        calls.append(kwargs)
        text, ids = answers.pop(0) if answers else ("", [])
        return ReflectResult(
            text=text,
            abstained=not text,
            based_on={"observation": [MemoryFact(id=i, text="rule", fact_type="observation") for i in ids]},
            usage=TokenUsage(input_tokens=100, output_tokens=10, total_tokens=110),
            llm_trace=[LLMCallTrace(scope="decision_pick", duration_ms=5, detail="none=0.90")],
        )

    return reflect_async


async def test_append_is_ordered_and_a_retry_stores_nothing_twice(memory, request_context):
    bank = _bank()
    s = memory.sessions
    r = await s.append(
        bank,
        "s1",
        _req({"id": "a", "role": "user", "text": "hi"}, {"id": "b", "role": "assistant", "text": "hello"}),
        request_context=request_context,
    )
    assert (r.accepted, r.duplicates, r.last_seq) == (2, 0, 2)
    # The response was lost: the client sends the same events again, plus a new one.
    r = await s.append(
        bank,
        "s1",
        _req(
            {"id": "a", "role": "user", "text": "hi"},
            {"id": "b", "role": "assistant", "text": "hello"},
            {"id": "c", "role": "user", "text": "next"},
            {"id": "c", "role": "user", "text": "next"},
        ),
        request_context=request_context,
    )
    assert (r.accepted, r.duplicates, r.last_seq) == (1, 3, 3)
    log = await s.events(bank, "s1", request_context=request_context)
    assert [(e.seq, e.event_id, e.source) for e in log.items] == [
        (1, "a", "client"),
        (2, "b", "client"),
        (3, "c", "client"),
    ]
    assert [e.seq for e in (await s.events(bank, "s1", after=2, request_context=request_context)).items] == [3]
    summary = await s.get(bank, "s1", request_context=request_context)
    assert summary.event_count == 3 and summary.document_id == "session:s1" and not summary.watch


async def test_without_watch_no_check_runs(memory, request_context, monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(memory, "reflect_async", _reflect_stub([("note", [])], calls))
    bank = _bank()
    r = await memory.sessions.append(
        bank, "s1", _req({"id": "a", "role": "user", "text": "Fix it"}), request_context=request_context
    )
    assert calls == [] and r.notes == [] and not r.checking


async def test_a_note_is_logged_delivered_until_acked_and_never_repeated(memory, request_context, monkeypatch):
    calls: list[dict] = []
    m1 = str(uuid.uuid4())
    answers = [
        ("Before you change pay/rounding.py: half cents round down.", [m1]),  # the heads-up
        ("You used HALF_UP; the rule is HALF_DOWN.", [m1]),  # an edit against it: said once
        ("Still HALF_UP.", [m1]),  # the same memory again: not said twice
    ]
    monkeypatch.setattr(memory, "reflect_async", _reflect_stub(answers, calls))
    bank, s = _bank(), memory.sessions
    r = await s.append(
        bank,
        "s1",
        _req({"id": "1", "role": "user", "text": "Fix the rounding in pay/rounding.py"}, watch=True, retain="off"),
        request_context=request_context,
    )
    # The check ran during the append (synchronous backend); the note comes back on the next append.
    assert calls and calls[0]["abstain"] is True and calls[0]["query"].startswith("Before I start")
    log = (await s.events(bank, "s1", request_context=request_context)).items
    assert [(e.source, e.kind) for e in log] == [("client", "message"), ("hindsight", "check"), ("hindsight", "note")]
    check = log[1].payload
    assert check["trigger"] == "task" and check["outcome"] == "note" and check["question"] == "headsup"
    assert check["usage"]["input_tokens"] == 100 and check["llm_calls"][0]["scope"] == "decision_pick"

    r = await s.append(bank, "s1", _req(), request_context=request_context)
    assert [n.seq for n in r.notes] == [3] and r.notes[0].trigger == "task"
    r = await s.append(bank, "s1", _req(ack=3), request_context=request_context)
    assert r.notes == []

    edit = (
        {
            "id": "2",
            "role": "assistant",
            "kind": "tool_call",
            "tool": "Edit",
            "call_id": "e",
            "input": {"file_path": "p"},
        },
        {"id": "3", "role": "tool", "kind": "tool_result", "call_id": "e", "text": "ok"},
        {"id": "4", "role": "system", "kind": "state", "data": {"diff": "+++ b/p\n+HALF_UP"}},
    )
    r = await s.append(bank, "s1", _req(*edit, ack=3), request_context=request_context)
    r = await s.append(bank, "s1", _req(ack=3), request_context=request_context)
    assert [n.text for n in r.notes] == ["You used HALF_UP; the rule is HALF_DOWN."]
    assert "ALREADY TOLD ME:\nBefore you change pay/rounding.py" in calls[1]["context"]
    assert calls[1]["search_queries"] == ["Change to p ():\n+HALF_UP"]

    edit2 = (
        {
            "id": "5",
            "role": "assistant",
            "kind": "tool_call",
            "tool": "Edit",
            "call_id": "f",
            "input": {"file_path": "p"},
        },
        {"id": "6", "role": "tool", "kind": "tool_result", "call_id": "f", "text": "ok"},
        {"id": "7", "role": "system", "kind": "state", "data": {"diff": "+++ b/p\n+HALF_UP  # still"}},
    )
    await s.append(bank, "s1", _req(*edit2), request_context=request_context)
    outcomes = [
        e.payload["outcome"]
        for e in (await s.events(bank, "s1", request_context=request_context)).items
        if e.kind == "check"
    ]
    assert outcomes == ["note", "note", "repeat"]
    summary = await s.get(bank, "s1", request_context=request_context)
    assert (summary.check_count, summary.note_count) == (3, 2) and not summary.checking
    assert summary.delivered_count == 1  # the client acknowledged the heads-up only


async def test_an_abstained_check_is_logged_silent(memory, request_context, monkeypatch):
    monkeypatch.setattr(memory, "reflect_async", _reflect_stub([("", [])], []))
    bank = _bank()
    r = await memory.sessions.append(
        bank, "s1", _req({"id": "1", "role": "user", "text": "Fix it"}, watch=True), request_context=request_context
    )
    log = (await memory.sessions.events(bank, "s1", request_context=request_context)).items
    assert [e.kind for e in log] == ["message", "check"] and log[1].payload["outcome"] == "silent"
    assert r.notes == []


async def test_a_failed_check_is_logged_and_the_session_goes_on(memory, request_context, monkeypatch):
    async def broken(**_):
        raise RuntimeError("provider down")

    monkeypatch.setattr(memory, "reflect_async", broken)
    bank = _bank()
    r = await memory.sessions.append(
        bank, "s1", _req({"id": "1", "role": "user", "text": "Fix it"}, watch=True), request_context=request_context
    )
    log = (await memory.sessions.events(bank, "s1", request_context=request_context)).items
    assert log[-1].payload["outcome"] == "error" and "provider down" in log[-1].payload["error"]
    assert r.accepted == 1


async def test_a_turn_end_saves_the_turn_into_the_document_once(memory, request_context, monkeypatch):
    submitted: list[dict] = []

    async def submit_async_retain(bank_id, contents, **kwargs):
        submitted.append({"bank_id": bank_id, "contents": contents, **kwargs})
        return {"operation_id": kwargs.get("operation_id")}

    monkeypatch.setattr(memory, "submit_async_retain", submit_async_retain)
    bank, s = _bank(), memory.sessions
    turn = (
        {"id": "1", "role": "user", "text": "Keep retries at 7"},
        {
            "id": "2",
            "role": "assistant",
            "kind": "tool_call",
            "tool": "Edit",
            "call_id": "e",
            "input": {"file_path": "a.py"},
        },
        {"id": "3", "role": "tool", "kind": "tool_result", "call_id": "e", "text": "done"},
        {"id": "4", "role": "assistant", "text": "Set to 7."},
    )
    await s.append(bank, "s1", _req(*turn, tags=["team:a"], metadata={"repo": "x"}), request_context=request_context)
    assert submitted == []  # no turn end yet: nothing is saved
    await s.append(
        bank, "s1", _req({"id": "5", "role": "assistant", "kind": "turn_end"}), request_context=request_context
    )
    assert len(submitted) == 1
    item = submitted[0]["contents"][0]
    lines = [json.loads(line) for line in item["content"].split("\n")]
    assert [(t["role"], t["content"]) for t in lines] == [
        ("system", "REF-ID: session:s1"),
        ("user", "Keep retries at 7"),
        ("action", "Edit a.py"),
        ("assistant", "Set to 7."),
    ]
    assert item["document_id"] == "session:s1" and item["update_mode"] == "append"
    assert item["tags"] == ["team:a"] and item["metadata"]["repo"] == "x" and item["metadata"]["session_id"] == "s1"
    summary = await s.get(bank, "s1", request_context=request_context)
    assert summary.saved_seq == 5

    # The next turn appends only what is new, under a new operation id.
    await s.append(
        bank,
        "s1",
        _req(
            {"id": "6", "role": "user", "text": "And the timeout?"},
            {"id": "7", "role": "assistant", "kind": "turn_end"},
        ),
        request_context=request_context,
    )
    assert len(submitted) == 2
    second = [json.loads(line) for line in submitted[1]["contents"][0]["content"].split("\n")]
    assert [t["content"] for t in second] == ["And the timeout?"]
    assert submitted[1]["operation_id"] != submitted[0]["operation_id"]


async def test_a_save_that_died_after_submitting_resubmits_the_same_operation(memory, request_context, monkeypatch):
    submitted: list[str | None] = []
    fail = [True]

    async def submit_async_retain(bank_id, contents, **kwargs):
        submitted.append(kwargs.get("operation_id"))
        if fail:
            fail.pop()
            raise RuntimeError("worker died")
        return {}

    monkeypatch.setattr(memory, "submit_async_retain", submit_async_retain)
    bank, s = _bank(), memory.sessions
    await s.append(
        bank, "s1", _req({"id": "1", "role": "user", "text": "hello"}, retain="close"), request_context=request_context
    )
    with pytest.raises(RuntimeError):
        await s.run_save({"bank_id": bank, "session_id": "s1"})
    # More arrived before the retry: the retried save still covers exactly the planned range.
    await s.append(bank, "s1", _req({"id": "2", "role": "user", "text": "later"}), request_context=request_context)
    await s.run_save({"bank_id": bank, "session_id": "s1"})
    assert len(submitted) == 2 and submitted[0] == submitted[1]
    assert (await s.get(bank, "s1", request_context=request_context)).saved_seq == 1
    # The next save picks up from there.
    await s.run_save({"bank_id": bank, "session_id": "s1"})
    assert len(submitted) == 3 and submitted[2] != submitted[0]


async def test_close_saves_and_retain_off_never_does(memory, request_context, monkeypatch):
    submitted: list[dict] = []

    async def submit_async_retain(bank_id, contents, **kwargs):
        submitted.append(contents[0])
        return {}

    monkeypatch.setattr(memory, "submit_async_retain", submit_async_retain)
    bank, s = _bank(), memory.sessions
    await s.append(
        bank, "a", _req({"id": "1", "role": "user", "text": "hello"}, retain="close"), request_context=request_context
    )
    await s.append(
        bank, "a", _req({"id": "2", "role": "assistant", "kind": "turn_end"}), request_context=request_context
    )
    assert submitted == []  # `close`: a turn end does not save
    closed = await s.close(bank, "a", request_context=request_context)
    assert closed.status == "closed" and len(submitted) == 1
    await s.append(
        bank, "b", _req({"id": "1", "role": "user", "text": "hello"}, retain="off"), request_context=request_context
    )
    await s.close(bank, "b", request_context=request_context)
    assert len(submitted) == 1
    # A later append opens a closed session again.
    await s.append(bank, "a", _req({"id": "3", "role": "user", "text": "back"}), request_context=request_context)
    assert (await s.get(bank, "a", request_context=request_context)).status == "open"


async def test_sessions_are_bank_scoped_and_listed_newest_first(memory, request_context):
    a, b, s = _bank(), _bank(), memory.sessions
    await s.append(
        a, "same", _req({"id": "1", "role": "user", "text": "in a"}, title="First"), request_context=request_context
    )
    await s.append(a, "other", _req({"id": "1", "role": "user", "text": "in a"}), request_context=request_context)
    await s.append(b, "same", _req({"id": "1", "role": "user", "text": "in b"}), request_context=request_context)
    listing = await s.list(a, request_context=request_context)
    assert listing.total == 2 and [x.session_id for x in listing.items] == ["other", "same"]
    assert [x.session_id for x in (await s.list(a, q="FIRST", request_context=request_context)).items] == ["same"]
    in_b = (await s.events(b, "same", request_context=request_context)).items
    assert [e.payload["text"] for e in in_b] == ["in b"]


async def test_http_routes(api_client):
    bank = _bank()
    r = await api_client.post(
        f"/v1/default/banks/{bank}/sessions/s1/events",
        json={"events": [{"id": "1", "role": "user", "text": "hi"}], "session": {"title": "T"}},
    )
    assert r.status_code == 200 and r.json()["accepted"] == 1
    r = await api_client.get(f"/v1/default/banks/{bank}/sessions/s1/events", params={"after": 0})
    assert r.status_code == 200 and r.json()["items"][0]["payload"]["text"] == "hi"
    assert (await api_client.get(f"/v1/default/banks/{bank}/sessions")).json()["total"] == 1
    assert (await api_client.get(f"/v1/default/banks/{bank}/sessions/s1")).json()["title"] == "T"
    assert (await api_client.post(f"/v1/default/banks/{bank}/sessions/s1/close")).json()["status"] == "closed"
    assert (await api_client.get(f"/v1/default/banks/{bank}/sessions/nope/events")).status_code == 404
    assert (await api_client.get(f"/v1/default/banks/{bank}/sessions/nope")).status_code == 404
    bad = await api_client.post(f"/v1/default/banks/{bank}/sessions/s1/events", json={"events": [{"role": "user"}]})
    assert bad.status_code == 422


async def test_a_check_waits_for_the_session_to_settle_on_a_queue(memory, request_context, monkeypatch):
    from hindsight_api.worker.exceptions import DeferOperation

    calls: list[dict] = []
    monkeypatch.setattr(memory, "reflect_async", _reflect_stub([("", [])], calls))
    queued: list[str] = []

    async def queue_check(bank_id, session_id, rc):
        queued.append(session_id)

    monkeypatch.setattr(memory.sessions, "_queue_check", queue_check)
    bank = _bank()
    await memory.sessions.append(
        bank, "s1", _req({"id": "1", "role": "user", "text": "Fix it"}, watch=True), request_context=request_context
    )
    assert queued == ["s1"] and calls == []
    # On a real queue the check goes back for later: the session only just moved.
    monkeypatch.setattr(memory._task_backend, "can_defer", True)
    with pytest.raises(DeferOperation) as deferred:
        await memory.sessions.run_check({"bank_id": bank, "session_id": "s1"})
    summary = await memory.sessions.get(bank, "s1", request_context=request_context)
    wait = (deferred.value.exec_date - summary.updated_at).total_seconds()
    assert 0.5 < wait <= 1.0 and calls == []  # quiet window, by the database's clock
    # Once it has settled, it runs.
    monkeypatch.setenv("HINDSIGHT_API_SESSION_CHECK_QUIET_MS", "0")
    from hindsight_api.config import clear_config_cache

    clear_config_cache()
    await memory.sessions.run_check({"bank_id": bank, "session_id": "s1"})
    assert len(calls) == 1


async def test_delete_removes_the_session_and_its_log(memory, request_context, api_client):
    bank = _bank()
    await memory.sessions.append(
        bank, "s1", _req({"id": "1", "role": "user", "text": "hi"}), request_context=request_context
    )
    r = await api_client.delete(f"/v1/default/banks/{bank}/sessions/s1")
    assert r.status_code == 200
    assert (await api_client.get(f"/v1/default/banks/{bank}/sessions/s1/events")).status_code == 404
    assert (await api_client.delete(f"/v1/default/banks/{bank}/sessions/s1")).status_code == 404


async def test_every_session_endpoint_is_validated_and_a_tag_scoped_caller_is_refused(memory, api_client, monkeypatch):
    from unittest.mock import AsyncMock, MagicMock

    from hindsight_api.engine.search.tags import TagGroupLeaf
    from hindsight_api.extensions import ValidationResult

    seen: list[str] = []

    async def record(ctx):
        seen.append(str(ctx.operation))
        return ValidationResult.accept()

    validator = MagicMock()
    validator.validate_bank_read = AsyncMock(side_effect=record)
    validator.validate_bank_write = AsyncMock(side_effect=record)
    validator.validate_create_bank = AsyncMock(return_value=ValidationResult.accept())
    validator.resolve_tag_scope = AsyncMock(return_value=None)
    validator.resolve_write_tag_scope = AsyncMock(return_value=None)
    monkeypatch.setattr(memory, "_operation_validator", validator)

    async def no_retain(*_, **__):
        return {}

    monkeypatch.setattr(memory, "submit_async_retain", no_retain)
    bank, base = _bank(), None
    base = f"/v1/default/banks/{bank}/sessions"
    assert (
        await api_client.post(f"{base}/s1/events", json={"events": [{"id": "1", "role": "user", "text": "hi"}]})
    ).status_code == 200
    assert (await api_client.get(f"{base}/s1/events")).status_code == 200
    assert (await api_client.get(base)).status_code == 200
    assert (await api_client.get(f"{base}/s1")).status_code == 200
    assert (await api_client.post(f"{base}/s1/close")).status_code == 200
    assert seen == [
        "append_session_events",
        "list_session_events",
        "list_sessions",
        "get_session",
        "close_session",
    ]
    # A caller confined to some tags would see the whole bank through the watcher's notes.
    validator.resolve_tag_scope = AsyncMock(return_value=[TagGroupLeaf(tags=["user:dan"], match="any_strict")])
    refused = await api_client.post(f"{base}/s1/events", json={"events": [{"id": "2", "role": "user", "text": "x"}]})
    assert refused.status_code == 403 and "tag-scoped caller" in refused.json()["detail"]
    assert (await api_client.get(f"{base}/s1/events")).status_code == 403
