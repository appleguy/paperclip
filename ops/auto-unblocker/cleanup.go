package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

type openDecision struct {
	ID              string                     `json:"id"`
	RuleKey         string                     `json:"ruleKey"`
	TargetSnapshots map[string]json.RawMessage `json:"targetSnapshots"`
}

// Cancellation delivers an origin-agent continuation, so cleanup uses the
// same 12-second pacing as status changes. The caller must use a Board token.
func (c *client) cleanupDecisions(ctx context.Context, apply bool) ([]row, error) {
	var decisions []openDecision
	path := "/api/companies/" + url.PathEscape(c.companyID) + "/decisions?status=open&limit=100"
	if err := c.request(ctx, http.MethodGet, path, nil, &decisions); err != nil {
		return nil, err
	}
	if len(decisions) >= 100 {
		return nil, fmt.Errorf("open-decision list reached its 100-item limit; cannot verify complete cleanup")
	}
	var out []row
	cancelled := 0
	for _, decision := range decisions {
		if decision.RuleKey != "blocked_issue.auto_unblocker" || decision.ID == "" || len(decision.TargetSnapshots) != 1 {
			continue
		}
		var target string
		for id := range decision.TargetSnapshots {
			target = id
		}
		var current issue
		if err := c.request(ctx, http.MethodGet, "/api/issues/"+url.PathEscape(target), nil, &current); err != nil {
			return out, err
		}
		if current.ID == "" || current.Identifier == "" {
			return out, fmt.Errorf("decision target is missing identity")
		}
		reason := ""
		if current.Status != "blocked" {
			reason = "Auto-unblocker decision is stale: issue is no longer blocked."
		} else if hasActive(current.UnblockDescriptor) {
			var descriptor unblockDescriptor
			if json.Unmarshal(current.UnblockDescriptor, &descriptor) != nil {
				return out, fmt.Errorf("invalid descriptor on %s", current.Identifier)
			}
			var owner struct {
				AgentID string `json:"agentId"`
			}
			if string(descriptor.Owner) != `"board"` && json.Unmarshal(descriptor.Owner, &owner) == nil && owner.AgentID != "" && owner.AgentID != c.boardID {
				reason = "Auto-unblocker decision was misrouted: the unblock owner is an agent; route to that agent instead."
			}
		}
		if reason == "" {
			continue
		}
		r := row{Issue: current.Identifier, Action: "cancel_decision", Cause: reason}
		if apply {
			if cancelled > 0 {
				time.Sleep(12 * time.Second)
			}
			var result struct {
				Status   string `json:"status"`
				Metadata struct {
					CancelReason string `json:"cancelReason"`
				} `json:"metadata"`
			}
			if err := c.request(ctx, http.MethodPost, "/api/decisions/"+url.PathEscape(decision.ID)+"/cancel", map[string]string{"reason": reason}, &result); err != nil {
				return out, err
			}
			if result.Status != "cancelled" || result.Metadata.CancelReason != reason {
				return out, fmt.Errorf("cancellation on %s did not confirm its reason; stop cleanup", current.Identifier)
			}
			r.Applied = true
			cancelled++
		}
		out = append(out, r)
	}
	if apply && cancelled > 0 {
		time.Sleep(12 * time.Second)
	}
	return out, nil
}
