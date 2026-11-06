import { agentWakeupRequests, chatActions, chatConversations, chatPublications, heartbeatRuns, type Db } from "@paperclipai/db";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { CHAT_CONTROL_RECOVERY_STOP_CODE, CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE, readChatControlRecoveryStop } from "../chat-control-recovery-stop.js";

export const QUEUE_DRIVE_HISTORY_HOLD_CODE = "queue_drive_recovery_hold";

/** A completed automatic successor cannot authorize a new attempt after a stop. */
export async function hasQueueDriveRecoveryHold(db: Db, scope: { companyId: string; agentId: string; issueId: string }, lockConversation = false) {
  // A user Stop commits its issue-locked intent before provider termination.
  // Do not admit an automatic successor during that settlement window.
  const [pendingStop] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId),
    inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
    sql`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.nativeIssueId}::text,
      ${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId') = ${scope.issueId}`,
    sql`${heartbeatRuns.resultJson}->>'cancelledByActorType' = 'user'`,
    sql`${heartbeatRuns.resultJson} #>> '{executionCancellation,state}' = 'requested'`,
  )).limit(1);
  if (pendingStop) return true;
  const [stop] = await db.select({ finishedAt: sql<string>`${heartbeatRuns.finishedAt}::text` }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId),
    isNotNull(heartbeatRuns.finishedAt),
    sql`${heartbeatRuns.errorCode} is distinct from ${QUEUE_DRIVE_HISTORY_HOLD_CODE}`,
    sql`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.nativeIssueId}::text,
      ${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId') = ${scope.issueId}`,
    sql`(${heartbeatRuns.errorCode} in (${CHAT_CONTROL_RECOVERY_STOP_CODE}, ${CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE})
      or (${heartbeatRuns.errorCode} = 'process_lost' and
        (coalesce(${heartbeatRuns.processLossRetryCount}, 0) >= 1
          or not exists (select 1 from heartbeat_runs retry
            where retry.retry_of_run_id = ${heartbeatRuns.id} and retry.company_id = ${heartbeatRuns.companyId}
              and retry.agent_id = ${heartbeatRuns.agentId} and retry.status = 'succeeded')))
      or (${heartbeatRuns.status} = 'cancelled' and (
        ${heartbeatRuns.errorCode} = 'operator_interrupted'
        or ${heartbeatRuns.resultJson}->>'cancelledByActorType' in ('user', 'board', 'agent')
        or (coalesce(${heartbeatRuns.resultJson}->>'cancelledByActorType', '') <> 'system'
          and (${heartbeatRuns.errorCode} is null or ${heartbeatRuns.errorCode} = 'cancelled')))))`,
  )).orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.id)).limit(1);
  const boundaries: string[] = stop?.finishedAt ? [stop.finishedAt] : [];
  // A published close can exist before any automatic successor is stopped.
  // Reuse the chat gate's source and publication proof rather than inferring
  // authority from a run's context or from a newer automatic wake.
  const [chatRun] = await db.select({ id: heartbeatRuns.id, conversationId: chatActions.conversationId, createdAt: sql<string>`${chatActions.createdAt}::text` }).from(heartbeatRuns)
    .innerJoin(chatActions, and(eq(chatActions.id, heartbeatRuns.wakeupRequestId),
      eq(chatActions.companyId, scope.companyId), inArray(chatActions.kind, ["inbound_wakeup", "failed_run_retry"])))
    .where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId),
      sql`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.nativeIssueId}::text,
        ${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId') = ${scope.issueId}`))
    .orderBy(desc(chatActions.createdAt), desc(chatActions.id)).limit(1);
  if (chatRun) {
    // The proof reader can return unresolved before taking the conversation
    // lock. Serialize that path with the actual close publication writer too.
    if (lockConversation && chatRun.conversationId) await db.select({ id: chatConversations.id }).from(chatConversations)
      .where(and(eq(chatConversations.id, chatRun.conversationId), eq(chatConversations.companyId, scope.companyId)))
      .for("update", { noWait: true });
    // Date coalesced Board causes against the publication below; an older
    // coalesced cause cannot authorize work after a later close.
    const proof = await readChatControlRecoveryStop(db, { ...scope, sourceRunId: chatRun.id }, lockConversation, true);
    if (proof.kind === "stopped") {
      const [publication] = await db.select({ publishedAt: sql<string>`${chatPublications.publishedAt}::text` }).from(chatPublications).where(and(
        eq(chatPublications.companyId, scope.companyId), eq(chatPublications.id, proof.publicationId),
      )).limit(1);
      if (!publication?.publishedAt) return true;
      // PostgreSQL text timestamps retain microseconds; compare each boundary
      // in SQL below instead of rounding through JavaScript Date.
      boundaries.push(publication.publishedAt);
    } else if (proof.kind === "unresolved") {
      // Even an unverified published close is a conservative lower bound on a
      // fresh cause. Do not let an earlier Board wake mask a later close when
      // the inbound proof is incomplete.
      boundaries.push(chatRun.createdAt);
      if (chatRun.conversationId) {
        const [publication] = await db.select({ publishedAt: sql<string | null>`max(${chatPublications.publishedAt})::text` })
          .from(chatPublications).where(and(eq(chatPublications.companyId, scope.companyId),
            eq(chatPublications.issueId, scope.issueId), eq(chatPublications.conversationId, chatRun.conversationId),
            eq(chatPublications.state, "published"), sql`${chatPublications.idempotencyKey} ~ '^control:(close|new):'`));
        if (publication?.publishedAt) boundaries.push(publication.publishedAt);
      }
    }
  }
  if (!boundaries.length) return false;

  // Only a durable, admitted user cause can reset the hold. System assignment
  // wakes and their successors are never evidence of a fresh request.
  const wakes = await db.select({ wake: agentWakeupRequests, actionId: chatActions.id }).from(agentWakeupRequests)
    .leftJoin(chatActions, and(eq(chatActions.id, agentWakeupRequests.id), eq(chatActions.companyId, scope.companyId)))
    .where(and(eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.agentId, scope.agentId),
      ...boundaries.map(boundary => sql`${agentWakeupRequests.requestedAt} > ${boundary}::timestamptz`), isNotNull(agentWakeupRequests.runId),
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
    if (actionId && run.wakeupRequestId && (wake.id === run.wakeupRequestId ||
        (wake.status === "coalesced" && wake.payload?.coalescedIntoWakeupRequestId === run.wakeupRequestId))) {
      // The chat proof validates all coalesced inbound sources when the run's
      // own wake is a chat action; an unrelated automatic owner is not proof.
      const [owner] = await db.select({ id: chatActions.id }).from(chatActions).where(and(
        eq(chatActions.id, run.wakeupRequestId), eq(chatActions.companyId, scope.companyId),
        inArray(chatActions.kind, ["inbound_wakeup", "failed_run_retry"]),
      )).limit(1);
      if (owner && (await readChatControlRecoveryStop(db, { ...scope, sourceRunId: run.id })).kind === "clear") return false;
    }
  }
  return true;
}
