import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { agents, agentSessionGoalActions, agentTaskSessions, companies, createDb, goals, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, projects, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { beginCodexManagedThreadBootstrap, type CodexSharedGoalBinding } from "./codex-shared-goal-authority.js";
import { hasCodexSharedSessionIdentity, rolloverSettledCodexSession } from "./codex-shared-admission.js";

it("rolls over only a settled created identity and leaves another issue alone",async()=>{
 const database=await startEmbeddedPostgresTestDatabase("codex-rollover-");const db=createDb(database.connectionString);
 try {
  const companyId=randomUUID(),agentId=randomUUID(),oldRun=randomUUID(),nextRun=randomUUID(),sessionId=randomUUID(),otherId=randomUUID();
  await db.insert(companies).values({id:companyId,name:"Test",issuePrefix:"ROL"});
  await db.insert(agents).values({id:agentId,companyId,name:"Test",role:"engineer",adapterType:"paperclip_runner"});
  await db.insert(heartbeatRuns).values([{id:oldRun,companyId,agentId,status:"succeeded"},{id:nextRun,companyId,agentId,status:"running"}]);
  const bootstrap={state:"created",threadId:"old-thread",runId:oldRun};
  await db.insert(agentTaskSessions).values([{id:sessionId,companyId,agentId,adapterType:"paperclip_runner",taskKey:"first",lastRunId:oldRun,sessionParamsJson:{codexSharedBootstrapV1:bootstrap}},{id:otherId,companyId,agentId,adapterType:"paperclip_runner",taskKey:"second",lastRunId:oldRun,sessionParamsJson:{codexSharedBootstrapV1:bootstrap}}]);
  const attempt=()=>db.transaction(async tx=>{const [row]=await tx.select().from(agentTaskSessions).where(eq(agentTaskSessions.id,sessionId)).for("update");return rolloverSettledCodexSession(tx,row!,nextRun);});
  await db.update(agentTaskSessions).set({sessionParamsJson:{codexSharedBootstrapV1:{...bootstrap,state:"starting"}}}).where(eq(agentTaskSessions.id,sessionId));
  expect(await attempt()).toBe(false);
  await db.update(agentTaskSessions).set({sessionParamsJson:{codexSharedBootstrapV1:bootstrap,codexSharedGoalV1:{observationEpoch:{state:"open"}}}}).where(eq(agentTaskSessions.id,sessionId));
  expect(await attempt()).toBe(false);
  await db.update(agentTaskSessions).set({sessionParamsJson:{codexSharedBootstrapV1:bootstrap,codexSharedGoalV1:{threadId:"old-thread",runId:oldRun,sourceGoalDigest:null,observationEpoch:{state:"open"}}}}).where(eq(agentTaskSessions.id,sessionId));
  await db.insert(agentSessionGoalActions).values({companyId,sessionId,requestId:"pending",action:"create",payloadJson:{}});
  expect(await attempt()).toBe(false);
  await db.update(agentSessionGoalActions).set({status:"completed"}).where(eq(agentSessionGoalActions.sessionId,sessionId));
  expect(await attempt()).toBe(true);
  const [row]=await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id,sessionId));
  expect(row?.sessionParamsJson).toEqual({__paperclipSharedRunFence:nextRun});expect(row?.lastRunId).toBe(nextRun);
  const [other]=await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id,otherId));expect(other?.sessionParamsJson).toEqual({codexSharedBootstrapV1:bootstrap});
  const [event]=await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId,nextRun));expect(event?.eventType).toBe("shared_session_rolled_over");expect(event?.payload).toEqual({oldThreadId:"old-thread"});
 } finally {await db.$client.end();await database.cleanup();}
},60000);

it("distinguishes Paperclip metadata from provider identity", () => {
 const base = {sessionDisplayId:null, goalJson:null, sessionParamsJson:{__paperclipConfiguredModel:"model",__paperclipConfigFingerprint:"fingerprint"}};
 expect(hasCodexSharedSessionIdentity(base)).toBe(false);
 for (const key of ["codexSharedBootstrapV1", "codexSharedGoalV1", "sessionId"]) {
  expect(hasCodexSharedSessionIdentity({...base,sessionParamsJson:{...base.sessionParamsJson,[key]:{}}})).toBe(true);
 }
 expect(hasCodexSharedSessionIdentity({...base,sessionDisplayId:"thread"})).toBe(true);
 expect(hasCodexSharedSessionIdentity({...base,goalJson:{}})).toBe(true);
});
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
