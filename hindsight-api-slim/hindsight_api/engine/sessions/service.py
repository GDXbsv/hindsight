"""Sessions: a live conversation a client streams in, and the memory watcher's side of it.

The protocol is plain request/response, so any server instance can take any request:

- **append** (``POST .../sessions/{id}/events``): the client sends what happened since its last
  append, each event with its own id. One transaction stores the new ones (a retried event is
  found by its id and skipped), reads them into the watcher's state, and returns the notes the
  client has not acknowledged yet. When the events make a moment worth checking, a ``session_check``
  operation is queued; the append never waits for it.
- **check** (worker): takes the session's pending moment, asks reflect with ``abstain``, and writes
  what it did to the session log, plus a note when there is something to say. One check runs per
  session at a time (the operation's serialization key); a check that finds new moments when it
  finishes takes them too, the latest and heaviest first.
- **save** (worker): writes the conversation's new turns into the session's document, as an append
  to it, at the end of a turn (``retain: turns``) or when the session closes. Memories are extracted
  from the document as from any retained one. The session decides when to pay for extraction; the
  log itself is written on every append and costs no model call.
- **read** (``GET .../sessions/{id}/events?after=``): the log from a position, for a client that
  waits for a late note and for the UI that follows the session live.

Everything a request needs is in the database: no server remembers a session between requests,
and a check that dies mid-way is retried by the next worker that claims its operation.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel

from ...config import get_config
from ...extensions import BankReadOperation, BankWriteOperation
from ...worker.exceptions import DeferOperation
from ..db_utils import acquire_with_retry
from ..schema import fq_table
from . import watch as W
from .models import (
    SessionAppendRequest,
    SessionAppendResponse,
    SessionEvent,
    SessionEventsResponse,
    SessionListResponse,
    SessionNote,
    SessionNoteSource,
    SessionOptions,
    SessionSummary,
)

if TYPE_CHECKING:
    from ...models import RequestContext
    from ..memory_engine import MemoryEngine

logger = logging.getLogger(__name__)

CHECK_TASK = "session_check"
SAVE_TASK = "session_save"
# Moments one check takes before it hands over: a session that keeps producing moments still gets
# its notes written, and the next queued check carries on.
MAX_ROUNDS = 4
# A check that started longer ago than this is taken for dead (its worker crashed): the session no
# longer reports itself as checking. The operation itself is retried by the worker poller.
CHECKING_STALE_S = 300
REFLECT_MAX_TOKENS = 600
# How the saved conversation reads to extraction when the client does not say: who is speaking.
DEFAULT_SAVE_CONTEXT = (
    "conversation between a user and an assistant: user turns are the user's words and decisions, "
    "assistant turns are the assistant's. When an assistant turn says something is done or works, "
    "record it as the assistant's claim, not as an established fact."
)
# A tool call saved as one compact line (the tool and its main target), as the coding-agents plugin
# has always saved its transcripts: tool output is mechanical noise for extraction.
_ACTION_TARGET_KEYS = ("file_path", "path", "notebook_path", "command", "cmd", "pattern", "query", "url", "name", "id")
_ACTION_TARGET_CAP = 100


def default_document_id(session_id: str) -> str:
    return f"session:{session_id}"


def _settings_of(opts: SessionOptions | None, current: dict[str, Any] | None = None) -> dict[str, Any]:
    out = dict(current or {})
    if opts is not None:
        for key in ("watch", "retain", "tags", "context", "strategy", "observation_scopes"):
            value = getattr(opts, key)
            if value is not None:
                out[key] = value
    out.setdefault("watch", False)
    out.setdefault("retain", "turns")
    return out


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _checking(state: W.WatchState, checking_since: datetime | None) -> bool:
    if state.pending is not None:
        return True
    return checking_since is not None and (_now() - checking_since).total_seconds() < CHECKING_STALE_S


def _action_line(tool: str, data: dict[str, Any]) -> str:
    target = ""
    for key in _ACTION_TARGET_KEYS:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            target = value.strip().split("\n")[0]
            break
    if len(target) > _ACTION_TARGET_CAP:
        target = f"{target[:_ACTION_TARGET_CAP]}…"
    return f"{tool} {target}".strip()


def _turn(kind: str, payload: dict[str, Any], at: datetime) -> dict[str, str] | None:
    """One logged client event as a saved transcript line, or None when it is not saved: what was
    said, and one compact line per tool call. Tool output, state snapshots and markers are left out."""
    role = payload.get("role")
    if kind == "message" and role in ("user", "assistant") and (payload.get("text") or "").strip():
        return {"role": role, "content": payload["text"], "timestamp": at.isoformat()}
    if kind == "tool_call" and payload.get("tool"):
        inp = payload.get("input")
        return {
            "role": "action",
            "content": _action_line(payload["tool"], inp if isinstance(inp, dict) else {}),
            "timestamp": at.isoformat(),
        }
    return None


class SavePlan(BaseModel):
    """A save in flight: the log range it covers and the retain operation it submits."""

    from_seq: int
    upto_seq: int
    operation_id: str


class SessionNotFoundError(LookupError):
    pass


class SessionService:
    def __init__(self, engine: MemoryEngine) -> None:
        self._engine = engine

    async def _authorize(
        self,
        bank_id: str,
        request_context: RequestContext,
        *,
        read: BankReadOperation | None = None,
        write: BankWriteOperation | None = None,
    ) -> None:
        """Tenant, then the operation validator's read or write hook, then refuse a tag-scoped caller.

        Refused rather than narrowed: the watcher's reflect searches the whole bank, so a note could
        carry a memory outside the caller's tags, and the log holds whatever the client sent.
        """
        engine = self._engine
        await engine._authenticate_tenant(request_context)
        validator = engine._operation_validator
        if validator is not None and read is not None:
            from ...extensions import BankReadContext

            ctx = BankReadContext(bank_id=bank_id, operation=read, request_context=request_context)
            await engine._validate_operation(validator.validate_bank_read(ctx))
        if validator is not None and write is not None:
            from ...extensions import BankWriteContext

            wctx = BankWriteContext(bank_id=bank_id, operation=write, request_context=request_context)
            await engine._validate_operation(validator.validate_bank_write(wctx))
        await engine._refuse_bank_wide_if_scoped(bank_id, request_context, "use sessions")

    # ------------------------------------------------------------------ append

    async def append(
        self,
        bank_id: str,
        session_id: str,
        request: SessionAppendRequest,
        *,
        request_context: RequestContext,
    ) -> SessionAppendResponse:
        engine = self._engine
        await self._authorize(bank_id, request_context, write=BankWriteOperation.APPEND_SESSION_EVENTS)
        backend = await engine._get_backend()
        opts = request.session
        if not request.events and opts is None:
            return await self._poll(bank_id, session_id, request.ack)
        async with acquire_with_retry(backend) as conn:
            async with conn.transaction():
                created_bank = await engine._ensure_bank_exists(bank_id, request_context, conn=conn)
                # Create on first sight, then lock: concurrent first appends both insert-or-skip,
                # and the row lock serializes everything after (seq allocation, the watcher state).
                await conn.execute(
                    f"""
                    INSERT INTO {fq_table("sessions")}
                        (bank_id, session_id, document_id, title, source, settings, metadata)
                    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
                    ON CONFLICT DO NOTHING
                    """,
                    bank_id,
                    session_id,
                    (opts.document_id if opts and opts.document_id else default_document_id(session_id)),
                    opts.title if opts else None,
                    opts.source if opts else None,
                    json.dumps(_settings_of(opts)),
                    json.dumps(opts.metadata if opts and opts.metadata else {}),
                )
                row = await conn.fetchrow(
                    f"""
                    SELECT next_seq, acked_seq, settings, metadata, watch_state, checking_since, title, source
                    FROM {fq_table("sessions")}
                    WHERE bank_id = $1 AND session_id = $2
                    FOR UPDATE
                    """,
                    bank_id,
                    session_id,
                )
                settings = _settings_of(opts, conn.parse_json(row["settings"]))
                metadata = {
                    **(conn.parse_json(row["metadata"]) or {}),
                    **(opts.metadata if opts and opts.metadata else {}),
                }
                state = W.WatchState.model_validate(conn.parse_json(row["watch_state"]) or {})

                # A retried append resends events already stored: find them by id.
                ids = list(dict.fromkeys(e.id for e in request.events))
                known: set[str] = set()
                if ids:
                    known = {
                        r["event_id"]
                        for r in await conn.fetch(
                            f"""
                            SELECT event_id FROM {fq_table("session_events")}
                            WHERE bank_id = $1 AND session_id = $2 AND event_id = ANY($3)
                            """,
                            bank_id,
                            session_id,
                            ids,
                        )
                    }
                seq = int(row["next_seq"])
                rows: list[tuple[int, str, str, datetime | None, str]] = []
                seen: set[str] = set()
                for event in request.events:
                    if event.id in known or event.id in seen:
                        continue
                    seen.add(event.id)
                    payload = event.model_dump(mode="json", exclude={"id", "kind", "ts"}, exclude_defaults=True)
                    if settings["watch"]:
                        step = W.step_of(event.kind, event.role, payload)
                        if step is not None:
                            W.read_step(state, step, seq)
                    rows.append((seq, event.id, event.kind, event.ts, json.dumps(payload)))
                    seq += 1
                turn_ended = any(r[2] == "turn_end" for r in rows)
                if rows:
                    await conn.bulk_insert_from_arrays(
                        fq_table("session_events"),
                        ["bank_id", "session_id", "seq", "event_id", "source", "kind", "ts", "payload"],
                        [
                            [bank_id] * len(rows),
                            [session_id] * len(rows),
                            [r[0] for r in rows],
                            [r[1] for r in rows],
                            ["client"] * len(rows),
                            [r[2] for r in rows],
                            [r[3] for r in rows],
                            [r[4] for r in rows],
                        ],
                        column_types=[
                            "text[]",
                            "text[]",
                            "int8[]",
                            "text[]",
                            "text[]",
                            "text[]",
                            "timestamptz[]",
                            "jsonb[]",
                        ],
                    )
                acked = max(int(row["acked_seq"]), request.ack or 0)
                # An append with nothing new (a client asking for notes) writes nothing: it is the
                # common case for a hook that runs on every tool call.
                if rows or opts is not None or acked != int(row["acked_seq"]):
                    await conn.execute(
                        f"""
                        UPDATE {fq_table("sessions")}
                        SET next_seq = $3, event_count = event_count + $4, acked_seq = $5,
                            watch_state = $6::jsonb, settings = $7::jsonb, metadata = $8::jsonb,
                            title = COALESCE($9, title), source = COALESCE($10, source),
                            last_event_at = CASE WHEN $11 > 0 THEN now() ELSE last_event_at END,
                            pending_since = CASE WHEN $12 = 1 THEN COALESCE(pending_since, now()) ELSE NULL END,
                            status = 'open', updated_at = now()
                        WHERE bank_id = $1 AND session_id = $2
                        """,
                        bank_id,
                        session_id,
                        seq,
                        len(rows),
                        acked,
                        state.model_dump_json(),
                        json.dumps(settings),
                        json.dumps(metadata),
                        opts.title if opts else None,
                        opts.source if opts else None,
                        len(rows),
                        1 if state.pending is not None else 0,
                    )
                notes = await self._notes_after(
                    conn, bank_id, session_id, request.ack if request.ack is not None else acked
                )
                checking = settings["watch"] and _checking(state, row["checking_since"])
        if created_bank:
            await engine._apply_default_bank_template(bank_id, request_context)
        # Only when this append brought something: the moment was queued by the append that made it.
        if rows and settings["watch"] and state.pending is not None:
            await self._queue_check(bank_id, session_id, request_context)
        if turn_ended and settings["retain"] == "turns":
            await self._queue_save(bank_id, session_id, request_context)
        return SessionAppendResponse(
            session_id=session_id,
            accepted=len(rows),
            duplicates=len(request.events) - len(rows),
            last_seq=seq - 1,
            notes=notes,
            checking=checking,
        )

    async def _poll(self, bank_id: str, session_id: str, ack: int | None) -> SessionAppendResponse:
        """An append with no events: what a client sends to fetch notes. No lock and no write but the
        acknowledgement, and a session that does not exist yet is not created."""
        backend = await self._engine._get_backend()
        async with acquire_with_retry(backend) as conn:
            row = await conn.fetchrow(
                f"""
                SELECT next_seq, acked_seq, settings, watch_state, checking_since FROM {fq_table("sessions")}
                WHERE bank_id = $1 AND session_id = $2
                """,
                bank_id,
                session_id,
            )
            if row is None:
                return SessionAppendResponse(
                    session_id=session_id, accepted=0, duplicates=0, last_seq=0, notes=[], checking=False
                )
            acked = int(row["acked_seq"])
            if ack is not None and ack > acked:
                await conn.execute(
                    f"""
                    UPDATE {fq_table("sessions")} SET acked_seq = $3
                    WHERE bank_id = $1 AND session_id = $2 AND acked_seq < $3
                    """,
                    bank_id,
                    session_id,
                    ack,
                )
                acked = ack
            settings = _settings_of(None, conn.parse_json(row["settings"]))
            state = W.WatchState.model_validate(conn.parse_json(row["watch_state"]) or {})
            return SessionAppendResponse(
                session_id=session_id,
                accepted=0,
                duplicates=0,
                last_seq=int(row["next_seq"]) - 1,
                notes=await self._notes_after(conn, bank_id, session_id, ack if ack is not None else acked),
                checking=bool(settings["watch"]) and _checking(state, row["checking_since"]),
            )

    async def _notes_after(self, conn: Any, bank_id: str, session_id: str, after: int) -> list[SessionNote]:
        rows = await conn.fetch(
            f"""
            SELECT seq, payload, created_at FROM {fq_table("session_events")}
            WHERE bank_id = $1 AND session_id = $2 AND source = 'hindsight' AND kind = 'note' AND seq > $3
            ORDER BY seq
            """,
            bank_id,
            session_id,
            after,
        )
        notes = []
        for r in rows:
            p = conn.parse_json(r["payload"]) or {}
            notes.append(
                SessionNote(
                    seq=int(r["seq"]),
                    text=p.get("text", ""),
                    trigger=p.get("trigger", ""),
                    memory_ids=p.get("memory_ids") or [],
                    source=SessionNoteSource.model_validate(p["source"]) if p.get("source") else None,
                    created_at=r["created_at"],
                )
            )
        return notes

    async def _queue(self, task: str, key: str, bank_id: str, session_id: str, request_context: RequestContext) -> None:
        payload: dict[str, Any] = {"session_id": session_id}
        if request_context.tenant_id:
            payload["_tenant_id"] = request_context.tenant_id
        if request_context.api_key_id:
            payload["_api_key_id"] = request_context.api_key_id
        # At most one waits per session (a waiting one reads the session when it runs, so it covers
        # everything since it was queued), and one runs at a time.
        #
        # A failure here does not fail the request: what the client sent is already stored, and the
        # work is queued again by the session's next append (a pending moment, or a turn end not yet
        # saved, stays in the session until a check or save takes it).
        try:
            await self._submit(task, key, bank_id, session_id, payload)
        except Exception as e:
            logger.warning(f"could not queue {task} for {bank_id}/{session_id}: {e}")

    async def _submit(self, task: str, key: str, bank_id: str, session_id: str, payload: dict[str, Any]) -> None:
        await self._engine._submit_async_operation(
            bank_id=bank_id,
            operation_type=task,
            task_type=task,
            task_payload=payload,
            dedupe_in_flight_payload_key="session_id",
            dedupe_in_flight_includes_processing=False,
            serialization_key=f"{key}:{session_id}",
        )

    async def _queue_check(self, bank_id: str, session_id: str, request_context: RequestContext) -> None:
        await self._queue(CHECK_TASK, "session", bank_id, session_id, request_context)

    async def _queue_save(self, bank_id: str, session_id: str, request_context: RequestContext) -> None:
        # Its own serialization key: a save does not wait behind a check's reflect, nor a check
        # behind a save.
        await self._queue(SAVE_TASK, "session-save", bank_id, session_id, request_context)

    # ------------------------------------------------------------------ check (worker)

    @staticmethod
    def _task_context(task: dict[str, Any]) -> RequestContext:
        from ...models import RequestContext

        return RequestContext(
            internal=True,
            tenant_id=task.get("_tenant_id"),
            api_key_id=task.get("_api_key_id"),
            retry_count=task.get("_retry_count", 0),
        )

    async def run_check(self, task: dict[str, Any]) -> None:
        bank_id: str = task["bank_id"]
        session_id: str = task["session_id"]
        rc = self._task_context(task)
        backend = await self._engine._get_backend()
        for _ in range(MAX_ROUNDS):
            # Take the moment under the session's lock; the slow part runs without it.
            async with acquire_with_retry(backend) as conn:
                async with conn.transaction():
                    row = await conn.fetchrow(
                        f"""
                        SELECT watch_state, pending_since, last_event_at, now() AS db_now FROM {fq_table("sessions")}
                        WHERE bank_id = $1 AND session_id = $2 FOR UPDATE
                        """,
                        bank_id,
                        session_id,
                    )
                    if row is None:
                        return
                    state = W.WatchState.model_validate(conn.parse_json(row["watch_state"]) or {})
                    settle = self._settle_at(row)
                    if state.pending is not None and settle is not None and self._engine._task_backend.can_defer:
                        # Not yet: back in the queue until the session settles. A deferral is not a
                        # failed attempt, and appends meanwhile fold into this same operation.
                        raise DeferOperation(exec_date=settle, reason="waiting for the session to settle")
                    moment = W.take_moment(state)
                    skip = W.skip_reason(state, moment) if moment else None
                    await conn.execute(
                        f"""
                        UPDATE {fq_table("sessions")}
                        SET watch_state = $3::jsonb, checking_since = $4, pending_since = NULL
                        WHERE bank_id = $1 AND session_id = $2
                        """,
                        bank_id,
                        session_id,
                        state.model_dump_json(),
                        _now() if moment and not skip else None,
                    )
                    if moment and skip:
                        await self._log(
                            conn,
                            bank_id,
                            session_id,
                            "check",
                            self._check_payload(moment, outcome="skipped", reason=skip),
                        )
            if moment is None:
                return
            if skip:
                continue
            await self._check(bank_id, session_id, moment, state.goal or moment.text, list(state.sent), rc)

    @staticmethod
    def _settle_at(row: Any) -> datetime | None:
        """When the pending moment may be checked, by the database's clock, or None when it may be now:
        once the session has been quiet for a while, and at the latest a while after the moment
        appeared. Database time because the append and the check may run on different machines."""
        cfg = get_config()
        if row["pending_since"] is None or row["last_event_at"] is None:
            return None
        at = min(
            row["last_event_at"] + timedelta(milliseconds=cfg.session_check_quiet_ms),
            row["pending_since"] + timedelta(milliseconds=cfg.session_check_max_wait_ms),
        )
        return at if at > row["db_now"] else None

    def _check_payload(self, m: W.Moment, **extra: Any) -> dict[str, Any]:
        return {"trigger": m.trigger, "moment_seq": m.seq, "moment": m.text[:2000], **extra}

    async def _check(
        self, bank_id: str, session_id: str, m: W.Moment, goal: str, sent: list[str], rc: RequestContext
    ) -> None:
        from ..memory_engine import Budget

        context = W.situation(goal, m, sent)
        queries = W.search_queries(m)
        t0 = time.monotonic()
        error = None
        text, memory_ids, usage, calls, abstained = "", [], None, [], False
        try:
            result = await self._engine.reflect_async(
                bank_id=bank_id,
                query=W.question(m),
                context=context,
                budget=Budget.LOW,
                max_tokens=REFLECT_MAX_TOKENS,
                fact_types=["observation"],
                exclude_mental_models=True,
                abstain=True,
                search_queries=queries,
                request_context=rc,
            )
            text = (result.text or "").strip()
            abstained = result.abstained
            memory_ids = [
                str(f.id)
                for kind, facts in result.based_on.items()
                if kind not in ("directives", "mental-models")
                for f in facts
            ]
            usage = result.usage.model_dump() if result.usage else None
            calls = [c.model_dump() for c in result.llm_trace]
        except Exception as e:  # a failed check is logged and the session goes on: notes are best-effort
            logger.warning(f"session check failed for {bank_id}/{session_id}: {e}")
            error = str(e)[:500]
        ms = int((time.monotonic() - t0) * 1000)
        # Looked up before taking the lock, and only when there is a note to cite: a few reads.
        source = await self._source_of(bank_id, memory_ids, text, rc) if text and not error else None

        backend = await self._engine._get_backend()
        async with acquire_with_retry(backend) as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    f"""
                    SELECT watch_state FROM {fq_table("sessions")}
                    WHERE bank_id = $1 AND session_id = $2 FOR UPDATE
                    """,
                    bank_id,
                    session_id,
                )
                if row is None:
                    return
                state = W.WatchState.model_validate(conn.parse_json(row["watch_state"]) or {})
                spoke = not error and W.accept_note(state, m, text, memory_ids)
                outcome = "error" if error else "note" if spoke else "repeat" if text else "silent"
                check_seq = await self._log(
                    conn,
                    bank_id,
                    session_id,
                    "check",
                    self._check_payload(
                        m,
                        outcome=outcome,
                        error=error,
                        ms=ms,
                        question="headsup" if m.trigger == "task" else "conflict",
                        context=context,
                        search_queries=queries,
                        answer=text,
                        abstained=abstained,
                        memory_ids=memory_ids,
                        usage=usage,
                        llm_calls=calls,
                    ),
                )
                if spoke:
                    await self._log(
                        conn,
                        bank_id,
                        session_id,
                        "note",
                        {
                            "text": text,
                            "trigger": m.trigger,
                            "check_seq": check_seq,
                            "memory_ids": memory_ids,
                            "source": source.model_dump(mode="json") if source else None,
                        },
                    )
                await conn.execute(
                    f"""
                    UPDATE {fq_table("sessions")}
                    SET watch_state = $3::jsonb, checking_since = NULL,
                        check_count = check_count + 1, note_count = note_count + $4, updated_at = now()
                    WHERE bank_id = $1 AND session_id = $2
                    """,
                    bank_id,
                    session_id,
                    state.model_dump_json(),
                    1 if spoke else 0,
                )

    async def _log(self, conn: Any, bank_id: str, session_id: str, kind: str, payload: dict[str, Any]) -> int:
        """Append one of Hindsight's own entries (a check, a note, a save) to the session log, at the
        next position. Needs the session row locked."""
        seq = int(
            await conn.fetchval(
                f"SELECT next_seq FROM {fq_table('sessions')} WHERE bank_id = $1 AND session_id = $2",
                bank_id,
                session_id,
            )
        )
        await conn.execute(
            f"""
            INSERT INTO {fq_table("session_events")} (bank_id, session_id, seq, event_id, source, kind, payload)
            VALUES ($1, $2, $3, $4, 'hindsight', $5, $6::jsonb)
            """,
            bank_id,
            session_id,
            seq,
            f"hindsight:{seq}",
            kind,
            json.dumps(payload, default=str),
        )
        await conn.execute(
            f"UPDATE {fq_table('sessions')} SET next_seq = $3 WHERE bank_id = $1 AND session_id = $2",
            bank_id,
            session_id,
            seq + 1,
        )
        return seq

    async def _source_of(
        self, bank_id: str, memory_ids: list[str], note: str, rc: RequestContext
    ) -> SessionNoteSource | None:
        """Where the note comes from: the newest document behind the first memory it used, and that
        document's closest sentence to the note (verbatim), so the reader can check it."""
        if not memory_ids:
            return None
        try:
            memory = await self._engine.get_memory_unit(bank_id, memory_ids[0], request_context=rc)
            sources = []
            for sid in ((memory or {}).get("source_memory_ids") or [])[:6]:
                unit = await self._engine.get_memory_unit(bank_id, sid, request_context=rc)
                if unit and unit.get("document_id"):
                    sources.append(unit)
            if memory and memory.get("document_id"):
                sources.append(memory)
            sources.sort(key=lambda u: str(u.get("mentioned_at") or ""), reverse=True)
            for unit in sources:
                doc = await self._engine.get_document(unit["document_id"], bank_id, request_context=rc)
                if not doc:
                    continue
                quote = W.best_sentence(W.readable(doc.get("original_text") or ""), note)
                if quote:
                    return SessionNoteSource(
                        document_id=unit["document_id"],
                        quote=quote,
                        mentioned_at=unit.get("mentioned_at"),
                        metadata=doc.get("document_metadata") or {},
                    )
            if sources:
                return SessionNoteSource(
                    document_id=sources[0]["document_id"], mentioned_at=sources[0].get("mentioned_at")
                )
        except Exception as e:  # the note stands without its source
            logger.warning(f"session note source lookup failed for {bank_id}: {e}")
        return None

    # ------------------------------------------------------------------ save (worker)

    async def run_save(self, task: dict[str, Any]) -> None:
        """Write the conversation's turns since the last save into the session's document.

        Three steps, each safe to repeat. (1) Under the session lock, plan the save: the range of
        the log it covers and the retain operation id it will use, stored in ``save_plan``. A plan
        already there (an earlier attempt that died) is reused as is. (2) Submit the retain as an
        append to the document, with that operation id: the server turns a resubmission of a known
        id into a no-op, so a retried save never writes a turn twice. (3) Move ``saved_seq`` to the
        end of the range and clear the plan.
        """
        bank_id: str = task["bank_id"]
        session_id: str = task["session_id"]
        rc = self._task_context(task)
        backend = await self._engine._get_backend()
        async with acquire_with_retry(backend) as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    f"""
                    SELECT document_id, settings, metadata, source, created_at, next_seq, saved_seq, save_plan
                    FROM {fq_table("sessions")} WHERE bank_id = $1 AND session_id = $2 FOR UPDATE
                    """,
                    bank_id,
                    session_id,
                )
                if row is None:
                    return
                stored = conn.parse_json(row["save_plan"])
                if stored:
                    plan = SavePlan.model_validate(stored)
                else:
                    upto = int(row["next_seq"]) - 1
                    if upto <= int(row["saved_seq"]):
                        return
                    plan = SavePlan(from_seq=int(row["saved_seq"]), upto_seq=upto, operation_id=str(uuid.uuid4()))
                    await conn.execute(
                        f"UPDATE {fq_table('sessions')} SET save_plan = $3::jsonb WHERE bank_id = $1 AND session_id = $2",
                        bank_id,
                        session_id,
                        plan.model_dump_json(),
                    )
            events = await conn.fetch(
                f"""
                SELECT seq, kind, ts, created_at, payload FROM {fq_table("session_events")}
                WHERE bank_id = $1 AND session_id = $2 AND source = 'client' AND seq > $3 AND seq <= $4
                ORDER BY seq
                """,
                bank_id,
                session_id,
                plan.from_seq,
                plan.upto_seq,
            )
            turns = [
                t
                for e in events
                if (t := _turn(e["kind"], conn.parse_json(e["payload"]) or {}, e["ts"] or e["created_at"]))
            ]
            settings = _settings_of(None, conn.parse_json(row["settings"]))
            metadata = conn.parse_json(row["metadata"]) or {}
        document_id: str = row["document_id"]
        if turns:
            if plan.from_seq == 0:
                # The document names itself, as the coding-agents transcripts always have: a reader of
                # a memory's source can find the session it came from.
                turns.insert(
                    0, {"role": "system", "content": f"REF-ID: {document_id}", "timestamp": turns[0]["timestamp"]}
                )
            item: dict[str, Any] = {
                "content": "\n".join(json.dumps(t, ensure_ascii=False) for t in turns),
                "context": settings.get("context") or DEFAULT_SAVE_CONTEXT,
                "document_id": document_id,
                "timestamp": row["created_at"].isoformat(),
                "update_mode": "append",
                # The session's own metadata, as the client set it, plus which session wrote it.
                "metadata": {**{k: str(v) for k, v in metadata.items()}, "session_id": session_id},
            }
            if settings.get("tags"):
                item["tags"] = settings["tags"]
            if settings.get("observation_scopes") is not None:
                item["observation_scopes"] = settings["observation_scopes"]
            await self._engine.submit_async_retain(
                bank_id,
                [item],
                request_context=rc,
                strategy=settings.get("strategy"),
                operation_id=plan.operation_id,
            )
        async with acquire_with_retry(backend) as conn:
            async with conn.transaction():
                await conn.fetchrow(
                    f"SELECT 1 FROM {fq_table('sessions')} WHERE bank_id = $1 AND session_id = $2 FOR UPDATE",
                    bank_id,
                    session_id,
                )
                await self._log(
                    conn,
                    bank_id,
                    session_id,
                    "save",
                    {
                        "from_seq": plan.from_seq,
                        "to_seq": plan.upto_seq,
                        "turns": len(turns),
                        "document_id": document_id,
                        "operation_id": plan.operation_id if turns else None,
                    },
                )
                await conn.execute(
                    f"""
                    UPDATE {fq_table("sessions")} SET saved_seq = $3, save_plan = NULL
                    WHERE bank_id = $1 AND session_id = $2
                    """,
                    bank_id,
                    session_id,
                    plan.upto_seq,
                )

    # ------------------------------------------------------------------ reads

    async def events(
        self,
        bank_id: str,
        session_id: str,
        *,
        after: int = 0,
        limit: int = 200,
        request_context: RequestContext,
    ) -> SessionEventsResponse:
        engine = self._engine
        await self._authorize(bank_id, request_context, read=BankReadOperation.LIST_SESSION_EVENTS)
        backend = await engine._get_backend()
        async with acquire_with_retry(backend) as conn:
            head = await conn.fetchrow(
                f"""
                SELECT next_seq, status, watch_state, checking_since, settings FROM {fq_table("sessions")}
                WHERE bank_id = $1 AND session_id = $2
                """,
                bank_id,
                session_id,
            )
            if head is None:
                raise SessionNotFoundError(session_id)
            rows = await conn.fetch(
                f"""
                SELECT seq, event_id, source, kind, ts, created_at, payload FROM {fq_table("session_events")}
                WHERE bank_id = $1 AND session_id = $2 AND seq > $3
                ORDER BY seq
                LIMIT $4
                """,
                bank_id,
                session_id,
                after,
                limit,
            )
            state = W.WatchState.model_validate(conn.parse_json(head["watch_state"]) or {})
            settings = _settings_of(None, conn.parse_json(head["settings"]))
            return SessionEventsResponse(
                items=[
                    SessionEvent(
                        seq=int(r["seq"]),
                        event_id=r["event_id"],
                        source=r["source"],
                        kind=r["kind"],
                        ts=r["ts"],
                        created_at=r["created_at"],
                        payload=conn.parse_json(r["payload"]) or {},
                    )
                    for r in rows
                ],
                last_seq=int(head["next_seq"]) - 1,
                status=head["status"],
                checking=bool(settings["watch"]) and _checking(state, head["checking_since"]),
            )

    def _summary(self, conn: Any, r: Any) -> SessionSummary:
        settings = _settings_of(None, conn.parse_json(r["settings"]))
        state = W.WatchState.model_validate(conn.parse_json(r["watch_state"]) or {})
        return SessionSummary(
            session_id=r["session_id"],
            document_id=r["document_id"],
            title=r["title"],
            source=r["source"],
            status=r["status"],
            watch=bool(settings["watch"]),
            retain=settings["retain"],
            event_count=int(r["event_count"]),
            check_count=int(r["check_count"]),
            note_count=int(r["note_count"]),
            delivered_count=int(r["delivered_count"]),
            last_seq=int(r["next_seq"]) - 1,
            saved_seq=int(r["saved_seq"]),
            acked_seq=int(r["acked_seq"]),
            checking=bool(settings["watch"]) and _checking(state, r["checking_since"]),
            created_at=r["created_at"],
            updated_at=r["updated_at"],
            last_event_at=r["last_event_at"],
            metadata=conn.parse_json(r["metadata"]) or {},
        )

    @staticmethod
    def _summary_columns() -> str:
        # Delivered notes, counted where the client's acknowledgement reached: one indexed range
        # read per session, so the list can say how many of a session's notes reached the agent.
        return (
            "s.session_id, s.document_id, s.title, s.source, s.status, s.settings, s.metadata, s.watch_state, "
            "s.next_seq, s.saved_seq, s.acked_seq, s.event_count, s.check_count, s.note_count, s.checking_since, "
            "s.created_at, s.updated_at, s.last_event_at, "
            f"(SELECT COUNT(*) FROM {fq_table('session_events')} e WHERE e.bank_id = s.bank_id "
            "AND e.session_id = s.session_id AND e.source = 'hindsight' AND e.kind = 'note' "
            "AND e.seq <= s.acked_seq) AS delivered_count"
        )

    async def get(self, bank_id: str, session_id: str, *, request_context: RequestContext) -> SessionSummary:
        await self._authorize(bank_id, request_context, read=BankReadOperation.GET_SESSION)
        return await self._fetch(bank_id, session_id)

    async def _fetch(self, bank_id: str, session_id: str) -> SessionSummary:
        backend = await self._engine._get_backend()
        async with acquire_with_retry(backend) as conn:
            r = await conn.fetchrow(
                f"SELECT {self._summary_columns()} FROM {fq_table('sessions')} s WHERE s.bank_id = $1 AND s.session_id = $2",
                bank_id,
                session_id,
            )
            if r is None:
                raise SessionNotFoundError(session_id)
            return self._summary(conn, r)

    async def list(
        self, bank_id: str, *, limit: int = 50, offset: int = 0, q: str | None = None, request_context: RequestContext
    ) -> SessionListResponse:
        engine = self._engine
        await self._authorize(bank_id, request_context, read=BankReadOperation.LIST_SESSIONS)
        backend = await engine._get_backend()
        where = "bank_id = $1"
        args: list[Any] = [bank_id]
        if q:
            args.append(f"%{q.lower()}%")
            where += f" AND (LOWER(session_id) LIKE ${len(args)} OR LOWER(COALESCE(title, '')) LIKE ${len(args)})"
        async with acquire_with_retry(backend) as conn:
            total = int(await conn.fetchval(f"SELECT COUNT(*) FROM {fq_table('sessions')} WHERE {where}", *args))
            rows = await conn.fetch(
                f"""
                SELECT {self._summary_columns()} FROM {fq_table("sessions")} s WHERE {where}
                ORDER BY updated_at DESC LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}
                """,
                *args,
                limit,
                offset,
            )
            return SessionListResponse(
                items=[self._summary(conn, r) for r in rows], total=total, limit=limit, offset=offset
            )

    async def close(self, bank_id: str, session_id: str, *, request_context: RequestContext) -> SessionSummary:
        engine = self._engine
        await self._authorize(bank_id, request_context, write=BankWriteOperation.CLOSE_SESSION)
        backend = await engine._get_backend()
        async with acquire_with_retry(backend) as conn:
            status = await conn.execute(
                f"""
                UPDATE {fq_table("sessions")} SET status = 'closed', updated_at = now()
                WHERE bank_id = $1 AND session_id = $2
                """,
                bank_id,
                session_id,
            )
            if status.endswith(" 0"):
                raise SessionNotFoundError(session_id)
        summary = await self._fetch(bank_id, session_id)
        if summary.retain != "off":
            await self._queue_save(bank_id, session_id, request_context)
        return summary

    async def delete(self, bank_id: str, session_id: str, *, request_context: RequestContext) -> None:
        """Delete the session and its log. The document it saved stays: that is memory now, and is
        deleted as a document. A check or save still queued for it finds no session and does nothing."""
        engine = self._engine
        await self._authorize(bank_id, request_context, write=BankWriteOperation.DELETE_SESSION)
        backend = await engine._get_backend()
        async with acquire_with_retry(backend) as conn:
            status = await conn.execute(
                f"DELETE FROM {fq_table('sessions')} WHERE bank_id = $1 AND session_id = $2", bank_id, session_id
            )
        if status.endswith(" 0"):
            raise SessionNotFoundError(session_id)
