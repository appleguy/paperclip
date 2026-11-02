import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { RunnerdAntigravityBackend } from "./runnerd-antigravity-backend.js";
import { openAntigravityNativeMcpWorkspace } from "./native-mcp-workspace.js";

it("binds an owned initialized fake child and exact private workspace before accepting a tool call",async()=>{
 const root=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/agy-attested-");
 let assertLive:(()=>void)|undefined;
 const scope={companyId:"company",issueId:"issue",runId:"run",agentId:"agent",leaseId:"lease",normalizedSessionId:"session"};
 const workspace=await openAntigravityNativeMcpWorkspace({privateParent:root,scope,tools:[{name:"task_read",inputSchema:{type:"object"}}],executeFenced:async(s)=>{assertLive!();return {conversation:s.conversationId};}});
 const fake=join(root,"fake-agy"),marker=join(root,"stdin-observed");
 await writeFile(fake,`#!${process.execPath}\nif(process.argv.includes('--version')){process.stdout.write('1.4.12');process.exit(0)};process.stdout.write(JSON.stringify({event:'init',conversation_id:'native',init:{cwd:process.cwd(),permission_mode:'request-review'}})+'\\n');process.stdin.on('data',()=>require('fs').writeFileSync(${JSON.stringify(marker)},'input'));`,{mode:0o700});
 const identity={companyId:"company",agentId:"agent",issueId:"issue",runId:"run",sessionId:"session"};
 const backend=new RunnerdAntigravityBackend({identity,runnerInstanceId:"runner",environmentLeaseId:"lease",turnId:"turn",itemId:"item",bindingId:"binding",bindingGeneration:1,conversationId:"native",cwd:workspace.workspace,stateDirectory:join(root,"state"),runnerBinary:process.env.AGY_TEST_RUNNER_BINARY ?? resolve(import.meta.dirname,"../../../runner/target/debug/paperclip-runnerd"),executable:fake,verifiedVersion:"1.4.12",env:{PATH:process.env.PATH},admit:()=>false,onNativeReady:async bound=>{expect(bound.conversationId).toBe("native");expect(bound.workspace).toBe(workspace.workspace);expect(bound.processGeneration).toMatch(/^\d+:/);bound.assertLive();assertLive=bound.assertLive;workspace.bindConversation({conversationId:bound.conversationId,processGeneration:bound.processGeneration});}});
 let session:Awaited<ReturnType<typeof backend.openSession>>|undefined;
 try{
  session=await backend.openSession({identity,workingDirectory:workspace.workspace});expect(assertLive).toBeDefined();
  const c=JSON.parse(await readFile(join(workspace.workspace,".agents/mcp_config.json"),"utf8")).mcpServers.paperclip;
  const rpc=async(id:string)=>await (await fetch(c.serverUrl,{method:"POST",headers:{authorization:c.headers.Authorization,"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id,method:"tools/call",params:{name:"task_read",arguments:{}}})})).json() as {result:{isError?:boolean}};
  expect((await rpc("first")).result.isError).not.toBe(true);
  await chmod(workspace.workspace,0o755);expect((await rpc("bad-mode")).result.isError).toBe(true);await chmod(workspace.workspace,0o700);
  await expect(session.startTurn({message:{role:"user",text:"must not dispatch"}})).rejects.toThrow(/ingress unsupported/);await expect(readFile(marker)).rejects.toMatchObject({code:"ENOENT"});await session.close({reason:"test"});session=undefined;expect(()=>assertLive!()).toThrow(/unavailable/);expect((await rpc("after-exit")).result.isError).toBe(true);
 }finally{if(session)await session.close({reason:"cleanup"}).catch(()=>{});await workspace.close();await rm(root,{recursive:true,force:true});}
},30000);
