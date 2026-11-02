import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute } from "node:path";
import { agentTaskSessions, connectionGrants, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, toolConnections, type Db } from "@paperclipai/db";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { assertCodexNativeDelegation } from "./codex-native-delegation.js";
import { activateCodexSharedObservation, authorizeReservedCodexGoalWrite, beginCodexManagedThreadBootstrap, beginCodexSharedObservation, completeCodexManagedThreadBootstrap, preflightCodexManagedThreadBootstrap, type CodexSharedGoalBinding } from "./codex-shared-goal-authority.js";
import { inspectCodexSharedDaemon } from "./codex-shared-daemon.js";
import { sharedThreadConfigViolation } from "../../vendor/paperclip-runner/index.js";

const record=(value:unknown):Record<string,unknown>=>value && typeof value==="object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value,(_key,item:unknown)=>item && typeof item==="object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item)).digest("hex");

/** Server-owned capability for the existing PRP prepare -> bind -> open path. */
export type CodexSharedLaunchContract = Readonly<{cwd:string;instructions:string;authorizedTools:Record<string,unknown>;approvalPolicy:"never";readOnly:boolean;webSearchDisabled:boolean;threadConfig:Record<string,unknown>}>;
export function createCodexSharedAdmission(input:{db:Db;binding:CodexSharedGoalBinding;bootstrapId:string;observationEpochId:string;launch:CodexSharedLaunchContract;attestDaemon():Promise<void>}) {
  const initial=input.binding; let bound:CodexSharedGoalBinding|undefined; let configurationDigest:string|undefined;
  if (!isAbsolute(input.launch.cwd) || !input.launch.instructions.trim() || input.launch.approvalPolicy!=="never" || typeof input.launch.readOnly!=="boolean" || !input.launch.authorizedTools || Array.isArray(input.launch.authorizedTools) || typeof input.launch.authorizedTools!=="object") throw new Error("codex_shared_launch_contract_invalid");
  if (typeof input.launch.webSearchDisabled!=="boolean" || sharedThreadConfigViolation(input.launch.threadConfig,{cwd:input.launch.cwd,readOnly:input.launch.readOnly,disableWebSearch:input.launch.webSearchDisabled})) throw new Error("codex_shared_launch_contract_invalid");
  const launch=structuredClone(input.launch);
  const bootstrapAuthority={
    async reserve(request:{bootstrapId:string;runAttachTemplate:Record<string,unknown>}) {
      if (request.bootstrapId!==input.bootstrapId || configurationDigest) throw new Error("codex_shared_bootstrap_mismatch");
      const provider=record(request.runAttachTemplate.provider),shared=record(provider.sharedDaemon),writer=record(shared.writer);
      if (provider.cwd!==launch.cwd || provider.instructions!==launch.instructions || provider.approvalPolicy!==launch.approvalPolicy || provider.readOnly!==launch.readOnly || !isDeepStrictEqual(request.runAttachTemplate.authorizedTools,launch.authorizedTools)) throw new Error("codex_shared_launch_contract_mismatch");
      if (provider.provider!=="codex" || provider.model!==initial.model || shared.bootstrapId!==input.bootstrapId || shared.threadId!=="" || writer.runId!==initial.runId || writer.normalizedSessionId!==initial.normalizedSessionId || writer.runnerInstanceId!==initial.runnerInstanceId || writer.grantId!==initial.writerGrantId || writer.epoch!==initial.writerEpoch || writer.observationEpochId!==input.observationEpochId || writer.managedTools!==true || writer.managedBootstrapId!==input.bootstrapId || writer.reasoningEffort!==initial.effort) throw new Error("codex_shared_bootstrap_mismatch");
      // The runner may not generate, widen or edit the thread policy: it must equal the server's, byte for byte in meaning.
      if (!isDeepStrictEqual(writer.threadConfig,launch.threadConfig)) throw new Error("codex_shared_thread_config_mismatch");
      await input.attestDaemon();
      const value=digest(request.runAttachTemplate);
      if (await beginCodexManagedThreadBootstrap(input.db,initial,{bootstrapId:input.bootstrapId,configurationDigest:value})!=="fresh") throw new Error("codex_shared_bootstrap_outcome_unknown");
      configurationDigest=value;
    },
    async bind(request:{bootstrapId:string;threadId:string}) {
      if (request.bootstrapId!==input.bootstrapId || !configurationDigest || bound || !request.threadId || request.threadId.length>240) throw new Error("codex_shared_bootstrap_mismatch");
      await input.attestDaemon();
      const next={...initial,threadId:request.threadId};
      await completeCodexManagedThreadBootstrap(input.db,next,{bootstrapId:input.bootstrapId,configurationDigest});
      if (await beginCodexSharedObservation(input.db,next,{epochId:input.observationEpochId,sourceGoalDigest:null})!=="fresh") throw new Error("codex_shared_observation_reconciliation_required");
      bound=next;
    },
    async attached(request:{bootstrapId:string;threadId:string}) {
      if (!bound || request.bootstrapId!==input.bootstrapId || request.threadId!==bound.threadId) throw new Error("codex_shared_bootstrap_mismatch");
      await input.attestDaemon();
      await activateCodexSharedObservation(input.db,bound,input.observationEpochId);
    },
  };
  return {bootstrapAuthority,authorizeGoalWrite:async (request:{requestId:string;threadId:string;objective:string;status:"paused"|"active";tokenBudget?:number|null})=>{
    if (!bound) throw new Error("codex_shared_bootstrap_mismatch");
    await input.attestDaemon();
    return authorizeReservedCodexGoalWrite(input.db,bound,request);
  }, binding:()=>bound};
}
export type CodexSharedAdmission = ReturnType<typeof createCodexSharedAdmission>;
export type CodexSharedServerOption = {
  environmentLeaseId:string;
  daemon:{socketPath:string;daemonGeneration:string;threadId:string;codexHome:string;bootstrapId:string;peer:{pid:number;startSeconds:number;startMicroseconds:number;executable:string};writer:{runId:string;normalizedSessionId:string;runnerInstanceId:string;grantId:string;epoch:number;observationEpochId:string;managedTools:true;managedBootstrapId:string;reasoningEffort:string;threadConfig:Record<string,unknown>}};
  admission:CodexSharedAdmission;
  attestDaemon():Promise<void>;
};

/** Claim a fresh task session for an explicitly selected, already registered daemon. */
export async function claimRegisteredCodexSharedOption(input:{db:Db;companyId:string;agentId:string;issueId:string;runId:string;normalizedSessionId:string;runnerInstanceId:string;executionWorkspaceId:string;model:string;effort:string;leaseOwner:string;leaseAttempt:number;controller:{bootId:string;pid:number;processStartedAt:Date};delegationGrantId:string;hostId:string;codexExecutable:string;codexHome:string;runnerExecutable:string;home:string;launch:CodexSharedLaunchContract}):Promise<CodexSharedServerOption> {
  if (!input.model || !["minimal","low","medium","high","xhigh","ultra"].includes(input.effort)) throw new Error("codex_shared_model_effort_invalid");
  const daemon=await inspectCodexSharedDaemon(input);
  const processGeneration=digest({daemonGeneration:daemon.daemonGeneration,peer:daemon.peer});
  const binding=await input.db.transaction(async tx=>{
    const [lease]=await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId,input.runId),eq(nativeRunFinalizations.companyId,input.companyId),eq(nativeRunFinalizations.issueId,input.issueId),eq(nativeRunFinalizations.leaseOwner,input.leaseOwner),eq(nativeRunFinalizations.attempt,input.leaseAttempt),eq(nativeRunFinalizations.controllerBootId,input.controller.bootId),eq(nativeRunFinalizations.controllerPid,input.controller.pid),eq(nativeRunFinalizations.controllerProcessStartedAt,input.controller.processStartedAt),gt(nativeRunFinalizations.leaseExpiresAt,sql`clock_timestamp()`))).for("update",{noWait:true}).limit(1);
    if (!lease || !Number.isSafeInteger(lease.controllerGeneration) || lease.controllerGeneration<1) throw new Error("codex_shared_lease_lost");
    const [run]=await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,input.runId),eq(heartbeatRuns.companyId,input.companyId),eq(heartbeatRuns.agentId,input.agentId),eq(heartbeatRuns.nativeIssueId,input.issueId),eq(heartbeatRuns.nativeSessionId,input.normalizedSessionId),eq(heartbeatRuns.runnerInstanceId,input.runnerInstanceId),eq(heartbeatRuns.status,"running"),eq(heartbeatRuns.runtimeMode,"native"))).for("update",{noWait:true}).limit(1);
    const [issue]=await tx.select().from(issues).where(and(eq(issues.id,input.issueId),eq(issues.companyId,input.companyId),eq(issues.executionRunId,input.runId),eq(issues.checkoutRunId,input.runId),eq(issues.assigneeAgentId,input.agentId),eq(issues.status,"in_progress"))).for("update",{noWait:true}).limit(1);
    if (!run || !issue?.projectId || !issue.goalId) throw new Error("codex_shared_issue_mismatch");
    const resources=await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId,input.companyId),eq(environmentLeases.heartbeatRunId,input.runId),eq(environmentLeases.issueId,input.issueId),eq(environmentLeases.executionWorkspaceId,input.executionWorkspaceId),eq(environmentLeases.status,"active"),or(isNull(environmentLeases.expiresAt),gt(environmentLeases.expiresAt,sql`clock_timestamp()`)))).for("update",{noWait:true}).limit(2);
    if (resources.length!==1) throw new Error("codex_shared_resource_lease_lost");
    const [selected]=await tx.select({config:toolConnections.config}).from(connectionGrants).innerJoin(toolConnections,eq(connectionGrants.connectionId,toolConnections.id)).where(and(eq(connectionGrants.id,input.delegationGrantId),eq(connectionGrants.companyId,input.companyId),eq(toolConnections.companyId,input.companyId))).limit(1);
    const revision=record(selected?.config.codexNativeDelegation).revision;
    if (typeof revision!=="string") throw new Error("codex_delegation_unavailable");
    await assertCodexNativeDelegation(tx,{companyId:input.companyId,agentId:input.agentId,projectId:issue.projectId,model:input.model,effort:input.effort,hostId:input.hostId,processGeneration,delegationGrantId:input.delegationGrantId,delegationRevision:revision});
    const [existing]=await tx.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId,input.companyId),eq(agentTaskSessions.agentId,input.agentId),eq(agentTaskSessions.adapterType,"paperclip_runner"),eq(agentTaskSessions.taskKey,input.issueId))).for("update",{noWait:true}).limit(1);
    if (existing && (existing.sessionDisplayId || Object.keys(record(existing.sessionParamsJson)).length || existing.goalJson)) throw new Error("codex_shared_existing_session_requires_recovery");
    const taskSessionId=existing?.id ?? randomUUID();
    if (existing) await tx.update(agentTaskSessions).set({lastRunId:input.runId,updatedAt:sql`clock_timestamp()`}).where(eq(agentTaskSessions.id,taskSessionId));
    else await tx.insert(agentTaskSessions).values({id:taskSessionId,companyId:input.companyId,agentId:input.agentId,adapterType:"paperclip_runner",taskKey:input.issueId,lastRunId:input.runId,sessionParamsJson:{}});
    return {companyId:input.companyId,agentId:input.agentId,issueId:input.issueId,runId:input.runId,projectId:issue.projectId,goalId:issue.goalId,normalizedSessionId:input.normalizedSessionId,runnerInstanceId:input.runnerInstanceId,executionWorkspaceId:input.executionWorkspaceId,environmentLeaseId:resources[0]!.id,taskSessionId,delegationGrantId:input.delegationGrantId,delegationRevision:revision,hostId:input.hostId,model:input.model,effort:input.effort,writerGrantId:input.runId,writerEpoch:lease.controllerGeneration,leaseOwner:input.leaseOwner,leaseAttempt:input.leaseAttempt,controllerBootId:input.controller.bootId,controllerPid:input.controller.pid,controllerProcessStartedAt:input.controller.processStartedAt,controllerGeneration:lease.controllerGeneration};
  });
  return createAttestedCodexSharedOption({...input,binding,bootstrapId:randomUUID(),observationEpochId:randomUUID()});
}

/** Concrete server factory: peer identity comes from Runner's OS inspection. */
export async function createAttestedCodexSharedOption(input:{db:Db;binding:Omit<CodexSharedGoalBinding,"threadId"|"processGeneration"|"protocolVersion">;bootstrapId:string;observationEpochId:string;launch:CodexSharedLaunchContract;codexExecutable:string;codexHome:string;runnerExecutable:string;home:string}):Promise<CodexSharedServerOption> {
  if (!input.binding.model || !["minimal","low","medium","high","xhigh","ultra"].includes(input.binding.effort)) throw new Error("codex_shared_model_effort_invalid");
  const inspect=()=>inspectCodexSharedDaemon({codexExecutable:input.codexExecutable,codexHome:input.codexHome,runnerExecutable:input.runnerExecutable,home:input.home});
  const daemon=await inspect();
  const processGeneration=digest({daemonGeneration:daemon.daemonGeneration,peer:daemon.peer});
  const binding:CodexSharedGoalBinding={...input.binding,threadId:"pending",processGeneration,protocolVersion:daemon.appServerVersion};
  await preflightCodexManagedThreadBootstrap(input.db,binding);
  const attestDaemon=async()=>{if (digest(await inspect())!==digest(daemon)) throw new Error("codex_shared_daemon_identity_changed");};
  const admission=createCodexSharedAdmission({...input,binding,attestDaemon});
  return {environmentLeaseId:input.binding.environmentLeaseId!,daemon:{socketPath:daemon.socketPath,daemonGeneration:daemon.daemonGeneration,codexHome:daemon.codexHome,threadId:"",bootstrapId:input.bootstrapId,peer:daemon.peer,writer:{runId:input.binding.runId,normalizedSessionId:input.binding.normalizedSessionId,runnerInstanceId:input.binding.runnerInstanceId,grantId:input.binding.writerGrantId,epoch:input.binding.writerEpoch,observationEpochId:input.observationEpochId,managedTools:true,managedBootstrapId:input.bootstrapId,reasoningEffort:input.binding.effort,threadConfig:structuredClone(input.launch.threadConfig)}},admission,attestDaemon};
}
