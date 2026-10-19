
# Sessions

A **session** is one live conversation that your client streams into a bank while it happens: a
coding agent's run, a support chat, an assistant's day. Hindsight keeps it as a log, saves it into
memory at the end of each turn, and, with the **memory watcher** on, sends notes back when memory
holds something the agent must hear right now.

It turns retain and reflect into a three-way conversation: the user, your agent, and Hindsight
following along.

{/* Import raw source files */}

> **💡 Prerequisites**
>
Make sure you've completed the [Quick Start](./quickstart.md) to install the client and start the server.
## How it works

Your client does one thing: after something happens, it sends the new events.

- **Append.** `POST /v1/default/banks/{bank_id}/sessions/{session_id}/events` with the events since
  your last append. The first append creates the session. The response comes back in milliseconds
  and carries any notes waiting for you.
- **Watch.** With `watch` on, each moment worth a look (a new request, a plan, a command that changes
  things, a file edit, a failure) queues one memory check in the background. Your append never waits
  for it. A check runs one [reflect](./reflect.md) with `abstain`: most moments end silently, and a note is
  written only when memory records a decision the moment does not state or goes against.
- **Save.** At the end of a turn (or when the session closes) the new turns are appended to the
  session's document, and memories are extracted from it like from any [retained](./retain.md) document.
- **Read.** `GET .../events?after=N` returns the session's log from position `N`: your events and
  Hindsight's own entries (each check, each note, each save) in one order. Poll it to follow a
  session live; the control plane's **Sessions** view does exactly that.

### Safe to retry, any server

The protocol is plain request and response, so any server instance can take any request, and every
call is safe to repeat:

- Each event carries **your own id**, unique in the session. An append that is retried after a lost
  response stores nothing twice.
- **Notes are delivered until you acknowledge them.** Send `ack` = the `seq` of the last note you
  handed to your agent; the response carries only the notes after it.
- Checks and saves are queued jobs. A server that dies in the middle of one leaves it to the next
  worker, and a save that is retried writes the same turns once.

## Sending events

### Python

```python
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
```

### Node.js

```javascript
// Send what happened since the last append. Each event has your own id: sending the
// same event again (a retry after a lost response) stores nothing twice. The first
// append creates the session.
const { data: appended } = await sdk.appendSessionEvents({
    client: apiClient,
    path: { bank_id: 'my-bank', session_id: sessionId },
    body: {
        session: { title: 'Fix the rounding bug', watch: true, retain: 'turns' },
        events: [
            { id: '1', role: 'user', kind: 'message', text: 'Half cents round the wrong way.' },
            { id: '2', role: 'assistant', kind: 'tool_call', tool: 'Edit', call_id: 't1', input: { file_path: 'pay/rounding.py' } },
            { id: '3', role: 'tool', kind: 'tool_result', call_id: 't1', text: 'updated' },
        ],
    },
});
console.log(appended.accepted, appended.last_seq, appended.checking);
```

### CLI

```bash
# One event from the flags; --id makes a retry store nothing twice. The first append creates the session.
hindsight session append my-bank "$SESSION_ID" --id 1 --role user --text "Half cents round the wrong way." \
  --watch --retain turns --title "Fix the rounding bug"

# Several events at once, from a JSON array.
hindsight session append my-bank "$SESSION_ID" --events-file "$EVENTS_FILE"
```

### Go

```go
// Send what happened since the last append. Each event has your own id: sending the
// same event again (a retry after a lost response) stores nothing twice. The first
// append creates the session.
opts := hindsight.NewSessionOptions()
opts.SetTitle("Fix the rounding bug")
opts.SetWatch(true)
opts.SetRetain("turns")

ask := hindsight.NewSessionEventIn("1", "user")
ask.SetKind("message")
ask.SetText("Half cents round the wrong way.")
call := hindsight.NewSessionEventIn("2", "assistant")
call.SetKind("tool_call")
call.SetTool("Edit")
call.SetCallId("t1")
call.SetInput(map[string]interface{}{"file_path": "pay/rounding.py"})
result := hindsight.NewSessionEventIn("3", "tool")
result.SetKind("tool_result")
result.SetCallId("t1")
result.SetText("updated")

req := hindsight.NewSessionAppendRequest()
req.SetSession(*opts)
req.SetEvents([]hindsight.SessionEventIn{*ask, *call, *result})
appended, _, err := client.SessionsAPI.AppendSessionEvents(ctx, "my-bank", sessionID).
	SessionAppendRequest(*req).Execute()
if err != nil {
	log.Fatalf("append: %v", err)
}
fmt.Println(appended.Accepted, appended.LastSeq, appended.Checking)
```

An event has a `role` (`user`, `assistant`, `tool`, `system`) and a `kind`:

| Kind | What it is | Fields |
|---|---|---|
| `message` | Something said | `text` |
| `tool_call` | The assistant calling a tool | `tool`, `call_id`, `input` |
| `tool_result` | What the tool returned | `call_id`, `text`, `is_error` |
| `state` | A snapshot of the work, said by no one | `data` (for a coding agent: `{"diff": "..."}`, its change so far) |
| `turn_end` | The assistant finished its turn | — |

Each event may carry `ts`, when it happened by your clock. Up to 500 events per append.

### Session options

Sent with an append (`session`), applied when the append creates the session; later appends that
carry options update what they set.

| Option | Meaning | Default |
|---|---|---|
| `watch` | The memory watcher follows the session and may send notes | `false` |
| `retain` | When the conversation is saved: `turns` (each turn end), `close`, or `off` | `turns` |
| `document_id` | The document it is saved into; fixed once the session exists | `session:<session_id>` |
| `title`, `source` | Shown in the session list (`source` names the client, e.g. `claude-code`) | — |
| `tags`, `metadata`, `context`, `strategy`, `observation_scopes` | Passed to the save's retain, as on [retain](./retain.md) | the bank's |

## Getting notes back

### Python

```python
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
```

### Node.js

```javascript
// Notes come back with every append. `ack` is the seq of the last note you delivered:
// the response carries the notes after it, so a note is handed over until you confirm it.
let delivered = 0;
const { data: polled } = await sdk.appendSessionEvents({
    client: apiClient,
    path: { bank_id: 'my-bank', session_id: sessionId },
    body: { events: [], ack: delivered },
});
for (const note of polled.notes) {
    console.log(`[${note.trigger}] ${note.text} (source: ${note.source?.document_id ?? 'memory'})`);
    delivered = note.seq;
}
```

### CLI

```bash
# With no event, an append just fetches the notes after --ack (the seq of the last note you delivered).
hindsight session append my-bank "$SESSION_ID" --ack 0
```

### Go

```go
// Notes come back with every append. `ack` is the seq of the last note you delivered:
// the response carries the notes after it, so a note is handed over until you confirm it.
delivered := int32(0)
poll := hindsight.NewSessionAppendRequest()
poll.SetEvents([]hindsight.SessionEventIn{})
poll.SetAck(delivered)
polled, _, err := client.SessionsAPI.AppendSessionEvents(ctx, "my-bank", sessionID).
	SessionAppendRequest(*poll).Execute()
if err != nil {
	log.Fatalf("poll: %v", err)
}
for _, note := range polled.Notes {
	fmt.Printf("[%s] %s\n", note.Trigger, note.Text)
	delivered = note.Seq
}
```

A note has its `text`, the `trigger` that caused it (`task`, `plan`, `command`, `edit`, `failure`),
the memories it used, and its `source`: the document it comes from and that document's own sentence
closest to the note (`quote`), so your agent can check it. The append's `checking` is `true` while a
check is queued or running: another note may still come, so a client at the end of a turn can poll
a little longer.

The watcher's rules: it waits for the session to settle before checking (a plan and the command
right after it are one check), never says the same memory twice, judges the same situation once,
and sends at most three notes per session.

## Saving into memory

### Python

```python
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
```

### Node.js

```javascript
// The end of a turn saves the conversation into the session's document
// (`session:<id>` unless you named one), where memories are extracted from it.
await sdk.appendSessionEvents({
    client: apiClient,
    path: { bank_id: 'my-bank', session_id: sessionId },
    body: {
        events: [
            { id: '4', role: 'assistant', kind: 'message', text: 'Fixed: half cents round down.' },
            { id: '5', role: 'assistant', kind: 'turn_end' },
        ],
        ack: delivered,
    },
});
```

### CLI

```bash
# The end of a turn saves the conversation into the session's document.
hindsight session append my-bank "$SESSION_ID" --id 4 --role assistant --kind turn_end
```

### Go

```go
// The end of a turn saves the conversation into the session's document
// (`session:<id>` unless you named one), where memories are extracted from it.
reply := hindsight.NewSessionEventIn("4", "assistant")
reply.SetKind("message")
reply.SetText("Fixed: half cents round down.")
end := hindsight.NewSessionEventIn("5", "assistant")
end.SetKind("turn_end")
turn := hindsight.NewSessionAppendRequest()
turn.SetEvents([]hindsight.SessionEventIn{*reply, *end})
turn.SetAck(delivered)
if _, _, err := client.SessionsAPI.AppendSessionEvents(ctx, "my-bank", sessionID).
	SessionAppendRequest(*turn).Execute(); err != nil {
	log.Fatalf("turn end: %v", err)
}
```

What is saved: what the user and the assistant said, and one short line per tool call (the tool and
its main target, such as `Edit pay/rounding.py`). Tool output and `state` snapshots are not saved.
Each save appends to the document, so its memories are extracted from the new turns only.

## Following a session

### Python

```python
# Follow the session's log: your events and Hindsight's checks, notes and saves, in one order.
after = 0
log = await client.sessions.list_session_events("my-bank", session_id, after=after)
for entry in log.items:
    print(entry.seq, entry.source, entry.kind)
after = log.last_seq  # poll again with this to get only what is new
```

### Node.js

```javascript
// Follow the session's log: your events and Hindsight's checks, notes and saves, in one order.
let after = 0;
const { data: log } = await sdk.listSessionEvents({
    client: apiClient,
    path: { bank_id: 'my-bank', session_id: sessionId },
    query: { after },
});
for (const entry of log.items) {
    console.log(entry.seq, entry.source, entry.kind);
}
after = log.last_seq; // poll again with this to get only what is new
```

### CLI

```bash
# The session's log, one line per entry. Add --follow to keep printing it live until the session closes.
hindsight session events my-bank "$SESSION_ID"
```

### Go

```go
// Follow the session's log: your events and Hindsight's checks, notes and saves, in one order.
entries, _, err := client.SessionsAPI.ListSessionEvents(ctx, "my-bank", sessionID).After(0).Execute()
if err != nil {
	log.Fatalf("events: %v", err)
}
for _, entry := range entries.Items {
	fmt.Println(entry.Seq, entry.Source, entry.Kind)
}
// poll again with After(entries.LastSeq) to get only what is new
```

Each log entry has a `seq`, a `source` (`client` or `hindsight`), a `kind` and a `payload`.
Hindsight's entries:

- `check`: one watcher check: the `trigger`, the `outcome` (`note`, `silent`, `repeat` when the
  memory was already told, `skipped`, `error`), how long it took, and everything sent to reflect
  (`question`, `context`, `search_queries`) with its decision path (`llm_calls`) and tokens.
- `note`: a note sent back, with `check_seq` pointing at its check.
- `save`: the log range saved into the document.

## Listing, closing, deleting

### Python

```python
sessions = await client.sessions.list_sessions("my-bank", limit=20)
for s in sessions.items:
    print(s.session_id, s.status, s.note_count, s.delivered_count)
```

### Node.js

```javascript
const { data: sessions } = await sdk.listSessions({
    client: apiClient,
    path: { bank_id: 'my-bank' },
    query: { limit: 20 },
});
for (const s of sessions.items) {
    console.log(s.session_id, s.status, s.note_count, s.delivered_count);
}
```

### CLI

```bash
hindsight session list my-bank
```

### Go

```go
sessions, _, err := client.SessionsAPI.ListSessions(ctx, "my-bank").Limit(20).Execute()
if err != nil {
	log.Fatalf("list: %v", err)
}
for _, s := range sessions.Items {
	fmt.Println(s.SessionId, s.Status, s.NoteCount, s.DeliveredCount)
}
```

### Python

```python
# Closing saves what is not saved yet. A later append opens the session again.
await client.sessions.close_session("my-bank", session_id)
```

### Node.js

```javascript
// Closing saves what is not saved yet. A later append opens the session again.
await sdk.closeSession({ client: apiClient, path: { bank_id: 'my-bank', session_id: sessionId } });
```

### CLI

```bash
# Closing saves what is not saved yet. A later append opens the session again.
hindsight session close my-bank "$SESSION_ID"
```

### Go

```go
// Closing saves what is not saved yet. A later append opens the session again.
if _, _, err := client.SessionsAPI.CloseSession(ctx, "my-bank", sessionID).Execute(); err != nil {
	log.Fatalf("close: %v", err)
}
```

### Python

```python
# Deletes the session and its log. The document it saved stays: that is memory now.
await client.sessions.delete_session("my-bank", session_id)
```

### Node.js

```javascript
// Deletes the session and its log. The document it saved stays: that is memory now.
await sdk.deleteSession({ client: apiClient, path: { bank_id: 'my-bank', session_id: sessionId } });
```

### CLI

```bash
# Deletes the session and its log. The document it saved stays: that is memory now.
hindsight session delete my-bank "$SESSION_ID"
```

### Go

```go
// Deletes the session and its log. The document it saved stays: that is memory now.
if _, _, err := client.SessionsAPI.DeleteSession(ctx, "my-bank", sessionID).Execute(); err != nil {
	log.Fatalf("delete: %v", err)
}
```

## Access

Sessions go through the same extension hooks as other bank reads and writes
(`append_session_events`, `close_session`, `delete_session`; `list_sessions`, `get_session`,
`list_session_events`). A caller confined to a tag scope is refused (`403`): the watcher's checks
search the whole bank, so its notes could carry memories outside the caller's tags.

## Configuration

| Variable | What it does | Default |
|---|---|---|
| `HINDSIGHT_API_SESSION_CHECK_QUIET_MS` | A moment is checked once the session has been quiet this long | `1000` |
| `HINDSIGHT_API_SESSION_CHECK_MAX_WAIT_MS` | ...or at the latest this long after the moment appeared | `3000` |

The checks use reflect's [decision model](../configuration.md#decision-model) when one is set: most
moments are then settled without an LLM call.

The coding-agents plugin uses sessions for its memory watcher on Claude Code and Codex (see
[Coding Agents](../../sdks/integrations/coding-agents.md)).
