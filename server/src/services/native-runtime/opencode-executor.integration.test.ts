import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agents, companies, completionContracts, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, projects } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "../../__tests__/helpers/route-test-harness.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { executePaperclipNativeSession } from "./native-session-executor.js";

vi.mock("./opencode-provider-profile.js", () => ({ resolveOpenCodeSharedProvider: async () => ({ provider: "openrouter", model: "fixture", baseUrl: "http://127.0.0.1:1/v1", key: "fixture" }) }));

describeEmbeddedPostgres("OpenCode ordinary executor", () => {
  const ctx = useEmbeddedPostgres("opencode-executor-");
  it("creates an admitted session and completes through a semantic receipt", async () => {
    const root = await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/opencode-executor-");
    const executable = join(root, "opencode-fixture");
    const script = `#!${process.execPath}
const http = require('node:http'), fs = require('node:fs');
if(process.argv.includes('--version')){console.log('opencode v2.2.5');process.exit(0)}
const auth='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_PASSWORD).toString('base64');let session, model;
const reply=(res,data)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data}))};
const server=http.createServer((req,res)=>{
 fs.appendFileSync('fixture-requests.log',req.method+' '+req.url+'\\n');
 if(req.headers.authorization!==auth)return res.writeHead(401).end();
 if(req.url==='/api/info'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({pid:process.pid,version:'2.2.5'}))}
 if(req.url.startsWith('/api/provider?'))return reply(res,[]);
 if(req.url.startsWith('/api/provider/openrouter?'))return reply(res,{id:'openrouter',package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).providers.openrouter.settings.baseURL,apiKey:process.env.PAPERCLIP_PROVIDER_TOKEN}});
 if(req.url.startsWith('/api/model?'))return reply(res,[{id:'fixture',providerID:'openrouter',variants:[{id:'high'}]}]);
 if(req.method==='POST'&&req.url==='/api/session'){let raw='';req.on('data',x=>raw+=x);return req.on('end',()=>{const p=JSON.parse(raw);session=p.id;model=p.model;reply(res,{id:session})})}
 if(req.method==='GET'&&req.url==='/api/session/'+session)return reply(res,{id:session,model,location:{directory:process.cwd()}});
 if(req.url.startsWith('/api/experimental/session/')){res.setHeader('content-type','text/event-stream');res.write('data: '+JSON.stringify({id:'evt_fixture',type:'session.tool.called',data:{sessionID:session,assistantMessageID:'msg_fixture',id:'tool_fixture',input:{},executed:true},durable:{aggregateID:session,seq:1,version:1}})+'\\n\\n');res.write('data: '+JSON.stringify({type:'log.synced',aggregateID:session,seq:1})+'\\n\\n');return}
 if(req.method==='POST'&&req.url==='/api/session/'+session+'/prompt'){let raw='';req.on('data',x=>raw+=x);return req.on('end',()=>{const p=JSON.parse(raw);reply(res,{id:p.id,sessionID:session,type:'user'});setTimeout(()=>{const target=new URL(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).mcp.servers.paperclip.url);const call=http.request(target,{method:'POST',headers:{authorization:'Bearer '+process.env.PAPERCLIP_MCP_TOKEN,'content-type':'application/json'}},r=>{let data='';r.on('data',x=>data+=x);r.on('end',()=>fs.appendFileSync('fixture-requests.log','finish '+data+'\\n'))});call.on('error',e=>fs.appendFileSync('fixture-requests.log','finish error '+e.message+'\\n'));call.end(JSON.stringify({jsonrpc:'2.0',id:'finish',method:'tools/call',params:{name:'paperclip_finish',arguments:{schema:'paperclip.run_result.v1',reportedWorkDisposition:'done',summary:'Fixture',completionClaim:{contractRevision:'fixture',objectiveSatisfied:true,criteria:[{criterionId:'c',status:'satisfied',evidenceRefs:[]}],remainingWork:[]},evidence:[],verification:[],attentionRequests:[],artifacts:[]},_meta:{'ai.opencode/sessionID':session}}}))},100)})}
 res.writeHead(404).end();
});server.listen(0,'127.0.0.1',()=>console.log('server listening on http://127.0.0.1:'+server.address().port));`;
    await writeFile(executable, script, { mode: 0o700 }); await chmod(executable, 0o700);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "91".repeat(32)); vi.stubEnv("PAPERCLIP_OPENCODE_V2_CLI", executable); vi.stubEnv("PAPERCLIP_HOME", root);
    const companyId=randomUUID(), projectId=randomUUID(), issueId=randomUUID(), agentId=randomUUID(), runId=randomUUID(), sessionId=randomUUID(), runnerInstanceId=randomUUID(), contractId=randomUUID(), sha="sha256:"+"a".repeat(64);
    await ctx.db.insert(companies).values({id:companyId,name:"Fixture",issuePrefix:"OCX"});
    await ctx.db.insert(agents).values({id:agentId,companyId,name:"Agent",role:"engineer",adapterType:"paperclip_runner"});
    await ctx.db.insert(projects).values({id:projectId,companyId,name:"Project"});
    await ctx.db.insert(issues).values({id:issueId,companyId,projectId,title:"Issue",assigneeAgentId:agentId,status:"in_progress"});
    await ctx.db.insert(completionContracts).values({id:contractId,companyId,issueId,revision:1,schemaVersion:"v1",policyVersion:"fixture",risk:"low",completionAuthority:"worker",incompleteCriteriaPolicy:"block",contractJson:{revision:"fixture",criteria:[{id:"c"}]},canonicalSha256:sha,createdByActorType:"system",createdByActorId:"fixture"});
    await ctx.db.insert(heartbeatRuns).values({id:runId,companyId,agentId,nativeIssueId:issueId,nativeSessionId:sessionId,runnerInstanceId,status:"running",runtimeMode:"native",completionContractId:contractId,completionContractSha256:sha});
    await ctx.db.update(issues).set({executionRunId:runId}).where(eq(issues.id,issueId));
    await ctx.db.insert(nativeRunFinalizations).values({runId,companyId,issueId,phase:"pending"});
    const execution=buildNativeExecutionInput({companyId,runId,agentId,issue:{id:issueId,identifier:"OCX-1",title:"Issue",description:null,workMode:"standard"},taskPrompt:"Issue",workspace:{id:randomUUID(),cwd:root,repoUrl:null,repoRef:null,branchName:null},normalizedSessionId:sessionId,provider:"opencode_shared_v2",model:"openrouter/fixture",opencodeEffort:"high",completionContract:{id:contractId,sha256:sha,schemaVersion:"v1",contract:{revision:"fixture",objective:"Issue",criteria:[{id:"c",requirement:"Done"}]}},runtimeContext:nativeRuntimeContextFixture()});
    try {
      const checkpoint = vi.fn<NonNullable<Parameters<typeof executePaperclipNativeSession>[0]["onOpenCodeFinalCheckpoint"]>>(async (session, lease) => { expect(session.result.summary).toBe("Fixture"); expect(lease.owner).toBeTruthy(); const [row] = await ctx.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,runId)); expect(row?.leaseOwner).toBe(lease.owner); return "fixture-revision"; });
      const result=await executePaperclipNativeSession({db:ctx.db,execution,runnerInstanceId,useRunnerd:true,runnerEnvironment:{OPENROUTER_API_KEY:"fixture"},turnTimeoutMs:10_000,onOpenCodeFinalCheckpoint:checkpoint});
      expect(result).toMatchObject({exitCode:0,resultJson:{nativeResult:{summary:"Fixture",reportedWorkDisposition:"done"}}});
      expect(checkpoint).toHaveBeenCalledOnce();
      const events = await ctx.db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId,runId));
      expect(events.some(event => event.eventType === "run.result.proposed")).toBe(true);
      expect(events.some(event => event.eventType === "turn.completed")).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  },30_000);
});
