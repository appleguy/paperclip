import { agentTaskSessions, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { and, eq, gt, sql } from "drizzle-orm";
import { isConversation } from "../agent-conversations.js";
import { nativeSha256 } from "../native-runtime/canonical.js";

type Lease = { owner: string; attempt: number; controllerGeneration?: number; controller: { bootId: string; pid: number; processStartedAt: Date } };
const immutable = ["companyId", "projectId", "issueId", "agentId", "runId", "taskSessionId", "normalizedSessionId", "runnerInstanceId", "providerSessionId", "generation", "epoch", "version", "model", "effort"] as const;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Preserve the durable v2 cursor under the same locks as admission and log commit. */
export async function saveOpenCodeGoalCheckpoint(db: Db, input: {
  companyId: string; agentId: string; taskKey: string; runId: string; adapterType: string;
  params: Record<string, unknown>; displayId: string; providerSessionId: string | null;
  normalizedSessionId: string; runnerInstanceId: string; lease: Lease;
  finalRevision?: string;
  terminalDigest?: string;
}) {
  return db.transaction(async tx => {
    const [lease] = await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, input.runId), eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.leaseOwner, input.lease.owner), eq(nativeRunFinalizations.attempt, input.lease.attempt), eq(nativeRunFinalizations.controllerBootId, input.lease.controller.bootId), eq(nativeRunFinalizations.controllerPid, input.lease.controller.pid), eq(nativeRunFinalizations.controllerProcessStartedAt, input.lease.controller.processStartedAt), gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`))).for("update", { noWait: true }).limit(1);
    if (!lease) throw new Error("opencode_checkpoint_lease_lost");
    if (input.finalRevision && (!Number.isSafeInteger(input.lease.controllerGeneration) || lease.controllerGeneration !== input.lease.controllerGeneration)) throw new Error("opencode_checkpoint_lease_lost");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.status, "running"))).for("update", { noWait: true }).limit(1);
    if (!run) throw new Error("opencode_checkpoint_run_changed");
    const [issue] = await tx.select().from(issues).where(and(sql`${issues.id}::text = ${input.taskKey}`, eq(issues.companyId, input.companyId))).for("update", { noWait: true }).limit(1);
    if (isConversation(issue) && run.contextSnapshot?.conversationSessionGeneration !== issue.conversationSessionGeneration) throw new Error("opencode_checkpoint_run_changed");
    const [session] = await tx.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, input.companyId), eq(agentTaskSessions.agentId, input.agentId), eq(agentTaskSessions.adapterType, input.adapterType), eq(agentTaskSessions.taskKey, input.taskKey))).for("update", { noWait: true }).limit(1);
    const previous = record(session?.sessionParamsJson);
    const native = previous?.opencodeSharedV2 === undefined ? null : record(previous.opencodeSharedV2);
    const incoming = input.params.opencodeSharedV2 === undefined ? null : record(input.params.opencodeSharedV2);
    if ((previous?.opencodeSharedV2 !== undefined && !native) || (input.params.opencodeSharedV2 !== undefined && !incoming)) throw new Error("opencode_checkpoint_binding_invalid");
    if (native) {
      if (!session || !issue || issue.id !== native.issueId || issue.projectId !== native.projectId || issue.executionRunId !== input.runId || session.lastRunId !== input.runId || native.companyId !== input.companyId || native.agentId !== input.agentId || native.runId !== input.runId || native.taskSessionId !== session.id || native.normalizedSessionId !== input.normalizedSessionId || native.runnerInstanceId !== input.runnerInstanceId || native.providerSessionId !== input.providerSessionId || native.version !== "2.2.5" || (incoming && immutable.some(key => incoming[key] !== native[key]))) throw new Error("opencode_checkpoint_binding_mismatch");
    } else if (incoming) throw new Error("opencode_checkpoint_binding_mismatch");
    if (input.finalRevision) {
      if (!native || !/^[0-9a-f-]{36}$/.test(input.finalRevision) || !input.terminalDigest || !Array.isArray(native.semanticCalls)) throw new Error("opencode_checkpoint_revision_invalid");
      const calls = native.semanticCalls.map(record);
      const terminal = calls.filter(call => call && (call.tool === "paperclip_finish" || call.tool === "paperclip_block") && call.state === "succeeded");
      if (calls.some(call => !call || call.state === "reserved") || terminal.length !== 1 || terminal[0]?.semanticResultDigest !== input.terminalDigest) throw new Error("opencode_checkpoint_terminal_mismatch");
    }
    const { finalCheckpoint: _previousCheckpoint, ...nativeState } = native ?? {};
    const params = { ...input.params, ...(native ? { opencodeSharedV2: { ...nativeState, ...(input.finalRevision ? { finalCheckpoint: { revision: input.finalRevision, runId: input.runId, stateDigest: nativeSha256(nativeState) } } : {}) } } : {}) };
    const [live] = await tx.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, input.runId), gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`))).limit(1);
    if (!live) throw new Error("opencode_checkpoint_lease_lost");
    if (session) return (await tx.update(agentTaskSessions).set({ sessionParamsJson: params, sessionDisplayId: input.displayId, lastRunId: input.runId, lastError: null, updatedAt: new Date() }).where(eq(agentTaskSessions.id, session.id)).returning())[0] ?? null;
    return (await tx.insert(agentTaskSessions).values({ companyId: input.companyId, agentId: input.agentId, adapterType: input.adapterType, taskKey: input.taskKey, sessionParamsJson: params, sessionDisplayId: input.displayId, lastRunId: input.runId, lastError: null }).returning())[0] ?? null;
  });
}
