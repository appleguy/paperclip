package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type unblockDescriptor struct {
	Owner  json.RawMessage `json:"owner"`
	Action string          `json:"action"`
}

func (c *client) routeDescriptor(ctx context.Context, current issue, d blockerDiagnostics, apply, reviewed bool) row {
	r := row{Issue: current.Identifier}
	var descriptor unblockDescriptor
	if err := json.Unmarshal(current.UnblockDescriptor, &descriptor); err != nil || descriptor.Action == "" {
		r.Action, r.Cause = "exception", "invalid unblock descriptor"
		return r
	}
	var owner struct {
		AgentID string `json:"agentId"`
		UserID  string `json:"userId"`
	}
	if string(descriptor.Owner) == `"board"` {
		return c.routeBoard(ctx, current, descriptor.Action, apply)
	}
	if err := json.Unmarshal(descriptor.Owner, &owner); err != nil {
		r.Action, r.Cause = "exception", "invalid unblock owner"
		return r
	}
	if owner.UserID != "" {
		return c.routeBoard(ctx, current, descriptor.Action, apply)
	}
	if c.boardID != "" && owner.AgentID == c.boardID {
		return c.routeBoard(ctx, current, descriptor.Action, apply)
	}
	if owner.AgentID == "" {
		r.Action, r.Cause = "exception", "missing unblock owner"
		return r
	}
	if current.BlockedTransitionAt == "" {
		r.Action, r.Cause = "exception", "missing blocked transition identity"
		return r
	}
	if owner.AgentID == current.AssigneeAgentID {
		r.BlockedTransitionAt = current.BlockedTransitionAt
		r.DescriptorAction = descriptor.Action
		if len(owner.AgentID) >= 8 {
			r.OwnerAgentPrefix = owner.AgentID[:8]
		} else {
			r.OwnerAgentPrefix = owner.AgentID
		}
		if next := current.ExecutionPolicy.Monitor.NextCheckAt; next != "" {
			when, err := time.Parse(time.RFC3339Nano, next)
			if err != nil || when.After(time.Now()) {
				r.Action, r.Cause = "scheduled_monitor", "a future or invalid monitor must be reviewed before resuming"
				return r
			}
		}
		if !dependencyReady(d) {
			r.Action, r.Cause = "live_dependency", "self-owned descriptor has an unresolved or uncertain dependency"
			return r
		}
		if d.Truncated {
			r.Action, r.Cause = "live_dependency", "dependency snapshot is truncated"
			return r
		}
		r.Action, r.Cause = "self_review", "Board must verify that the descriptor action has cleared; dependency readiness alone is insufficient"
		if !apply {
			return r
		}
		if !reviewed {
			r.Error = "self-owned descriptor has no Board review"
			return r
		}
		var latest issue
		if err := c.request(ctx, http.MethodGet, "/api/issues/"+url.PathEscape(current.ID), nil, &latest); err != nil {
			r.Error = "final issue recheck: " + err.Error()
			return r
		}
		if current.UpdatedAt == "" || latest.UpdatedAt != current.UpdatedAt || latest.Status != "blocked" || latest.BlockedTransitionAt != current.BlockedTransitionAt || latest.AssigneeAgentID != current.AssigneeAgentID || !bytes.Equal(bytes.TrimSpace(latest.UnblockDescriptor), bytes.TrimSpace(current.UnblockDescriptor)) {
			r.Error = "issue changed during gate checks; review again"
			return r
		}
		r.Action = "self_unblock"
		blockerIDs := make([]string, 0, len(d.Blockers))
		for _, blocker := range d.Blockers {
			if blocker.ID == "" {
				r.Error = "dependency snapshot missing an ID"
				return r
			}
			blockerIDs = append(blockerIDs, blocker.ID)
		}
		body := map[string]any{"status": "todo", "expectedBlockedTransition": map[string]any{
			"statusVersion": current.StatusVersion, "updatedAt": current.UpdatedAt,
			"blockedTransitionAt": current.BlockedTransitionAt, "blockedByIssueIds": blockerIDs,
		}}
		var updated issueResult
		if err := c.request(ctx, http.MethodPatch, "/api/issues/"+url.PathEscape(current.ID)+"/guarded-unblock", body, &updated); err != nil {
			r.Error = err.Error()
			return r
		}
		if updated.Status != "todo" {
			r.Error = "Paperclip did not confirm status todo"
			return r
		}
		r.Applied = true
		return r
	}
	if apply {
		r.Action, r.Cause, r.Error = "exception", "review file permits self-owned transitions only", "not a self-owned transition"
		return r
	}
	r.Action, r.Cause = "agent_redelivery", "redeliver to the other agent once for this blocked transition"
	if !apply {
		return r
	}
	body := map[string]any{"source": "automation", "triggerDetail": "system", "reason": "issue_unblock_requested", "idempotencyKey": "auto-unblocker:" + current.ID + ":" + current.BlockedTransitionAt, "payload": map[string]string{"issueId": current.ID, "action": descriptor.Action}}
	var wake struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := c.request(ctx, http.MethodPost, "/api/agents/"+url.PathEscape(owner.AgentID)+"/wakeup", body, &wake); err != nil {
		r.Error = err.Error()
		return r
	}
	if wake.ID == "" || wake.Status == "skipped" {
		r.Error = "agent wake was skipped or not confirmed"
		return r
	}
	r.Applied = true
	return r
}

func readReviewed(path string) (map[string]reviewedTransition, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var entries []reviewedTransition
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&entries); err != nil {
		return nil, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("expected one JSON array")
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("at least one reviewed transition is required")
	}
	result := make(map[string]reviewedTransition, len(entries))
	for _, entry := range entries {
		if entry.Issue == "" || strings.TrimSpace(entry.DescriptorAction) == "" || len(entry.OwnerAgentPrefix) != 8 {
			return nil, fmt.Errorf("each entry requires issue, descriptorAction, and an eight-character ownerAgentPrefix")
		}
		if _, err := time.Parse(time.RFC3339Nano, entry.BlockedTransitionAt); err != nil {
			return nil, fmt.Errorf("%s: invalid blockedTransitionAt", entry.Issue)
		}
		if _, exists := result[entry.Issue]; exists {
			return nil, fmt.Errorf("duplicate issue %s", entry.Issue)
		}
		result[entry.Issue] = entry
	}
	return result, nil
}

func (c *client) routeBoard(ctx context.Context, current issue, cause string, apply bool) row {
	r := row{Issue: current.Identifier, Action: "board_interaction", Cause: cause}
	if !apply {
		return r
	}
	if c.boardID == "" || current.BlockedTransitionAt == "" {
		r.Error = "Board agent ID and blocked transition identity are required"
		return r
	}
	body := map[string]any{
		"kind": "ask_user_questions", "addresseeAgentId": c.boardID, "resolverPolicy": "not_creator", "continuationPolicy": "wake_assignee",
		"idempotencyKey": "auto-unblocker:board:" + current.ID + ":" + current.BlockedTransitionAt,
		"title":          "Review blocked " + current.Identifier,
		"payload":        map[string]any{"version": 1, "questions": []any{map[string]any{"id": "next_step", "prompt": "Review this blocker and decide the next step: " + cause, "selectionMode": "single", "required": true, "allowOther": true, "options": []any{map[string]string{"id": "review", "label": "Review and route"}}}}},
	}
	var interaction struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := c.request(ctx, http.MethodPost, "/api/issues/"+url.PathEscape(current.ID)+"/interactions", body, &interaction); err != nil {
		r.Error = err.Error()
		return r
	}
	if interaction.ID == "" || interaction.Status != "pending" {
		r.Error = "Board interaction was not confirmed pending"
		return r
	}
	r.Applied = true
	return r
}
