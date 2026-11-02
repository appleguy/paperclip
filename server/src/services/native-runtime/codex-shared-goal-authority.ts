import { agentSessionGoalActions, agentTaskSessions, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { assertCodexNativeDelegation } from "./codex-native-delegation.js";

/** Server-established identity; never construct this from an HTTP request. */
export type CodexSharedGoalBinding = Readonly<{
  companyId: string; projectId: string; issueId: string; agentId: string; runId: string;
  goalId: string; taskSessionId: string; normalizedSessionId: string; runnerInstanceId: string;
  executionWorkspaceId?: string; environmentLeaseId?: string;
  hostId?: string; delegationGrantId?: string; delegationRevision?: string;
  threadId: string; processGeneration: string; protocolVersion: string; model: string; effort: string;
  writerGrantId: string; writerEpoch: number;
  leaseOwner: string; leaseAttempt: number; controllerBootId: string; controllerPid: number;
  controllerProcessStartedAt: Date; controllerGeneration: number;
}>;
const nativeKeys = ["companyId", "projectId", "issueId", "agentId", "runId", "goalId", "taskSessionId", "normalizedSessionId", "runnerInstanceId", "executionWorkspaceId", "environmentLeaseId", "hostId", "delegationGrantId", "delegationRevision", "threadId", "processGeneration", "protocolVersion", "model", "effort", "writerGrantId", "writerEpoch"] as const;
const obj = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function validate(b: CodexSharedGoalBinding) {
  if (nativeKeys.some(k => k !== "writerEpoch" && k !== "executionWorkspaceId" && k !== "environmentLeaseId" && k !== "hostId" && k !== "delegationGrantId" && k !== "delegationRevision" && (typeof b[k] !== "string" || !(b[k] as string).trim())) ||
      ![b.writerEpoch,b.leaseAttempt,b.controllerPid,b.controllerGeneration].every(n => Number.isSafeInteger(n) && n > 0) ||
      !b.leaseOwner || !b.controllerBootId || !(b.controllerProcessStartedAt instanceof Date) || !Number.isFinite(b.controllerProcessStartedAt.getTime())) throw new Error("codex_shared_binding_invalid");
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** nowait row locks lose to concurrent executor writes; a transaction aborted before any external send has no side effect, so retry it briefly. `sendStarted` must report true once a send was issued: an unknown write is never retried. */
async function lockRetryTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>, sendStarted: () => boolean = () => false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.transaction(fn); }
    catch (error) {
      const code = (error as { code?: unknown; cause?: { code?: unknown } })?.cause?.code ?? (error as { code?: unknown })?.code;
      const reason = String((error as { cause?: { message?: unknown } })?.cause?.message ?? (error as Error)?.message ?? "");
      if (sendStarted() || code !== "55P03" || !reason.includes("could not obtain lock") || attempt >= 5) throw error; // nowait losses only; lock_timeout keeps its bound
      await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)));
    }
  }
}
async function locked(db: Tx, b: CodexSharedGoalBinding, allowNew = false) {
  const [lease] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.runId,b.runId), eq(nativeRunFinalizations.companyId,b.companyId), eq(nativeRunFinalizations.issueId,b.issueId),
    eq(nativeRunFinalizations.leaseOwner,b.leaseOwner), eq(nativeRunFinalizations.attempt,b.leaseAttempt),
    eq(nativeRunFinalizations.controllerBootId,b.controllerBootId), eq(nativeRunFinalizations.controllerPid,b.controllerPid),
    eq(nativeRunFinalizations.controllerProcessStartedAt,b.controllerProcessStartedAt), eq(nativeRunFinalizations.controllerGeneration,b.controllerGeneration),
    gt(nativeRunFinalizations.leaseExpiresAt,sql`clock_timestamp()`),
  )).for("update",{noWait:true}).limit(1);
  if (!lease) throw new Error("codex_shared_lease_lost");
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,b.runId),eq(heartbeatRuns.companyId,b.companyId),eq(heartbeatRuns.agentId,b.agentId),eq(heartbeatRuns.nativeIssueId,b.issueId),eq(heartbeatRuns.nativeSessionId,b.normalizedSessionId),eq(heartbeatRuns.runnerInstanceId,b.runnerInstanceId),eq(heartbeatRuns.runtimeMode,"native"),eq(heartbeatRuns.status,"running"))).for("update",{noWait:true}).limit(1);
  if (!run) throw new Error("codex_shared_run_mismatch");
  const [issue] = await db.select().from(issues).where(and(eq(issues.id,b.issueId),eq(issues.companyId,b.companyId),eq(issues.projectId,b.projectId),eq(issues.goalId,b.goalId),eq(issues.executionRunId,b.runId),eq(issues.checkoutRunId,b.runId),eq(issues.assigneeAgentId,b.agentId),eq(issues.status,"in_progress"))).for("update",{noWait:true}).limit(1);
  if (!issue) throw new Error("codex_shared_issue_mismatch");
  // The workspace lease is independently revocable. It does not attest the
  // provider account or model. The writer generation is the coordinator's.
  if (!b.executionWorkspaceId || !b.environmentLeaseId) throw new Error("codex_shared_resource_lease_lost");
  if (b.writerGrantId !== b.runId || b.writerEpoch !== b.controllerGeneration) throw new Error("codex_shared_writer_mismatch");
  const [resource] = await db.select({id:environmentLeases.id}).from(environmentLeases).where(and(
    eq(environmentLeases.id,b.environmentLeaseId),eq(environmentLeases.companyId,b.companyId),
    eq(environmentLeases.heartbeatRunId,b.runId),eq(environmentLeases.issueId,b.issueId),
    eq(environmentLeases.executionWorkspaceId,b.executionWorkspaceId),eq(environmentLeases.status,"active"),
    or(isNull(environmentLeases.expiresAt),gt(environmentLeases.expiresAt,sql`clock_timestamp()`)),
  )).for("update",{noWait:true}).limit(1);
  if (!resource) throw new Error("codex_shared_resource_lease_lost");
  await assertCodexNativeDelegation(db,b);
  const [session] = await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.id,b.taskSessionId),eq(agentTaskSessions.companyId,b.companyId),eq(agentTaskSessions.agentId,b.agentId),eq(agentTaskSessions.taskKey,b.issueId),eq(agentTaskSessions.lastRunId,b.runId),eq(agentTaskSessions.adapterType,"paperclip_runner"))).for("update",{noWait:true}).limit(1);
  if (!session) throw new Error("codex_shared_session_mismatch");
  const params=obj(session.sessionParamsJson), native=obj(params.codexSharedGoalV1);
  if (!(allowNew && params.codexSharedGoalV1 === undefined) && nativeKeys.some(k=>native[k]!==b[k])) throw new Error("codex_shared_identity_mismatch");
  const [live] = await db.select({id:nativeRunFinalizations.runId}).from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId,b.runId),gt(nativeRunFinalizations.leaseExpiresAt,sql`clock_timestamp()`))).limit(1);
  if (!live) throw new Error("codex_shared_lease_lost");
  return {session,params,native};
}

/** Recheck all run, writer, workspace and delegation authority before launching Runner. */
export async function preflightCodexManagedThreadBootstrap(db: Db, b: CodexSharedGoalBinding): Promise<void> {
  validate(b);
  await lockRetryTransaction(db, async tx => {
    const {params} = await locked(tx, b, true);
    if (params.codexSharedBootstrapV1 !== undefined || params.codexSharedGoalV1 !== undefined) throw new Error("codex_shared_bootstrap_outcome_unknown");
  });
}

/** Persist a unique create intent before thread/start; any replay is uncertain. */
export async function beginCodexManagedThreadBootstrap(db:Db,b:CodexSharedGoalBinding,input:{bootstrapId:string;configurationDigest:string}):Promise<"fresh"|"existing_or_uncertain"> {
  validate(b);
  if (!input.bootstrapId || input.bootstrapId.length>128 || !digest(input.configurationDigest)) throw new Error("codex_shared_bootstrap_invalid");
  return lockRetryTransaction(db, async tx=>{
    const {session,params}=await locked(tx,b,true);
    if (params.codexSharedBootstrapV1!==undefined || params.codexSharedGoalV1!==undefined) return "existing_or_uncertain";
    const identity=Object.fromEntries(nativeKeys.filter(k=>k!=="threadId").map(k=>[k,b[k]]));
    await tx.update(agentTaskSessions).set({sessionParamsJson:{...params,codexSharedBootstrapV1:{...identity,bootstrapId:input.bootstrapId,configurationDigest:input.configurationDigest,state:"starting"}},updatedAt:sql`clock_timestamp()`}).where(eq(agentTaskSessions.id,b.taskSessionId));
    return "fresh";
  });
}

/** Bind only the exact returned native ID to the original durable create intent. */
export async function completeCodexManagedThreadBootstrap(db:Db,b:CodexSharedGoalBinding,input:{bootstrapId:string;configurationDigest:string}):Promise<void> {
  validate(b);
  await lockRetryTransaction(db, async tx=>{
    const {session,params}=await locked(tx,b,true), bootstrap=obj(params.codexSharedBootstrapV1);
    if (bootstrap.state!=="starting" || bootstrap.bootstrapId!==input.bootstrapId || bootstrap.configurationDigest!==input.configurationDigest || nativeKeys.filter(k=>k!=="threadId").some(k=>bootstrap[k]!==b[k]) || params.codexSharedGoalV1!==undefined) throw new Error("codex_shared_bootstrap_mismatch");
    await tx.update(agentTaskSessions).set({sessionParamsJson:{...params,codexSharedBootstrapV1:{...bootstrap,state:"created",threadId:b.threadId}},updatedAt:sql`clock_timestamp()`}).where(eq(agentTaskSessions.id,b.taskSessionId));
  });
}

/** Reserve observation before connecting. An existing open epoch cannot be replayed. */
export async function beginCodexSharedObservation(db: Db, b: CodexSharedGoalBinding, input: { epochId:string; sourceGoalDigest:string|null }): Promise<"fresh"|"reconciliation_required"> {
  validate(b);
  if (!input.epochId || input.epochId.length>128 || (input.sourceGoalDigest!==null && !digest(input.sourceGoalDigest))) throw new Error("codex_shared_observation_invalid");
  return lockRetryTransaction(db, async tx=>{
    const {session,params,native}=await locked(tx,b,true);
    const epoch=obj(native.observationEpoch);
    if (params.codexSharedGoalV1 !== undefined) {
      // There is no replay cursor in the upstream stream. A previous attach,
      // including a reconnect by the same controller, leaves a possible gap.
      await tx.update(agentTaskSessions).set({sessionParamsJson:{...params,codexSharedGoalV1:{...native,observationEpoch:{...epoch,state:"reconciliation_required"}}},updatedAt:sql`clock_timestamp()`}).where(eq(agentTaskSessions.id,b.taskSessionId));
      return "reconciliation_required";
    }
    if (params.codexSharedBootstrapV1!==undefined) {
      const bootstrap=obj(params.codexSharedBootstrapV1);
      if (bootstrap.state!=="created" || bootstrap.threadId!==b.threadId || nativeKeys.filter(k=>k!=="threadId").some(k=>bootstrap[k]!==b[k])) throw new Error("codex_shared_bootstrap_mismatch");
    }
    const identity=Object.fromEntries(nativeKeys.map(k=>[k,b[k]]));
    await tx.update(agentTaskSessions).set({sessionParamsJson:{...params,codexSharedGoalV1:{...identity,sourceGoalDigest:input.sourceGoalDigest,observationEpoch:{id:input.epochId,state:"attaching",controllerBootId:b.controllerBootId,controllerGeneration:b.controllerGeneration}}},updatedAt:sql`clock_timestamp()`}).where(eq(agentTaskSessions.id,b.taskSessionId));
    return "fresh";
  });
}

/** Called only after the exact authenticated socket and thread have been attached. */
export async function activateCodexSharedObservation(db:Db,b:CodexSharedGoalBinding,epochId:string):Promise<void> {
  validate(b);
  await lockRetryTransaction(db, async tx=>{
    const {session,params,native}=await locked(tx,b);
    const epoch=obj(native.observationEpoch);
    if (!epochId || epoch.id!==epochId || epoch.state!=="attaching" || epoch.controllerBootId!==b.controllerBootId || epoch.controllerGeneration!==b.controllerGeneration) throw new Error("codex_shared_observation_reconciliation_required");
    await tx.update(agentTaskSessions).set({sessionParamsJson:{...params,codexSharedGoalV1:{...native,observationEpoch:{...epoch,state:"open"}}},updatedAt:sql`clock_timestamp()`}).where(eq(agentTaskSessions.id,b.taskSessionId));
  });
}

function requireOpenObservation(native:Record<string,unknown>, b:CodexSharedGoalBinding) {
  const epoch=obj(native.observationEpoch);
  if (epoch.state!=="open" || typeof epoch.id!=="string" || !epoch.id || epoch.controllerBootId!==b.controllerBootId || epoch.controllerGeneration!==b.controllerGeneration) throw new Error("codex_shared_observation_reconciliation_required");
}

/** Read-only recovery inspection remains available while automation is held. */
export async function readCodexSharedObservation(db:Db,b:CodexSharedGoalBinding) {
  validate(b);
  return lockRetryTransaction(db, async tx=>{
    const {native}=await locked(tx,b);
    return {sourceGoalDigest:native.sourceGoalDigest,observationEpoch:structuredClone(obj(native.observationEpoch))};
  });
}

/** Re-read the already-reserved service action before issuing its PRP write. */
/** Canary ceiling for an ACTIVE goal's token budget; activation without a budget at or under it is never admitted. */
export const CODEX_SHARED_ACTIVE_GOAL_TOKEN_CAP = 20_000;
type PausedWrite = {requestId:string;threadId:string;objective:string;status:"paused"|"active";tokenBudget?:number|null};
type PausedAdmission = {writer:{grantId:string;epoch:number;observationEpochId:string};expectedGoal:{objective:string;status:string;tokenBudget:number|null}|null};
const sendScope=new AsyncLocalStorage<{key:string;admission:PausedAdmission;open:boolean}>();
const scopeKey=(b:CodexSharedGoalBinding,input:PausedWrite)=>JSON.stringify([b.companyId,b.runId,b.threadId,b.writerGrantId,b.writerEpoch,b.delegationGrantId,b.delegationRevision,input.requestId,input.threadId,input.objective,input.status,input.tokenBudget??null]);
/**
 * Pure contract between a reserved service action and the goal write it may carry. Activation is only ever the resume of an
 * existing paused goal with a non-null budget at or under the cap, written with that same budget; pause only stops an active goal.
 * Create and edit stay paused writes. Throws before any send; returns the goal the writer must find.
 */
export function codexSharedGoalWriteContract(action:string,payload:Record<string,unknown>,input:PausedWrite,goal:Record<string,unknown>|null):PausedAdmission["expectedGoal"] {
  const activating=input.status==="active";
  if (activating ? action!=="resume" : !["create","edit","pause"].includes(action)) throw new Error("codex_shared_action_mismatch");
  const named=action==="create"||action==="edit";
  if (payload.objective!==input.objective && (named || payload.objective!==undefined)) throw new Error("codex_shared_action_mismatch");
  const wanted=activating ? "paused" : action==="pause" ? "active" : "paused";
  if (goal && (goal.status!==wanted || typeof goal.objective!=="string" || !(goal.tokenBudget===null || Number.isSafeInteger(goal.tokenBudget)))) throw new Error("codex_shared_source_changed");
  if (!goal && (activating || action!=="create")) throw new Error("codex_shared_source_changed");
  if (!named && goal!.objective!==input.objective) throw new Error("codex_shared_action_mismatch");
  if (activating) {
    const budget=goal!.tokenBudget;
    if (typeof budget!=="number" || budget<1 || budget>CODEX_SHARED_ACTIVE_GOAL_TOKEN_CAP || input.tokenBudget!==budget || (payload.tokenBudget!==undefined && payload.tokenBudget!==budget)) throw new Error("codex_shared_active_budget_not_admitted");
  }
  return goal ? {objective:String(goal.objective),status:String(goal.status),tokenBudget:goal.tokenBudget as number|null} : null;
}
async function pausedAdmission(tx:Tx,b:CodexSharedGoalBinding,input:PausedWrite):Promise<PausedAdmission> {
    const {session,native}=await locked(tx,b);requireOpenObservation(native,b);
    const [action]=await tx.select().from(agentSessionGoalActions).where(and(eq(agentSessionGoalActions.sessionId,b.taskSessionId),eq(agentSessionGoalActions.companyId,b.companyId),eq(agentSessionGoalActions.requestId,input.requestId))).for("update",{noWait:true}).limit(1);
    const payload=obj(action?.payloadJson), reservation=obj(obj(action?.resultJson).codexSharedGoalV1), epoch=obj(native.observationEpoch);
    if (!action || !["pending","delivering","delivered"].includes(action.status) || input.threadId!==b.threadId || reservation.state!=="reserved" || reservation.threadId!==b.threadId || reservation.writerGrantId!==b.writerGrantId || reservation.writerEpoch!==b.writerEpoch || reservation.inputDigest!==createHash("sha256").update(JSON.stringify(payload)).digest("hex")) throw new Error("codex_shared_action_mismatch");
    const goal=session.goalJson===null ? null : obj(session.goalJson);
    const expectedGoal=codexSharedGoalWriteContract(action.action,payload,input,goal);
    const fingerprint=goal ? createHash("sha256").update(JSON.stringify({threadId:b.threadId,objective:goal.objective,status:goal.status,tokenBudget:goal.tokenBudget})).digest("hex") : null;
    if (fingerprint!==native.sourceGoalDigest) throw new Error("codex_shared_source_changed");
    return {writer:{grantId:b.writerGrantId,epoch:b.writerEpoch,observationEpochId:String(epoch.id)},expectedGoal};
}
export async function authorizeReservedCodexGoalWrite(db:Db,b:CodexSharedGoalBinding,input:PausedWrite) {
  validate(b);
  const scoped=sendScope.getStore();
  if (scoped) {
    if (!scoped.open || scoped.key!==scopeKey(b,input)) throw new Error("codex_shared_send_scope_invalid");
    return scoped.admission;
  }
  // A writer must execute inside the locked send scope, never through an
  // independently checked authorization followed by an unlocked send.
  throw new Error("codex_shared_send_scope_missing");
}

export const authorizeReservedCodexPausedGoal=authorizeReservedCodexGoalWrite;

/** The reservation is committed before entering. Hold revocation locks across
 * the bounded send; timeout means outcome unknown, not cancellation of it. */
export async function withReservedCodexPausedGoalSend<T>(db:Db,b:CodexSharedGoalBinding,input:PausedWrite,send:()=>Promise<T>,timeoutMs=15_000):Promise<T> {
  validate(b);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>15_000) throw new Error("codex_shared_send_timeout_invalid");
  let sent=false;
  return lockRetryTransaction(db, async tx=>{
    // Delegation rows can be held by a concurrent registration or revocation;
    // bound acquisition as well as the external send itself.
    await tx.execute(sql`set local lock_timeout = '2s'`);
    const admission=await pausedAdmission(tx,b,input);
    const scope={key:scopeKey(b,input),admission,open:true};
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      return await sendScope.run(scope,()=>Promise.race([(sent=true,send()),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("codex_shared_send_outcome_unknown")),timeoutMs);})]));
    } finally {scope.open=false;if(timer)clearTimeout(timer);}
  }, () => sent);
}

/** Same locked scope for activation (resume of a paused goal); the contract above rejects any other action carrying status "active". */
export const withReservedCodexActiveGoalSend=<T>(db:Db,b:CodexSharedGoalBinding,input:PausedWrite&{status:"active"},send:()=>Promise<T>,timeoutMs?:number)=>withReservedCodexPausedGoalSend(db,b,input,send,timeoutMs);

/** Read the existing service-owned action and its authoritative source pin. */
export async function readCodexSharedGoalAction(db: Db, b: CodexSharedGoalBinding, requestId:string) {
  validate(b);
  if (!requestId || requestId.length>128) throw new Error("codex_shared_request_invalid");
  return lockRetryTransaction(db, async tx=>{
    const {session,native}=await locked(tx,b);
    requireOpenObservation(native,b);
    const [action]=await tx.select().from(agentSessionGoalActions).where(and(eq(agentSessionGoalActions.sessionId,b.taskSessionId),eq(agentSessionGoalActions.companyId,b.companyId),eq(agentSessionGoalActions.requestId,requestId))).for("update",{noWait:true}).limit(1);
    if (!action || !["pending","delivering","delivered"].includes(action.status)) throw new Error("codex_shared_action_mismatch");
    const payload=obj(action.payloadJson);
    if (!Number.isSafeInteger(payload.expectedRevision) || session.goalRevision!==Number(payload.expectedRevision)+1 || (native.sourceGoalDigest!==null && !digest(native.sourceGoalDigest))) throw new Error("codex_shared_revision_or_source_mismatch");
    return { action:action.action, payload:structuredClone(payload), expectedRevision:Number(payload.expectedRevision), sourceGoalDigest:native.sourceGoalDigest as string|null };
  });
}

/** Claim the already-created goal-service action; a reserved action is never dispatched twice. */
export async function reserveCodexSharedGoalAction(db: Db, b: CodexSharedGoalBinding, input: {requestId:string; action:"create"|"edit"|"replace"|"pause"|"resume"|"clear"; expectedRevision:number; inputDigest:string; sourceGoalDigest:string|null}): Promise<"fresh"|"existing_or_uncertain"> {
  validate(b);
  if (!input.requestId || input.requestId.length>128 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<0 || !digest(input.inputDigest) || (input.sourceGoalDigest!==null && !digest(input.sourceGoalDigest))) throw new Error("codex_shared_request_invalid");
  return lockRetryTransaction(db, async tx=>{
    const {session,native}=await locked(tx,b);
    requireOpenObservation(native,b);
    const [action]=await tx.select().from(agentSessionGoalActions).where(and(eq(agentSessionGoalActions.sessionId,b.taskSessionId),eq(agentSessionGoalActions.companyId,b.companyId),eq(agentSessionGoalActions.requestId,input.requestId))).for("update",{noWait:true}).limit(1);
    if (!action || action.action!==input.action || !["pending","delivering","delivered"].includes(action.status)) throw new Error("codex_shared_action_mismatch");
    const payload=obj(action.payloadJson), result=obj(action.resultJson);
    if (payload.expectedRevision!==input.expectedRevision || session.goalRevision!==input.expectedRevision+1 || native.sourceGoalDigest!==input.sourceGoalDigest) throw new Error("codex_shared_revision_or_source_mismatch");
    if (createHash("sha256").update(JSON.stringify(payload)).digest("hex")!==input.inputDigest) throw new Error("codex_shared_payload_mismatch");
    if (result.codexSharedGoalV1 !== undefined) return "existing_or_uncertain";
    await tx.update(agentSessionGoalActions).set({resultJson:{...result,codexSharedGoalV1:{state:"reserved",inputDigest:input.inputDigest,writerGrantId:b.writerGrantId,writerEpoch:b.writerEpoch,threadId:b.threadId}},updatedAt:sql`clock_timestamp()`}).where(eq(agentSessionGoalActions.id,action.id));
    return "fresh";
  });
}

/** Store source readback and its digest atomically with the existing action. */
export type CodexGoalSourceStatus = "active"|"paused"|"blocked"|"limited"|"usageLimited"|"budgetLimited"|"complete"|"cleared";
export async function commitCodexSharedGoalReceipt(db: Db,b: CodexSharedGoalBinding,input:{requestId:string;inputDigest:string;sourceGoalDigest:string;sourceStatus:CodexGoalSourceStatus}):Promise<void> {
  validate(b);
  if (!input.requestId || !digest(input.inputDigest) || !digest(input.sourceGoalDigest) || !["active","paused","blocked","limited","usageLimited","budgetLimited","complete","cleared"].includes(input.sourceStatus)) throw new Error("codex_shared_receipt_invalid");
  await lockRetryTransaction(db, async tx=>{
    const {session,params,native}=await locked(tx,b);
    requireOpenObservation(native,b);
    const [action]=await tx.select().from(agentSessionGoalActions).where(and(eq(agentSessionGoalActions.sessionId,b.taskSessionId),eq(agentSessionGoalActions.companyId,b.companyId),eq(agentSessionGoalActions.requestId,input.requestId))).for("update",{noWait:true}).limit(1);
    if (!action || !["pending","delivering","delivered","completed"].includes(action.status)) throw new Error("codex_shared_action_mismatch");
    const result=obj(action.resultJson), reservation=obj(result.codexSharedGoalV1);
    if (reservation.state!=="reserved" || reservation.inputDigest!==input.inputDigest || reservation.threadId!==b.threadId || reservation.writerGrantId!==b.writerGrantId || reservation.writerEpoch!==b.writerEpoch) throw new Error("codex_shared_reservation_mismatch");
    const expectedRevision=Number(obj(action.payloadJson).expectedRevision);
    if (action.status==="completed") {
      const goal=obj(session.goalJson);
      const projected=input.sourceStatus==="cleared" && session.goalJson===null ? createHash("sha256").update(`goal:cleared:${b.threadId}`).digest("hex") :
        createHash("sha256").update(JSON.stringify({threadId:b.threadId,objective:goal.objective,status:goal.status,tokenBudget:goal.tokenBudget ?? null})).digest("hex");
      if (session.goalRevision<expectedRevision+2 || session.goalSourceId!==`${b.runnerInstanceId}:${b.runId}` || projected!==input.sourceGoalDigest) throw new Error("codex_shared_projection_mismatch");
    } else if (session.goalRevision!==expectedRevision+1) throw new Error("codex_shared_reservation_mismatch");
    if ((action.action==="clear") !== (input.sourceStatus==="cleared")) throw new Error("codex_shared_receipt_action_mismatch");
    await tx.update(agentSessionGoalActions).set({resultJson:{...result,codexSharedGoalV1:{...reservation,state:"source_receipted",sourceGoalDigest:input.sourceGoalDigest,sourceStatus:input.sourceStatus}},updatedAt:sql`clock_timestamp()`}).where(eq(agentSessionGoalActions.id,action.id));
    await tx.update(agentTaskSessions).set({sessionParamsJson:{...params,codexSharedGoalV1:{...native,sourceGoalDigest:input.sourceStatus==="cleared"?null:input.sourceGoalDigest}},updatedAt:sql`clock_timestamp()`}).where(eq(agentTaskSessions.id,b.taskSessionId));
  });
}
