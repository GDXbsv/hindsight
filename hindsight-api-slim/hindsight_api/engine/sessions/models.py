"""Request and response shapes of the sessions API."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

EventRole = Literal["user", "assistant", "tool", "system"]
EventKind = Literal["message", "tool_call", "tool_result", "state", "turn_end"]

MAX_EVENTS_PER_APPEND = 500
MAX_EVENT_TEXT = 100_000


class SessionEventIn(BaseModel):
    """One thing that happened in the conversation, as the client saw it."""

    id: str = Field(
        min_length=1,
        max_length=256,
        description="The client's id for this event, unique in the session. Sending it again is a no-op: "
        "an append that is retried after a lost response stores nothing twice.",
    )
    role: EventRole = Field(description="Who it came from: the user, the assistant, a tool, or the system.")
    kind: EventKind = Field(
        default="message",
        description="`message`: something said. `tool_call`: the assistant calling a tool (`tool`, `input`, "
        "`call_id`). `tool_result`: what the tool returned (`call_id`, `text`, `is_error`). `state`: a snapshot "
        "of the work, not said by anyone (`data`, e.g. `{diff}` for a coding agent's change so far). "
        "`turn_end`: the assistant finished its turn.",
    )
    text: str | None = Field(default=None, max_length=MAX_EVENT_TEXT)
    tool: str | None = Field(default=None, max_length=256)
    call_id: str | None = Field(default=None, max_length=256)
    input: dict[str, Any] | None = None
    is_error: bool = False
    data: dict[str, Any] | None = None
    ts: datetime | None = Field(default=None, description="When it happened, by the client's clock.")


class SessionOptions(BaseModel):
    """How the session is set up. Applied when an append creates the session; later appends that
    carry options update the fields they set."""

    title: str | None = Field(default=None, max_length=1000)
    source: str | None = Field(
        default=None, max_length=256, description="What is sending the session, e.g. `claude-code`."
    )
    document_id: str | None = Field(
        default=None,
        max_length=512,
        description="The document the conversation is saved into. Defaults to `session:<session_id>`. "
        "Fixed once the session exists.",
    )
    watch: bool | None = Field(
        default=None,
        description="Whether the memory watcher follows the session and may send notes back. Off by default.",
    )
    retain: Literal["turns", "close", "off"] | None = Field(
        default=None,
        description="When the conversation is saved into its document: at the end of each turn (`turns`, the "
        "default), only when the session closes (`close`), or never (`off`).",
    )
    tags: list[str] | None = Field(default=None, description="Tags the saved document gets.")
    context: str | None = Field(
        default=None,
        max_length=2000,
        description="How extraction should read the saved conversation (who is speaking). A generic "
        "user/assistant description by default.",
    )
    strategy: str | None = Field(default=None, max_length=256, description="The retain strategy saves use.")
    observation_scopes: Literal["per_tag", "combined", "all_combinations", "shared"] | list[list[str]] | None = Field(
        default=None,
        description="How observations built from the saved conversation are scoped, as on retain. The bank's "
        "default when unset.",
    )
    metadata: dict[str, str] | None = None


class SessionAppendRequest(BaseModel):
    events: list[SessionEventIn] = Field(default_factory=list, max_length=MAX_EVENTS_PER_APPEND)
    ack: int | None = Field(
        default=None,
        ge=0,
        description="The `seq` of the last note this client delivered. The response carries the notes after it. "
        "Omit it to get every note the session has not had acknowledged.",
    )
    session: SessionOptions | None = None


class SessionNoteSource(BaseModel):
    document_id: str
    quote: str = Field(default="", description="The source's own sentence closest to the note, verbatim.")
    mentioned_at: datetime | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SessionNote(BaseModel):
    seq: int
    text: str
    trigger: str
    memory_ids: list[str] = Field(default_factory=list)
    source: SessionNoteSource | None = None
    created_at: datetime


class SessionAppendResponse(BaseModel):
    session_id: str
    accepted: int = Field(description="Events stored by this append.")
    duplicates: int = Field(description="Events already stored, by their id.")
    last_seq: int = Field(description="The session log's last position.")
    notes: list[SessionNote] = Field(description="Notes after `ack`, oldest first.")
    checking: bool = Field(description="A watcher check is queued or running: another note may still come.")


class SessionEvent(BaseModel):
    seq: int
    event_id: str
    source: Literal["client", "hindsight"] = Field(
        description="`client`: an event the client sent. `hindsight`: Hindsight's own entry: a watcher "
        "`check`, a `note`, or a `save` of the conversation into its document."
    )
    kind: str
    ts: datetime | None = None
    created_at: datetime
    payload: dict[str, Any]


class SessionEventsResponse(BaseModel):
    items: list[SessionEvent]
    last_seq: int = Field(description="The log's last position now: poll again with `after` set to it.")
    status: str
    checking: bool


class SessionSummary(BaseModel):
    session_id: str
    document_id: str
    title: str | None = None
    source: str | None = None
    status: str
    watch: bool
    retain: str
    event_count: int
    check_count: int
    note_count: int
    delivered_count: int = Field(description="Notes the client acknowledged delivering to the agent.")
    last_seq: int
    saved_seq: int
    acked_seq: int
    checking: bool
    created_at: datetime
    updated_at: datetime
    last_event_at: datetime | None = Field(default=None, description="When the client last sent an event.")
    metadata: dict[str, Any] = Field(default_factory=dict)


class SessionListResponse(BaseModel):
    items: list[SessionSummary]
    total: int
    limit: int
    offset: int
