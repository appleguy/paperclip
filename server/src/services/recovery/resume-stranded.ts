import { issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Request } from "express";

export type ResumeRecoveryResolver = (input: {
  req: Request;
  companyId: string;
  agentId: string;
  issueId: string;
  actionId: string;
  pausedAt: Date | null;
}) => Promise<void>;

export function isPauseStrandedAction(input: {
  issue: { status: string; assigneeAgentId: string | null };
  action: { id: string; kind: string; cause: string; status: string; returnOwnerAgentId: string | null; evidence: Record<string, unknown>; createdAt: Date };
  agentId: string;
  actionId: string;
  pausedAt: Date | null;
}): boolean {
  const { issue, action, agentId, actionId, pausedAt } = input;
  const reason = action.evidence.assigneeInvokabilityReason;
  return !["done", "cancelled"].includes(issue.status) && issue.assigneeAgentId === agentId &&
    action.id === actionId && action.kind === "stranded_assigned_issue" &&
    action.cause === "stranded_assigned_issue" && ["active", "escalated"].includes(action.status) &&
    action.returnOwnerAgentId === agentId &&
    (reason === "paused" || (reason == null && pausedAt !== null && action.createdAt >= pausedAt));
}

export async function restorePauseStrandedIssues(input: {
  db: Db;
  companyId: string;
  agentId: string;
  pausedAt: Date | null;
  req: Request;
  resolve: ResumeRecoveryResolver;
  onError: (error: unknown, issueId: string) => void;
}) {
  const rows = await input.db.select({ issueId: issues.id, actionId: issueRecoveryActions.id })
    .from(issues)
    .innerJoin(issueRecoveryActions, and(
      eq(issueRecoveryActions.companyId, issues.companyId),
      eq(issueRecoveryActions.sourceIssueId, issues.id),
    ))
    .where(and(eq(issues.companyId, input.companyId), eq(issues.assigneeAgentId, input.agentId),
      notInArray(issues.status, ["done", "cancelled"]), eq(issueRecoveryActions.kind, "stranded_assigned_issue"),
      eq(issueRecoveryActions.cause, "stranded_assigned_issue"), inArray(issueRecoveryActions.status, ["active", "escalated"])));
  for (const row of rows) {
    try {
      await input.resolve({ req: input.req, companyId: input.companyId, agentId: input.agentId,
        issueId: row.issueId, actionId: row.actionId, pausedAt: input.pausedAt });
    } catch (error) {
      input.onError(error, row.issueId);
    }
  }
}
