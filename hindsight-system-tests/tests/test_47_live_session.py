"""A live session: a client streams a conversation in, Hindsight speaks once, and the turn becomes memory.

Retain, reflect and the worker meet here for the first time as one conversation. The client only
appends what happens; the server decides what is worth a check, runs the check in the background,
writes the note into the session's log, hands it back on a later append until the client
acknowledges it, and at the end of the turn saves the conversation into the session's document,
where extraction finds it like any retained document.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid

import pytest
from hindsight_client_api.models import SessionAppendRequest, SessionEventIn, SessionOptions

from hindsight_system_tests.payloads import extracted, fact, observes
from hindsight_system_tests.reflect import reflect_loop

pytestmark = pytest.mark.asyncio

DECISION = "parse_quantity reads memory suffixes as binary: K is 1024, never 1000"
NOTE = "Memory suffixes are binary: K is 1024, not 1000."
REQUEST = "Fix parse_quantity so pods get the memory their config asks for."


@pytest.fixture
async def decided_bank(client, llm, bank_id, settled) -> str:
    llm.on_step("extract_facts").returns(
        extracted(fact("We decided parse_quantity memory suffixes are binary, K is 1024", entities=["parse_quantity"]))
    )
    llm.on_step("consolidate").answers_with(observes(DECISION))
    await client.aretain(bank_id=bank_id, content="We decided parse_quantity memory suffixes are binary: K is 1024.")
    await settled(bank_id)
    return bank_id


async def _log(client, bank: str, session: str, *, kind: str, timeout: float = 30.0):
    """The session's log once it holds an entry of ``kind``: the check runs in the background."""
    deadline = time.monotonic() + timeout
    while True:
        log = await client.sessions.list_session_events(bank, session)
        if any(e.kind == kind for e in log.items):
            return log.items
        assert time.monotonic() < deadline, f"no {kind} in the session log: {[(e.kind, e.payload) for e in log.items]}"
        await asyncio.sleep(0.25)


async def test_a_watched_session_hears_the_decision_once_and_its_turn_is_saved(client, llm, decided_bank, settled):
    # This server has no decision model: the check is reflect's agent loop, which finds the decision.
    reflect_loop(llm, answer=NOTE, query="parse_quantity")
    session = f"live-{uuid.uuid4().hex[:8]}"

    r = await client.sessions.append_session_events(
        decided_bank,
        session,
        SessionAppendRequest(
            session=SessionOptions(watch=True, retain="turns", title="parse_quantity"),
            events=[SessionEventIn(id="1", role="user", kind="message", text=REQUEST)],
        ),
    )
    assert r.accepted == 1 and r.notes == [], "the append never waits for the check"

    log = await _log(client, decided_bank, session, kind="note")
    check = next(e for e in log if e.kind == "check")
    assert check.source == "hindsight" and check.payload["trigger"] == "task"
    assert check.payload["outcome"] == "note" and check.payload["moment_seq"] == 1

    # Handed back on the next append, until acknowledged.
    r = await client.sessions.append_session_events(decided_bank, session, SessionAppendRequest(events=[]))
    assert [n.text for n in r.notes] == [NOTE]
    note = r.notes[0]
    assert note.trigger == "task"
    r = await client.sessions.append_session_events(decided_bank, session, SessionAppendRequest(events=[], ack=note.seq))
    assert r.notes == []

    # The same request again is not judged twice; the end of the turn saves the conversation.
    await client.sessions.append_session_events(
        decided_bank,
        session,
        SessionAppendRequest(
            events=[
                SessionEventIn(id="1", role="user", kind="message", text=REQUEST),  # a retry: stored once
                SessionEventIn(id="2", role="assistant", kind="message", text="Reading parse_quantity as binary."),
                SessionEventIn(id="3", role="assistant", kind="turn_end"),
            ],
            ack=note.seq,
        ),
    )
    log = await _log(client, decided_bank, session, kind="save")
    await settled(decided_bank)
    assert [e.event_id for e in log if e.source == "client"] == ["1", "2", "3"]

    doc = await client.documents.get_document(decided_bank, f"session:{session}")
    lines = [json.loads(line) for line in doc.original_text.splitlines()]
    assert [(t["role"], t["content"]) for t in lines] == [
        ("system", f"REF-ID: session:{session}"),
        ("user", REQUEST),
        ("assistant", "Reading parse_quantity as binary."),
    ]
    summary = await client.sessions.get_session(decided_bank, session)
    assert (summary.note_count, summary.delivered_count) == (1, 1)
    assert summary.saved_seq >= 3
