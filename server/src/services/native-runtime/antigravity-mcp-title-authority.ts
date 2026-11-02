import { agents, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { setIssueTitleSchema } from "@paperclipai/shared";
import { and, eq, gt, isNull, notInArray, or, sql } from "drizzle-orm";
import { publishActivity } from "../activity-log.js";
import { setIssueTitle } from "../issue-title.js";
import type { AntigravityMcpScope } from "../../../../packages/paperclip-runner/src/drivers/antigravity/native-mcp-workspace.js";
import type { RunnerToolCall } from "../../../../packages/paperclip-runner/src/drivers/runner-tool-bridge.js";

/** Narrow candidate: only the existing, transactionally receipted title operation.
 * The caller must independently attest and freeze native process/conversation identity. */
export function createAntigravityMcpTitleAuthority(db:Db, options:{scope:AntigravityMcpScope;executionWorkspaceId:string;leaseOwner:string;attempt:number;writerGeneration:number;assertControllerActive:()=>void}) {
 const b=Object.freeze({...options.scope});
 options=Object.freeze({...options,scope:b});
 const owner=()=>and(eq(nativeRunFinalizations.companyId,b.companyId),eq(nativeRunFinalizations.runId,b.runId),eq(nativeRunFinalizations.issueId,b.issueId),eq(nativeRunFinalizations.phase,"observed"),eq(nativeRunFinalizations.leaseOwner,options.leaseOwner),eq(nativeRunFinalizations.attempt,options.attempt),eq(nativeRunFinalizations.controllerGeneration,options.writerGeneration),gt(nativeRunFinalizations.leaseExpiresAt,sql`clock_timestamp()`));
 const environment=()=>and(eq(environmentLeases.id,b.leaseId),eq(environmentLeases.companyId,b.companyId),eq(environmentLeases.heartbeatRunId,b.runId),eq(environmentLeases.issueId,b.issueId),eq(environmentLeases.executionWorkspaceId,options.executionWorkspaceId),eq(environmentLeases.status,"active"),or(isNull(environmentLeases.expiresAt),gt(environmentLeases.expiresAt,sql`clock_timestamp()`)));
 return async (scope:AntigravityMcpScope,call:RunnerToolCall)=>{
  if(Object.keys(b).some(k=>scope[k as keyof AntigravityMcpScope]!==b[k as keyof AntigravityMcpScope]))throw new Error("antigravity_mcp_scope_mismatch");
  if(call.tool!=="set_task_title")throw new Error("antigravity_mcp_tool_unsupported");
  const input=setIssueTitleSchema.parse(call.arguments);if(!input.idempotencyKey)throw new Error("antigravity_mcp_idempotency_required");
  options.assertControllerActive();
  const receipt=await db.transaction(async tx=>{
   const [o]=await tx.select({id:nativeRunFinalizations.runId}).from(nativeRunFinalizations).where(owner()).for("update");
   const [e]=await tx.select({id:environmentLeases.id}).from(environmentLeases).where(environment()).for("update");
   if(!o||!e)throw new Error("antigravity_mcp_lease_lost");options.assertControllerActive();
   const [issue]=await tx.select({id:issues.id}).from(issues).where(and(eq(issues.id,b.issueId),eq(issues.companyId,b.companyId),eq(issues.assigneeAgentId,b.agentId),eq(issues.executionRunId,b.runId))).for("update");
   const [run]=await tx.select({id:heartbeatRuns.id}).from(heartbeatRuns).innerJoin(agents,eq(agents.id,heartbeatRuns.agentId)).where(and(eq(heartbeatRuns.id,b.runId),eq(heartbeatRuns.companyId,b.companyId),eq(heartbeatRuns.agentId,b.agentId),eq(heartbeatRuns.nativeIssueId,b.issueId),eq(heartbeatRuns.nativeSessionId,b.normalizedSessionId),eq(heartbeatRuns.runtimeMode,"native"),eq(heartbeatRuns.status,"running"),eq(agents.companyId,b.companyId),notInArray(agents.status,["paused","terminated","pending_approval","error"]))).for("update");
   if(!issue||!run)throw new Error("antigravity_mcp_run_lost");
   const result=await setIssueTitle(tx as unknown as Db,b.companyId,b.issueId,input,{actorType:"agent",actorId:b.agentId,agentId:b.agentId,runId:b.runId});
   options.assertControllerActive();
   const [stillOwner]=await tx.select({id:nativeRunFinalizations.runId}).from(nativeRunFinalizations).where(owner());const [stillEnv]=await tx.select({id:environmentLeases.id}).from(environmentLeases).where(environment());
   if(!stillOwner||!stillEnv)throw new Error("antigravity_mcp_lease_expired");
   return result;
  });
  if(receipt.publication)publishActivity(receipt.publication);
  return receipt.result;
 };
}
