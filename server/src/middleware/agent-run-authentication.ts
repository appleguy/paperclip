import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

export function loadAgentRunAuthentication(db: Db, input: {
  runId: string;
  companyId: string;
  agentId: string;
}) {
  return db.select({
    activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
    responsibleUserId: heartbeatRuns.responsibleUserId,
    status: heartbeatRuns.status,
    issueId: heartbeatRuns.issueId,
    nativeIssueId: heartbeatRuns.nativeIssueId,
    resultJson: sql<Record<string, unknown>>`jsonb_build_object(
      'executionCancellation', jsonb_build_object(
        'state', ${heartbeatRuns.resultJson}->'executionCancellation'->'state'
      )
    )`,
    contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
      'conversationMode', ${heartbeatRuns.contextSnapshot}->'conversationMode',
      'issueId', ${heartbeatRuns.contextSnapshot}->'issueId'
    )`,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId),
  ));
}
