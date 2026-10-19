"""The memory watcher's rules on session events: which steps make a moment, and when a note may go out.

Pure functions, no database: see test_sessions.py for the session store and the worker steps.
"""

from hindsight_api.engine.sessions import watch as W


def _feed(state: W.WatchState, *events: tuple[str, str, dict]) -> None:
    for i, (kind, role, payload) in enumerate(events, start=1):
        step = W.step_of(kind, role, payload)
        if step is not None:
            W.read_step(state, step, i)


def test_a_request_is_a_task_moment_and_becomes_the_goal():
    s = W.WatchState()
    _feed(s, ("message", "user", {"text": "Fix the rounding in pay/rounding.py"}))
    assert s.pending is not None and s.pending.trigger == "task" and s.pending.seq == 1
    assert s.goal == "Fix the rounding in pay/rounding.py"


def test_a_system_reminder_or_own_note_in_the_user_turn_is_not_a_request():
    s = W.WatchState()
    _feed(
        s,
        ("message", "user", {"text": "<system-reminder>stuff</system-reminder>"}),
        ("message", "user", {"text": "🧠 Note from this project's memory (past sessions): keep 7"}),
    )
    assert s.pending is None and s.goal == ""


def test_a_plan_does_not_push_out_a_pending_request():
    s = W.WatchState()
    _feed(
        s,
        ("message", "user", {"text": "Fix the bug"}),
        ("message", "assistant", {"text": "I'll look at the rounding module first and then change the mode used."}),
    )
    assert s.pending is not None and s.pending.trigger == "task"


def test_reads_and_test_runs_are_context_but_a_changing_command_is_a_moment():
    s = W.WatchState()
    _feed(
        s,
        ("tool_call", "assistant", {"tool": "Bash", "call_id": "a", "input": {"command": "grep -rn round pay/"}}),
        ("tool_call", "assistant", {"tool": "Bash", "call_id": "b", "input": {"command": "python -m pytest -q"}}),
    )
    assert s.pending is None
    assert s.recent[-1].startswith("agent bash:")
    _feed(s, ("tool_call", "assistant", {"tool": "Bash", "call_id": "c", "input": {"command": "rm -rf build"}}))
    assert s.pending is not None and s.pending.trigger == "command" and s.pending.text == "rm -rf build"


def test_an_edit_is_a_moment_when_its_result_comes_back():
    s = W.WatchState()
    _feed(s, ("tool_call", "assistant", {"tool": "Edit", "call_id": "e1", "input": {"file_path": "pay/rounding.py"}}))
    assert s.pending is None  # the call alone changed nothing yet
    _feed(s, ("tool_result", "tool", {"call_id": "e1", "text": "updated"}))
    assert s.pending is not None and s.pending.trigger == "edit"
    assert s.recent[-1] == "agent edited pay/rounding.py"


def test_a_failure_is_a_moment_but_a_missing_tool_is_not():
    s = W.WatchState()
    _feed(
        s,
        ("tool_call", "assistant", {"tool": "Bash", "call_id": "x", "input": {"command": "make build"}}),
        ("tool_result", "tool", {"call_id": "x", "text": "python: command not found", "is_error": True}),
    )
    assert s.pending is not None and s.pending.trigger == "command"  # the command itself, not the failure
    s.pending = None
    _feed(
        s,
        ("tool_call", "assistant", {"tool": "Bash", "call_id": "y", "input": {"command": "make build"}}),
    )
    s.pending = None
    _feed(s, ("tool_result", "tool", {"call_id": "y", "text": "Traceback (most recent call last):\n boom"}))
    assert s.pending is not None and s.pending.trigger == "failure"


def test_a_state_event_is_the_change_so_far_and_makes_no_moment():
    s = W.WatchState()
    _feed(s, ("state", "system", {"data": {"diff": "+++ b/pay/rounding.py\n+x = 1"}}))
    assert s.diff.startswith("+++ b/pay") and s.pending is None and not s.recent


def test_take_moment_carries_the_steps_and_change_it_is_judged_against():
    s = W.WatchState()
    _feed(
        s,
        ("message", "user", {"text": "Fix the bug"}),
        ("state", "system", {"data": {"diff": "diff"}}),
    )
    m = W.take_moment(s)
    assert m is not None and m.trigger == "task" and m.diff == "diff" and s.pending is None
    assert W.take_moment(s) is None


def test_the_same_situation_is_judged_once_and_notes_stop_at_the_limit():
    s = W.WatchState()
    m = W.Moment(trigger="plan", text="I will set the retry to 10", recent=[], diff="")
    assert W.skip_reason(s, m) is None
    assert W.skip_reason(s, m) == "already judged"
    s.sent = ["a", "b", "c"]
    other = W.Moment(trigger="plan", text="something else entirely", recent=[], diff="")
    assert W.skip_reason(s, other) == "note limit reached"


def test_a_memory_is_said_once_but_a_heads_up_does_not_use_it_up():
    s = W.WatchState()
    task = W.Moment(trigger="task", text="Fix it", recent=[], diff="")
    edit = W.Moment(trigger="edit", text="", recent=[], diff="d")
    assert W.accept_note(s, task, "Before you change x: keep 7", ["m1"])
    assert s.evidence_sent == []
    assert W.accept_note(s, edit, "You set 10, the rule is 7", ["m1"])
    assert not W.accept_note(s, edit, "Again: the rule is 7", ["m1"])
    assert not W.accept_note(s, edit, "   ", ["m2"])
    assert s.sent == ["Before you change x: keep 7", "You set 10, the rule is 7"]


def test_a_request_is_searched_by_its_sentences_naming_code_then_its_paragraphs():
    m = W.Moment(
        trigger="task",
        text="You are a maintainer.\n\nFix `round_cents` so half cents round down. The tests show it.\n\n"
        "Work efficiently and do not modify the tests in this repository please.",
        recent=[],
        diff="",
    )
    queries = W.search_queries(m)
    assert queries[0] == "Fix `round_cents` so half cents round down."
    assert any(q.startswith("Work efficiently") for q in queries)


def test_an_edit_is_searched_by_its_diff_in_words():
    m = W.Moment(trigger="edit", text="", recent=[], diff="+++ b/pay/r.py\n@@ def f():\n-x = 1\n+x = 2\n")
    assert W.search_queries(m) == ["Change to pay/r.py (def f():):\n-x = 1\n+x = 2"]


def test_the_situation_speaks_as_the_agent_and_lists_what_it_was_told():
    m = W.Moment(trigger="command", text="rm -rf build", recent=["agent runs: rm -rf build"], diff="+x")
    text = W.situation("Fix it", m, ["keep 7"])
    assert text.startswith("MY REQUEST:\nFix it")
    assert "WHAT I JUST DID (command):\nrm -rf build" in text
    assert "MY CODE CHANGE SO FAR:\n+x" in text
    assert text.endswith("ALREADY TOLD ME:\nkeep 7")


def test_the_quote_prefers_the_sentence_with_the_note_value():
    source = "The current setting is 10 retries for now. We decided to keep the retry count at 7 for ledger reasons."
    assert W.best_sentence(source, "Keep the retry count at 7").startswith("We decided")


def test_a_saved_chat_reads_as_its_words():
    assert W.readable('{"role": "user", "content": "keep 7"}\nplain') == "keep 7\nplain"
    assert W.readable('[{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]') == "a\nb"


def test_the_end_of_a_turn_drops_a_pending_closing_message_but_not_an_edit():
    s = W.WatchState()
    _feed(
        s,
        ("message", "assistant", {"text": "All tests pass. I changed the rounding to ROUND_HALF_DOWN as recorded."}),
        ("turn_end", "assistant", {}),
    )
    assert s.pending is None
    _feed(
        s,
        ("tool_call", "assistant", {"tool": "Edit", "call_id": "e", "input": {"file_path": "a.py"}}),
        ("tool_result", "tool", {"call_id": "e", "text": "ok"}),
        ("turn_end", "assistant", {}),
    )
    assert s.pending is not None and s.pending.trigger == "edit"


def test_the_same_request_with_other_whitespace_is_judged_once_and_a_note_never_repeats_word_for_word():
    s = W.WatchState()
    a = W.Moment(trigger="task", text="Fix the rounding.", recent=[], diff="")
    b = W.Moment(trigger="task", text="Fix the rounding.\n", recent=[], diff="")
    assert W.skip_reason(s, a) is None and W.skip_reason(s, b) == "already judged"
    assert W.accept_note(s, a, "Before you change round_cents: half cents round down.", ["m1"])
    assert not W.accept_note(s, a, "Before you change round_cents: half cents round down.", ["m2"])
