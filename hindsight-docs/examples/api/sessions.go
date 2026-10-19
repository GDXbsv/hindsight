package main

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"os"

	hindsight "github.com/vectorize-io/hindsight/hindsight-clients/go"
)

func main() {
	apiURL := os.Getenv("HINDSIGHT_API_URL")
	if apiURL == "" {
		apiURL = "http://localhost:8888"
	}

	cfg := hindsight.NewConfiguration()
	cfg.Servers = hindsight.ServerConfigurations{{URL: apiURL}}
	client := hindsight.NewAPIClient(cfg)
	ctx := context.Background()
	sessionID := fmt.Sprintf("chat-%08x", rand.Uint32())

	// [docs:sessions-append]
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
	// [/docs:sessions-append]

	// [docs:sessions-notes]
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
	// [/docs:sessions-notes]

	// [docs:sessions-turn-end]
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
	// [/docs:sessions-turn-end]

	// [docs:sessions-follow]
	// Follow the session's log: your events and Hindsight's checks, notes and saves, in one order.
	entries, _, err := client.SessionsAPI.ListSessionEvents(ctx, "my-bank", sessionID).After(0).Execute()
	if err != nil {
		log.Fatalf("events: %v", err)
	}
	for _, entry := range entries.Items {
		fmt.Println(entry.Seq, entry.Source, entry.Kind)
	}
	// poll again with After(entries.LastSeq) to get only what is new
	// [/docs:sessions-follow]

	// [docs:sessions-list]
	sessions, _, err := client.SessionsAPI.ListSessions(ctx, "my-bank").Limit(20).Execute()
	if err != nil {
		log.Fatalf("list: %v", err)
	}
	for _, s := range sessions.Items {
		fmt.Println(s.SessionId, s.Status, s.NoteCount, s.DeliveredCount)
	}
	// [/docs:sessions-list]

	// [docs:sessions-close]
	// Closing saves what is not saved yet. A later append opens the session again.
	if _, _, err := client.SessionsAPI.CloseSession(ctx, "my-bank", sessionID).Execute(); err != nil {
		log.Fatalf("close: %v", err)
	}
	// [/docs:sessions-close]

	// [docs:sessions-delete]
	// Deletes the session and its log. The document it saved stays: that is memory now.
	if _, _, err := client.SessionsAPI.DeleteSession(ctx, "my-bank", sessionID).Execute(); err != nil {
		log.Fatalf("delete: %v", err)
	}
	// [/docs:sessions-delete]

	client.BanksAPI.DeleteBank(ctx, "my-bank").Execute()
}
