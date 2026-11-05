import { notifyStatusCardIssueChange } from "./status-card-notifications.js";
import { notifyIssueRecovery } from "./issue-recovery-notifications.js";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { issueComments, type Db } from "@paperclipai/db";
import type {
  CommentAuthoringSource,
  IssueCommentAuthorType,
  SourceTrustMetadata,
} from "@paperclipai/shared";
import { commentAuthoringSourceForAuthorType, withCommentAuthoringSource } from "./source-trust.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

type WriteDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type InsertIssueCommentInput = Omit<PgInsertValue<typeof issueComments>, "authorType" | "sourceTrust"> & {
  companyId: string;
  authorType?: IssueCommentAuthorType;
  sourceTrust?: SourceTrustMetadata | null;
  commentAuthoringSource?: CommentAuthoringSource;
};

export function insertIssueComment(db: WriteDb, input: InsertIssueCommentInput) {
  const { commentAuthoringSource, ...comment } = input;
  const authorType = comment.authorType ?? (comment.authorAgentId ? "agent" : comment.authorUserId ? "user" : "system");
  const values = {
    ...comment,
    sourceTrust: withCommentAuthoringSource(
      comment.sourceTrust,
      commentAuthoringSource ?? commentAuthoringSourceForAuthorType(authorType),
    ),
  };
  return db.transaction(async tx => {
    await notifyStatusCardIssueChange(tx, comment.companyId);
    await notifyIssueRecovery(tx, { companyId: comment.companyId,
      issueId: typeof comment.issueId === "string" ? comment.issueId : undefined });
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.dotEvents, `company:${comment.companyId}`);
    return tx.insert(issueComments).values(values).returning();
  });
}
