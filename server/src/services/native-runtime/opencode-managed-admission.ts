import { randomUUID } from "node:crypto";
import { agentTaskSessions, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { and, eq, gt, sql } from "drizzle-orm";
import type { NativeExecutionInputV12 } from "../../vendor/paperclip-runner/index.js";
import { PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA, PRP_COMPLETION_TOOL_DESCRIPTION, startOpenCodeProviderProxy } from "../../vendor/paperclip-runner/index.js";
import { startOpenCodeSharedHost } from "./opencode-shared-host.js";
import { createOpenCodeSemanticHandler } from "./opencode-semantic-handler.js";
import { createOpenCodeNativePort } from "./opencode-native-port.js";
import type { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import type { PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";
import type { OpenCodeSharedBinding } from "./opencode-shared-authority.js";
import { resolveOpenCodeSharedProvider } from "./opencode-provider-profile.js";
import { retainOpenCodeManagedHost } from "./opencode-host-registry.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";

const pending = new Map<string, { host: Awaited<ReturnType<typeof startOpenCodeSharedHost>>; binding: OpenCodeSharedBinding }>();
const retained = new Map<string, { host: Awaited<ReturnType<typeof startOpenCodeSharedHost>>; binding: OpenCodeSharedBinding; durable: boolean; cause?: unknown }>();
const starting = new Set<string>();

/** Failure disposition must hold while this exact controller still owns a host.
 * `durable` says whether its host identity and reserved create intent were saved;
 * false is still a hold, never evidence that no native process exists. */
export function getOpenCodeRetainedOwnership(input: { runId: string; leaseOwner: string; attempt: number; controllerGeneration: number }) {
  const item = retained.get(input.runId);
  if (!item) return null;
  if (item.binding.leaseOwner !== input.leaseOwner || item.binding.leaseAttempt !== input.attempt || item.binding.controllerGeneration !== input.controllerGeneration) throw new Error("opencode_retained_owner_mismatch");
  return { binding: { ...item.binding, controllerProcessStartedAt: new Date(item.binding.controllerProcessStartedAt) }, durable: item.durable, cause: item.cause };
}

/** Reconstruct only the existing session identity under a successor's already
 * claimed lease. No new identity, prompt or authority is minted here. */
export async function loadOpenCodeSuccessorBinding(db: Db, input: { execution: NativeExecutionInputV12; runnerInstanceId: string; leaseOwner: string; attempt: number; controller: { bootId: string; pid: number; processStartedAt: Date } }): Promise<OpenCodeSharedBinding> {
  const b = input.execution.binding, current = await currentNativeControllerIdentity();
  if (current.pid !== input.controller.pid || current.bootId !== input.controller.bootId || current.processStartedAt.getTime() !== input.controller.processStartedAt.getTime()) throw new Error("opencode_recovery_foreign_controller");
  return db.transaction(async tx => {
    const [lease] = await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, b.runId), eq(nativeRunFinalizations.companyId, b.companyId), eq(nativeRunFinalizations.issueId, b.issueId), eq(nativeRunFinalizations.leaseOwner, input.leaseOwner), eq(nativeRunFinalizations.attempt, input.attempt), eq(nativeRunFinalizations.controllerBootId, input.controller.bootId), eq(nativeRunFinalizations.controllerPid, input.controller.pid), eq(nativeRunFinalizations.controllerProcessStartedAt, input.controller.processStartedAt), gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`))).for("update", { noWait: true }).limit(1);
    if (!lease) throw new Error("opencode_recovery_lease_lost");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, b.runId), eq(heartbeatRuns.companyId, b.companyId), eq(heartbeatRuns.agentId, b.agentId), eq(heartbeatRuns.nativeIssueId, b.issueId), eq(heartbeatRuns.nativeSessionId, input.execution.session.normalizedSessionId!), eq(heartbeatRuns.runnerInstanceId, input.runnerInstanceId), eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.runtimeMode, "native"))).for("update", { noWait: true }).limit(1);
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, b.issueId), eq(issues.companyId, b.companyId), eq(issues.executionRunId, b.runId))).for("update", { noWait: true }).limit(1);
    const [session] = await tx.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, b.companyId), eq(agentTaskSessions.agentId, b.agentId), eq(agentTaskSessions.adapterType, "paperclip_runner"), eq(agentTaskSessions.taskKey, b.issueId), eq(agentTaskSessions.lastRunId, b.runId))).for("update", { noWait: true }).limit(1);
    const params = session?.sessionParamsJson, native = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>).opencodeSharedV2 : null;
    if (!run || !issue?.projectId || !session || !native || typeof native !== "object" || Array.isArray(native)) throw new Error("opencode_recovery_binding_mismatch");
    const saved = native as Record<string, unknown>;
    const expected: Record<string, string> = { companyId: b.companyId, projectId: issue.projectId, issueId: b.issueId, agentId: b.agentId, runId: b.runId, taskSessionId: session.id, normalizedSessionId: input.execution.session.normalizedSessionId!, runnerInstanceId: input.runnerInstanceId, version: "2.2.5", model: input.execution.provider.model, effort: input.execution.provider.effort };
    if (Object.entries(expected).some(([key, value]) => !value || saved[key] !== value) || typeof saved.providerSessionId !== "string" || !/^ses_[A-Za-z0-9_-]+$/.test(saved.providerSessionId) || typeof saved.generation !== "string" || !saved.generation || typeof saved.epoch !== "string" || !saved.epoch) throw new Error("opencode_recovery_binding_mismatch");
    const [live] = await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, b.runId), gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`))).limit(1);
    if (!live) throw new Error("opencode_recovery_lease_lost");
    return { ...b, projectId: issue.projectId, taskSessionId: session.id, normalizedSessionId: input.execution.session.normalizedSessionId!, runnerInstanceId: input.runnerInstanceId, providerSessionId: saved.providerSessionId, generation: saved.generation, epoch: saved.epoch, version: "2.2.5", model: input.execution.provider.model, effort: input.execution.provider.effort, leaseOwner: input.leaseOwner, leaseAttempt: input.attempt, controllerBootId: input.controller.bootId, controllerPid: input.controller.pid, controllerProcessStartedAt: input.controller.processStartedAt, controllerGeneration: lease.controllerGeneration };
  });
}

/** Claim the existing task-session row under the same controller lease before
 * allocating a native process or sending a session-create request. */
export async function claimOpenCodeTaskSession(db: Db, input: { execution: NativeExecutionInputV12; runnerInstanceId: string; leaseOwner: string; attempt: number; controller: { bootId: string; pid: number; processStartedAt: Date } }) {
  const b = input.execution.binding;
  return db.transaction(async tx => {
    const [lease] = await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, b.runId), eq(nativeRunFinalizations.companyId, b.companyId), eq(nativeRunFinalizations.issueId, b.issueId), eq(nativeRunFinalizations.leaseOwner, input.leaseOwner), eq(nativeRunFinalizations.attempt, input.attempt), eq(nativeRunFinalizations.controllerBootId, input.controller.bootId), eq(nativeRunFinalizations.controllerPid, input.controller.pid), eq(nativeRunFinalizations.controllerProcessStartedAt, input.controller.processStartedAt), gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`))).for("update", { noWait: true }).limit(1);
    if (!lease) throw new Error("opencode_admission_lease_lost");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, b.runId), eq(heartbeatRuns.companyId, b.companyId), eq(heartbeatRuns.agentId, b.agentId), eq(heartbeatRuns.nativeIssueId, b.issueId), eq(heartbeatRuns.nativeSessionId, input.execution.session.normalizedSessionId!), eq(heartbeatRuns.runnerInstanceId, input.runnerInstanceId), eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.runtimeMode, "native"))).for("update", { noWait: true }).limit(1);
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, b.issueId), eq(issues.companyId, b.companyId), eq(issues.executionRunId, b.runId))).for("update", { noWait: true }).limit(1);
    if (!run || !issue?.projectId) throw new Error("opencode_admission_run_mismatch");
    const [existing] = await tx.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, b.companyId), eq(agentTaskSessions.agentId, b.agentId), eq(agentTaskSessions.adapterType, "paperclip_runner"), eq(agentTaskSessions.taskKey, b.issueId))).for("update", { noWait: true }).limit(1);
    if (existing) {
      const params = existing.sessionParamsJson;
      if (!params || typeof params !== "object" || Array.isArray(params) || "opencodeSharedV2" in params) throw new Error("opencode_admission_existing_session_requires_recovery");
      await tx.update(agentTaskSessions).set({ lastRunId: b.runId, updatedAt: sql`clock_timestamp()` }).where(eq(agentTaskSessions.id, existing.id));
    } else {
      await tx.insert(agentTaskSessions).values({ id: randomUUID(), companyId: b.companyId, agentId: b.agentId, adapterType: "paperclip_runner", taskKey: b.issueId, lastRunId: b.runId, sessionParamsJson: {} });
    }
    const [session] = await tx.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, b.companyId), eq(agentTaskSessions.agentId, b.agentId), eq(agentTaskSessions.adapterType, "paperclip_runner"), eq(agentTaskSessions.taskKey, b.issueId), eq(agentTaskSessions.lastRunId, b.runId))).limit(1);
    const [live] = await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, b.runId), gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`))).limit(1);
    if (!session || !live) throw new Error("opencode_admission_lease_lost");
    return { taskSessionId: session.id, projectId: issue.projectId, controllerGeneration: lease.controllerGeneration };
  });
}

/** Create one private, exactly bound host; uncertain creates retain their owner
 * handle for explicit reconciliation and are never sent again. */
export async function startOpenCodeManagedBackend(db: Db, input: { execution: NativeExecutionInputV12; runnerInstanceId: string; leaseOwner: string; attempt: number; controller: { bootId: string; pid: number; processStartedAt: Date }; executable: string; dataRoot: string; environment: NodeJS.ProcessEnv; authority: PaperclipRunnerToolAuthority; completionFeedback: (result: PrpStructuredRunResult) => Promise<string> }) {
  const b = input.execution.binding, cwd = input.execution.workspace.cwd;
  if (!cwd || starting.has(b.runId) || pending.has(b.runId) || retained.has(b.runId)) throw new Error("opencode_admission_unavailable_or_pending");
  starting.add(b.runId);
  try {
  const profile = await resolveOpenCodeSharedProvider({ model: input.execution.provider.model, environment: input.environment });
  const claim = await claimOpenCodeTaskSession(db, input);
  const tools = [...input.authority.definitions(), ...["paperclip_finish", "paperclip_block"].map(name => ({ name, description: PRP_COMPLETION_TOOL_DESCRIPTION, inputSchema: PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA }))];
  const proxy = await startOpenCodeProviderProxy(profile.baseUrl, profile.key, profile.model, input.environment);
  const host = await startOpenCodeSharedHost({ executable: input.executable, dataRoot: input.dataRoot, workspaceCwd: cwd, provider: { provider: profile.provider, model: profile.model, baseURL: proxy.baseURL, token: proxy.token }, onShutdown: proxy.close, mcp: { tools,
    createHandler: binding => createOpenCodeSemanticHandler(db, binding, { execute: call => input.authority.execute(call), recover: call => input.authority.recover(call), completionFeedback: input.completionFeedback, completionContract: { revision: input.execution.completionContract.contract.revision, criterionIds: input.execution.completionContract.contract.criteria.map(criterion => criterion.id) } }),
  } }).catch(async error => { await proxy.close(); throw error; });
  const binding: OpenCodeSharedBinding = { ...b, projectId: claim.projectId, taskSessionId: claim.taskSessionId, normalizedSessionId: input.execution.session.normalizedSessionId!, runnerInstanceId: input.runnerInstanceId, providerSessionId: `ses_${randomUUID()}`, generation: host.generation, epoch: randomUUID(), version: "2.2.5", model: input.execution.provider.model, effort: input.execution.provider.effort, leaseOwner: input.leaseOwner, leaseAttempt: input.attempt, controllerBootId: input.controller.bootId, controllerPid: input.controller.pid, controllerProcessStartedAt: input.controller.processStartedAt, controllerGeneration: claim.controllerGeneration };
  const guard = { host, binding: Object.freeze({ ...binding, controllerProcessStartedAt: new Date(binding.controllerProcessStartedAt) }), durable: false, cause: undefined as unknown };
  retained.set(b.runId, guard);
  pending.set(b.runId, { host, binding });
  try {
    await host.prepareManagedSession(db, binding);
    guard.durable = true;
    try { await host.verifyCatalog(input.execution.provider.model, input.execution.provider.effort); }
    catch (error) {
      guard.cause = error;
      try { await host.shutdown(); pending.delete(b.runId); retained.delete(b.runId); } catch { /* retain original failure and owner */ }
      throw error;
    }
    try { await host.createManagedSession(db, binding, true); }
    catch (error) { try { await host.reconcileManagedSession(db, binding); } catch { throw new Error("opencode_creation_outcome_unknown", { cause: error }); } }
    retainOpenCodeManagedHost(binding, host);
    pending.delete(b.runId);
    return { host, binding, admitted: createOpenCodeNativePort(db, binding, host) };
  } catch (error) { guard.cause ??= error; throw error; }
  } finally { starting.delete(b.runId); }
}

/** Read-only native reconciliation of a same-controller lost create ACK. */
export async function reconcilePendingOpenCodeManagedBackend(db: Db, runId: string) {
  const item = pending.get(runId);
  if (!item) throw new Error("opencode_creation_not_pending");
  await item.host.reconcileManagedSession(db, item.binding);
  retainOpenCodeManagedHost(item.binding, item.host);
  pending.delete(runId);
  return { ...item, admitted: createOpenCodeNativePort(db, item.binding, item.host) };
}
