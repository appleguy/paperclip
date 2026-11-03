import { describe, expect, it } from "vitest";
import { accountingForScheduledRetry, executionFailureRetryCount, executionRetryAttemptCount, SERVER_SHUTDOWN_REJOIN_RETRY_REASON } from "./execution-recovery-attempt.js";

describe("failure attempts across resource waits", () => {
  it("preserves prior failures through subscription waits without trusting unrelated context", () => {
    expect(executionFailureRetryCount({ scheduledRetryReason: "ai_connection_busy", scheduledRetryAttempt: 12,
      contextSnapshot: { failureRetriesBeforeAiConnectionWait: 1 } })).toBe(1);
    expect(executionFailureRetryCount({ scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2,
      contextSnapshot: { failureRetriesBeforeAiConnectionWait: 0 } })).toBe(2);
    for (const count of [undefined, -1, 1.5, "0"]) {
      expect(executionFailureRetryCount({ scheduledRetryReason: "ai_connection_busy", scheduledRetryAttempt: 4,
        contextSnapshot: { failureRetriesBeforeAiConnectionWait: count } })).toBe(4);
    }
  });
  it("preserves prior failures through repeated workspace waits", () => {
    expect(executionFailureRetryCount({ scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 12,
      contextSnapshot: { failureRetriesBeforeWorkspaceWait: 1 } })).toBe(1);
  });
  it("does not trust a caller-supplied count outside a server-created workspace retry", () => {
    expect(executionFailureRetryCount({ scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2,
      contextSnapshot: { failureRetriesBeforeWorkspaceWait: 0 } })).toBe(2);
  });
  it("keeps ambiguous historical counts without treating a historical productive count as failures", () => {
    expect(executionFailureRetryCount({ scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 4 })).toBe(4);
    expect(executionFailureRetryCount({ scheduledRetryReason: "max_turns_continuation", scheduledRetryAttempt: 4 })).toBe(0);
  });
});

describe("persisted independent accounting", () => {
  it.each(["max_turns_continuation", "issue_disposition_repair", "workspace_busy", "ai_connection_busy", "ai_connection_pool_wait"])("%s cannot erase prior infrastructure debits or spend more", scheduledRetryReason => {
    expect(executionFailureRetryCount({ scheduledRetryReason, scheduledRetryAttempt: 20,
      contextSnapshot: { executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 1 } },
    })).toBe(2);
  });
  it("never lowers the current failure count from a partial or stale ledger", () => {
    for (const executionRetryAccounting of [
      { version: 1, failureRetries: 0, maxTurnContinuations: 1 },
      { version: 1, failureRetries: -1, maxTurnContinuations: 1 },
      { version: 1, failureRetries: "0", maxTurnContinuations: 1 },
      { version: 2, failureRetries: 0, maxTurnContinuations: 1 },
    ]) expect(executionFailureRetryCount({ scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2,
      contextSnapshot: { executionRetryAccounting },
    })).toBe(2);
  });
});

describe("server shutdown rejoin lane", () => {
  it("counts deploy interrupts per reason and never spends the failure budget", () => {
    const run = { scheduledRetryReason: SERVER_SHUTDOWN_REJOIN_RETRY_REASON, scheduledRetryAttempt: 5,
      contextSnapshot: { executionRetryAccounting: { version: 1, failureRetries: 1, maxTurnContinuations: 0 } } };
    expect(executionRetryAttemptCount(run, SERVER_SHUTDOWN_REJOIN_RETRY_REASON)).toBe(5);
    expect(executionRetryAttemptCount(run, "transient_failure")).toBe(1);
    expect(executionFailureRetryCount(run)).toBe(1);
    expect(accountingForScheduledRetry(run, SERVER_SHUTDOWN_REJOIN_RETRY_REASON, 6).failureRetries).toBe(1);
  });
  it("keeps the transient failure budget unchanged", () => {
    const run = { scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2 };
    expect(executionRetryAttemptCount(run, "transient_failure")).toBe(2);
    expect(accountingForScheduledRetry(run, "transient_failure", 3).failureRetries).toBe(3);
    expect(executionRetryAttemptCount(run, SERVER_SHUTDOWN_REJOIN_RETRY_REASON)).toBe(0);
  });
});
