package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDescriptorRouting(t *testing.T) {
	ready := blockerDiagnostics{}
	ready.Readiness.IsDependencyReady = true
	for _, tc := range []struct {
		name, owner, assignee, action, method string
		ready                                 bool
	}{
		{"self", `{"agentId":"agent-a"}`, "agent-a", "self_unblock", "PATCH", true},
		{"peer", `{"agentId":"agent-b"}`, "agent-a", "agent_redelivery", "POST", true},
		{"board", `"board"`, "agent-a", "board_interaction", "POST", true},
		{"user", `{"userId":"user-a"}`, "agent-a", "board_interaction", "POST", true},
		{"dependency", `{"agentId":"agent-a"}`, "agent-a", "live_dependency", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				calls++
				if req.Method != tc.method {
					t.Errorf("method = %s", req.Method)
				}
				var body map[string]any
				if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if tc.action == "agent_redelivery" && (body["reason"] != "issue_unblock_requested" || !strings.HasPrefix(body["idempotencyKey"].(string), "auto-unblocker:")) {
					t.Errorf("unexpected wake payload: %v", body)
				}
				if tc.action == "board_interaction" && body["addresseeAgentId"] != "board-a" {
					t.Errorf("wrong Board target")
				}
				w.Header().Set("Content-Type", "application/json")
				if tc.method == "PATCH" {
					_, _ = w.Write([]byte(`{"status":"todo"}`))
				} else {
					_, _ = w.Write([]byte(`{"id":"created","status":"pending"}`))
				}
			}))
			defer s.Close()
			c := client{baseURL: s.URL, http: s.Client(), boardID: "board-a"}
			item := issue{ID: "issue-a", Identifier: "SCO-1", AssigneeAgentID: tc.assignee, BlockedTransitionAt: "2026-01-01T00:00:00Z", UnblockDescriptor: json.RawMessage(`{"owner":` + tc.owner + `,"action":"Review"}`)}
			d := blockerDiagnostics{}
			if tc.ready {
				d = ready
			}
			got := c.routeDescriptor(context.Background(), item, d, true)
			if got.Action != tc.action || got.Error != "" {
				t.Fatalf("got %+v", got)
			}
			if (tc.method != "") != got.Applied || calls > 1 {
				t.Fatalf("applied=%v calls=%d", got.Applied, calls)
			}
		})
	}
}
