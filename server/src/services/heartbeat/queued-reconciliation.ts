import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { queuedCommentIdsFromRunContext } from "../issue-queued-comment-queue.js";
import { notifyChatRunMilestones } from "../chat-run-milestone-notifications.js";
import { notifyInstructionCollection } from "../instruction-collection-notifications.js";
import { notifyExternalAgentSettlement } from "../../modules/external-agents/index.js";
import { notifyCancelledWorkspacePreservation } from "../cancelled-workspace-preservation-notifications.js";
import { notifyExecutionRunWork } from "../execution-control-notifications.js";
import { notifyUnsafeWorkspaceExportRunChange } from "../unsafe-workspace-export-notifications.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Receipt = typeof agentWakeupRequests.$inferSelect;
export type QueuedReceiptDecision =
  | { kind: "ready" }
  | { kind: "held"; reason: string }
  | { kind: "superseded"; reason: string };

function issueId(run: Run) {
  return run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId ?? null;
}

function commentIds(run: Run) {
  return [...new Set([...queuedCommentIdsFromRunContext(run.contextSnapshot),
    run.contextSnapshot?.commentId, run.contextSnapshot?.wakeCommentId,
  ].filter((id): id is string => typeof id === "string" && Boolean(id)))];
}

/** Age and local process absence are deliberately not execution evidence. */
export function decideQueuedReceipt(run: Run, receipt: Receipt | null, target: Run | null): QueuedReceiptDecision {
  if (!run.wakeupRequestId) return { kind: "ready" }; // Historical/direct runs have no wake receipt.
  if (!receipt || receipt.companyId !== run.companyId || receipt.agentId !== run.agentId)
    return { kind: "held", reason: "Wake receipt is missing or outside this run's scope; reconcile the saved wake before dispatch." };
  if (receipt.runId && receipt.runId !== run.id) {
    if (run.startedAt || run.processStartedAt || run.runtimeModeResolvedAt)
      return { kind: "held", reason: "This attempt may have started; reconcile its execution effects before retiring it." };
    if (!target || target.companyId !== run.companyId || target.agentId !== run.agentId ||
        target.responsibleUserId !== run.responsibleUserId || issueId(target) !== issueId(run))
      return { kind: "held", reason: "Wake points to an unverified execution; preserve it until its owner is reconciled." };
    const sourceIds = commentIds(run);
    const targetIds = new Set(commentIds(target));
    // Unknown context fields may carry a separate owner answer or delivery
    // contract. Require coverage instead of guessing which fields are intent.
    const sameContext = Object.entries(run.contextSnapshot ?? {}).every(([key, value]) =>
      ["wakeCommentIds", "commentId", "wakeCommentId"].includes(key) ||
      JSON.stringify(value) === JSON.stringify(target.contextSnapshot?.[key]));
    const covered = sameContext && sourceIds.every(id => targetIds.has(id)) &&
      (target.wakeupRequestId === receipt.id || (sourceIds.length > 0 && receipt.status === "coalesced"));
    return covered
      ? { kind: "superseded", reason: `Saved wake is already bound to execution ${target.id.slice(0, 8)}; do not dispatch it twice.` }
      : { kind: "held", reason: "Another execution owns the receipt, but coverage of this run's distinct input is unverified; preserve both." };
  }
  if (receipt.status === "queued" || (receipt.status === "claimed" && (run.startedAt || !receipt.runId)))
    return { kind: "ready" };
  return { kind: "held", reason: `Wake receipt is ${receipt.status}; verify delivery or settlement before dispatching saved input.` };
}

/** Same lock order as queue edits/claims: issue, wake, run. No provider work. */
export async function reconcileQueuedReceipt(db: Db, candidate: Run) {
  if (!candidate.wakeupRequestId) return { kind: "ready" as const, run: candidate };
  return db.transaction(async tx => {
    const taskId = issueId(candidate);
    if (typeof taskId === "string") await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, taskId), eq(issues.companyId, candidate.companyId))).for("update");
    const [receipt] = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, candidate.wakeupRequestId!), eq(agentWakeupRequests.companyId, candidate.companyId),
      eq(agentWakeupRequests.agentId, candidate.agentId),
    )).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, candidate.id), eq(heartbeatRuns.companyId, candidate.companyId), eq(heartbeatRuns.status, "queued"),
    )).for("update");
    if (!run) return { kind: "changed" as const, run: null };
    const [target] = receipt?.runId && receipt.runId !== run.id
      ? await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, receipt.runId), eq(heartbeatRuns.companyId, run.companyId))) : [];
    const decision = decideQueuedReceipt(run, receipt ?? null, target ?? null);
    if (decision.kind === "held") await tx.update(heartbeatRuns).set({
      nextAction: `Queued: receipt reconciliation. ${decision.reason}`,
    }).where(eq(heartbeatRuns.id, run.id));
    if (decision.kind === "superseded") {
      // Retire only this never-started shadow, atomically with the receipt
      // evidence. The authoritative receipt and execution are left untouched.
      await notifyChatRunMilestones(tx, { companyId: run.companyId, runId: run.id });
      await notifyInstructionCollection(tx, { companyId: run.companyId, runId: run.id });
      await notifyExternalAgentSettlement(tx, { companyId: run.companyId, runId: run.id });
      await notifyCancelledWorkspacePreservation(tx, { companyId: run.companyId, runId: run.id });
      await notifyExecutionRunWork(tx, { companyId: run.companyId, agentId: run.agentId, runId: run.id });
      await notifyUnsafeWorkspaceExportRunChange(tx, run);
      const [retired] = await tx.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
        errorCode: "queued_wake_superseded", error: decision.reason, nextAction: decision.reason, updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, run.id)).returning();
      return { ...decision, run: retired };
    }
    return { ...decision, run };
  });
}

export async function recordQueuedReason(db: Db, run: Pick<Run, "id" | "companyId">, reason: string) {
  const nextAction = `Queued: ${reason}`;
  await db.update(heartbeatRuns).set({ nextAction }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.status, "queued"),
    sql`(${heartbeatRuns.nextAction} is null or ${heartbeatRuns.nextAction} not like 'Queued: receipt reconciliation.%')`,
  ));
}
