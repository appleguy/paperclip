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
import { dispatchLiveRunnerGoalControl } from "../runner-goal-control-broker.js";
import { setupRunnerPrpWebSocketServer, runnerPrpWebSocketInternals } from "../../realtime/runner-prp-ws.js";

it.each(["no registered grant","conversation mode"] as const)("registered agent that cannot be admitted fails closed without launching a provider (%s)",async mode=>{
 const root=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/codex-executor-");const home=join(root,"home"),workspace=join(root,"workspace"),assets=join(root,"assets");await mkdir(home);await mkdir(workspace);await mkdir(assets);await writeFile(join(assets,"AGENTS.md"),"Fixture instructions\n");await mkdir(join(home,"app-server-daemon"));await writeFile(join(home,"app-server-daemon","settings.json"),JSON.stringify({remoteControlEnabled:false,updater:{autoUpdateEnabled:false}}));
 const exec=promisify(execFile),cli="/opt/homebrew/bin/codex",runner=process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER??"/Volumes/NVM/AI_Agent_Runtime/tmp/codex-shared-proof.UC8Vu3/target/debug/paperclip-runnerd",env={PATH:"/opt/homebrew/bin:/usr/bin:/bin",HOME:home,CODEX_HOME:home,TMPDIR:home,LANG:"C"};
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
  const host={hostId:"isolated",codexExecutable:cli,codexHome:home,runnerExecutable:runner,home};
  for(const [key,value] of Object.entries({PAPERCLIP_RUNNER_BINARY:runner,PAPERCLIP_HOME:root,PAPERCLIP_CODEX_SHARED_AGENT_ID:agentId,...(mode==="no registered grant"?{}:{PAPERCLIP_CODEX_SHARED_GRANT_ID:"00000000-0000-4000-8000-000000000001"}),PAPERCLIP_CODEX_SHARED_HOST_ID:host.hostId,PAPERCLIP_CODEX_SHARED_EXECUTABLE:cli,PAPERCLIP_CODEX_SHARED_CODEX_HOME:home,PAPERCLIP_CODEX_SHARED_HOME:home,PAPERCLIP_SECRETS_MASTER_KEY:"91".repeat(32)})) vi.stubEnv(key,value);
  const context=nativeRuntimeContextFixture();context.instructions.bundle.rootPath=assets;context.aggregateDigest=canonicalNativeRuntimeContextDigest(context);
  const execution=buildNativeExecutionInput({companyId,runId,agentId,issue:{id:issueId,identifier:"CEX-1",title:"Issue",description:null,workMode:"standard"},taskPrompt:"Issue",workspace:{id:workspaceId,cwd:workspace,repoUrl:null,repoRef:null,branchName:null},normalizedSessionId:sessionId,provider:"codex",model:"gpt-5.1-codex",codexReasoningEffort:"high",completionContract:{id:contractId,sha256:sha,schemaVersion:"v1",contract:{revision:"fixture",objective:"Issue",criteria:[{id:"c",requirement:"Done"}]}},runtimeContext:context});
  let reached=false;
  const result=executePaperclipNativeSession({db,execution,runnerInstanceId,useRunnerd:true,adapterType:"paperclip_runner",turnTimeoutMs:10000,...(mode==="conversation mode"?{conversationMode:true}:{}),onCodexSharedSessionReady:async()=>{reached=true;}} as never);
  await expect(result).rejects.toThrow("codex_shared_registration_unavailable");
  expect(reached).toBe(false);
 } finally {vi.unstubAllEnvs();runnerPrpWebSocketInternals.resetForTests();await new Promise<void>(resolve=>server.close(()=>resolve()));await db.$client.end();await database.cleanup();}
},60000);
