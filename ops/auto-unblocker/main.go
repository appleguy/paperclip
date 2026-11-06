package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/appleguy/zkit/go/pacific"
)

type issue struct {
	ID                  string          `json:"id"`
	Identifier          string          `json:"identifier"`
	Title               string          `json:"title"`
	Status              string          `json:"status"`
	StatusVersion       int64           `json:"statusVersion"`
	AssigneeAgentID     string          `json:"assigneeAgentId"`
	AssigneeUserID      string          `json:"assigneeUserId"`
	CreatedAt           string          `json:"createdAt"`
	UpdatedAt           string          `json:"updatedAt"`
	BlockedTransitionAt string          `json:"blockedTransitionAt"`
	UnblockDescriptor   json.RawMessage `json:"unblockDescriptor"`
	ExecutionPolicy     struct {
		Monitor struct {
			NextCheckAt string `json:"nextCheckAt"`
		} `json:"monitor"`
	} `json:"executionPolicy"`
	ActiveRecoveryAction json.RawMessage `json:"activeRecoveryAction"`
	BlockerAttention     struct {
		State                   string `json:"state"`
		Reason                  string `json:"reason"`
		UnresolvedBlockerCount  int    `json:"unresolvedBlockerCount"`
		PendingFinalizeBlockers int    `json:"pendingFinalizeBlockerCount"`
	} `json:"blockerAttention"`
	BlockedInboxAttention struct {
		Reason        string `json:"reason"`
		InteractionID string `json:"interactionId"`
		ApprovalID    string `json:"approvalId"`
	} `json:"blockedInboxAttention"`
}

type blocker struct {
	ID            string `json:"id"`
	Identifier    string `json:"identifier"`
	Status        string `json:"status"`
	DisplayStatus string `json:"displayStatus"`
}

type blockerDiagnostics struct {
	Readiness struct {
		AllBlockersDone         bool `json:"allBlockersDone"`
		IsDependencyReady       bool `json:"isDependencyReady"`
		UnresolvedBlockerCount  int  `json:"unresolvedBlockerCount"`
		PendingFinalizeBlockers int  `json:"pendingFinalizeBlockerCount"`
	} `json:"readiness"`
	Blockers  []blocker `json:"blockers"`
	Truncated bool      `json:"truncated"`
}

type interaction struct {
	Kind        string `json:"kind"`
	Status      string `json:"status"`
	DismissedAt string `json:"dismissedAt"`
}

type approval struct {
	Status string `json:"status"`
}

type issueResult struct {
	Status string `json:"status"`
}

type httpError struct {
	Status  int
	Message string
}

var uuidPattern = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`)

func (e httpError) Error() string {
	message := uuidPattern.ReplaceAllString(e.Message, "[id]")
	if message == "" {
		return fmt.Sprintf("Paperclip API returned HTTP %d", e.Status)
	}
	return fmt.Sprintf("Paperclip API returned HTTP %d: %s", e.Status, message)
}

type client struct {
	baseURL   string
	apiKey    string
	runID     string
	companyID string
	agentID   string
	boardID   string
	http      *http.Client
}

type options struct {
	apply            bool
	jsonOutput       bool
	olderThan        time.Duration
	concurrency      int
	limit            int
	cleanupDecisions bool
	reviewed         map[string]reviewedTransition
}

type reviewedTransition struct {
	Issue               string `json:"issue"`
	BlockedTransitionAt string `json:"blockedTransitionAt"`
	DescriptorAction    string `json:"descriptorAction"`
	OwnerAgentPrefix    string `json:"ownerAgentPrefix"`
}

type row struct {
	Issue               string `json:"issue"`
	Action              string `json:"action"`
	Cause               string `json:"cause"`
	Applied             bool   `json:"applied"`
	Error               string `json:"error,omitempty"`
	BlockedTransitionAt string `json:"blockedTransitionAt,omitempty"`
	DescriptorAction    string `json:"descriptorAction,omitempty"`
	OwnerAgentPrefix    string `json:"ownerAgentPrefix,omitempty"`
}

type report struct {
	DryRun          bool           `json:"dryRun"`
	OlderThan       string         `json:"olderThan"`
	Checked         int            `json:"checked"`
	Counts          map[string]int `json:"counts"`
	Issues          []row          `json:"issues"`
	DecisionCleanup []row          `json:"decisionCleanup,omitempty"`
}

func main() {
	var opts options
	var olderThan string
	var reviewFile string
	flag.BoolVar(&opts.apply, "apply", false, "apply safe unblocks and route remaining work to agents or Board (default is dry-run)")
	flag.BoolVar(&opts.jsonOutput, "json", false, "write a machine-readable report")
	flag.StringVar(&olderThan, "older-than", "2h", "minimum blocked age (Go duration)")
	flag.IntVar(&opts.concurrency, "concurrency", 1, "maximum concurrent live issue rechecks")
	flag.IntVar(&opts.limit, "limit", 0, "optional maximum candidate count; zero checks all")
	flag.BoolVar(&opts.cleanupDecisions, "cleanup-decisions", false, "inspect misrouted or stale auto-unblocker decisions (dry-run only)")
	flag.StringVar(&reviewFile, "review-file", "", "JSON array of Board-reviewed self-owned transitions (required for apply)")
	flag.Parse()

	duration, err := time.ParseDuration(olderThan)
	if err != nil || duration <= 0 {
		fatal("--older-than must be a positive Go duration")
	}
	opts.olderThan = duration
	if opts.concurrency < 1 || opts.concurrency > 32 {
		fatal("--concurrency must be between 1 and 32")
	}
	if opts.apply && opts.concurrency != 1 {
		fatal("--apply requires --concurrency=1 for the careful-resume rate limit")
	}
	if opts.limit < 0 {
		fatal("--limit must be zero or greater")
	}
	if opts.apply && (reviewFile == "" || opts.cleanupDecisions) {
		fatal("--apply requires --review-file and cannot be combined with --cleanup-decisions")
	}
	if reviewFile != "" {
		var err error
		opts.reviewed, err = readReviewed(reviewFile)
		if err != nil {
			fatal("review file: " + err.Error())
		}
	}

	apiBase := strings.TrimRight(os.Getenv("PAPERCLIP_API_URL"), "/")
	apiBase = strings.TrimSuffix(apiBase, "/api")
	apiKey := os.Getenv("PAPERCLIP_API_KEY")
	if opts.apply || opts.cleanupDecisions {
		apiKey = os.Getenv("PAPERCLIP_BOARD_API_KEY")
		if apiKey == "" {
			fatal("PAPERCLIP_BOARD_API_KEY is required for Board-authorized routing")
		}
	}
	companyID := os.Getenv("PAPERCLIP_COMPANY_ID")
	runID := os.Getenv("PAPERCLIP_RUN_ID")
	agentID := os.Getenv("PAPERCLIP_AGENT_ID")
	if apiBase == "" || apiKey == "" || companyID == "" {
		fatal("PAPERCLIP_API_URL, PAPERCLIP_API_KEY, and PAPERCLIP_COMPANY_ID are required")
	}
	if opts.apply && runID == "" {
		fatal("PAPERCLIP_RUN_ID is required when --apply is set")
	}
	if opts.apply && agentID == "" {
		fatal("PAPERCLIP_AGENT_ID is required when --apply is set")
	}

	api := &client{
		baseURL:   apiBase,
		apiKey:    apiKey,
		runID:     runID,
		companyID: companyID,
		agentID:   agentID,
		boardID:   os.Getenv("PAPERCLIP_BOARD_AGENT_ID"),
		http:      &http.Client{Timeout: 30 * time.Second},
	}
	if (opts.apply || opts.cleanupDecisions) && api.boardID == "" {
		fatal("PAPERCLIP_BOARD_AGENT_ID is required to preserve Board-owned decisions")
	}
	ctx := context.Background()
	var cleanup []row
	if opts.cleanupDecisions {
		var err error
		cleanup, err = api.cleanupDecisions(ctx, opts.apply)
		if err != nil {
			fatal("decision cleanup: " + err.Error())
		}
	}
	issues, err := api.listBlocked(ctx)
	if err != nil {
		fatal("list blocked issues: " + err.Error())
	}

	// Pacific time is the shared zkit time source; comparisons remain instant-based.
	asOf := pacific.Now()
	candidates := make([]issue, 0, len(issues))
	for _, item := range issues {
		if item.Status != "blocked" {
			continue
		}
		if opts.reviewed != nil {
			if _, ok := opts.reviewed[item.Identifier]; !ok {
				continue
			}
		}
		blockedAt, ok := blockedSince(item)
		if ok && asOf.Sub(blockedAt) > opts.olderThan {
			candidates = append(candidates, item)
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].Identifier < candidates[j].Identifier })
	if opts.limit > 0 && len(candidates) > opts.limit {
		candidates = candidates[:opts.limit]
	}

	results := make([]row, len(candidates))
	jobs := make(chan int)
	var workers sync.WaitGroup
	for i := 0; i < opts.concurrency; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				if opts.apply && index > 0 {
					time.Sleep(12 * time.Second)
				}
				results[index] = api.process(ctx, candidates[index], asOf, opts)
			}
		}()
	}
	for index := range candidates {
		jobs <- index
	}
	close(jobs)
	workers.Wait()
	if opts.reviewed != nil {
		seen := make(map[string]bool)
		for _, item := range candidates {
			seen[item.Identifier] = true
		}
		for id := range opts.reviewed {
			if !seen[id] {
				results = append(results, row{Issue: id, Action: "exception", Cause: "reviewed issue is absent, no longer blocked, too recent, or excluded by limit", Error: "reviewed transition not checked"})
			}
		}
	}

	counts := make(map[string]int)
	hasError := false
	for _, item := range results {
		counts[item.Action]++
		if item.Error != "" {
			hasError = true
		}
	}
	out := report{
		DryRun:          !opts.apply,
		OlderThan:       opts.olderThan.String(),
		Checked:         len(results),
		Counts:          counts,
		Issues:          results,
		DecisionCleanup: cleanup,
	}
	if err := writeReport(out, opts.jsonOutput); err != nil {
		fatal("write report: " + err.Error())
	}
	if hasError {
		os.Exit(1)
	}
}

func (c *client) listBlocked(ctx context.Context) ([]issue, error) {
	query := url.Values{}
	query.Set("status", "blocked")
	query.Set("includeBlockedBy", "true")
	query.Set("includeBlockedInboxAttention", "true")
	path := "/api/companies/" + url.PathEscape(c.companyID) + "/issues?" + query.Encode()
	var result []issue
	if err := c.request(ctx, http.MethodGet, path, nil, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func (c *client) process(ctx context.Context, initial issue, asOf time.Time, opts options) row {
	result := row{Issue: initial.Identifier}
	if initial.ID == "" || initial.Identifier == "" {
		result.Action = "exception"
		result.Cause = "blocked-issue row is missing its id or short identifier"
		return result
	}
	basePath := "/api/issues/" + url.PathEscape(initial.ID)

	var current issue
	if err := c.request(ctx, http.MethodGet, basePath, nil, &current); err != nil {
		result.Action = "exception"
		result.Cause = "could not recheck issue state"
		result.Error = err.Error()
		return result
	}
	if current.Status != "blocked" {
		result.Action = "skip_changed"
		result.Cause = "issue is no longer blocked"
		return result
	}
	if reviewed, ok := opts.reviewed[initial.Identifier]; ok {
		var descriptor unblockDescriptor
		var owner struct {
			AgentID string `json:"agentId"`
		}
		if current.Identifier != reviewed.Issue || current.BlockedTransitionAt != reviewed.BlockedTransitionAt ||
			json.Unmarshal(current.UnblockDescriptor, &descriptor) != nil || json.Unmarshal(descriptor.Owner, &owner) != nil ||
			descriptor.Action != reviewed.DescriptorAction || !strings.HasPrefix(owner.AgentID, reviewed.OwnerAgentPrefix) || current.AssigneeAgentID != owner.AgentID {
			result.Action, result.Cause, result.Error = "exception", "reviewed transition, descriptor action, or assignee changed", "stale review"
			return result
		}
	} else if opts.apply {
		result.Action, result.Cause, result.Error = "exception", "issue was not reviewed", "missing review"
		return result
	}
	blockedAt, ok := blockedSince(current)
	if !ok || asOf.Sub(blockedAt) <= opts.olderThan {
		result.Action = "skip_changed"
		result.Cause = "live blocked age is under the configured threshold"
		return result
	}

	var diagnostics blockerDiagnostics
	if err := c.request(ctx, http.MethodGet, basePath+"/diagnostics/blockers", nil, &diagnostics); err != nil {
		result.Action = "exception"
		result.Cause = "could not recheck live blocker diagnostics"
		result.Error = err.Error()
		return result
	}
	var interactions []interaction
	if err := c.request(ctx, http.MethodGet, basePath+"/interactions", nil, &interactions); err != nil {
		result.Action = "exception"
		result.Cause = "could not recheck pending issue decisions"
		result.Error = err.Error()
		return result
	}

	if hasActive(current.ActiveRecoveryAction) {
		result.Action = "active_recovery"
		result.Cause = "an active recovery action already owns the next step"
		return result
	}
	if pending, kind := pendingInteraction(interactions); pending {
		result.Action = "existing_decision"
		result.Cause = "a pending " + kind + " interaction already exists"
		return result
	}
	attentionReason := initial.BlockedInboxAttention.Reason
	approvalIDs := map[string]bool{}
	if initial.BlockedInboxAttention.ApprovalID != "" {
		approvalIDs[initial.BlockedInboxAttention.ApprovalID] = true
	}
	if current.BlockedInboxAttention.ApprovalID != "" {
		approvalIDs[current.BlockedInboxAttention.ApprovalID] = true
	}
	for approvalID := range approvalIDs {
		var currentApproval approval
		approvalPath := "/api/approvals/" + url.PathEscape(approvalID)
		if err := c.request(ctx, http.MethodGet, approvalPath, nil, &currentApproval); err != nil {
			result.Action = "exception"
			result.Cause = "could not recheck the existing approval"
			result.Error = err.Error()
			return result
		}
		if currentApproval.Status == "pending" || currentApproval.Status == "revision_requested" {
			result.Action = "existing_decision"
			result.Cause = "an existing " + attentionReason + " approval is still " + currentApproval.Status
			return result
		}
	}

	cause := blockerCause(current, diagnostics)
	if hasActive(current.UnblockDescriptor) {
		return c.routeDescriptor(ctx, current, diagnostics, opts.apply, opts.reviewed != nil)
	}
	if dependencyReady(diagnostics) && !hasActive(current.UnblockDescriptor) {
		if current.AssigneeAgentID == "" {
			return c.routeBoard(ctx, current, "Dependencies are complete but no agent is assigned.", opts.apply)
		}
		result.Action = "unblock"
		result.Cause = cause
		if !opts.apply {
			return result
		}
		body := map[string]string{
			"status":  "todo",
			"comment": "Auto-unblocker rechecked the live blocker graph: " + cause + ". Dependencies are complete, so this issue is ready to resume.",
		}
		var updated issueResult
		if err := c.request(ctx, http.MethodPatch, basePath, body, &updated); err != nil {
			result.Error = err.Error()
			return result
		}
		if updated.Status != "todo" {
			result.Error = "Paperclip did not confirm status todo"
			return result
		}
		result.Applied = true
		return result
	}

	if current.BlockerAttention.State == "covered" && attentionReason == "" && allBlockersActivelyMoving(diagnostics) {
		result.Action = "live_dependency"
		result.Cause = cause
		return result
	}

	return c.routeBoard(ctx, current, cause, opts.apply)
}

func (c *client) request(ctx context.Context, method, path string, body any, output any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if method != http.MethodGet {
		req.Header.Set("X-Paperclip-Run-Id", c.runID)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		var detail struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(body, &detail)
		message := detail.Error
		if message == "" {
			message = detail.Message
		}
		return httpError{Status: resp.StatusCode, Message: message}
	}
	if output == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 8<<20))
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("decode Paperclip response: %w", err)
	}
	return nil
}

func blockedSince(item issue) (time.Time, bool) {
	for _, value := range []string{item.BlockedTransitionAt, item.UpdatedAt} {
		if value == "" {
			continue
		}
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func hasActive(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null")) && !bytes.Equal(trimmed, []byte("false"))
}

func pendingInteraction(items []interaction) (bool, string) {
	for _, item := range items {
		if item.Status == "pending" && item.DismissedAt == "" {
			if item.Kind == "" {
				return true, "decision"
			}
			return true, item.Kind
		}
	}
	return false, ""
}

func dependencyReady(d blockerDiagnostics) bool {
	return d.Readiness.IsDependencyReady && d.Readiness.UnresolvedBlockerCount == 0 && d.Readiness.PendingFinalizeBlockers == 0 && !d.Truncated
}

func allBlockersActivelyMoving(d blockerDiagnostics) bool {
	if len(d.Blockers) == 0 || d.Truncated || d.Readiness.UnresolvedBlockerCount == 0 || d.Readiness.PendingFinalizeBlockers > 0 {
		return false
	}
	moving := 0
	for _, item := range d.Blockers {
		status := item.Status
		if status == "done" {
			continue
		}
		if status != "in_progress" && status != "in_review" {
			return false
		}
		moving++
	}
	return moving > 0
}

func blockerCause(current issue, d blockerDiagnostics) string {
	if hasActive(current.UnblockDescriptor) {
		return "an unblock descriptor remains; owner direction is needed"
	}
	if d.Readiness.PendingFinalizeBlockers > 0 {
		return fmt.Sprintf("%d blocker(s) still need finalization", d.Readiness.PendingFinalizeBlockers)
	}
	if d.Truncated {
		return "live blocker diagnostics are truncated; owner direction is needed"
	}
	if dependencyReady(d) {
		if len(d.Blockers) == 0 {
			return "no unresolved live blockers remain"
		}
		return "all live blocker issues are complete"
	}
	if len(d.Blockers) > 0 {
		parts := make([]string, 0, len(d.Blockers))
		for i, item := range d.Blockers {
			if i == 5 {
				parts = append(parts, fmt.Sprintf("%d more blocker(s)", len(d.Blockers)-i))
				break
			}
			identifier := item.Identifier
			if identifier == "" {
				identifier = "unknown blocker"
			}
			status := item.DisplayStatus
			if status == "" {
				status = item.Status
			}
			if status == "" {
				status = "unknown status"
			}
			parts = append(parts, identifier+" ("+status+")")
		}
		return "live blocker chain: " + strings.Join(parts, ", ")
	}
	return fmt.Sprintf("dependency is not ready (unresolved=%d, pending-finalize=%d)", d.Readiness.UnresolvedBlockerCount, d.Readiness.PendingFinalizeBlockers)
}

func writeReport(out report, asJSON bool) error {
	if asJSON {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(out)
	}
	mode := "live"
	if out.DryRun {
		mode = "dry-run"
	}
	fmt.Printf("auto-unblocker %s: checked=%d older-than=%s\n", mode, out.Checked, out.OlderThan)
	keys := make([]string, 0, len(out.Counts))
	for key := range out.Counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		fmt.Printf("  %s: %d\n", key, out.Counts[key])
	}
	for _, item := range append(out.DecisionCleanup, out.Issues...) {
		state := "planned"
		if item.Applied {
			state = "applied"
		}
		if item.Error != "" {
			state = "error: " + item.Error
		}
		fmt.Printf("%s | %s | %s | %s\n", item.Issue, item.Action, state, item.Cause)
	}
	return nil
}

func fatal(message string) {
	fmt.Fprintln(os.Stderr, "auto-unblocker:", message)
	os.Exit(2)
}
