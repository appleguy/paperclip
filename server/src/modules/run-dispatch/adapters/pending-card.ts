import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, issueThreadInteractions, issues } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { accessService } from "../../../services/access.js";

export async function isVerifiedPendingCardWake(db: Db, input: {
  companyId: string;
  issueId: string;
  agentId: string;
  contextSnapshot: Record<string, unknown>;
  admission?: { source: string; actorType: string | null; idempotencyKey: string | null };
  runId?: string;
  wakeupRequestId?: string | null;
}): Promise<boolean> {
  const context = input.contextSnapshot;
  const cardId = typeof context.interactionId === "string" ? context.interactionId : "";
  if (context.wakeReason !== "interaction_pending" || context.source !== "task_watchdogs.pending_interaction" ||
      context.issueId !== input.issueId || !isUuidLike(cardId)) return false;
  const key = `interaction-pending:${cardId}:board-fallback`;
  if (input.admission) {
    if (input.admission.source !== "automation" || input.admission.actorType !== "system" || input.admission.idempotencyKey !== key) return false;
  } else {
    if (!input.runId || !input.wakeupRequestId) return false;
    const [receipt] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, input.wakeupRequestId), eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.agentId, input.agentId), eq(agentWakeupRequests.runId, input.runId),
      eq(agentWakeupRequests.source, "automation"), eq(agentWakeupRequests.requestedByActorType, "system"),
      inArray(agentWakeupRequests.status, ["queued", "claimed"]),
      eq(agentWakeupRequests.idempotencyKey, key),
      sql`${agentWakeupRequests.payload}->>'interactionId' = ${cardId}`,
      sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
    )).limit(1);
    if (!receipt) return false;
  }
  const boards = await db.select({ id: agents.id }).from(agents).where(and(
    eq(agents.companyId, input.companyId), sql`lower(${agents.name}) = 'board'`,
  )).limit(2);
  if (boards.length !== 1 || boards[0].id !== input.agentId) return false;
  const [card] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions)
    .innerJoin(issues, and(eq(issues.id, issueThreadInteractions.issueId), eq(issues.companyId, issueThreadInteractions.companyId)))
    .where(and(eq(issueThreadInteractions.id, cardId), eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId), eq(issueThreadInteractions.status, "pending"),
      isNull(issueThreadInteractions.dismissedAt), isNull(issueThreadInteractions.addresseeAgentId),
      isNull(issueThreadInteractions.addresseeUserId), isNull(issues.conversationAgentId),
      isNull(issues.hiddenAt),
      notInArray(issues.status, ["done", "cancelled"]))).limit(1);
  if (!card) return false;
  return (await accessService(db).decide({
    actor: { type: "agent", agentId: input.agentId, companyId: input.companyId },
    action: "issue:read", resource: { type: "issue", companyId: input.companyId, issueId: input.issueId },
  })).allowed;
}
