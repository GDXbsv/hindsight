"""The memory watcher's rules: what in a session is worth a check, what to ask memory, and when to speak.

A session's client sends what happens (a request, what the agent says, the tools it calls and what
they return). The watcher reads those events as steps and keeps a small running state: the agent's
last steps, the request it is working on, and the moment waiting to be checked. A moment is one of:

- ``task``: a new request (checked for a heads-up: a recorded decision the request does not state);
- ``plan``: the agent saying what it will do;
- ``command``: a command that changes things (reads, searches and test runs are only context);
- ``edit``: a change to a file;
- ``failure``: a command or tool that failed.

Each checked moment is ONE reflect call with ``abstain``: the decision model settles most moments
silently with no LLM call, and a note is written from the memory it picked otherwise. The rules
around that call are the ones the sde-bench watcher measured (33 tasks x 3 runs, every task solved
on the first try): never the same memory twice, at most ``MAX_NOTES`` per session, the same
situation never judged twice, a heads-up does not use its memory up.

Pure functions over plain data: no I/O, so the same code runs in the append request (reading new
events into the state) and in the worker (checking the moment). Ported from the coding-agents
client (``hindsight-integrations/coding-agents/src/core/watch.ts``), where it ran on each machine.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Literal

from pydantic import BaseModel, Field

Trigger = Literal["task", "plan", "command", "edit", "failure"]

MAX_NOTES = 3
RECENT_STEPS = 12
JUDGED_KEYS = 200
# Tool calls waiting for their result. Bounded: a client that never sends results must not grow
# the state without end.
OPEN_TOOL_CALLS = 64
# The change so far, as the client last sent it. Bounded the same way the situation cuts it.
DIFF_CAP = 64_000

# A moment's weight when several arrive before the watcher is free: the heaviest, latest one wins.
PRIORITY: dict[str, int] = {"task": 0, "plan": 1, "failure": 2, "command": 3, "edit": 3}

HEADSUP_Q = (
    "Before I start on this request: which project decision recorded in memory (an exact value, a rule, "
    "an exception) about exactly the code this request will change must my fix respect, that the request "
    "itself does not state? Only what someone decided (a chosen value or rule, an exception, a rejected "
    "option), not what the code already does: I can read that myself. Tell me in at most 70 words, as "
    "'Before you change <the code>: <every such rule the memory's source text records for this code, "
    "in its final form, not only its summary; each rule a fix could get wrong>', copying "
    "exact literals verbatim, no advice beyond the rules. If memory records no such decision about this "
    "code, reply with nothing."
)

CONFLICT_Q = (
    "Does what I am doing right now (my plan, command or code change) contradict a project decision recorded "
    "in memory, miss one, or repeat an option recorded as rejected? If so, tell me in at most 50 words the "
    "recorded value or rule (exact literals verbatim) and what in my work disagrees. How I run, install or "
    "check tests is never a conflict. If nothing conflicts, reply with nothing."
)

# Tools that change a file. Claude Code's names, plus the ones other agents use for the same thing.
EDIT_TOOLS = frozenset({"edit", "write", "multiedit", "notebookedit", "apply_patch", "str_replace_editor"})
# Tools that run a command.
COMMAND_TOOLS = frozenset({"bash", "shell", "exec_command", "run_command", "terminal"})
# Commands that change nothing, or only run checks: no moment.
READ_ONLY_CMD = re.compile(
    r"^\s*(cd [^;&|]+(&&|;)\s*)?(cat|ls|find|grep|rg|head|tail|wc|tree|file|which|pwd|echo|sed -n|awk|"
    r"git (status|diff|log|show|blame)|python3? -m pytest|pytest|python3? -c|python3? -I -c|pip3? install|"
    r"npm (test|run test)|npx (vitest|jest))\b"
)
# The sandbox failing, not the project: no moment.
ENV_TROUBLE = re.compile(r"command not found|No module named (pytest|pip)")
FAILED = re.compile(r"\b\d+ failed\b|Traceback \(most recent call last\)|\bFAILED\b|\bError:")
# How a delivered note reads when the agent's transcript carries it back.
OWN_NOTE_MARK = "Note from this project's memory"


class Pending(BaseModel):
    trigger: Trigger
    text: str = ""
    seq: int = 0  # the log position of the event that made the moment


class WatchState(BaseModel):
    """What the watcher keeps per session, between appends. Stored as the session's ``watch_state``."""

    recent: list[str] = Field(default_factory=list)
    tools: dict[str, tuple[str, dict[str, Any]]] = Field(default_factory=dict)
    pending: Pending | None = None
    goal: str = ""
    diff: str = ""
    sent: list[str] = Field(default_factory=list)
    evidence_sent: list[str] = Field(default_factory=list)
    judged: list[str] = Field(default_factory=list)


class Step(BaseModel):
    kind: Literal["ask", "say", "tool", "result", "state", "end"]
    text: str = ""
    id: str = ""
    tool: str = ""
    input: dict[str, Any] = Field(default_factory=dict)
    error: bool = False


class Moment(BaseModel):
    trigger: Trigger
    text: str
    recent: list[str]
    diff: str
    seq: int = 0


def _clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n]


def step_of(kind: str, role: str, event: dict[str, Any]) -> Step | None:
    """One session event as a watcher step, or None when the watcher does not read it."""
    text = str(event.get("text") or "")
    if kind == "message":
        if role == "user":
            return Step(kind="ask", text=_clip(text, 4000))
        if role == "assistant" and text:
            return Step(kind="say", text=_clip(text, 3000))
        return None
    if kind == "tool_call":
        raw = event.get("input")
        return Step(
            kind="tool",
            id=str(event.get("call_id") or ""),
            tool=str(event.get("tool") or ""),
            input=raw if isinstance(raw, dict) else {},
        )
    if kind == "tool_result":
        return Step(
            kind="result", id=str(event.get("call_id") or ""), text=_clip(text, 3000), error=bool(event.get("is_error"))
        )
    if kind == "state":
        data = event.get("data") or {}
        if isinstance(data, dict) and isinstance(data.get("diff"), str):
            return Step(kind="state", text=data["diff"])
    if kind == "turn_end":
        return Step(kind="end")
    return None


def _is_own_note(state: WatchState, text: str) -> bool:
    return OWN_NOTE_MARK in text or any(s[:80] in text for s in state.sent if len(s) >= 40)


def read_step(state: WatchState, step: Step, seq: int = 0) -> None:
    """One step into the state: the recent-steps line, and the moment it makes (if any) as pending."""
    said = ""
    trigger: Trigger | None = None
    text = ""
    if step.kind == "state":
        state.diff = step.text[:DIFF_CAP]
        return
    if step.kind == "end":
        # The turn is over, so the assistant's last words describe work it has finished ("All tests
        # pass. I changed..."): there is nothing left for a note to change before the next turn, and
        # the sde-bench measurements showed these closing checks to be most of a session's wasted
        # ones (13 of 77 reflects). A pending edit, command or failure is still checked: its note
        # can be handed over at the end of the turn.
        if state.pending is not None and state.pending.trigger == "plan":
            state.pending = None
        return
    if step.kind == "ask":
        # A system reminder or our own note rides in the user's turn too: neither is a new request.
        if _is_own_note(state, step.text) or step.text.startswith("<"):
            return
        said = f"the user asked: {_clip(step.text, 200)}"
        trigger, text = "task", step.text
        state.goal = step.text
    elif step.kind == "say":
        said = f"agent said: {_clip(step.text, 300)}"
        if len(step.text) >= 60:
            trigger, text = "plan", step.text
    elif step.kind == "tool":
        tool = step.tool.lower()
        state.tools[step.id] = (tool, step.input)
        if len(state.tools) > OPEN_TOOL_CALLS:
            state.tools = dict(list(state.tools.items())[-OPEN_TOOL_CALLS:])
        inp = step.input
        what = str(
            inp.get("command") or inp.get("cmd") or inp.get("file_path") or inp.get("pattern") or inp.get("path") or ""
        )
        if tool in COMMAND_TOOLS and not READ_ONLY_CMD.match(what):
            said = f"agent runs: {_clip(what, 300)}"
            trigger, text = "command", what
        else:
            said = f"agent {tool}: {_clip(what, 200)}"
    else:
        tool, inp = state.tools.pop(step.id, ("", {}))
        if _is_own_note(state, step.text):
            said = "the agent was given the watcher's note"
        elif tool in EDIT_TOOLS:
            said = f"agent edited {inp.get('file_path') or inp.get('notebook_path') or inp.get('path') or ''}"
            trigger = "edit"
        elif (step.error or FAILED.search(step.text)) and not ENV_TROUBLE.search(step.text):
            said = f"it failed: {step.text[-300:]}"
            trigger, text = "failure", step.text[-2000:]
    if said:
        state.recent = [*state.recent, said][-RECENT_STEPS:]
    # A new request is never pushed out: read in one pass with the agent's first "I'll check..." (a
    # plan, heavier), it used to be replaced, and the heads-up for the request was never given.
    keep = state.pending is not None and state.pending.trigger == "task" and trigger != "task"
    if trigger and not keep and (state.pending is None or PRIORITY[trigger] >= PRIORITY[state.pending.trigger]):
        state.pending = Pending(trigger=trigger, text=text, seq=seq)


def take_moment(state: WatchState) -> Moment | None:
    """The pending moment, removed from the state, with the steps and change it is judged against."""
    p = state.pending
    if p is None:
        return None
    state.pending = None
    return Moment(trigger=p.trigger, text=p.text, recent=list(state.recent), diff=state.diff, seq=p.seq)


def query_from_diff(diff: str, cap: int = 1500) -> str:
    """A diff as a search: the files and functions touched, then the changed lines."""
    files: list[str] = []
    funcs: list[str] = []
    lines: list[str] = []
    for line in diff.split("\n"):
        if line.startswith("+++ b/"):
            files.append(line[6:])
        elif line.startswith("@@"):
            funcs.append(line.split("@@")[-1].strip())
        elif line[:1] in ("+", "-") and not line.startswith(("+++", "---")) and line[1:].strip():
            lines.append(line.strip())
    q = f"Change to {', '.join(files)} ({'; '.join(f for f in funcs if f)}):\n" + "\n".join(lines)
    return q[:cap]


def search_queries(m: Moment) -> list[str]:
    """What the moment searches. A request is searched by its sentences naming code, then its
    paragraphs: as one query, a harness's boilerplate (role, rules, "work efficiently") outweighed the
    request and the heads-up never saw the decision. An edit is searched by its diff in words,
    anything else by its own text."""
    if m.trigger == "edit":
        return [query_from_diff(m.diff)]
    if m.trigger != "task":
        return [m.text[:1500]]
    paras = [p.strip() for p in re.split(r"\n\s*\n", m.text) if len(p.strip()) >= 40]
    named = [
        s.strip()
        for s in re.split(r"(?<=[.!?])\s+", m.text)
        if re.search(r"\b[a-z]+_[a-z_]+\b|\w\(\)|`[^`]+`", s) and not re.search("test", s, re.I)
    ]
    # A one-paragraph request that names code is both; searching it twice finds nothing new.
    queries = list(dict.fromkeys(q[:1500] for q in (named[:3] + paras)[:8]))
    return queries or [m.text[:1500]]


def _clip_diff(diff: str, cap: int) -> str:
    return diff if len(diff) <= cap else f"{diff[:cap]}\n... (diff cut at {cap} chars)"


def question(m: Moment) -> str:
    return HEADSUP_Q if m.trigger == "task" else CONFLICT_Q


def situation(goal: str, m: Moment, sent: list[str]) -> str:
    """The moment as reflect's context: what the question is about, in the agent's own voice."""
    parts = [f"MY REQUEST:\n{goal[:3000]}"]
    if m.trigger != "task":
        doing = _clip_diff(m.diff, 6000) if m.trigger == "edit" else m.text[:3000]
        parts.append(f"WHAT I JUST DID ({m.trigger}):\n{doing}")
        if m.recent:
            parts.append("MY RECENT STEPS:\n" + "\n".join(m.recent[-8:]))
        if m.trigger != "edit" and m.diff.strip():
            parts.append(f"MY CODE CHANGE SO FAR:\n{_clip_diff(m.diff, 4000)}")
    if sent:
        parts.append("ALREADY TOLD ME:\n" + "\n".join(sent))
    return "\n\n".join(parts)


def moment_key(m: Moment) -> str:
    """The same situation is never judged twice (an edit is its diff)."""
    return hashlib.sha1(
        json.dumps([m.trigger, "" if m.trigger == "edit" else m.text.strip(), m.diff.strip()]).encode(),
        usedforsecurity=False,
    ).hexdigest()


def skip_reason(state: WatchState, m: Moment) -> str | None:
    """Why the moment is not worth a reflect call, or None (and then it is recorded as judged)."""
    if len(state.sent) >= MAX_NOTES:
        return "note limit reached"
    if not (m.diff if m.trigger == "edit" else m.text).strip():
        return "nothing to judge"
    key = moment_key(m)
    if key in state.judged:
        return "already judged"
    state.judged = [*state.judged, key][-JUDGED_KEYS:]
    return None


def accept_note(state: WatchState, m: Moment, text: str, memory_ids: list[str]) -> bool:
    """Whether a note reaches the agent, recording it when it does: never the same memory twice.
    A heads-up does not use its memory up: going against it later is still worth saying."""
    if not text.strip():
        return False
    # The same words twice say nothing new, whatever the moment (a heads-up for a request the
    # client sent twice wrote the same note again).
    if text.strip() in state.sent:
        return False
    if memory_ids and all(i in state.evidence_sent for i in memory_ids):
        return False
    state.sent.append(text.strip())
    if m.trigger != "task":
        state.evidence_sent = list(dict.fromkeys([*state.evidence_sent, *memory_ids]))
    return True


def readable(text: str) -> str:
    """A chat stored as JSON lines (or one JSON array), as its messages' words: a quote must be
    text the reader can find."""
    try:
        whole = json.loads(text)
    except ValueError:
        whole = None
    if isinstance(whole, list):
        return "\n".join(str(m.get("content", "")) if isinstance(m, dict) else str(m) for m in whole)
    out = []
    for line in text.split("\n"):
        try:
            msg = json.loads(line)
        except ValueError:
            out.append(line)
            continue
        out.append(str(msg.get("content", "")) if isinstance(msg, dict) else line)
    return "\n".join(out)


def _words(s: str) -> set[str]:
    # Numbers of any length count: a changed value ("7", not "10") is often the whole story.
    return set(re.findall(r"[a-z_][a-z0-9_]{2,}|\d+(?:\.\d+)?", s.lower()))


def best_sentence(text: str, like: str) -> str:
    """The source sentence sharing the most words with the note, less two per number the note does not
    have: verbatim by construction, no model call. By overlap alone the line stating the old value
    ("10 # Current setting") beat the rule (7). On a tie the later sentence wins: a chat settles on its
    last word ("leave it at 7" after trying 5)."""
    want = _words(like)
    best, best_score = "", float("-inf")
    for s in (x.strip() for x in re.split(r"(?<=[.!?])\s+|\n+", text)):
        if len(s) < 20 or len(s) > 300:
            continue
        shared = foreign = 0
        for w in _words(s):
            if w in want:
                shared += 1
            elif w[0].isdigit():
                foreign += 1
        # The penalty only ranks: "K is 1024, never 1000" still quotes a note that says 1024.
        if shared > 0 and shared - 2 * foreign >= best_score:
            best, best_score = s, shared - 2 * foreign
    return best
