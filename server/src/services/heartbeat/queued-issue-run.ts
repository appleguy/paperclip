import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

// The caller holds the issue row lock until its lookup and write commit. A parked
// scheduled retry counts: it promotes to queued later and would duplicate the wake.
export async function findQueuedIssueRun(db: Db, companyId: string, agentId: string, issueId: string) {
  return db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
    inArray(heartbeatRuns.status, ["queued", "scheduled_retry"]), isNull(heartbeatRuns.startedAt),
    sql`coalesce(nullif(${heartbeatRuns.contextSnapshot}->>'issueId', ''), nullif(${heartbeatRuns.contextSnapshot}->>'taskId', ''), ${heartbeatRuns.issueId}::text) = ${issueId}`,
  )).orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id)).limit(1).for("update").then(rows => rows[0] ?? null);
}

export function coalescedWakeContext(context: Record<string, unknown> | null, reason: string) {
  const existing = context ?? {};
  const reasons = Array.isArray(existing.coalescedWakeReasons)
    ? existing.coalescedWakeReasons.filter((value): value is string => typeof value === "string") : [];
  const initial = typeof existing.wakeReason === "string" ? [existing.wakeReason] : [];
  return { ...existing, coalescedWakeReasons: [...new Set([...initial, ...reasons, reason])] };
}
