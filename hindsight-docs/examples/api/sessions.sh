#!/bin/bash
# Sessions API examples for Hindsight CLI (live conversations and the memory watcher)
# Run: bash examples/api/sessions.sh

set -e

# =============================================================================
# Setup (not shown in docs)
# =============================================================================
SESSION_ID="chat-$RANDOM$RANDOM"
EVENTS_FILE=$(mktemp)
cat > "$EVENTS_FILE" <<'EOF'
[
  {"id": "2", "role": "assistant", "kind": "tool_call", "tool": "Edit", "call_id": "t1", "input": {"file_path": "pay/rounding.py"}},
  {"id": "3", "role": "tool", "kind": "tool_result", "call_id": "t1", "text": "updated"}
]
EOF


# =============================================================================
# Doc Examples
# =============================================================================

# [docs:sessions-append]
# One event from the flags; --id makes a retry store nothing twice. The first append creates the session.
hindsight session append my-bank "$SESSION_ID" --id 1 --role user --text "Half cents round the wrong way." \
  --watch --retain turns --title "Fix the rounding bug"

# Several events at once, from a JSON array.
hindsight session append my-bank "$SESSION_ID" --events-file "$EVENTS_FILE"
# [/docs:sessions-append]


# [docs:sessions-notes]
# With no event, an append just fetches the notes after --ack (the seq of the last note you delivered).
hindsight session append my-bank "$SESSION_ID" --ack 0
# [/docs:sessions-notes]


# [docs:sessions-turn-end]
# The end of a turn saves the conversation into the session's document.
hindsight session append my-bank "$SESSION_ID" --id 4 --role assistant --kind turn_end
# [/docs:sessions-turn-end]


# [docs:sessions-follow]
# The session's log, one line per entry. Add --follow to keep printing it live until the session closes.
hindsight session events my-bank "$SESSION_ID"
# [/docs:sessions-follow]


# [docs:sessions-list]
hindsight session list my-bank
# [/docs:sessions-list]


# [docs:sessions-close]
# Closing saves what is not saved yet. A later append opens the session again.
hindsight session close my-bank "$SESSION_ID"
# [/docs:sessions-close]


# [docs:sessions-delete]
# Deletes the session and its log. The document it saved stays: that is memory now.
hindsight session delete my-bank "$SESSION_ID"
# [/docs:sessions-delete]


# =============================================================================
# Cleanup (not shown in docs)
# =============================================================================
rm -f "$EVENTS_FILE"
hindsight bank delete my-bank -y 2>/dev/null || true
