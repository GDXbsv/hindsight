#!/usr/bin/env python3
"""
Sessions API examples for Hindsight (live conversations and the memory watcher).
Run: python examples/api/sessions.py
"""
import asyncio
import os
import uuid

from hindsight_client import Hindsight
from hindsight_client_api.models import SessionAppendRequest, SessionEventIn, SessionOptions

HINDSIGHT_URL = os.getenv("HINDSIGHT_API_URL", "http://localhost:8888")

# =============================================================================
# Setup (not shown in docs)
# =============================================================================
client = Hindsight(base_url=HINDSIGHT_URL)
session_id = f"chat-{uuid.uuid4().hex[:8]}"


async def main() -> None:
    # [docs:sessions-append]
    # Send what happened since the last append. Each event has your own id: sending the
    # same event again (a retry after a lost response) stores nothing twice. The first
    # append creates the session.
    r = await client.sessions.append_session_events(
        "my-bank",
        session_id,
        SessionAppendRequest(
            session=SessionOptions(title="Fix the rounding bug", watch=True, retain="turns"),
            events=[
                SessionEventIn(id="1", role="user", kind="message", text="Half cents round the wrong way."),
                SessionEventIn(
                    id="2", role="assistant", kind="tool_call", tool="Edit", call_id="t1",
                    input={"file_path": "pay/rounding.py"},
                ),
                SessionEventIn(id="3", role="tool", kind="tool_result", call_id="t1", text="updated"),
            ],
        ),
    )
    print(r.accepted, r.last_seq, r.checking)
    # [/docs:sessions-append]

    # [docs:sessions-notes]
    # Notes come back with every append. `ack` is the seq of the last note you delivered:
    # the response carries the notes after it, so a note is handed over until you confirm it.
    delivered = 0
    r = await client.sessions.append_session_events(
        "my-bank", session_id, SessionAppendRequest(events=[], ack=delivered)
    )
    for note in r.notes:
        source = note.source.document_id if note.source else "memory"
        print(f"[{note.trigger}] {note.text} (source: {source})")
        delivered = note.seq
    # [/docs:sessions-notes]

    # [docs:sessions-turn-end]
    # The end of a turn saves the conversation into the session's document
    # (`session:<id>` unless you named one), where memories are extracted from it.
    await client.sessions.append_session_events(
        "my-bank",
        session_id,
        SessionAppendRequest(
            events=[
                SessionEventIn(id="4", role="assistant", kind="message", text="Fixed: half cents round down."),
                SessionEventIn(id="5", role="assistant", kind="turn_end"),
            ],
            ack=delivered,
        ),
    )
    # [/docs:sessions-turn-end]

    # [docs:sessions-follow]
    # Follow the session's log: your events and Hindsight's checks, notes and saves, in one order.
    after = 0
    log = await client.sessions.list_session_events("my-bank", session_id, after=after)
    for entry in log.items:
        print(entry.seq, entry.source, entry.kind)
    after = log.last_seq  # poll again with this to get only what is new
    # [/docs:sessions-follow]

    # [docs:sessions-list]
    sessions = await client.sessions.list_sessions("my-bank", limit=20)
    for s in sessions.items:
        print(s.session_id, s.status, s.note_count, s.delivered_count)
    # [/docs:sessions-list]

    # [docs:sessions-close]
    # Closing saves what is not saved yet. A later append opens the session again.
    await client.sessions.close_session("my-bank", session_id)
    # [/docs:sessions-close]

    # [docs:sessions-delete]
    # Deletes the session and its log. The document it saved stays: that is memory now.
    await client.sessions.delete_session("my-bank", session_id)
    # [/docs:sessions-delete]

    # Cleanup (not shown in docs)
    await client.adelete_bank(bank_id="my-bank")
    await client.aclose()


asyncio.run(main())
