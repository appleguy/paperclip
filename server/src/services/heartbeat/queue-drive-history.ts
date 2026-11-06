import { agentWakeupRequests, chatActions, heartbeatRuns, type Db } from "@paperclipai/db";
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { CHAT_CONTROL_RECOVERY_STOP_CODE, CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE, readChatControlRecoveryStop } from "../chat-control-recovery-stop.js";

export const QUEUE_DRIVE_HISTORY_HOLD_CODE = "queue_drive_recovery_hold";

/** A completed automatic successor cannot authorize a new attempt after a stop. */
export async function hasQueueDriveRecoveryHold(db: Db, scope: { companyId: string; agentId: string; issueId: string }) {
  const [stop] = await db.select({ finishedAt: heartbeatRuns.finishedAt }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId),
    isNotNull(heartbeatRuns.finishedAt),
    sql`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.nativeIssueId}::text,
      ${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId') = ${scope.issueId}`,
    sql`(${heartbeatRuns.errorCode} in (${CHAT_CONTROL_RECOVERY_STOP_CODE}, ${CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE}, ${QUEUE_DRIVE_HISTORY_HOLD_CODE}, 'process_lost')
      or (${heartbeatRuns.status} = 'cancelled' and (
        ${heartbeatRuns.errorCode} = 'operator_interrupted'
        or ${heartbeatRuns.resultJson}->>'cancelledByActorType' in ('user', 'board', 'agent')
        or (coalesce(${heartbeatRuns.resultJson}->>'cancelledByActorType', '') <> 'system'
          and (${heartbeatRuns.errorCode} is null or ${heartbeatRuns.errorCode} = 'cancelled')))))`,
  )).orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.id)).limit(1);
  if (!stop?.finishedAt) return false;

  // Only a durable, admitted user cause can reset the hold. System assignment
  // wakes and their successors are never evidence of a fresh request.
  const wakes = await db.select({ wake: agentWakeupRequests, actionId: chatActions.id }).from(agentWakeupRequests)
    .leftJoin(chatActions, and(eq(chatActions.id, agentWakeupRequests.id), eq(chatActions.companyId, scope.companyId)))
    .where(and(eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.agentId, scope.agentId),
      gt(agentWakeupRequests.requestedAt, stop.finishedAt), isNotNull(agentWakeupRequests.runId),
      inArray(agentWakeupRequests.status, ["claimed", "completed", "failed", "coalesced"]),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${scope.issueId}`));
  for (const { wake, actionId } of wakes) {
    if (!wake.runId) continue;
    const [run] = await db.select({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, wake.runId), eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId),
      sql`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.nativeIssueId}::text,
        ${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId') = ${scope.issueId}`,
    )).limit(1);
    if (!run) continue;
    if (!actionId && wake.requestedByActorType === "user" && wake.requestedByActorId) return false;
    if (actionId && run.wakeupRequestId === wake.id &&
        (await readChatControlRecoveryStop(db, { ...scope, sourceRunId: run.id })).kind === "clear") return false;
  }
  return true;
}
