import {
  activityLog, documents, heartbeatRuns, issueComments, issueDocuments, type Db,
} from "@paperclipai/db";
import { and, desc, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

/**
 * issue_monitor_due is intentionally not covered by the generic issue re-wake
 * throttle. This guard prevents no-change monitor polling from consuming a
 * whole adapter turn, while preserving explicit/manual and recovery wakes.
 */
export function monitorCoalescingLimits(env: NodeJS.ProcessEnv = process.env) {
  function duration(name: string, fallback: number) {
    const value = Number(env[name]);
    return Number.isSafeInteger(value) && value >= 1_000 && value <= 86_400_000
      ? value : fallback;
  }
  const windowMs = duration("PAPERCLIP_MONITOR_WAKE_WINDOW_MS", 5 * 60_000);
  const capMs = Math.max(windowMs, duration("PAPERCLIP_MONITOR_BACKOFF_CAP_MS", 30 * 60_000));
  return { windowMs, capMs };
}

export function monitorBackoffMs(windowMs: number, capMs: number, streak: number) {
  return Math.min(capMs, windowMs * 2 ** Math.min(20, Math.max(0, streak - 1)));
}

const ISSUE_DELTA_ACTIONS = [
  "issue.blockers_updated", "issue.document_created", "issue.document_upserted",
  "issue.document_updated", "issue.document_deleted", "issue.document_restored",
  "issue.work_product_created", "issue.work_product_updated", "issue.work_product_deleted",
  "issue.attachment_added", "issue.attachment_removed", "issue.thread_interaction_created",
  "issue.thread_interaction_answered", "issue.thread_interaction_item_verdicts_submitted",
  "issue.approval_linked", "issue.child_created",
];

/** Excludes agent's own status comments and monitor scheduling bookkeeping. */
export async function hasMeaningfulIssueDelta(
  db: Db, companyId: string, issueId: string, agentId: string, since: Date,
): Promise<boolean> {
  const [externalComments, changes, updatedDocuments] = await Promise.all([
    db.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      gt(issueComments.createdAt, since), isNull(issueComments.deletedAt),
      or(isNotNull(issueComments.authorUserId),
        and(isNotNull(issueComments.authorAgentId), sql`${issueComments.authorAgentId} <> ${agentId}`)),
    )).limit(1),
    db.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issueId), gt(activityLog.createdAt, since),
      or(
        sql`${activityLog.action} in (${sql.join(ISSUE_DELTA_ACTIONS.map(action => sql`${action}`), sql`, `)})`,
        // Only real state/assignment/content changes count. issue.updated is
        // also emitted for routine monitor bookkeeping and must not count.
        sql`${activityLog.action} = 'issue.updated' and
          (${activityLog.details}->'changes' ?| array[
            'status','assigneeAgentId','assigneeUserId','blockedByIssueIds',
            'title','description'
          ]::text[])`,
      ),
    )).limit(1),
    db.select({ id: issueDocuments.documentId }).from(issueDocuments)
      .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .where(and(eq(issueDocuments.companyId, companyId), eq(issueDocuments.issueId, issueId),
        or(gt(issueDocuments.createdAt, since), gt(documents.updatedAt, since))))
      .limit(1),
  ]);
  return externalComments.length > 0 || changes.length > 0 || updatedDocuments.length > 0;
}

export type MonitorCoalescingDecision =
  | { skip: false }
  | { skip: true; reason: "recent_issue_run" | "unchanged_issue"; delayMs: number; streak: number; lastRunId: string };

export async function evaluateMonitorCoalescing(
  db: Db, input: { companyId: string; issueId: string; agentId: string; now: Date },
): Promise<MonitorCoalescingDecision> {
  const [lastRun] = await db.select({
    id: heartbeatRuns.id, createdAt: heartbeatRuns.createdAt,
    startedAt: heartbeatRuns.startedAt,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId),
    lte(heartbeatRuns.createdAt, input.now),
    or(eq(heartbeatRuns.issueId, input.issueId),
      eq(heartbeatRuns.nativeIssueId, input.issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);

  if (!lastRun) return { skip: false };
  const limits = monitorCoalescingLimits();
  const recent = input.now.getTime() - lastRun.createdAt.getTime() < limits.windowMs;
  const changed = recent ? false : await hasMeaningfulIssueDelta(
    db, input.companyId, input.issueId, input.agentId, lastRun.startedAt ?? lastRun.createdAt,
  );
  if (!recent && changed) return { skip: false };
  const reason = recent ? "recent_issue_run" : "unchanged_issue";
  const [previous] = await db.select({ details: activityLog.details }).from(activityLog).where(and(
    eq(activityLog.companyId, input.companyId), eq(activityLog.entityType, "issue"),
    eq(activityLog.entityId, input.issueId), eq(activityLog.action, "issue.monitor_coalesced"),
  )).orderBy(desc(activityLog.createdAt)).limit(1);
  const old = previous?.details;
  const streak = old?.lastRunId === lastRun.id &&
    (old?.reason === "recent_issue_run" || old?.reason === "unchanged_issue") &&
    typeof old?.streak === "number" && Number.isSafeInteger(old.streak)
      ? Math.min(21, old.streak + 1) : 1;
  return {
    skip: true, reason, streak, lastRunId: lastRun.id,
    delayMs: monitorBackoffMs(limits.windowMs, limits.capMs, streak),
  };
}
