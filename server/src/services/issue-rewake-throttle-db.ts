import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, heartbeatRunEvents, heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import {
  ISSUE_NEW_INPUT_ACTIVITY_ACTIONS,
  ISSUE_WAKE_DELTA_KEY,
  ISSUE_WAKE_STATE_FIELDS,
  buildIssueWakeFingerprint,
  isThrottleCandidateIssueRewake,
  shouldSuppressIssueWakeDelta,
  type IssueRewakeCandidateInput,
} from "./issue-rewake-throttle.js";

/** Used for both progress and input queries: own narration is not progress. */
export function meaningfulIssueActivity(agentId: string) {
  return and(
    inArray(activityLog.action, ISSUE_NEW_INPUT_ACTIVITY_ACTIONS),
    sql`coalesce(${activityLog.details}->>'origin', '') <> 'fast_response'`,
    or(
      ne(activityLog.action, "issue.comment_added"),
      ne(activityLog.actorType, "agent"),
      ne(activityLog.actorId, agentId),
    ),
    or(
      ne(activityLog.action, "issue.updated"),
      // Only changed business fields count. A comment-only PATCH can emit an
      // issue.updated row containing just source/identifier/resume metadata.
      sql`exists (
        select 1 from jsonb_each(coalesce(${activityLog.details}, '{}'::jsonb)) as field(key, value)
        where field.key in (${sql.join(ISSUE_WAKE_STATE_FIELDS.map(key => sql`${key}`), sql`, `)})
          and (not (${activityLog.details} ? '_previous')
            or field.value is distinct from ${activityLog.details}->'_previous'->field.key)
      )`,
    ),
  );
}

/** Runs inside the caller's existing issue-lock transaction, before any defer. */
export async function readIssueWakeDelta(db: Pick<Db, "select">, input: {
  companyId: string;
  agentId: string;
  issue: { id: string } & Record<string, unknown>;
  candidate: IssueRewakeCandidateInput;
  agentConfig: unknown;
}) {
  const { companyId, agentId, issue } = input;
  const [comment] = input.candidate.wakeCommentId
    ? await db.select({ authorAgentId: issueComments.authorAgentId }).from(issueComments).where(and(
        eq(issueComments.companyId, companyId), eq(issueComments.issueId, issue.id),
        eq(issueComments.id, input.candidate.wakeCommentId),
      )).limit(1)
    : [];
  const [delta] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue"),
    eq(activityLog.entityId, issue.id), meaningfulIssueActivity(agentId),
  )).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(1);
  const [result] = await db.select({
    status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error,
    exitCode: heartbeatRuns.exitCode, signal: heartbeatRuns.signal,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
    sql`${heartbeatRuns.finishedAt} is not null`,
  )).orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.id)).limit(1);
  const [consumed] = await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
    sql`${agentWakeupRequests.payload}->>${ISSUE_WAKE_DELTA_KEY} is not null`,
    ne(agentWakeupRequests.status, "skipped"),
  )).orderBy(desc(agentWakeupRequests.createdAt), desc(agentWakeupRequests.id)).limit(1);
  // Existing provider-trace projections record actual workspace changes.
  // A tool invocation or a text/log event alone is not a state change.
  const [work] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, heartbeatRunEvents.runId)).where(and(
      eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRuns.companyId, companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
      eq(heartbeatRunEvents.eventType, "workspace.diff.recorded"),
      sql`${heartbeatRunEvents.payload}->>'changeSetId' is not null`,
    )).orderBy(desc(heartbeatRunEvents.createdAt), desc(heartbeatRunEvents.id)).limit(1);
  const fingerprint = buildIssueWakeFingerprint({
    activity: delta?.id ?? null,
    state: Object.fromEntries(ISSUE_WAKE_STATE_FIELDS.map(key => [key, issue[key]])),
    // A new result/fault gets one recovery turn. IDs/timestamps/output chatter
    // do not turn repeated identical failures into fresh information.
    result: result ?? null,
    config: input.agentConfig,
    work: work?.payload?.changeSetId ?? null,
  });
  const candidate = (!result || result.status === "succeeded" || Boolean(result.errorCode)) && isThrottleCandidateIssueRewake({
    ...input.candidate, agentId, commentAuthorAgentId: comment?.authorAgentId ?? null,
  });
  return {
    fingerprint,
    candidate,
    hasNewDelta: Boolean(consumed && consumed.payload?.[ISSUE_WAKE_DELTA_KEY] !== fingerprint),
    blocked: shouldSuppressIssueWakeDelta({
      candidate, fingerprint,
      consumedFingerprint: typeof consumed?.payload?.[ISSUE_WAKE_DELTA_KEY] === "string"
        ? consumed.payload[ISSUE_WAKE_DELTA_KEY] as string : null,
    }),
    commentAuthorAgentId: comment?.authorAgentId ?? null,
  };
}
