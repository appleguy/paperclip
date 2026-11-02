import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { agents, agentTaskSessions, companies, createDb, goals, heartbeatRuns, issues, nativeRunFinalizations, projects, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { beginCodexManagedThreadBootstrap, type CodexSharedGoalBinding } from "./codex-shared-goal-authority.js";
it("does not reserve bootstrap when the issue checkout is not committed to the run",async()=>{
 const database=await startEmbeddedPostgresTestDatabase("codex-admission-review-");const db=createDb(database.connectionString);
 try {
  const companyId=randomUUID(),agentId=randomUUID(),projectId=randomUUID(),goalId=randomUUID(),issueId=randomUUID(),runId=randomUUID(),taskSessionId=randomUUID(),normalizedSessionId=randomUUID(),runnerInstanceId=randomUUID();
  const b:CodexSharedGoalBinding={companyId,agentId,projectId,goalId,issueId,runId,taskSessionId,normalizedSessionId,runnerInstanceId,threadId:"pending",processGeneration:"pid:birth",protocolVersion:"0.166.0",model:"model",effort:"high",writerGrantId:"grant",writerEpoch:1,leaseOwner:"owner",leaseAttempt:1,controllerBootId:randomUUID(),controllerPid:123,controllerProcessStartedAt:new Date(1000),controllerGeneration:1};
  await db.insert(companies).values({id:companyId,name:"Test",issuePrefix:"CAD"});await db.insert(agents).values({id:agentId,companyId,name:"Test",role:"engineer",adapterType:"paperclip_runner"});await db.insert(projects).values({id:projectId,companyId,name:"Test"});await db.insert(goals).values({id:goalId,companyId,title:"Goal",level:"company"});
  await db.insert(issues).values({id:issueId,companyId,projectId,goalId,title:"Test",status:"in_progress",assigneeAgentId:agentId});
  await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,nativeIssueId:issueId,nativeSessionId:normalizedSessionId,runnerInstanceId,status:"running",runtimeMode:"native"});
  await db.update(issues).set({executionRunId:runId,checkoutRunId:null}).where(eq(issues.id,issueId));
  await db.insert(agentTaskSessions).values({id:taskSessionId,companyId,agentId,adapterType:"paperclip_runner",taskKey:issueId,lastRunId:runId,sessionParamsJson:{}});
  await db.insert(nativeRunFinalizations).values({runId,companyId,issueId,phase:"running",leaseOwner:b.leaseOwner,attempt:b.leaseAttempt,leaseExpiresAt:new Date(Date.now()+60_000),controllerBootId:b.controllerBootId,controllerPid:b.controllerPid,controllerProcessStartedAt:b.controllerProcessStartedAt,controllerGeneration:b.controllerGeneration});
  await expect(beginCodexManagedThreadBootstrap(db,b,{bootstrapId:"bootstrap",configurationDigest:"a".repeat(64)})).rejects.toThrow("codex_shared_issue_mismatch");
  const [session]=await db.select({params:agentTaskSessions.sessionParamsJson}).from(agentTaskSessions).where(eq(agentTaskSessions.id,taskSessionId));expect(session?.params).toEqual({});
 } finally {await db.$client.end();await database.cleanup();}
},60000);
