import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
  documentRevisions,
  documents,
  type Db,
  issueComments,
  issueDocuments,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import { documentAnnotationService } from "../services/document-annotations.js";
import { documentService } from "../services/documents.js";
import { logActivity, type ActivityPublication } from "../services/activity-log.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { issueReferenceService } from "../services/issue-references.js";
import { ownerCommentIntakeService, OWNER_COMMENT_INTAKE_BACKFILL_FROM, parseOwnerCommentIntakeBackfillFrom } from "../services/owner-comment-intake.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping owner-comment intake tests: ${embeddedPostgresSupport.reason ?? "embedded Postgres unavailable"}`);
}

describe("owner-comment intake backfill boundary", () => {
  it("defaults to the bounded lower limit and rejects configuration that widens history", () => {
    expect(parseOwnerCommentIntakeBackfillFrom(undefined).toISOString()).toBe("2026-10-29T02:30:00.000Z");
    expect(parseOwnerCommentIntakeBackfillFrom("2026-10-29T01:00:00.000Z").toISOString()).toBe("2026-10-29T02:30:00.000Z");
    expect(parseOwnerCommentIntakeBackfillFrom("2026-10-29T05:00:00.000Z").toISOString()).toBe("2026-10-29T05:00:00.000Z");
  });
});

describeEmbeddedPostgres("owner-comment intake reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let temporaryDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const ownerUserId = `owner-${randomUUID()}`;
  const assigneeAgentId = randomUUID();
  const issueId = randomUUID();
  const issueIdentifier = `INT-${companyId.replace(/-/g, "").slice(0, 8).toUpperCase()}-1`;
  let now = new Date("2026-10-30T03:00:00.000Z");
  let wakeupCalls: Array<{ agentId: string; input: Record<string, any> }> = [];

  beforeAll(async () => {
    temporaryDb = await startEmbeddedPostgresTestDatabase("paperclip-owner-comment-intake-");
    db = createDb(temporaryDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(documentAnnotationAnchorSnapshots);
    await db.delete(documentAnnotationComments);
    await db.delete(documentAnnotationThreads);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(issueWorkProducts);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    now = new Date("2026-10-30T03:00:00.000Z");
    wakeupCalls = [];
  });

  afterAll(async () => { await temporaryDb?.cleanup(); });

  it("reproduces the source/activity crash window for a committed annotation", async () => {
    await db.insert(companies).values({ id: companyId, name: "Intake fixture", issuePrefix: `INT${companyId.slice(0, 5).toUpperCase()}` });
    await db.insert(agents).values({ id: assigneeAgentId, companyId, name: "Assignee", role: "engineer", status: "idle", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, identifier: issueIdentifier, title: "Intake fixture", status: "in_progress", assigneeAgentId });

    const document = (await documentService(db).upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "Alpha selected text omega",
    })).document;
    const thread = await documentAnnotationService(db).createThread(
      issueId,
      "plan",
      annotationInput(document.latestRevisionId!, document.latestRevisionNumber),
      { actorType: "user", actorId: ownerUserId, userId: ownerUserId },
    );
    const sourceCommentId = thread.comments[0]!.id;

    // The route calls logActivity only after createThread has committed. Model a process
    // failure at that boundary by deliberately omitting the later activity write.
    expect(await db.select().from(documentAnnotationComments).where(eq(documentAnnotationComments.id, sourceCommentId))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).toHaveLength(0);

    const intake = ownerCommentIntakeService(db, {
      wakeup: async (_agentId, input) => {
        wakeupCalls.push({ agentId: _agentId, input });
        return { id: randomUUID() } as any;
      },
      initialBackfillFrom: new Date(OWNER_COMMENT_INTAKE_BACKFILL_FROM),
      now: () => now,
    });
    await intake.sweepPending();

    expect(await intake.getDisposition(companyId, "document_annotation", sourceCommentId)).toBeNull();
    expect(wakeupCalls).toHaveLength(0);
  });

  it("keeps annotation creation and replies atomic with intake activity and recovers once across duplicates and restart", async () => {
    now = new Date(Date.now() + 60_000);
    await db.insert(companies).values({ id: companyId, name: "Intake fixture", issuePrefix: `INT${companyId.slice(0, 5).toUpperCase()}` });
    await db.insert(agents).values({ id: assigneeAgentId, companyId, name: "Assignee", role: "engineer", status: "idle", adapterType: "codex_local" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerUserId, status: "active", membershipRole: "owner" });
    await db.insert(issues).values({ id: issueId, companyId, identifier: issueIdentifier, title: "Intake fixture", status: "in_progress", assigneeAgentId });
    const document = (await documentService(db).upsertIssueDocument({
      issueId, key: "plan", title: "Plan", format: "markdown", body: "Alpha selected text omega",
    })).document;
    const annotations = documentAnnotationService(db);
    const references = issueReferenceService(db);
    const settled = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.ownerCommentIntake, settled);
    const publications: ActivityPublication[] = [];
    const wakeup = async (agentId: string, input: Record<string, any>) => {
      wakeupCalls.push({ agentId, input });
      const [wake] = await db.insert(agentWakeupRequests).values({
        companyId, agentId, source: input.source, triggerDetail: input.triggerDetail, reason: input.reason,
        payload: input.payload, requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId, idempotencyKey: input.idempotencyKey, status: "queued",
      }).returning();
      return wake;
    };
    const intake = ownerCommentIntakeService(db, {
      wakeup,
      initialBackfillFrom: new Date(OWNER_COMMENT_INTAKE_BACKFILL_FROM),
      now: () => now,
    });

    try {
      await expect(db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const thread = await annotations.createThread(
          issueId, "plan", annotationInput(document.latestRevisionId!, document.latestRevisionNumber),
          { actorType: "user", actorId: ownerUserId, userId: ownerUserId }, txDb,
        );
        const comment = thread.comments[0]!;
        await references.syncAnnotationComment(comment.id, txDb);
        await logActivity(txDb, {
          companyId, actorType: "user", actorId: ownerUserId,
          action: "issue.document_annotation_thread_created", entityType: "issue", entityId: issueId,
          details: { key: "plan", documentKey: "plan", documentId: thread.documentId, threadId: thread.id, commentId: comment.id },
        }, publications);
        throw new Error("injected before outer commit");
      })).rejects.toThrow("injected before outer commit");

      expect(await db.select().from(documentAnnotationComments).where(eq(documentAnnotationComments.companyId, companyId))).toHaveLength(0);
      expect(await db.select().from(documentAnnotationThreads).where(eq(documentAnnotationThreads.companyId, companyId))).toHaveLength(0);
      expect(await db.select().from(activityLog).where(and(
        eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.document_annotation_thread_created"),
      ))).toHaveLength(0);
      await intake.sweepPending();
      expect(wakeupCalls).toHaveLength(0);

      const createdAtNotifications = settled.mock.calls.length;
      let threadId = "";
      let threadCommentId = "";
      const createPublications: ActivityPublication[] = [];
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const referenceSummaryBefore = await references.listIssueReferenceSummary(issueId, txDb);
        const thread = await annotations.createThread(
          issueId, "plan", annotationInput(document.latestRevisionId!, document.latestRevisionNumber),
          { actorType: "user", actorId: ownerUserId, userId: ownerUserId }, txDb,
        );
        const comment = thread.comments[0]!;
        threadId = thread.id;
        threadCommentId = comment.id;
        await references.syncAnnotationComment(comment.id, txDb);
        const referenceSummaryAfter = await references.listIssueReferenceSummary(issueId, txDb);
        const referenceDiff = references.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
        await logActivity(txDb, {
          companyId, actorType: "user", actorId: ownerUserId,
          action: "issue.document_annotation_thread_created", entityType: "issue", entityId: issueId,
          details: {
            key: thread.documentKey, documentKey: thread.documentKey, documentId: thread.documentId,
            threadId: thread.id, commentId: comment.id,
            addedReferencedIssues: referenceDiff.addedReferencedIssues,
            removedReferencedIssues: referenceDiff.removedReferencedIssues,
            currentReferencedIssues: referenceDiff.currentReferencedIssues,
          },
        }, createPublications);
      });
      expect(settled).toHaveBeenCalledTimes(createdAtNotifications + 1);
      expect(createPublications).toHaveLength(1);
      expect(await db.select().from(documentAnnotationComments).where(eq(documentAnnotationComments.id, threadCommentId))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(and(
        eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.document_annotation_thread_created"),
      ))).toHaveLength(1);
      await intake.sweepPending();
      expect(wakeupCalls).toHaveLength(1);

      const replyInput = { body: "Please also check this reply." };
      await expect(db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const comment = await annotations.addComment(
          issueId, "plan", threadId, replyInput,
          { actorType: "user", actorId: ownerUserId, userId: ownerUserId }, txDb,
        );
        await references.syncAnnotationComment(comment.id, txDb);
        await logActivity(txDb, {
          companyId, actorType: "user", actorId: ownerUserId,
          action: "issue.document_annotation_comment_added", entityType: "issue", entityId: issueId,
          details: { key: "plan", documentKey: "plan", threadId: comment.threadId, commentId: comment.id },
        }, publications);
        throw new Error("injected before reply commit");
      })).rejects.toThrow("injected before reply commit");
      expect(await db.select().from(documentAnnotationComments).where(eq(documentAnnotationComments.threadId, threadId))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(and(
        eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.document_annotation_comment_added"),
      ))).toHaveLength(0);

      const replyNotifications = settled.mock.calls.length;
      let replyCommentId = "";
      const replyPublications: ActivityPublication[] = [];
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const referenceSummaryBefore = await references.listIssueReferenceSummary(issueId, txDb);
        const comment = await annotations.addComment(
          issueId, "plan", threadId, replyInput,
          { actorType: "user", actorId: ownerUserId, userId: ownerUserId }, txDb,
        );
        replyCommentId = comment.id;
        await references.syncAnnotationComment(comment.id, txDb);
        const referenceSummaryAfter = await references.listIssueReferenceSummary(issueId, txDb);
        const referenceDiff = references.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
        await logActivity(txDb, {
          companyId, actorType: "user", actorId: ownerUserId,
          action: "issue.document_annotation_comment_added", entityType: "issue", entityId: issueId,
          details: {
            key: "plan", documentKey: "plan", threadId: comment.threadId, commentId: comment.id,
            addedReferencedIssues: referenceDiff.addedReferencedIssues,
            removedReferencedIssues: referenceDiff.removedReferencedIssues,
            currentReferencedIssues: referenceDiff.currentReferencedIssues,
          },
        }, replyPublications);
      });
      expect(settled).toHaveBeenCalledTimes(replyNotifications + 1);
      expect(replyPublications).toHaveLength(1);
      expect(await db.select().from(documentAnnotationComments).where(eq(documentAnnotationComments.id, replyCommentId))).toHaveLength(1);
      await intake.sweepPending();
      expect(wakeupCalls).toHaveLength(2);

      const duplicateActivityInput = {
        companyId, actorType: "user" as const, actorId: ownerUserId,
        entityType: "issue", entityId: issueId,
      };
      await logActivity(db, {
        ...duplicateActivityInput, action: "issue.document_annotation_thread_created",
        details: { key: "plan", documentKey: "plan", threadId, commentId: threadCommentId },
      });
      await logActivity(db, {
        ...duplicateActivityInput, action: "issue.document_annotation_comment_added",
        details: { key: "plan", documentKey: "plan", threadId, commentId: replyCommentId },
      });
      const restarted = ownerCommentIntakeService(db, {
        wakeup,
        initialBackfillFrom: new Date(OWNER_COMMENT_INTAKE_BACKFILL_FROM),
        now: () => now,
      });
      await restarted.sweepPending();
      await restarted.sweepPending();
      expect(wakeupCalls).toHaveLength(2);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(2);
      expect((await restarted.getDisposition(companyId, "document_annotation", threadCommentId))?.details).toMatchObject({ status: "routed", sourceTrust: null });
      expect((await restarted.getDisposition(companyId, "document_annotation", replyCommentId))?.details).toMatchObject({ status: "routed", sourceTrust: null });
    } finally {
      unsubscribe();
    }
  });

  it("reconciles issue, document, artifact-review, reply, reopen, and edit activity once across restart", async () => {
    expect(OWNER_COMMENT_INTAKE_BACKFILL_FROM).toBe("2026-10-29T02:30:00.000Z");
    await db.insert(companies).values({ id: companyId, name: "Intake fixture", issuePrefix: `INT${companyId.slice(0, 5).toUpperCase()}` });
    const lowTrustSource = { preset: "low_trust_review", disposition: "quarantined" } as const;
    await db.insert(agents).values({ id: assigneeAgentId, companyId, name: "Assignee", role: "engineer", status: "idle", adapterType: "codex_local" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerUserId, status: "active", membershipRole: "owner" });
    await db.insert(issues).values({ id: issueId, companyId, identifier: issueIdentifier, title: "Intake fixture", status: "in_progress", assigneeAgentId });

    const outsideBackfillCommentId = randomUUID();
    await db.insert(issueComments).values({ id: outsideBackfillCommentId, companyId, issueId, authorUserId: ownerUserId, authorType: "user", body: "Historical request outside the bounded window." });
    const outsideBackfillActivity = await recordOwnerActivity("issue.comment_added", { commentId: outsideBackfillCommentId });
    await db.update(activityLog).set({ createdAt: new Date("2026-10-29T02:29:59.999Z") }).where(eq(activityLog.id, outsideBackfillActivity.id));

    const issueCommentId = randomUUID();
    await db.insert(issueComments).values({ id: issueCommentId, companyId, issueId, authorUserId: ownerUserId, authorType: "user", body: "Please make the requested change.", sourceTrust: lowTrustSource });
    const issueCommentActivity = await recordOwnerActivity("issue.comment_added", { commentId: issueCommentId });

    const alreadyActionedCommentId = randomUUID();
    const alreadyActionedAt = new Date("2026-10-29T02:31:00.000Z");
    await db.insert(issueComments).values({ id: alreadyActionedCommentId, companyId, issueId, authorUserId: ownerUserId, authorType: "user", body: "This request was already handled before intake began.", createdAt: alreadyActionedAt });
    await db.insert(issueComments).values({ companyId, issueId, authorType: "agent", authorAgentId: assigneeAgentId, body: `Completed earlier. #comment-${alreadyActionedCommentId}`, createdAt: new Date(alreadyActionedAt.getTime() + 1_000) });
    await recordOwnerActivity("issue.comment_added", { commentId: alreadyActionedCommentId });

    const docs = documentService(db);
    const annotations = documentAnnotationService(db);
    const planDocument = (await docs.upsertIssueDocument({ issueId, key: "plan", title: "Plan", format: "markdown", body: "Alpha selected text omega" })).document;
    await db.update(documents).set({ sourceTrust: lowTrustSource }).where(eq(documents.id, planDocument.id));
    const reviewProductId = randomUUID();
    await db.insert(issueWorkProducts).values({ id: reviewProductId, companyId, issueId, type: "web", provider: "paperclip", title: "Review build", status: "ready", url: "https://example.test/review" });
    const createdTaskId = randomUUID();
    const createdTaskIdentifier = issueIdentifier.replace(/-1$/, "-2");
    await db.insert(issues).values({ id: createdTaskId, companyId, identifier: createdTaskIdentifier, title: "Bounded follow-up", status: "todo", assigneeAgentId });
    const reviewDocumentKey = `artifact-review-${reviewProductId}`;
    const reviewDocument = (await docs.upsertIssueDocument({ issueId, key: reviewDocumentKey, title: "Artifact review", format: "markdown", body: "Alpha selected text omega" })).document;
    await db.update(documents).set({ sourceTrust: lowTrustSource }).where(eq(documents.id, reviewDocument.id));

    const annotationThread = await annotations.createThread(issueId, "plan", annotationInput(planDocument.latestRevisionId!, planDocument.latestRevisionNumber), { actorType: "user", actorId: ownerUserId, userId: ownerUserId });
    const annotationCommentId = annotationThread.comments[0]!.id;
    const annotationActivity = await recordOwnerActivity("issue.document_annotation_thread_created", {
      key: "plan", documentKey: "plan", documentId: planDocument.id, threadId: annotationThread.id, commentId: annotationCommentId,
    });
    const annotationReply = await annotations.addComment(issueId, "plan", annotationThread.id, { body: "Please also check this follow-up." }, { actorType: "user", actorId: ownerUserId, userId: ownerUserId });
    const annotationReplyActivity = await recordOwnerActivity("issue.document_annotation_comment_added", {
      key: "plan", documentKey: "plan", documentId: planDocument.id, threadId: annotationThread.id, commentId: annotationReply.id,
    });

    const artifactThread = await annotations.createThread(issueId, reviewDocumentKey, annotationInput(reviewDocument.latestRevisionId!, reviewDocument.latestRevisionNumber), { actorType: "user", actorId: ownerUserId, userId: ownerUserId });
    const artifactCommentId = artifactThread.comments[0]!.id;
    const artifactActivity = await recordOwnerActivity("issue.document_annotation_thread_created", {
      key: reviewDocumentKey, documentKey: reviewDocumentKey, documentId: reviewDocument.id, threadId: artifactThread.id, commentId: artifactCommentId,
    });

    const reopenThread = await annotations.createThread(issueId, "plan", annotationInput(planDocument.latestRevisionId!, planDocument.latestRevisionNumber), { actorType: "user", actorId: ownerUserId, userId: ownerUserId });
    const reopenActivity = await recordOwnerActivity("issue.document_annotation_thread_reopened", { threadId: reopenThread.id, reopenedAt: reopenThread.updatedAt.toISOString() });

    await db.update(documents).set({ latestBody: "Owner-edited plan", updatedByUserId: ownerUserId }).where(eq(documents.id, planDocument.id));
    const documentEditActivity = await recordOwnerActivity("issue.document_updated", { key: "plan", documentId: planDocument.id });
    await db.update(documents).set({ latestBody: "Owner-edited artifact review", updatedByUserId: ownerUserId }).where(eq(documents.id, reviewDocument.id));
    const artifactReviewEditActivity = await recordOwnerActivity("issue.document_updated", { key: reviewDocumentKey, documentId: reviewDocument.id });

    const artifactEditProductId = randomUUID();
    await db.insert(issueWorkProducts).values({ id: artifactEditProductId, companyId, issueId, type: "web", provider: "paperclip", title: "Preview", status: "ready" });
    const artifactEditActivity = await recordOwnerActivity("issue.work_product_updated", { workProductId: artifactEditProductId, changedKeys: ["summary"] });

    await db.insert(agentWakeupRequests).values({
      companyId, agentId: assigneeAgentId, source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: { issueId, commentId: issueCommentId, ownerCommentIntakeSourceKey: `issue_comment:${issueCommentId}` },
      status: "queued", requestedByActorType: "user", requestedByActorId: ownerUserId,
    });

    const wakeup = async (agentId: string, input: Record<string, any>) => {
      wakeupCalls.push({ agentId, input });
      const [wake] = await db.insert(agentWakeupRequests).values({
        companyId, agentId, source: input.source, triggerDetail: input.triggerDetail, reason: input.reason,
        payload: input.payload, requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId, idempotencyKey: input.idempotencyKey, status: "queued",
      }).returning();
      return wake;
    };
    const firstProcess = ownerCommentIntakeService(db, {
      wakeup,
      initialBackfillFrom: new Date(OWNER_COMMENT_INTAKE_BACKFILL_FROM),
      now: () => now,
    });
    await firstProcess.sweepPending();
    expect(wakeupCalls).toHaveLength(7);
    expect((await firstProcess.getDisposition(companyId, "issue_comment", alreadyActionedCommentId))?.details).toMatchObject({ status: "actioned_existing", receiptFound: true });
    expect(await firstProcess.nextRunAt()).not.toBeNull();

    const lateSameTimestampCommentId = randomUUID();
    await db.insert(issueComments).values({ id: lateSameTimestampCommentId, companyId, issueId, authorUserId: ownerUserId, authorType: "user", body: "Late event at the cursor timestamp." });
    const lateSameTimestampActivity = await recordOwnerActivity("issue.comment_added", { commentId: lateSameTimestampCommentId });
    await db.update(activityLog).set({ createdAt: artifactEditActivity.createdAt, id: "00000000-0000-0000-0000-000000000001" }).where(eq(activityLog.id, lateSameTimestampActivity.id));

    // A new service instance models restart recovery at the end of the native-wake grace period.
    now = new Date(now.getTime() + 31_000);
    const restartedProcess = ownerCommentIntakeService(db, {
      wakeup,
      initialBackfillFrom: new Date(OWNER_COMMENT_INTAKE_BACKFILL_FROM),
      now: () => now,
    });
    await restartedProcess.sweepPending();
    expect(wakeupCalls).toHaveLength(7);
    expect((await restartedProcess.getDisposition(companyId, "issue_comment", lateSameTimestampCommentId))?.details).toMatchObject({ status: "pending" });
    now = new Date(now.getTime() + 31_000);
    await restartedProcess.sweepPending();
    expect(wakeupCalls).toHaveLength(8);

    const fastResponseCommentId = randomUUID();
    await db.insert(issueComments).values({ id: fastResponseCommentId, companyId, issueId, authorUserId: ownerUserId, authorType: "user", body: "A fast native wake already began this request." });
    await recordOwnerActivity("issue.comment_added", { commentId: fastResponseCommentId });
    const fastResponseReceiptId = await addReceipt({ sourceKind: "issue_comment", sourceId: fastResponseCommentId, threadId: null, documentKey: null, productId: null }, "Started before reconciliation caught up.", null);
    const fastResponseMapping = await restartedProcess.ensureDisposition({ companyId, sourceKind: "issue_comment", sourceId: fastResponseCommentId });
    expect(fastResponseMapping?.details).toMatchObject({ status: "actioned_existing", receiptFound: true });
    expect(await restartedProcess.verifyReceipt({ companyId, issueId, sourceKind: "issue_comment", sourceId: fastResponseCommentId,
      actorType: "agent", actorId: assigneeAgentId, receiptCommentId: fastResponseReceiptId })).toBe(true);
    await restartedProcess.recordDisposition({ companyId, issueId, sourceKind: "issue_comment", sourceId: fastResponseCommentId,
      actorType: "agent", actorId: assigneeAgentId, stage: "started", disposition: "existing_work", summary: "Acknowledged work already in progress.",
      receiptCommentId: fastResponseReceiptId, linkedIssueId: issueId });

    const surfaces = [
      { sourceKind: "issue_comment", sourceId: issueCommentId, activityId: issueCommentActivity.id, threadId: null, documentKey: null, productId: null },
      { sourceKind: "issue_comment", sourceId: lateSameTimestampCommentId, activityId: lateSameTimestampActivity.id, threadId: null, documentKey: null, productId: null },
      { sourceKind: "document_annotation", sourceId: annotationCommentId, activityId: annotationActivity.id, threadId: annotationThread.id, documentKey: "plan", productId: null },
      { sourceKind: "document_annotation", sourceId: annotationReply.id, activityId: annotationReplyActivity.id, threadId: annotationThread.id, documentKey: "plan", productId: null },
      { sourceKind: "artifact_review_comment", sourceId: artifactCommentId, activityId: artifactActivity.id, threadId: artifactThread.id, documentKey: reviewDocumentKey, productId: reviewProductId },
      { sourceKind: "document_annotation_reopen", sourceId: `${reopenThread.id}~${reopenThread.updatedAt.getTime()}`, activityId: reopenActivity.id, threadId: reopenThread.id, documentKey: "plan", productId: null },
      { sourceKind: "document_edit", sourceId: documentEditActivity.id, activityId: documentEditActivity.id, threadId: null, documentKey: "plan", productId: null },
      { sourceKind: "artifact_review_edit", sourceId: artifactReviewEditActivity.id, activityId: artifactReviewEditActivity.id, threadId: null, documentKey: reviewDocumentKey, productId: null },
      { sourceKind: "artifact_edit", sourceId: artifactEditActivity.id, activityId: artifactEditActivity.id, threadId: null, documentKey: null, productId: artifactEditProductId },
    ] as const;
    for (const surface of surfaces) {
      const mapping = await restartedProcess.getDisposition(companyId, surface.sourceKind, surface.sourceId);
      expect(mapping?.details).toMatchObject({ status: "routed", issueId });
      if (surface.sourceKind === "issue_comment" && surface.sourceId === issueCommentId) expect(mapping?.details.sourceTrust).toEqual(lowTrustSource);
      if (surface.sourceKind !== "issue_comment") {
        const delivered = wakeupCalls.find(call => call.input.payload.ownerCommentIntakeSourceKey === `${surface.sourceKind}:${surface.sourceId}`);
        expect(delivered?.agentId).toBe(assigneeAgentId);
        expect(delivered?.input.contextSnapshot.ownerCommentIntake).toMatchObject({
          sourceKind: surface.sourceKind,
          sourceId: surface.sourceId,
          issueId,
          author: { type: "user", userId: ownerUserId },
        });
        if (surface.sourceKind === "document_annotation" && surface.sourceId === annotationCommentId) {
          expect(delivered?.input.contextSnapshot.ownerCommentIntake.sourceTrust).toEqual(lowTrustSource);
        }
      }
      const createsTask = surface.sourceKind === "artifact_review_comment";
      const linkedIssueId = createsTask ? createdTaskId : issueId;
      const linkedIssueIdentifier = createsTask ? createdTaskIdentifier : null;
      const receiptCommentId = await addReceipt(surface, "Started work on this owner request.", linkedIssueIdentifier);
      expect(await restartedProcess.verifyReceipt({ companyId, issueId, sourceKind: surface.sourceKind, sourceId: surface.sourceId,
        actorType: "agent", actorId: assigneeAgentId, receiptCommentId, linkedIssueIdentifier })).toBe(true);
      await restartedProcess.recordDisposition({ companyId, issueId, sourceKind: surface.sourceKind, sourceId: surface.sourceId,
        actorType: "agent", actorId: assigneeAgentId, stage: "started", disposition: createsTask ? "task_created" : "existing_work", summary: createsTask ? "Created and assigned a bounded follow-up." : "Started on the assigned issue.",
        receiptCommentId, linkedIssueId });
      const completionReceiptId = await addReceipt(surface, "Completed the requested work.", linkedIssueIdentifier);
      expect(await restartedProcess.verifyReceipt({ companyId, issueId, sourceKind: surface.sourceKind, sourceId: surface.sourceId,
        actorType: "agent", actorId: assigneeAgentId, receiptCommentId: completionReceiptId, linkedIssueIdentifier })).toBe(true);
      await restartedProcess.recordDisposition({ companyId, issueId, sourceKind: surface.sourceKind, sourceId: surface.sourceId,
        actorType: "agent", actorId: assigneeAgentId, stage: "completed", disposition: "inline_change", summary: createsTask ? "Completed the bounded follow-up." : "Completed inline on the assigned issue.",
        receiptCommentId: completionReceiptId, linkedIssueId });
      const countBeforeRetry = await db.select().from(activityLog).where(and(
        eq(activityLog.companyId, companyId), eq(activityLog.action, "owner_comment_intake.mapping"), eq(activityLog.entityId, `${surface.sourceKind}:${surface.sourceId}`),
      ));
      await restartedProcess.recordDisposition({ companyId, issueId, sourceKind: surface.sourceKind, sourceId: surface.sourceId,
        actorType: "agent", actorId: assigneeAgentId, stage: "completed", disposition: "inline_change", summary: createsTask ? "Completed the bounded follow-up." : "Completed inline on the assigned issue.",
        receiptCommentId: completionReceiptId, linkedIssueId });
      const countAfterRetry = await db.select().from(activityLog).where(and(
        eq(activityLog.companyId, companyId), eq(activityLog.action, "owner_comment_intake.mapping"), eq(activityLog.entityId, `${surface.sourceKind}:${surface.sourceId}`),
      ));
      expect(countAfterRetry).toHaveLength(countBeforeRetry.length);
      expect((await restartedProcess.getDisposition(companyId, surface.sourceKind, surface.sourceId))?.details).toMatchObject({ stage: "completed", status: "dispositioned" });
    }

    // Duplicate source activity with the same comment ID is a no-op after process restart.
    await recordOwnerActivity("issue.comment_added", { commentId: issueCommentId });
    await recordOwnerActivity("issue.document_annotation_thread_reopened", { threadId: reopenThread.id, reopenedAt: reopenThread.updatedAt.toISOString() });
    await restartedProcess.sweepPending();
    expect(wakeupCalls).toHaveLength(8);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(9);
    expect(await restartedProcess.getDisposition(companyId, "issue_comment", outsideBackfillCommentId)).toBeNull();
  });

  async function recordOwnerActivity(action: string, details: Record<string, unknown>) {
    const activity = await logActivity(db, { companyId, actorType: "user", actorId: ownerUserId, action,
      entityType: "issue", entityId: issueId, issueId, details });
    const createdAt = new Date("2026-10-30T03:00:00.000Z");
    createdAt.setMilliseconds(createdAt.getMilliseconds() + (await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).length);
    await db.update(activityLog).set({ createdAt }).where(eq(activityLog.id, activity.id));
    return { ...activity, createdAt };
  }

  function annotationInput(baseRevisionId: string, baseRevisionNumber: number) {
    return {
      baseRevisionId,
      baseRevisionNumber,
      selector: { quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
        position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 } },
      body: "Please review this content.",
    };
  }

  async function addReceipt(surface: { sourceKind: string; sourceId: string; threadId: string | null; documentKey: string | null; productId: string | null }, text: string, linkedIssueIdentifier: string | null) {
    if (surface.threadId) {
      const [thread] = await db.select().from(documentAnnotationThreads).where(eq(documentAnnotationThreads.id, surface.threadId));
      const [receipt] = await db.insert(documentAnnotationComments).values({
        companyId, threadId: surface.threadId, issueId, documentId: thread!.documentId,
        body: `${text}${linkedIssueIdentifier ? ` Follow-up: ${linkedIssueIdentifier}` : ""}`, authorType: "agent", authorAgentId: assigneeAgentId,
      }).returning();
      return receipt!.id;
    }
    const sourceReference = surface.sourceKind === "issue_comment"
      ? `#comment-${surface.sourceId}`
      : surface.sourceKind === "artifact_edit"
        ? surface.productId!
        : `#document-${surface.documentKey}`;
    const [receipt] = await db.insert(issueComments).values({
      companyId, issueId, body: `${text} Source: ${sourceReference}${linkedIssueIdentifier ? ` Follow-up: ${linkedIssueIdentifier}` : ""}`, authorType: "agent", authorAgentId: assigneeAgentId,
    }).returning();
    return receipt!.id;
  }
});
