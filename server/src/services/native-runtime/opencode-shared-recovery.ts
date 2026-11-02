import { agentTaskSessions, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { and, eq, gt, sql } from "drizzle-orm";
import { secretService } from "../secrets.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import type { OpenCodeSharedBinding } from "./opencode-shared-authority.js";
import { nativeSha256 } from "./canonical.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { validatePrpStructuredRunResult, type PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";
import { createOpenCodeBridgeReceiptLink, verifyOpenCodeBridgeReceiptSet } from "./opencode-bridge-receipt-link.js";

export type SharedHostRecord = Readonly<{ pid: number; startedAt: string; executable: string; port: number; namespace: string; workingDirectory?: string; generation: string; secretId: string; secretVersion: number }>;
type NewHost = Omit<SharedHostRecord, "secretId" | "secretVersion"> & { password: string; proxy?: { baseURL: string; token: string } };
type HostSecret = { password: string; proxy?: { baseURL: string; token: string } };
function parseHostSecret(value: string): HostSecret {
  if (!value.startsWith('{')) return { password: value }; // Existing records used a raw password.
  let raw: unknown; try { raw = JSON.parse(value); } catch { throw new Error("opencode_host_secret_invalid"); }
  const payload = object(raw), proxy = payload.proxy === undefined ? undefined : object(payload.proxy);
  if (payload.schema !== "opencode.host-secret.v1" || typeof payload.password !== "string" || !payload.password || (proxy && (typeof proxy.baseURL !== "string" || typeof proxy.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proxy.token)))) throw new Error("opencode_host_secret_invalid");
  if (proxy) { const url = new URL(proxy.baseURL as string); if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/v1" || url.search || url.hash || url.username || url.password) throw new Error("opencode_host_secret_invalid"); }
  return { password: payload.password, ...(proxy ? { proxy: { baseURL: proxy.baseURL as string, token: proxy.token as string } } : {}) };
}
const keys = ["companyId", "projectId", "issueId", "agentId", "runId", "taskSessionId", "normalizedSessionId", "runnerInstanceId", "providerSessionId", "generation", "epoch", "version", "model", "effort"] as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("opencode_recovery_binding_invalid");
  return value as Record<string, unknown>;
}
function validateHost(value: unknown, binding: OpenCodeSharedBinding): SharedHostRecord {
  const host = object(value);
  if (!Number.isSafeInteger(host.pid) || Number(host.pid) < 1 || !Number.isSafeInteger(host.port) || Number(host.port) < 1 || Number(host.port) > 65535 || typeof host.startedAt !== "string" || !Number.isFinite(Date.parse(host.startedAt)) || typeof host.executable !== "string" || !host.executable.startsWith("/") || typeof host.namespace !== "string" || !host.namespace.startsWith("/") || (host.workingDirectory !== undefined && (typeof host.workingDirectory !== "string" || !host.workingDirectory.startsWith("/"))) || host.generation !== binding.generation || typeof host.secretId !== "string" || !host.secretId || !Number.isSafeInteger(host.secretVersion) || Number(host.secretVersion) < 1) throw new Error("opencode_recovery_host_invalid");
  return host as unknown as SharedHostRecord;
}

async function withLockedSession<T>(db: Db, binding: OpenCodeSharedBinding, operation: (tx: Db, session: typeof agentTaskSessions.$inferSelect, params: Record<string, unknown>, native: Record<string, unknown>) => Promise<T>, initialize = false): Promise<T> {
  if (binding.version !== "2.2.5" || keys.some(key => typeof binding[key] !== "string" || !binding[key]) || !binding.providerSessionId.startsWith("ses_") || !Number.isSafeInteger(binding.leaseAttempt) || !Number.isSafeInteger(binding.controllerGeneration) || !(binding.controllerProcessStartedAt instanceof Date) || !Number.isFinite(binding.controllerProcessStartedAt.getTime())) throw new Error("opencode_recovery_binding_invalid");
  const current = await currentNativeControllerIdentity();
  if (current.pid !== binding.controllerPid || current.bootId !== binding.controllerBootId || current.processStartedAt.getTime() !== binding.controllerProcessStartedAt.getTime()) throw new Error("opencode_recovery_foreign_controller");
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [lease] = await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, binding.runId), eq(nativeRunFinalizations.companyId, binding.companyId), eq(nativeRunFinalizations.issueId, binding.issueId), eq(nativeRunFinalizations.leaseOwner, binding.leaseOwner), eq(nativeRunFinalizations.attempt, binding.leaseAttempt), eq(nativeRunFinalizations.controllerBootId, binding.controllerBootId), eq(nativeRunFinalizations.controllerPid, binding.controllerPid), eq(nativeRunFinalizations.controllerProcessStartedAt, binding.controllerProcessStartedAt), eq(nativeRunFinalizations.controllerGeneration, binding.controllerGeneration), gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`))).for("update", { noWait: true }).limit(1);
    if (!lease) throw new Error("opencode_recovery_lease_lost");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.nativeIssueId, binding.issueId), eq(heartbeatRuns.nativeSessionId, binding.normalizedSessionId), eq(heartbeatRuns.runnerInstanceId, binding.runnerInstanceId), eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"))).for("update", { noWait: true }).limit(1);
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId), eq(issues.projectId, binding.projectId), eq(issues.executionRunId, binding.runId))).for("update", { noWait: true }).limit(1);
    const [session] = await tx.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.id, binding.taskSessionId), eq(agentTaskSessions.companyId, binding.companyId), eq(agentTaskSessions.agentId, binding.agentId), eq(agentTaskSessions.lastRunId, binding.runId), eq(agentTaskSessions.adapterType, "paperclip_runner"))).for("update", { noWait: true }).limit(1);
    if (!run || !issue || !session) throw new Error("opencode_recovery_run_mismatch");
    const params = object(session.sessionParamsJson);
    const native = params.opencodeSharedV2 === undefined && initialize
      ? { ...Object.fromEntries(keys.map(key => [key, binding[key]])), cursor: null }
      : object(params.opencodeSharedV2);
    if (keys.some(key => native[key] !== binding[key]) || !(native.cursor === null || (Number.isSafeInteger(native.cursor) && Number(native.cursor) >= 0))) throw new Error("opencode_recovery_binding_mismatch");
    const result = await operation(tx, session, params, native);
    const [live] = await tx.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, binding.runId), gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`))).limit(1);
    if (!live) throw new Error("opencode_recovery_lease_lost");
    return result;
  });
}

/** Only a live, already bound controller may persist a host. Password stays in the encrypted secret provider. */
export async function persistOpenCodeHost(db: Db, binding: OpenCodeSharedBinding, host: NewHost, creationIntent?: { sessionId: string; model: string; effort: string; workingDirectory: string }): Promise<void> {
  if (host.generation !== binding.generation || !host.password) throw new Error("opencode_recovery_host_invalid");
  if (creationIntent && (creationIntent.sessionId !== binding.providerSessionId || creationIntent.model !== binding.model || creationIntent.effort !== binding.effort || creationIntent.workingDirectory !== host.workingDirectory)) throw new Error("opencode_creation_binding_invalid");
  await withLockedSession(db, binding, async (tx, session, params, native) => {
    if (native.host !== undefined) throw new Error("opencode_recovery_host_exists");
    const value = host.proxy ? JSON.stringify({ schema: "opencode.host-secret.v1", password: host.password, proxy: host.proxy }) : host.password;
    parseHostSecret(value);
    const secret = await secretService(tx).create(binding.companyId, { name: `opencode-shared-${binding.generation}-${binding.taskSessionId}`, provider: "local_encrypted", value, description: "OpenCode shared host authentication" });
    const { password: _password, proxy: _proxy, ...identity } = host;
    const record = validateHost({ ...identity, secretId: secret.id, secretVersion: secret.latestVersion }, binding);
    await tx.update(agentTaskSessions).set({ sessionParamsJson: { ...params, opencodeSharedV2: { ...native, host: record, ...(creationIntent ? { sessionCreation: { ...creationIntent, state: "reserved" } } : {}) } }, updatedAt: sql`clock_timestamp()` }).where(eq(agentTaskSessions.id, session.id));
  }, true);
}

/** Seal an observed exact session; no retry authority is derived from intent. */
export async function completeOpenCodeSessionCreation(db: Db, binding: OpenCodeSharedBinding, workingDirectory: string): Promise<void> {
  await withLockedSession(db, binding, async (tx, session, params, native) => {
    const intent = object(native.sessionCreation), host = validateHost(native.host, binding);
    if (intent.state !== "reserved" || intent.sessionId !== binding.providerSessionId || intent.model !== binding.model || intent.effort !== binding.effort || intent.workingDirectory !== workingDirectory || host.workingDirectory !== workingDirectory) throw new Error("opencode_creation_binding_invalid");
    await tx.update(agentTaskSessions).set({ sessionParamsJson: { ...params, opencodeSharedV2: { ...native, sessionCreation: { ...intent, state: "observed" } } }, updatedAt: sql`clock_timestamp()` }).where(eq(agentTaskSessions.id, session.id));
  });
}

/** Reads only under this controller's current lease; callers must attest the live OS socket before use. */
export async function readOpenCodeHost(db: Db, binding: OpenCodeSharedBinding): Promise<{ host: SharedHostRecord; password: string }> {
  return withLockedSession(db, binding, async (tx, _session, _params, native) => {
    if (native.sessionCreation !== undefined && object(native.sessionCreation).state !== "observed") throw new Error("opencode_creation_unconfirmed");
    const host = validateHost(native.host, binding);
    const value = await secretService(tx).resolveSecretValue(binding.companyId, host.secretId, host.secretVersion, { accessContext: { consumerType: "system", consumerId: "opencode-shared-recovery", actorType: "system", actorId: "opencode-shared-recovery" } });
    return { host, password: parseHostSecret(value).password };
  });
}

/** Private restoration material, available only to the exact current controller lease. */
export async function readOpenCodeHostRestoration(db: Db, binding: OpenCodeSharedBinding): Promise<{ host: SharedHostRecord; password: string; proxy: { baseURL: string; token: string } }> {
  return withLockedSession(db, binding, async (tx, _session, _params, native) => {
    if (native.sessionCreation !== undefined && object(native.sessionCreation).state !== "observed") throw new Error("opencode_creation_unconfirmed");
    if (native.mutations !== undefined && !Array.isArray(native.mutations)) throw new Error("opencode_mutation_history_invalid");
    if (native.semanticCalls !== undefined && !Array.isArray(native.semanticCalls)) throw new Error("opencode_semantic_history_invalid");
    const mutations = ((native.mutations ?? []) as unknown[]).map(object), calls = ((native.semanticCalls ?? []) as unknown[]).map(object);
    // An acknowledged prompt does not prove that its provider work ended.
    // Until native quiescence and full receipt reconciliation are available,
    // restore write-capable listeners only before any work was admitted.
    if (mutations.length || calls.length) throw new Error("opencode_recovery_outcome_unknown");
    const host = validateHost(native.host, binding);
    const value = await secretService(tx).resolveSecretValue(binding.companyId, host.secretId, host.secretVersion, { accessContext: { consumerType: "system", consumerId: "opencode-shared-recovery", actorType: "system", actorId: "opencode-shared-recovery" } });
    const secret = parseHostSecret(value);
    if (!secret.proxy) throw new Error("opencode_proxy_restoration_unavailable");
    return { host, password: secret.password, proxy: secret.proxy };
  });
}

/** One-shot durable reservation; a lost MCP replacement ACK is never replayed. */
export async function reserveOpenCodeMcpRestoration(db: Db, binding: OpenCodeSharedBinding, digest: string) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("opencode_mcp_restoration_invalid");
  await withLockedSession(db, binding, async (tx, session, params, native) => {
    if ((native.mutations !== undefined && (!Array.isArray(native.mutations) || native.mutations.length)) || (native.semanticCalls !== undefined && (!Array.isArray(native.semanticCalls) || native.semanticCalls.length))) throw new Error("opencode_recovery_outcome_unknown");
    const prior = native.mcpRestoration === undefined ? null : object(native.mcpRestoration);
    if (prior !== null) throw new Error("opencode_mcp_restoration_outcome_unknown");
    await tx.update(agentTaskSessions).set({ sessionParamsJson: { ...params, opencodeSharedV2: { ...native, mcpRestoration: { digest, state: "reserved" } } }, updatedAt: sql`clock_timestamp()` }).where(eq(agentTaskSessions.id, session.id));
  });
}

/** Keep the exact lease row locked while the bounded one-shot replacement is
 * delivered; expiry must exceed the network timeout by a safety margin. */
export async function deliverOpenCodeMcpRestoration(db: Db, binding: OpenCodeSharedBinding, digest: string, deliver: () => Promise<void>) {
  await withLockedSession(db, binding, async (tx, session, params, native) => {
    const prior = object(native.mcpRestoration);
    if (!/^[a-f0-9]{64}$/.test(digest) || prior.digest !== digest || prior.state !== "reserved") throw new Error("opencode_mcp_restoration_outcome_unknown");
    if ((native.mutations !== undefined && (!Array.isArray(native.mutations) || native.mutations.length)) || (native.semanticCalls !== undefined && (!Array.isArray(native.semanticCalls) || native.semanticCalls.length))) throw new Error("opencode_recovery_outcome_unknown");
    const [lease] = await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, binding.runId), gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp() + interval '25 seconds'`))).limit(1);
    if (!lease) throw new Error("opencode_recovery_lease_margin_insufficient");
    await deliver();
    await tx.update(agentTaskSessions).set({ sessionParamsJson: { ...params, opencodeSharedV2: { ...native, mcpRestoration: { digest, state: "completed" } } }, updatedAt: sql`clock_timestamp()` }).where(eq(agentTaskSessions.id, session.id));
  });
}

/** Reserve before invoking authority and persist only digest receipts. A
 * reserved call is uncertain after interruption and is never re-executed. */
export async function transitionOpenCodeSemanticCall(db: Db, binding: OpenCodeSharedBinding, input: { callId: string; tool: string; arguments: unknown; outcome?: { result: unknown; isError: boolean } }): Promise<void> {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(input.callId) || !/^[A-Za-z0-9._:-]{1,200}$/.test(input.tool)) throw new Error("opencode_semantic_call_invalid");
  const digest = nativeSha256({ tool: input.tool, arguments: input.arguments });
  const operationId = nativeSha256({ epoch: binding.epoch, sessionId: binding.providerSessionId, callId: input.callId });
  await withLockedSession(db, binding, async (tx, session, params, native) => {
    if (native.semanticCalls !== undefined && !Array.isArray(native.semanticCalls)) throw new Error("opencode_semantic_history_invalid");
    const history = (native.semanticCalls ?? []) as unknown[];
    if (history.length > 2048) throw new Error("opencode_semantic_history_invalid");
    const entries = history.map(object);
    if (entries.some(entry => typeof entry.operationId !== "string" || typeof entry.digest !== "string" || typeof entry.tool !== "string" || !["reserved", "returned", "succeeded", "failed"].includes(String(entry.state)))) throw new Error("opencode_semantic_history_invalid");
    const prior = entries.find(entry => entry.operationId === operationId);
    if (input.outcome === undefined) {
      if (prior) throw new Error(prior.digest === digest ? "opencode_semantic_outcome_unknown_or_recorded" : "opencode_semantic_identity_conflict");
      if (entries.length >= 2048) throw new Error("opencode_semantic_capacity_exhausted");
      if (entries.some(entry => (entry.tool === "paperclip_finish" || entry.tool === "paperclip_block") && entry.state !== "failed")) throw new Error("opencode_semantic_terminal_already_recorded");
      if ((input.tool === "paperclip_finish" || input.tool === "paperclip_block") && entries.some(entry => entry.state === "reserved")) throw new Error("opencode_semantic_outcome_unknown");
      const authorityReceipt = createOpenCodeBridgeReceiptLink(binding, input);
      entries.push({ operationId, digest, tool: input.tool, state: "reserved", ...(authorityReceipt ? { authorityReceipt } : {}) });
    } else {
      if (!prior || prior.digest !== digest || prior.state !== "reserved") throw new Error("opencode_semantic_receipt_mismatch");
      prior.state = input.outcome.isError ? "failed" : (input.tool === "paperclip_finish" || input.tool === "paperclip_block") ? "succeeded" : "returned";
      prior.resultDigest = nativeSha256(input.outcome.result);
      if (!input.outcome.isError && (input.tool === "paperclip_finish" || input.tool === "paperclip_block")) {
        const validated = validatePrpStructuredRunResult(object(input.outcome.result).result);
        if (!validated.ok || (input.tool === "paperclip_block") !== (validated.result.reportedWorkDisposition === "blocked")) throw new Error("opencode_semantic_result_invalid");
        prior.semanticResult = validated.result;
        prior.semanticResultDigest = nativeSha256(validated.result);
        prior.recordedAt = new Date().toISOString();
      }
    }
    await appendHeartbeatRunEvent(tx, { companyId: binding.companyId, agentId: binding.agentId, runId: binding.runId, eventType: "opencode.shared.semantic", stream: "system", payload: { sessionId: binding.providerSessionId, epoch: binding.epoch, operationId, digest, state: input.outcome === undefined ? "reserved" : input.outcome.isError ? "failed" : (input.tool === "paperclip_finish" || input.tool === "paperclip_block") ? "succeeded" : "returned", ...(input.outcome ? { resultDigest: nativeSha256(input.outcome.result) } : {}), origin: "unknown" } });
    await tx.update(agentTaskSessions).set({ sessionParamsJson: { ...params, opencodeSharedV2: { ...native, semanticCalls: entries } }, updatedAt: sql`clock_timestamp()` }).where(eq(agentTaskSessions.id, binding.taskSessionId));
  });
}

/** Inspect an already returned bridge receipt under the exact live lease.
 * This is not a quiescence proof, restoration grant, or retry authority. */
export async function hasOpenCodeBridgeAuthorityReceipt(db: Db, binding: OpenCodeSharedBinding, operationId: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(operationId)) return false;
  return withLockedSession(db, binding, async (tx, _session, _params, native) => {
    if (!Array.isArray(native.semanticCalls)) return false;
    const [run] = await tx.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.agentId, binding.agentId))).limit(1);
    return !!run && verifyOpenCodeBridgeReceiptSet(binding, native.semanticCalls, run.resultJson, operationId);
  });
}

/** Reconstruct only a completed receipt under the current exact controller lease. */
export async function readOpenCodeTerminalReceipt(db: Db, binding: OpenCodeSharedBinding): Promise<{ result: PrpStructuredRunResult; operationId: string; recordedAt: string } | null> {
  return withLockedSession(db, binding, async (_tx, _session, _params, native) => {
    if (native.semanticCalls === undefined) return null;
    if (!Array.isArray(native.semanticCalls)) throw new Error("opencode_semantic_history_invalid");
    const calls = native.semanticCalls.map(object);
    const terminal = calls.filter(call => (call.tool === "paperclip_finish" || call.tool === "paperclip_block") && call.state === "succeeded");
    if (!terminal.length) return null;
    if (calls.some(call => call.state === "reserved")) throw new Error("opencode_semantic_outcome_unknown");
    if (terminal.length !== 1) throw new Error("opencode_semantic_history_invalid");
    const result = validatePrpStructuredRunResult(terminal[0]!.semanticResult);
    if (!result.ok || nativeSha256(result.result) !== terminal[0]!.semanticResultDigest || (terminal[0]!.tool === "paperclip_block") !== (result.result.reportedWorkDisposition === "blocked") || typeof terminal[0]!.operationId !== "string" || !/^[a-f0-9]{64}$/.test(terminal[0]!.operationId) || typeof terminal[0]!.recordedAt !== "string" || !Number.isFinite(Date.parse(terminal[0]!.recordedAt))) throw new Error("opencode_semantic_receipt_mismatch");
    return { result: result.result, operationId: terminal[0]!.operationId, recordedAt: terminal[0]!.recordedAt };
  });
}

/** Inspect a reserved call for read-only authority receipt recovery. This is
 * not permission to dispatch it again. */
export async function isOpenCodeSemanticCallReserved(db: Db, binding: OpenCodeSharedBinding, input: { callId: string; tool: string; arguments: unknown }): Promise<boolean> {
  const digest = nativeSha256({ tool: input.tool, arguments: input.arguments });
  const operationId = nativeSha256({ epoch: binding.epoch, sessionId: binding.providerSessionId, callId: input.callId });
  return withLockedSession(db, binding, async (_tx, _session, _params, native) => {
    if (!Array.isArray(native.semanticCalls)) return false;
    const matches = native.semanticCalls.map(object).filter(entry => entry.operationId === operationId);
    return matches.length === 1 && matches[0]!.digest === digest && matches[0]!.tool === input.tool && matches[0]!.state === "reserved";
  });
}

/** Atomically fence a single automated prompt; a reserved operation is never replayed. */
export async function transitionOpenCodeMutation(db: Db, binding: OpenCodeSharedBinding, input: { id: string; digest: string; transition: "reserve" | "check" | "acknowledge" }): Promise<void> {
  if (!/^msg_[A-Za-z0-9_-]+$/.test(input.id) || !/^[a-f0-9]{64}$/.test(input.digest)) throw new Error("opencode_mutation_identity_invalid");
  await withLockedSession(db, binding, async (tx, session, params, native) => {
    if (native.mutations !== undefined && !Array.isArray(native.mutations)) throw new Error("opencode_mutation_history_invalid");
    const history = (native.mutations ?? []) as unknown[];
    if (history.length > 128) throw new Error("opencode_mutation_history_invalid");
    const entries = history.map(object);
    if (entries.some(entry => typeof entry.id !== "string" || typeof entry.digest !== "string" || !["reserved", "acknowledged"].includes(String(entry.state)))) throw new Error("opencode_mutation_history_invalid");
    const existing = entries.find(entry => entry.id === input.id);
    if (input.transition === "reserve") {
      if (native.semanticCalls !== undefined && !Array.isArray(native.semanticCalls)) throw new Error("opencode_semantic_history_invalid");
      if (((native.semanticCalls ?? []) as unknown[]).map(object).some(entry => (entry.tool === "paperclip_finish" || entry.tool === "paperclip_block") && entry.state !== "failed")) throw new Error("opencode_semantic_terminal_already_recorded");
      // Any unresolved operation blocks another automated send, including a
      // repeated ID: acknowledgement loss never authorizes a replay.
      if (entries.some(entry => entry.state !== "acknowledged")) throw new Error("opencode_mutation_outcome_unknown");
      if (existing) throw new Error(existing.digest === input.digest ? "opencode_mutation_already_recorded" : "opencode_mutation_digest_mismatch");
      if (entries.length >= 128) throw new Error("opencode_mutation_history_full");
    } else if (!existing || existing.id !== input.id || existing.digest !== input.digest || existing.state !== "reserved") throw new Error("opencode_mutation_reservation_mismatch");
    if (input.transition === "check") return;
    const mutation = { id: input.id, digest: input.digest, state: input.transition === "reserve" ? "reserved" : "acknowledged" };
    const mutations = input.transition === "reserve" ? [...entries, mutation] : entries.map(entry => entry.id === input.id ? mutation : entry);
    await tx.update(agentTaskSessions).set({ sessionParamsJson: { ...params, opencodeSharedV2: { ...native, mutations } }, updatedAt: sql`clock_timestamp()` }).where(eq(agentTaskSessions.id, session.id));
  });
}
