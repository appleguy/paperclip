import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { agents, agentSessionGoalActions, agentTaskSessions, companies, completionContracts, createDb, environmentLeases, executionWorkspaces, goals, heartbeatRuns, issues, nativeRunFinalizations, projects, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { canonicalNativeRuntimeContextDigest } from "../../vendor/paperclip-runner/index.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { localNativeDaemonHost, registerCodexNativeDelegation } from "./codex-native-delegation.js";
import { dispatchLiveRunnerGoalControl } from "../runner-goal-control-broker.js";
import { setupRunnerPrpWebSocketServer, runnerPrpWebSocketInternals } from "../../realtime/runner-prp-ws.js";

it("ordinary executor admits the selected daemon and projects a paused edit before any turn",async()=>{
 const root=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/codex-executor-");const home=join(root,"home"),workspace=join(root,"workspace"),assets=join(root,"assets");await mkdir(home);await mkdir(workspace);await mkdir(assets);await writeFile(join(assets,"AGENTS.md"),"Fixture instructions\n");await mkdir(join(home,"app-server-daemon"));await writeFile(join(home,"app-server-daemon","settings.json"),JSON.stringify({remoteControlEnabled:false,updater:{autoUpdateEnabled:false}}));
 const exec=promisify(execFile),cli="/opt/homebrew/bin/codex",runner=process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER??"/Volumes/NVM/AI_Agent_Runtime/tmp/codex-shared-proof.UC8Vu3/target/debug/paperclip-runnerd",env={PATH:"/opt/homebrew/bin:/usr/bin:/bin",HOME:home,CODEX_HOME:home,TMPDIR:home,LANG:"C"};
 await exec(cli,["app-server","daemon","start"],{cwd:root,env,timeout:15000});
 const database=await startEmbeddedPostgresTestDatabase("codex-executor-");const db=createDb(database.connectionString);
 const server=createServer();server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address || typeof address==="string")throw new Error("fixture_listener_missing");setupRunnerPrpWebSocketServer(server,{apiUrl:`http://127.0.0.1:${address.port}`});
 try {
  const companyId=randomUUID(),projectId=randomUUID(),goalId=randomUUID(),issueId=randomUUID(),agentId=randomUUID(),runId=randomUUID(),sessionId=randomUUID(),runnerInstanceId=randomUUID(),workspaceId=randomUUID(),leaseId=randomUUID(),contractId=randomUUID(),sha="sha256:"+"a".repeat(64);
  await db.insert(companies).values({id:companyId,name:"Fixture",issuePrefix:"CEX"});await db.insert(projects).values({id:projectId,companyId,name:"Fixture"});await db.insert(goals).values({id:goalId,companyId,title:"Goal",level:"company"});await db.insert(agents).values({id:agentId,companyId,name:"Agent",role:"engineer",adapterType:"paperclip_runner"});
  await db.insert(issues).values({id:issueId,companyId,projectId,goalId,title:"Issue",status:"in_progress",assigneeAgentId:agentId});
  await db.insert(completionContracts).values({id:contractId,companyId,issueId,revision:1,schemaVersion:"v1",policyVersion:"fixture",risk:"low",completionAuthority:"worker",incompleteCriteriaPolicy:"block",contractJson:{revision:"fixture",criteria:[{id:"c"}]},canonicalSha256:sha,createdByActorType:"system",createdByActorId:"fixture"});
  await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,nativeIssueId:issueId,nativeSessionId:sessionId,runnerInstanceId,status:"running",runtimeMode:"native",completionContractId:contractId,completionContractSha256:sha});
  await db.update(issues).set({executionRunId:runId,checkoutRunId:runId}).where(eq(issues.id,issueId));await db.insert(nativeRunFinalizations).values({runId,companyId,issueId,phase:"pending"});
  await db.insert(executionWorkspaces).values({id:workspaceId,companyId,projectId,name:"Fixture",mode:"shared",strategyType:"local"});await db.insert(environmentLeases).values({id:leaseId,companyId,issueId,heartbeatRunId:runId,executionWorkspaceId:workspaceId,status:"active"});
  const host={hostId:"isolated",codexExecutable:cli,codexHome:home,runnerExecutable:runner,home};const delegation=await registerCodexNativeDelegation(db,localNativeDaemonHost(host),{companyId,projectId,agentId,model:"gpt-5.1-codex",effort:"high",issuer:"board",expiresAt:new Date(Date.now()+120000)});
  for(const [key,value] of Object.entries({PAPERCLIP_RUNNER_BINARY:runner,PAPERCLIP_HOME:root,PAPERCLIP_CODEX_SHARED_AGENT_ID:agentId,PAPERCLIP_CODEX_SHARED_GRANT_ID:delegation.grantId,PAPERCLIP_CODEX_SHARED_HOST_ID:host.hostId,PAPERCLIP_CODEX_SHARED_EXECUTABLE:cli,PAPERCLIP_CODEX_SHARED_CODEX_HOME:home,PAPERCLIP_CODEX_SHARED_HOME:home,PAPERCLIP_SECRETS_MASTER_KEY:"91".repeat(32)})) vi.stubEnv(key,value);
  const context=nativeRuntimeContextFixture();context.instructions.bundle.rootPath=assets;context.aggregateDigest=canonicalNativeRuntimeContextDigest(context);
  const execution=buildNativeExecutionInput({companyId,runId,agentId,issue:{id:issueId,identifier:"CEX-1",title:"Issue",description:null,workMode:"standard"},taskPrompt:"Issue",workspace:{id:workspaceId,cwd:workspace,repoUrl:null,repoRef:null,branchName:null},normalizedSessionId:sessionId,provider:"codex",model:"gpt-5.1-codex",codexReasoningEffort:"high",completionContract:{id:contractId,sha256:sha,schemaVersion:"v1",contract:{revision:"fixture",objective:"Issue",criteria:[{id:"c",requirement:"Done"}]}},runtimeContext:context});
  let reached=false;
  const result=executePaperclipNativeSession({db,execution,runnerInstanceId,useRunnerd:true,adapterType:"paperclip_runner",turnTimeoutMs:10000,onCodexSharedSessionReady:async()=>{
    reached=true;const [session]=await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey,issueId));expect(session).toBeTruthy();
    for(const [index,action,objective] of [[0,"create","initial goal"]] as const){
      const requestId=randomUUID(),request={requestId,agentId,action,objective,expectedRevision:index*2};await db.insert(agentSessionGoalActions).values({companyId,sessionId:session!.id,requestId,action,payloadJson:request,resultJson:{}});await db.update(agentTaskSessions).set({goalRevision:index*2+1}).where(eq(agentTaskSessions.id,session!.id));
      const dispatched=dispatchLiveRunnerGoalControl({companyId,issueId,agentId},request);expect(dispatched).not.toBeNull();await dispatched!.completion;
      await vi.waitFor(async()=>{const [row]=await db.select().from(agentSessionGoalActions).where(eq(agentSessionGoalActions.requestId,requestId));expect((row!.resultJson as any).codexSharedGoalV1).toMatchObject({state:"source_receipted",sourceStatus:"paused"});},{timeout:8000,interval:50});
    }
  },onCodexSharedEventConsumerReady:async()=>{
    // Event consumer is live, no turn yet: the paused create must have projected into goalJson, so an edit is now admissible.
    const [session]=await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey,issueId));
    await vi.waitFor(async()=>{const [row]=await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id,session!.id));expect((row!.goalJson as any)?.objective).toBe("initial goal");expect((row!.goalJson as any)?.status).toBe("paused");},{timeout:8000,interval:50});
    const [projected]=await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id,session!.id));
    const requestId=randomUUID(),request={requestId,agentId,action:"edit" as const,objective:"edited goal",expectedRevision:projected!.goalRevision};
    await db.insert(agentSessionGoalActions).values({companyId,sessionId:session!.id,requestId,action:"edit",payloadJson:request,resultJson:{}});await db.update(agentTaskSessions).set({goalRevision:projected!.goalRevision+1}).where(eq(agentTaskSessions.id,session!.id));
    const dispatched=dispatchLiveRunnerGoalControl({companyId,issueId,agentId},request);expect(dispatched).not.toBeNull();await dispatched!.completion;
    await vi.waitFor(async()=>{const [row]=await db.select().from(agentSessionGoalActions).where(eq(agentSessionGoalActions.requestId,requestId));expect((row!.resultJson as any).codexSharedGoalV1).toMatchObject({state:"source_receipted",sourceStatus:"paused"});},{timeout:8000,interval:50});
    // Known gap (real daemon): an objective-only edit of a paused goal emits no goal event, so goalJson stays at "initial goal" and a second edit holds with codex_shared_source_changed until a later snapshot.
    throw new Error("fixture_stop_before_turn");
  }});
  await expect(result).rejects.toThrow("fixture_stop_before_turn");expect(reached).toBe(true);
 } finally {vi.unstubAllEnvs();runnerPrpWebSocketInternals.resetForTests();await new Promise<void>(resolve=>server.close(()=>resolve()));await exec(cli,["app-server","daemon","stop"],{cwd:root,env,timeout:15000});await db.$client.end();await database.cleanup();}
},60000);
