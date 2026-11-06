package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCleanupKeepsBoardAndUserDecisions(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(req.URL.Path, "/decisions") {
			_, _ = w.Write([]byte(`[{"id":"d1","ruleKey":"blocked_issue.auto_unblocker","targetSnapshots":{"stale":{}}},{"id":"d2","ruleKey":"blocked_issue.auto_unblocker","targetSnapshots":{"agent":{}}},{"id":"d3","ruleKey":"blocked_issue.auto_unblocker","targetSnapshots":{"board":{}}},{"id":"d4","ruleKey":"blocked_issue.auto_unblocker","targetSnapshots":{"user":{}}},{"id":"d5","ruleKey":"blocked_issue.auto_unblocker","targetSnapshots":{"board-agent":{}}}]`))
			return
		}
		id := strings.TrimPrefix(req.URL.Path, "/api/issues/")
		owner := map[string]any{"agentId": "agent-a"}
		status := "blocked"
		switch id {
		case "stale":
			status = "todo"
		case "board":
			owner = nil
		case "user":
			owner = map[string]any{"userId": "user-a"}
		case "board-agent":
			owner = map[string]any{"agentId": "board-a"}
		}
		descriptor := any(map[string]any{"owner": owner, "action": "review"})
		if id == "board" {
			descriptor = map[string]any{"owner": "board", "action": "review"}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": id, "identifier": "SCO-" + id, "status": status, "unblockDescriptor": descriptor})
	}))
	defer s.Close()
	c := client{baseURL: s.URL, companyID: "company", boardID: "board-a", http: s.Client()}
	rows, err := c.cleanupDecisions(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].Issue != "SCO-stale" || rows[1].Issue != "SCO-agent" {
		t.Fatalf("unexpected cleanup: %+v", rows)
	}
}
