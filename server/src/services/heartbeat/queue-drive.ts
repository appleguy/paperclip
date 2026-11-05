import {
  agentWakeupRequests, approvals, companies, heartbeatRuns, issueApprovals,
  issueThreadInteractions, issues, type Db,
} from "@paperclipai/db";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { executionIssueCondition } from "../issue-visibility.js";
import { getExecutionBlocker, hasPendingRunCleanup } from "../execution-blocker.js";
import type { HeartbeatQueueDependencies, createHeartbeatQueue } from "./queue.js";

export const QUEUE_DRIVE_WAKE_REASON = "issue_queue_drive";
const COMPLETED_STATUSES = ["succeeded", "failed", "timed_out"];
const FAILURE_STATUSES = new Set(["failed", "timed_out"]);

interface QueueDriveDependencies extends Pick<HeartbeatQueueDependencies,
  "getAgent" | "getAgentInvokability" | "getSchedulingSuppression" | "getWorktreeExecutionCutoff"> {
  issuesSvc: Pick<HeartbeatQueueDependencies["issuesSvc"], "listDependencyReadiness">;
  treeControlSvc: HeartbeatQueueDependencies["treeControlSvc"];
  enqueueWakeup: ReturnType<typeof createHeartbeatQueue>["enqueueWakeup"];
}

/** Completion-driven admission only: no timer, new queue, or provider execution path. */
export function createHeartbeatQueueDrive(db: Db, deps: QueueDriveDependencies) {
  async function wakeNextAssignedIssueAfterRun(source: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId">) {
    if ((await deps.getSchedulingSuppression()).suppressed) return null;

    // Admission atomically debounces the completion receipt in its own transaction.
    const [run] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, source.id), eq(heartbeatRuns.companyId, source.companyId),
      eq(heartbeatRuns.agentId, source.agentId),
    ));
    if (!run || !COMPLETED_STATUSES.includes(run.status) || !run.finishedAt ||
        (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) ||
        await hasPendingRunCleanup(db, source.companyId, source.id)) return null;

    const agent = await deps.getAgent(source.agentId);
    if (!agent || agent.companyId !== source.companyId ||
        !(await deps.getAgentInvokability(agent)).invokable ||
        (await deps.getSchedulingSuppression()).suppressed) return null;
    const [company] = await db.select({ id: companies.id }).from(companies)
      .where(and(eq(companies.id, source.companyId), eq(companies.status, "active")));
    if (!company) return null;

    const receiptPrefix = `queue-drive:${source.id}:`;
    const receipts = await db.select({ key: agentWakeupRequests.idempotencyKey, status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, source.companyId), eq(agentWakeupRequests.agentId, source.agentId),
        sql`starts_with(${agentWakeupRequests.idempotencyKey}, ${receiptPrefix})`,
      ));
    if (receipts.some(receipt => receipt.status !== "skipped")) return null;
    const attempted = new Set(receipts.map(receipt => receipt.key));
    const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, source.companyId), eq(heartbeatRuns.agentId, source.agentId),
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
    )).limit(1);
    if (active) return null; // Existing queued work and bounded retries own the next turn.

    const cutoff = await deps.getWorktreeExecutionCutoff();
    const candidates = await db.select({ id: issues.id, statusVersion: issues.statusVersion }).from(issues).where(and(
      eq(issues.companyId, source.companyId), eq(issues.assigneeAgentId, source.agentId),
      isNull(issues.assigneeUserId), executionIssueCondition(), inArray(issues.status, ["todo", "in_progress"]),
      cutoff ? gte(issues.createdAt, cutoff) : undefined,
      // Confirmations and approvals gate work; an unanswered question alone does not.
      sql`not exists (select 1 from ${issueThreadInteractions} where
        ${issueThreadInteractions.companyId} = ${issues.companyId} and ${issueThreadInteractions.issueId} = ${issues.id}
        and ${issueThreadInteractions.status} = 'pending' and ${issueThreadInteractions.dismissedAt} is null
        and ${issueThreadInteractions.kind} = 'request_confirmation')`,
      sql`not exists (select 1 from ${issueApprovals} join ${approvals} on ${approvals.id} = ${issueApprovals.approvalId}
        where ${issueApprovals.companyId} = ${issues.companyId} and ${issueApprovals.issueId} = ${issues.id}
        and ${approvals.status} in ('pending', 'revision_requested'))`,
    )).orderBy(sql`case ${issues.priority} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`,
      asc(issues.createdAt), asc(issues.id));
    if (!candidates.length) return null;
    const readiness = await deps.issuesSvc.listDependencyReadiness(source.companyId, candidates.map(issue => issue.id));
    for (const issue of candidates) {
      const receiptKey = `${receiptPrefix}${issue.id}`;
      if (attempted.has(receiptKey) || readiness.get(issue.id)?.isDependencyReady === false ||
          await deps.treeControlSvc.getActivePauseHoldGate(source.companyId, issue.id) ||
          await getExecutionBlocker(db, source.companyId, issue.id)) continue;
      // Per-issue history prevents alternating failing issues from resetting each other's bound.
      // A successful explicit/event-driven attempt resets the streak; other issues do not.
      const recent = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, source.companyId), eq(heartbeatRuns.agentId, source.agentId),
        inArray(heartbeatRuns.status, COMPLETED_STATUSES),
        sql`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.nativeIssueId}::text,
          ${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId') = ${issue.id}`,
      )).orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(2);
      if (recent.length === 2 && recent.every(row => FAILURE_STATUSES.has(row.status))) continue;

      const admittedRun = await deps.enqueueWakeup(source.agentId, {
        source: "assignment", triggerDetail: "system", reason: QUEUE_DRIVE_WAKE_REASON,
        requestedByActorType: "system", requestedByActorId: "heartbeat_queue_drive",
        idempotencyKey: receiptKey,
        payload: { issueId: issue.id },
        contextSnapshot: { issueId: issue.id, source: "heartbeat.queue_drive", completedRunId: source.id },
        issueStateGuard: { assigneeAgentId: source.agentId, statuses: ["todo", "in_progress"], statusVersion: issue.statusVersion },
      });
      if (admittedRun) return admittedRun;
      const [receipt] = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, source.companyId), eq(agentWakeupRequests.agentId, source.agentId),
        sql`starts_with(${agentWakeupRequests.idempotencyKey}, ${receiptPrefix})`,
        sql`${agentWakeupRequests.status} <> 'skipped'`,
      )).limit(1);
      if (receipt) return null; // Admission retained a queued/deferred continuation.
      // A refusal (for example the existing no-progress cooldown) must not starve other work.
    }
    return null;
  }
  return { wakeNextAssignedIssueAfterRun };
}
