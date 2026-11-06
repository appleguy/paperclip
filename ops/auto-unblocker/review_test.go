package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSelfOwnedHoldsNeedSpecificReview(t *testing.T) {
	d := blockerDiagnostics{}
	d.Readiness.IsDependencyReady = true
	for _, action := range []string{"Wait for owner to resume", "Wait for resource window", "Future announced handoff"} {
		t.Run(action, func(t *testing.T) {
			item := issue{Identifier: "SCO-1", AssigneeAgentID: "agent-12345678", BlockedTransitionAt: "2026-01-01T00:00:00Z"}
			item.UnblockDescriptor, _ = json.Marshal(map[string]any{"owner": map[string]string{"agentId": item.AssigneeAgentID}, "action": action})
			c := client{}
			proposal := c.routeDescriptor(context.Background(), item, d, false, false)
			if proposal.Action != "self_review" || proposal.DescriptorAction != action || proposal.BlockedTransitionAt != item.BlockedTransitionAt {
				t.Fatalf("proposal: %+v", proposal)
			}
			got := c.routeDescriptor(context.Background(), item, d, true, false)
			if got.Applied || got.Error == "" {
				t.Fatalf("unreviewed hold: %+v", got)
			}
		})
	}
}

func TestReviewedTransitionRechecksGates(t *testing.T) {
	const transition = "2026-01-01T00:00:00Z"
	const agent = "12345678-agent"
	review := reviewedTransition{Issue: "SCO-1", BlockedTransitionAt: transition, DescriptorAction: "action cleared", OwnerAgentPrefix: "12345678"}
	for _, tc := range []struct {
		name, transition, action, monitor string
		pending, ready, expectApply       bool
	}{
		{"reviewed", transition, "action cleared", "", false, true, true},
		{"new transition", "2026-01-02T00:00:00Z", "action cleared", "", false, true, false},
		{"changed action", transition, "wait for owner", "", false, true, false},
		{"pending interaction", transition, "action cleared", "", true, true, false},
		{"resource dependency", transition, "action cleared", "", false, false, false},
		{"future handoff", transition, "action cleared", "2999-01-01T00:00:00Z", false, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			patches := 0
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.Method == http.MethodPatch:
					patches++
					if r.URL.Path != "/api/issues/one/guarded-unblock" {
						t.Errorf("unguarded endpoint: %s", r.URL.Path)
					}
					var body struct {
						Status   string `json:"status"`
						Expected struct {
							BlockedTransitionAt string   `json:"blockedTransitionAt"`
							BlockedByIssueIDs   []string `json:"blockedByIssueIds"`
						} `json:"expectedBlockedTransition"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Status != "todo" || body.Expected.BlockedTransitionAt != transition || body.Expected.BlockedByIssueIDs == nil {
						t.Errorf("missing guarded snapshot: %+v, %v", body, err)
					}
					_, _ = w.Write([]byte(`{"status":"todo"}`))
				case strings.HasSuffix(r.URL.Path, "/diagnostics/blockers"):
					_ = json.NewEncoder(w).Encode(map[string]any{"readiness": map[string]any{"isDependencyReady": tc.ready}})
				case strings.HasSuffix(r.URL.Path, "/interactions"):
					if tc.pending {
						_, _ = w.Write([]byte(`[{"status":"pending","kind":"ask_user_questions"}]`))
					} else {
						_, _ = w.Write([]byte(`[]`))
					}
				default:
					_ = json.NewEncoder(w).Encode(map[string]any{"id": "one", "identifier": "SCO-1", "status": "blocked", "updatedAt": transition, "assigneeAgentId": agent, "blockedTransitionAt": tc.transition, "unblockDescriptor": map[string]any{"owner": map[string]string{"agentId": agent}, "action": tc.action}, "executionPolicy": map[string]any{"monitor": map[string]string{"nextCheckAt": tc.monitor}}})
				}
			}))
			defer s.Close()
			c := client{baseURL: s.URL, http: s.Client()}
			got := c.process(context.Background(), issue{ID: "one", Identifier: "SCO-1"}, time.Now(), options{apply: true, olderThan: time.Nanosecond, reviewed: map[string]reviewedTransition{"SCO-1": review}})
			if got.Applied != tc.expectApply || (patches == 1) != tc.expectApply {
				t.Fatalf("result=%+v patches=%d", got, patches)
			}
		})
	}
}
