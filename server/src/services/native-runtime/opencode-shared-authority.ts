import { agentTaskSessions, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { and, eq, gt, sql } from "drizzle-orm";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";

/** Must be established by an authenticated native backend admission, not a request body. */
export type OpenCodeSharedBinding = Readonly<{
  companyId: string; projectId: string; issueId: string; agentId: string; runId: string;
  taskSessionId: string; normalizedSessionId: string; runnerInstanceId: string;
  providerSessionId: string; generation: string; epoch: string; version: "2.2.5";
  model: string; effort: string; leaseOwner: string; leaseAttempt: number;
  controllerBootId: string; controllerPid: number; controllerProcessStartedAt: Date; controllerGeneration: number;
}>;
const MAX_LOG_BYTES = 1_048_576;
const bindingKeys = ["companyId", "projectId", "issueId", "agentId", "runId", "taskSessionId", "normalizedSessionId", "runnerInstanceId", "providerSessionId", "generation", "epoch", "version", "model", "effort"] as const;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("opencode_shared_binding_invalid");
  return value as Record<string, unknown>;
}
function validSeq(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

/** Validate independently of the Runner client before committing untrusted wire data. */
export function validateOpenCodeLogItem(sessionId: string, previous: number | null, next: number | null, value: unknown): Record<string, unknown> {
  const item = record(value);
  if (Buffer.byteLength(JSON.stringify(item), "utf8") > MAX_LOG_BYTES) throw new Error("opencode_shared_event_oversized");
  if ((previous !== null && !validSeq(previous)) || (next !== null && !validSeq(next))) throw new Error("opencode_shared_cursor_invalid");
  if (item.type === "log.synced") {
    if (item.aggregateID !== sessionId || (item.seq === undefined ? next !== null : item.seq !== next) || (previous !== null && (next === null || next < previous))) throw new Error("opencode_shared_watermark_invalid");
  } else {
    const durable = record(item.durable), data = record(item.data);
    if (typeof item.id !== "string" || !item.id.startsWith("evt_") || typeof item.type !== "string" || !item.type.startsWith("session.") || durable.aggregateID !== sessionId || data.sessionID !== sessionId || durable.seq !== next || !validSeq(next) || (previous !== null && next <= previous) || !Number.isSafeInteger(durable.version) || Number(durable.version) < 1) throw new Error("opencode_shared_event_invalid");
  }
  return item;
}

/** Atomically append exact provider data and advance its session-scoped cursor.
 * This is a persistence primitive, not backend authentication or mutation admission. */
export async function commitOpenCodeSharedLog(db: Db, binding: OpenCodeSharedBinding, input: { previous: number | null; next: number | null; item: unknown }): Promise<void> {
  if (binding.version !== "2.2.5" || bindingKeys.some(key => typeof binding[key] !== "string" || !binding[key]) || !binding.providerSessionId.startsWith("ses_") || !Number.isSafeInteger(binding.leaseAttempt) || !Number.isSafeInteger(binding.controllerGeneration) || !Number.isSafeInteger(binding.controllerPid) || !(binding.controllerProcessStartedAt instanceof Date) || !Number.isFinite(binding.controllerProcessStartedAt.getTime())) throw new Error("opencode_shared_binding_invalid");
  binding = { ...binding, controllerProcessStartedAt: new Date(binding.controllerProcessStartedAt) };
  const item = structuredClone(validateOpenCodeLogItem(binding.providerSessionId, input.previous, input.next, input.item));
  await db.transaction(async tx => {
    // Existing issue checkout and finalization paths acquire these rows in
    // different orders. Never wait while holding a subset: PostgreSQL 55P03
    // aborts this transaction, leaving event and cursor unchanged for replay.
    await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, binding.runId)).for("update", { noWait: true });
    const [lease] = await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.runId, binding.runId), eq(nativeRunFinalizations.companyId, binding.companyId), eq(nativeRunFinalizations.issueId, binding.issueId),
      eq(nativeRunFinalizations.leaseOwner, binding.leaseOwner), eq(nativeRunFinalizations.attempt, binding.leaseAttempt),
      eq(nativeRunFinalizations.controllerBootId, binding.controllerBootId), eq(nativeRunFinalizations.controllerPid, binding.controllerPid),
      eq(nativeRunFinalizations.controllerProcessStartedAt, binding.controllerProcessStartedAt), eq(nativeRunFinalizations.controllerGeneration, binding.controllerGeneration),
      gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`),
    )).limit(1);
    if (!lease) throw new Error("opencode_shared_lease_lost");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.nativeIssueId, binding.issueId), eq(heartbeatRuns.nativeSessionId, binding.normalizedSessionId), eq(heartbeatRuns.runnerInstanceId, binding.runnerInstanceId), eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"))).for("update", { noWait: true }).limit(1);
    if (!run) throw new Error("opencode_shared_run_mismatch");
    const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId), eq(issues.projectId, binding.projectId), eq(issues.executionRunId, binding.runId))).for("update", { noWait: true }).limit(1);
    if (!issue) throw new Error("opencode_shared_project_mismatch");
    const [session] = await tx.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.id, binding.taskSessionId), eq(agentTaskSessions.companyId, binding.companyId), eq(agentTaskSessions.agentId, binding.agentId), eq(agentTaskSessions.lastRunId, binding.runId), eq(agentTaskSessions.adapterType, "paperclip_runner"))).for("update", { noWait: true }).limit(1);
    if (!session) throw new Error("opencode_shared_session_mismatch");
    const params = record(session.sessionParamsJson), native = record(params.opencodeSharedV2);
    if (bindingKeys.some(key => native[key] !== binding[key]) || native.cursor !== input.previous) throw new Error("opencode_shared_cursor_or_identity_mismatch");
    // Lock acquisition can wait past expiry. Recheck the already locked lease
    // immediately before writing; no work is admitted on a revived lease.
    const [liveLease] = await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, binding.runId), gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`))).limit(1);
    if (!liveLease) throw new Error("opencode_shared_lease_lost");
    await appendHeartbeatRunEvent(tx as unknown as Db, { companyId: binding.companyId, agentId: binding.agentId, runId: binding.runId, eventType: "opencode.shared.log", stream: "system", payload: { opencodeSharedV2: { sessionId: binding.providerSessionId, generation: binding.generation, epoch: binding.epoch, previous: input.previous, next: input.next, item } } });
    // Closed, coarse UI projection from pinned v2 durable tool events. Never
    // attribute a shared-session event to the dispatched prompt or expose tool input.
    const data = item.type === "log.synced" ? {} : record(item.data);
    const toolFact = typeof data.id === "string" && data.id.length > 0 && typeof data.assistantMessageID === "string" && data.assistantMessageID.startsWith("msg_") && typeof data.executed === "boolean";
    const progress = !toolFact ? null : item.type === "session.tool.called" ? "tool.execution.started" : item.type === "session.tool.success" || item.type === "session.tool.failed" ? "tool.execution.completed" : null;
    if (progress) await appendHeartbeatRunEvent(tx as unknown as Db, { companyId: binding.companyId, agentId: binding.agentId, runId: binding.runId, eventType: progress, stream: "system", payload: { opencodeSharedV2: { sessionId: binding.providerSessionId, generation: binding.generation, epoch: binding.epoch, sourceEventId: item.id, sourceSeq: input.next, origin: "unknown" } } });
    await tx.update(agentTaskSessions).set({ sessionParamsJson: { ...params, opencodeSharedV2: { ...native, cursor: input.next } }, updatedAt: sql`clock_timestamp()` }).where(eq(agentTaskSessions.id, binding.taskSessionId));
  });
}
