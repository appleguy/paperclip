import { issueRecoveryActions, type Db } from "@paperclipai/db";
import type { IssueRecoveryAction, IssueRecoveryActionOutcome } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { notFound } from "../../errors.js";
import { issueRecoveryActionReadModel, issueRecoveryActionService } from "../issue-recovery-actions.js";
import { settleStrandedLegacyExecutions } from "../stranded-execution-recovery.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function resolveRecoveryAction(input: {
  db: Db;
  tx: Transaction;
  issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null };
  action: IssueRecoveryAction;
  status: "resolved" | "cancelled";
  outcome: IssueRecoveryActionOutcome;
  resolutionNote: string | null;
  actorId: string;
  strandedRestore: boolean;
  chatRetry: boolean;
}) {
  const { db, tx, issue, action } = input;
  const settledLegacyActionIds = input.strandedRestore
    ? await settleStrandedLegacyExecutions(tx as unknown as Db, { companyId: issue.companyId,
      issueId: issue.id, recoveryActionId: action.id, actorId: input.actorId }) : [];
  let recoveryAction = await issueRecoveryActionService(db).resolveActiveForIssue({
    companyId: issue.companyId, sourceIssueId: issue.id, actionId: action.id,
    status: input.status, outcome: input.outcome, resolutionNote: input.resolutionNote,
  }, tx);
  if (!recoveryAction) throw notFound("Active recovery action not found");
  if (input.strandedRestore && !input.chatRetry) {
    const [updated] = await tx.update(issueRecoveryActions).set({ evidence: {
      ...recoveryAction.evidence, continuationDelivery: "pending",
      strandedRestoreDelivery: { settledLegacyActionIds, actorId: input.actorId },
    } }).where(eq(issueRecoveryActions.id, recoveryAction.id)).returning();
    recoveryAction = issueRecoveryActionReadModel(updated!);
  }
  return recoveryAction;
}
