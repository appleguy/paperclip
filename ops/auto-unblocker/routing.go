package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"time"
)

type unblockDescriptor struct {
	Owner  json.RawMessage `json:"owner"`
	Action string          `json:"action"`
}

func (c *client) routeDescriptor(ctx context.Context, current issue, d blockerDiagnostics, apply bool) row {
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
		r.Action, r.Cause = "self_unblock", "self-owned descriptor has no unresolved dependency or pending decision"
		if !apply {
			return r
		}
		body := map[string]string{"status": "todo", "comment": "Auto-unblocker: the unblock owner is the assignee and no live dependency or pending decision remains; resume the task and use a monitor for external waits."}
		var updated issueResult
		if err := c.request(ctx, http.MethodPatch, "/api/issues/"+url.PathEscape(current.ID), body, &updated); err != nil {
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
