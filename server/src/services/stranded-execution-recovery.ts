import { and, eq, inArray, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { hasPendingRunCleanup } from "./execution-blocker.js";

/** Called with the source issue locked, as part of an authorized stranded restore.
 * This settles execution authority, without inventing external action outcomes
 * or claiming that missing workspace files have been recovered. */
export async function settleStrandedLegacyExecutions(db: Db, input: {
  companyId: string; issueId: string; recoveryActionId: string; actorId: string;
}) {
  const { companyId, issueId } = input;
  const candidates = await db.select({ action: issueRecoveryActions, run: heartbeatRuns })
    .from(issueRecoveryActions).innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
      eq(heartbeatRuns.id, canonicalExecutionUuid(sql`${issueRecoveryActions.evidence}->>'runId'`)),
    )).where(and(
      eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
      eq(issueRecoveryActions.kind, "active_run_watchdog"),
      eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
      inArray(issueRecoveryActions.status, ["active", "escalated", "resolved"]),
      sql`not (${issueRecoveryActions.evidence} ?| array['executionReconciliation', 'strandedRestoreReconciliation', 'workspaceRestoreFailure', 'workspaceRestoreRecovery', 'systemRecovery'])`,
      eq(heartbeatRuns.runtimeMode, "legacy"),
      inArray(heartbeatRuns.status, ["failed", "interrupted", "timed_out", "cancelled"]),
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`,
    )).for("update");
  const settled: string[] = [];
  for (const { action, run } of candidates) {
    if (hasWorkspaceRestoreFailure(run.resultJson) || hasRequiredWorkspaceRecovery(run.resultJson)
      || run.resultJson?.systemRecovery) continue;
    if (await hasPendingRunCleanup(db, companyId, run.id)) continue;
    const [coordinator] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
      .where(and(eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, run.id))).limit(1);
    if (coordinator) continue;
    const leases = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, run.id),
    ));
    if (leases.some(lease => !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
      || (lease.provider !== "local" && !hasRemoteTerminationReceipt(lease)))) continue;
    let stopped = true;
    // Remote PIDs belong to their sandbox; its matching termination receipt is
    // the authority check. Local or historical unleased sources use the host.
    if (!leases.length || leases.some(lease => lease.provider === "local")) {
      for (const pid of [run.processPid, run.processGroupId ? -run.processGroupId : null]) {
        if (!pid) continue;
        try { process.kill(pid, 0); stopped = false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") stopped = false; }
      }
    }
    if (!stopped) continue;
    const now = new Date();
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored",
      resolvedAt: now, updatedAt: now, wakePolicy: null, monitorPolicy: null,
      resolutionNote: "The stranded task was restored after its terminal legacy execution released provider authority.",
      evidence: { ...action.evidence, automaticRecovery: undefined, continuationDelivery: "not_requested",
        strandedRestoreReconciliation: { runId: run.id, providerStopped: true,
          recoveryActionId: input.recoveryActionId, actorId: input.actorId, recordedAt: now.toISOString() } },
    }).where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.id, action.id)));
    settled.push(action.id);
  }
  return settled;
}
