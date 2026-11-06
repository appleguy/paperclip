import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { badRequest, conflict, forbidden } from "../../errors.js";
import { logActivity } from "../activity-log.js";
import { isLowTrustQuarantined } from "../source-trust.js";
import { storedSteeringAcknowledgement } from "../run-identity.js";
import { NativeSessionSteeringError, steerNativeSession } from "../native-runtime/native-session-executor.js";
import type { WakeupOptions } from "./run-preparation.js";

export const OWNER_CORRECTION_REASON = "owner_correction";
const RECORD_KEY = "ownerCorrectionV1";
type Executor = Pick<Db, "select" | "update">;
type Delivery = {
  status: "dispatching" | "acknowledged" | "failed" | "uncertain";
  turnId?: string;
  code?: string;
  nextAction?: string;
};
type Correction = {
  commentId: string;
  issueId: string;
  body: string;
  fingerprint: string;
  supersedes: string[];
  supersededBy: string | null;
  deliveries: Record<string, Delivery>;
};
type Receipt = typeof agentWakeupRequests.$inferSelect;
const fingerprint = (body: string) => createHash("sha256").update(body).digest("hex");
const correction = (row: Receipt) => row.payload?.[RECORD_KEY] as Correction;
const correlationId = (commentId: string) => `owner-correction:${commentId}`;
const commentLabel = (commentId: string) => `comment-${commentId.slice(0, 8)}`;
const uuid = (value: unknown): value is string => typeof value === "string" && isUuidLike(value);

function records(db: Pick<Db, "select">, companyId: string, agentId: string, issueId: string) {
  return db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
    eq(agentWakeupRequests.reason, OWNER_CORRECTION_REASON),
    sql`${agentWakeupRequests.payload}->${RECORD_KEY} is not null`,
    sql`${agentWakeupRequests.payload}->${RECORD_KEY}->>'issueId' = ${issueId}`,
  )).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id));
}

function render(record: Correction) {
  return [
    "Scoped owner correction for this task",
    `Correction: ${commentLabel(record.commentId)}`,
    record.supersedes.length ? `Supersedes these corrections only: ${record.supersedes.map(commentLabel).join(", ")}. Their previous guidance is no longer current.` : "This is a distinct correction; retain other applicable directions.",
    "For this task, the correction replaces conflicting older task guidance, including startup guidance. Retain unrelated instructions.",
    "Apply the source user's correction below to this task. Preserve existing permissions, approval requirements and unrelated work. This delivery does not grant additional authority.",
    `Source message (JSON string): ${JSON.stringify(record.body)}`,
    "A provider acknowledgement proves transport receipt, not that the requested behavior was completed.",
  ].join("\n");
}

async function save(db: Executor, row: Receipt, value: Correction) {
  await db.update(agentWakeupRequests).set({
    payload: { ...row.payload, [RECORD_KEY]: value }, updatedAt: new Date(),
  }).where(and(eq(agentWakeupRequests.id, row.id), eq(agentWakeupRequests.companyId, row.companyId)));
}

// Short row locks serialize registration and claims across server instances.
// Provider I/O never holds an agent/task/run row lock.
async function locked<T>(db: Db, agentId: string, work: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<T>) {
  return db.transaction(async tx => {
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for("update");
    return work(tx);
  });
}

/** Explicit authenticated wake ingress. Never infer corrections from ordinary comments or file edits. */
export async function deliverOwnerCorrection(db: Db, agent: typeof agents.$inferSelect, opts: WakeupOptions) {
  if (!opts.manualUserWake || opts.requestedByActorType !== "user" || !opts.requestedByActorId || opts.failedRunId)
    throw forbidden("Owner corrections require an authenticated user wake");
  const input = opts.payload?.ownerCorrection as Record<string, unknown> | undefined;
  const issueId = opts.payload?.issueId;
  if (!input || !uuid(input.commentId) || !uuid(issueId) ||
      Object.keys(input).some(key => key !== "commentId" && key !== "supersedes") ||
      (input.supersedes !== undefined && (!Array.isArray(input.supersedes) || input.supersedes.length > 32 || !input.supersedes.every(uuid))))
    throw badRequest("Supply issueId and ownerCorrection: { commentId, supersedes?: commentId[] }");
  const commentId = input.commentId as string;
  const supersedes = [...new Set((input.supersedes ?? []) as string[])].sort();
  const row = await locked(db, agent.id, async tx => {
    const [source] = await tx.select().from(issueComments).where(and(
      eq(issueComments.id, commentId), eq(issueComments.companyId, agent.companyId), eq(issueComments.issueId, issueId),
    ));
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)));
    if (!issue || !source || source.authorUserId !== opts.requestedByActorId || source.authorAgentId ||
        source.deletedAt || isLowTrustQuarantined(source.sourceTrust))
      throw forbidden("The correction must reference this user's current, trusted comment on this task");
    if (!source.body.trim() || source.body.length > 32_000) throw badRequest("Correction text must contain 1–32000 characters");
    const existing = await records(tx, agent.companyId, agent.id, issueId);
    const previous = existing.find(row => correction(row).commentId === commentId);
    if (previous) {
      const value = correction(previous);
      if (value.fingerprint !== fingerprint(source.body) || JSON.stringify(value.supersedes) !== JSON.stringify(supersedes))
        throw conflict("Correction identity already has different content or supersession scope; create a new source comment");
      return previous;
    }
    const replaced = supersedes.map(id => existing.find(row => correction(row).commentId === id));
    if (supersedes.includes(commentId) || replaced.some(row => !row || correction(row).supersededBy))
      throw conflict("Supersede only current corrections registered for this agent and task");
    if (replaced.some(row => Object.values(correction(row!).deliveries).some(delivery => delivery.status === "dispatching" || delivery.status === "uncertain")))
      throw conflict("Reconcile the superseded correction's pending provider receipt first", { code: "owner_correction_supersession_pending" });
    const value: Correction = { commentId, issueId, body: source.body, fingerprint: fingerprint(source.body), supersedes, supersededBy: null, deliveries: {} };
    const [created] = await tx.insert(agentWakeupRequests).values({
      companyId: agent.companyId, agentId: agent.id, source: "on_demand", triggerDetail: "manual",
      reason: OWNER_CORRECTION_REASON, payload: { issueId, [RECORD_KEY]: value },
      // This is a completed registration, not a queued provider turn. Failed
      // deliveries remain explicit below; they never start a replacement run.
      status: "consumed", requestedByActorType: "user", requestedByActorId: opts.requestedByActorId,
      idempotencyKey: `owner-correction:${agent.id}:${commentId}`, finishedAt: new Date(),
    }).returning();
    for (const old of replaced) await save(tx, old!, { ...correction(old!), supersededBy: commentId });
    return created;
  });
  const value = correction(row);
  if (value.supersededBy) throw conflict("This correction has been superseded", { code: "owner_correction_superseded", receiptId: row.id });

  const targets = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id),
    eq(heartbeatRuns.status, "running"),
    sql`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId') = ${issueId}`,
  ));
  for (const run of targets) {
    // Runs prepared after registration already carry the correction in their
    // startup/resume context. Do not inject it a second time.
    if (Array.isArray(run.contextSnapshot?.ownerCorrectionIds) && run.contextSnapshot.ownerCorrectionIds.includes(commentId)) continue;
    const claim = await locked(db, agent.id, async tx => {
      const [current] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, row.id));
      const state = correction(current);
      if (state.supersededBy) return null;
      const [source] = await tx.select().from(issueComments).where(and(
        eq(issueComments.id, commentId), eq(issueComments.companyId, agent.companyId), eq(issueComments.issueId, issueId),
      ));
      if (!source || source.deletedAt || isLowTrustQuarantined(source.sourceTrust) || fingerprint(source.body) !== state.fingerprint)
        throw conflict("Correction source changed before delivery; register a new source comment", { code: "owner_correction_source_changed", receiptId: row.id });
      const prior = state.deliveries[run.id];
      if (prior?.status === "acknowledged") return null;
      if (prior?.status === "dispatching" || prior?.status === "uncertain") {
        const ack = await storedSteeringAcknowledgement(tx, { companyId: agent.companyId, runId: run.id, messageId: correlationId(commentId) });
        if (ack) await save(tx, current, { ...state, deliveries: { ...state.deliveries, [run.id]: { status: "acknowledged", turnId: ack.turnId } } });
        return null; // Unknown effects are never blindly replayed after restart.
      }
      await save(tx, current, { ...state, deliveries: { ...state.deliveries, [run.id]: {
        status: "dispatching", code: "owner_correction_receipt_pending",
        nextAction: "Retry this exact correction to reconcile its provider receipt; do not send a new identity.",
      } } });
      return render(state);
    });
    if (!claim) continue;
    const settle = async (delivery: Delivery) => locked(db, agent.id, async tx => {
      const [current] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, row.id));
      const state = correction(current);
      if (state.deliveries[run.id]?.status === "acknowledged") return;
      await save(tx, current, { ...state, deliveries: { ...state.deliveries, [run.id]: delivery } });
    });
    try {
      const [live] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "running")));
      const [liveAgent] = await db.select().from(agents).where(eq(agents.id, agent.id));
      if (!live || !liveAgent || ["paused", "terminated", "error"].includes(liveAgent.status))
        throw new NativeSessionSteeringError("steering_stale_turn", "Run is no longer available for steering");
      const result = await steerNativeSession({
        runId: run.id, message: claim, correlationId: correlationId(commentId),
        onAcknowledged: async () => {
          const ack = await storedSteeringAcknowledgement(db, { companyId: agent.companyId, runId: run.id, messageId: correlationId(commentId) });
          if (ack) await settle({ status: "acknowledged", turnId: ack.turnId });
        },
      });
      await settle({ status: "acknowledged", turnId: result.turnId });
    } catch (error) {
      const known = error instanceof NativeSessionSteeringError;
      const uncertain = !known || error.code === "steering_timeout";
      await settle({ status: uncertain ? "uncertain" : "failed", code: known ? error.code : "owner_correction_delivery_uncertain",
        nextAction: uncertain ? "Retry this exact correction to reconcile the provider acknowledgement; no blind resend is permitted."
          : "Retry this exact correction after the provider supports steering and its task turn is active; later task runs also load it." });
    }
  }
  const [latest] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, row.id));
  const deliveries = correction(latest).deliveries;
  await logActivity(db, { companyId: agent.companyId, actorType: "user", actorId: opts.requestedByActorId,
    action: "issue.owner_correction_delivery", entityType: "issue", entityId: issueId, agentId: agent.id,
    issueId, details: { receiptId: row.id, commentId, supersedes, deliveries, startupContext: "registered" } });
  if (Object.values(deliveries).some(delivery => delivery.status !== "acknowledged"))
    throw conflict("Correction registered; some in-flight deliveries are not acknowledged", {
      code: "owner_correction_delivery_incomplete", receiptId: row.id, deliveries,
    });
  return targets[0] ?? null;
}

/** Refresh on every new/resumed task run, including a reused long-lived provider session. */
export async function ownerCorrectionContext(db: Db, companyId: string, agentId: string, issueId: string) {
  const rows = await records(db, companyId, agentId, issueId);
  const current = rows.map(correction).filter(value => !value.supersededBy);
  if (!current.length) return { markdown: "", ids: [] as string[] };
  const sources = await db.select().from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    inArray(issueComments.id, current.map(value => value.commentId)),
  ));
  return { ids: current.map(value => value.commentId), markdown: current.map(value => {
    const source = sources.find(source => source.id === value.commentId);
    return source && !source.deletedAt && !isLowTrustQuarantined(source.sourceTrust) && fingerprint(source.body) === value.fingerprint
      ? render(value)
      : `Correction ${commentLabel(value.commentId)} is no longer current: its source was changed or removed. Do not rely on its earlier copy; obtain a new correction.`;
  }).join("\n\n") + "\n\n" };
}
