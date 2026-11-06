import { isPreDispatchReviewWait } from "./pre-dispatch-review-wait.js";
import { expect, it } from "vitest";
import { legacyExecutionNeedsReconciliation, legacyExecutionNeedsReconciliationWithEvidence } from "./legacy-execution-recovery.js";

const stopped = {
  runtimeMode: "legacy", status: "cancelled", errorCode: "cancelled",
  resultJson: {
    executionCancellation: { state: "acknowledged" },
    executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" },
  },
};

it.each(["workspace_git_scan_timeout", "workspace_git_scan_saturated", "remote_workspace_prepare_timeout", "reusable_sandbox_resume_failed", "remote_workspace_restore_failed", "plugin_worker_unavailable", "runner_revision_mismatch"])("does not invent unknown provider actions after exhausted %s bootstrap retries", (errorCode) => {
  const run = { runtimeMode: "legacy", status: "failed", errorCode, scheduledRetryAttempt: 2,
    resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } };
  expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {
    executionRecovery: { kind: "bootstrap", providerWorkStarted: true },
  } })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, errorCode: "setup_failed" })).toBe(true);
});

it("permits subscription waits only with explicit evidence that provider work never started", () => {
  const waiting = {
    runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 12,
    resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } },
  };
  expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, status: "failed" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, errorCode: "cancelled" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {
    executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true },
  } })).toBe(true);
});

it("keeps mid-turn quota failures held and exempts only proven pre-dispatch waits", () => {
  const resultJson = { errorFamily: "provider_quota", retryNotBefore: new Date(Date.now() + 3_600_000).toISOString(), toolActionsCompleted: 1 };
  const run = { runtimeMode: "legacy", status: "failed", errorCode: "provider_quota", resultJson };
  expect(legacyExecutionNeedsReconciliation(run)).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {
    ...resultJson, conversationContinuation: "continue_conversation_v1",
  } })).toBe(false);
  const waiting = { ...run, status: "cancelled", errorCode: "target_busy", scheduledRetryAttempt: 12 };
  expect(legacyExecutionNeedsReconciliation(waiting)).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {
    errorFamily: "provider_quota", executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
  } })).toBe(false);
});

it("allows a confirmed interrupted checkpoint without treating ordinary cancellation as replay permission", () => {
  expect(legacyExecutionNeedsReconciliation(stopped)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, status: "failed" })).toBe(true);
});

it.each([
  { providerStopped: false }, { sessionPreserved: false }, { actionOutcomes: "unknown" },
])("retains the hold for incomplete interruption evidence: %j", (missing) => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson,
    executionRecovery: { ...stopped.resultJson.executionRecovery, ...missing },
  } })).toBe(true);
});

it("retains the hold until the provider actually acknowledges cancellation", () => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson, executionCancellation: { state: "requested" },
  } })).toBe(true);
});

 it("continues a conversation without requiring receipts, even after automatic attempts are exhausted", () => {
  for (const status of ["failed", "timed_out", "interrupted", "cancelled"]) {
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy", status, errorCode: "process_lost", scheduledRetryAttempt: 2,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    })).toBe(false);
  }
});

it("holds a lost OpenCode controller despite generic conversation continuation", () => {
  const run = { runtimeMode: "legacy", status: "failed", errorCode: "process_lost",
    runnerProfileJson: { adapterDispatch: { adapterType: "opencode_local" } },
    resultJson: { conversationContinuation: "continue_conversation_v1" } };
  expect(legacyExecutionNeedsReconciliation(run)).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: { ...run.resultJson,
    executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } })).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...run, runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } } })).toBe(false);
});

it("holds OpenCode reattach failures with possible provider work despite conversation continuation", () => {
  const run = { runtimeMode: "legacy", status: "failed", errorCode: "adapter_failed",
    runnerProfileJson: { adapterDispatch: { adapterType: "opencode_local" } },
    resultJson: { conversationContinuation: "continue_conversation_v1",
      executionRecovery: { kind: "bootstrap", reason: "reattach_message_unknown", providerWorkStarted: true } } };
  expect(legacyExecutionNeedsReconciliation(run)).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: { ...run.resultJson,
    executionRecovery: { ...run.resultJson.executionRecovery, providerWorkStarted: false } } })).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...run, runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } } })).toBe(false);
});

it.each([false, true])("holds explicit unverified OpenCode work when local started is %s", (started) => {
  for (const errorCode of ["adapter_failed", "process_lost"]) {
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy", status: "failed", errorCode,
      runnerProfileJson: { adapterDispatch: { adapterType: "opencode_local" } },
      resultJson: { conversationContinuation: "continue_conversation_v1", executionRecovery: {
        kind: "bootstrap", reason: "unowned_turn_verified_idle", providerWorkStarted: started,
        providerWorkEvidence: "unverified", providerSessionId: "session-original", providerMessageId: "message-original",
      } },
    })).toBe(true);
  }
});

it("retries a busy AI subscription only when no provider work started", () => {
   const waiting = { runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 10,
     resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } } };
   expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true } } })).toBe(true);
 });


it.each(["failed", "timed_out", "cancelled"])("holds an unsafe archive after %s even with conversation or bootstrap evidence", (status) => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status, errorCode: "workspace_restore_failed", resultJson: {
    workspaceRestoreFailure: "restore_unsafe_archive", conversationContinuation: "continue_conversation_v1",
    executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, stopReason: "max_turns",
  } })).toBe(true);
});


it("retains conversation retry eligibility for a transient restore lock timeout", () => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status: "failed", errorCode: "workspace_restore_failed", resultJson: {
    workspaceRestoreFailure: "restore_lock_timeout", conversationContinuation: "continue_conversation_v1",
  } })).toBe(false);
});


it("recognizes only an unclaimed pre-dispatch review wait receipt", () => {
  const run = { runtimeMode: "legacy", status: "cancelled", errorCode: "issue_continuation_waiting_on_review",
    startedAt: null, runtimeModeResolvedAt: null, processPid: null, processGroupId: null,
    processStartedAt: null, nativeIssueId: null, nativeSessionId: null, sessionIdAfter: null,
    controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null,
    resultJson: { stopReason: "issue_continuation_waiting_on_review", timeoutSource: "stale_queued_run_gate" } };
  expect(isPreDispatchReviewWait(run)).toBe(true);
  expect(legacyExecutionNeedsReconciliation(run)).toBe(true);
  for (const patch of [
    { startedAt: new Date() }, { processPid: 123 }, { processGroupId: 123 },
    { processStartedAt: new Date() }, { nativeSessionId: "provider-session" }, { nativeIssueId: "native-task" },
    { sessionIdAfter: "provider-session" }, { runtimeModeResolvedAt: new Date() },
    { controllerBootId: "live-controller" }, { controllerLeaseExpiresAt: new Date() }, { executionStage: "preparing" },
    { errorCode: "operator_interrupted" }, { resultJson: {} },
    { resultJson: { ...run.resultJson, stopReason: "cancelled" } },
    { resultJson: { ...run.resultJson, workspaceRestoreFailure: "restore_unsafe_archive" } },
  ]) expect(isPreDispatchReviewWait({ ...run, ...patch })).toBe(false);
});

it("does not hold a repair that dispatch suppressed before it reached the provider", () => {
  const suppressed = { runtimeMode: "legacy", status: "cancelled", errorCode: "legacy_disposition_repair_suppressed", resultJson: {} };
  expect(legacyExecutionNeedsReconciliation(suppressed)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...suppressed, status: "failed" })).toBe(true);
});

it("does not hold a claude_rc run interrupted by a server shutdown (TUI left intact), but holds other adapters", () => {
  const run = { runtimeMode: "legacy", status: "interrupted", errorCode: "server_shutdown_interrupted", resultJson: {},
    runnerProfileJson: { adapterDispatch: { adapterType: "claude_rc" } } } as never;
  expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...(run as object), runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } } } as never)).toBe(true);
});

it("falls back to the agent adapter for deploy-interrupted runs that recorded no adapterDispatch (SCO-817)", async () => {
  const fakeDb = (adapterType: string) => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ adapterType }] }) }) }) }) as never;
  const run = { id: "r", agentId: "a", runtimeMode: "legacy", status: "interrupted", errorCode: "server_shutdown_interrupted",
    resultJson: {}, runnerProfileJson: {} } as never;
  expect(await legacyExecutionNeedsReconciliationWithEvidence(fakeDb("claude_rc"), run)).toBe(false);
});
