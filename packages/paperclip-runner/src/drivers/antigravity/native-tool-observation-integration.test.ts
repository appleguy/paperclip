import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { createAntigravityHeadlessBackend } from "../../backends/native-backend-factory.js";
it("delivers bounded provider-only tool observation through a real Runner",async()=>{
 const root=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/agy-backend-");const fake=join(root,"fake-agy");
 await writeFile(fake,`#!${process.execPath}\nif(process.argv.includes('--version')){process.stdout.write('1.4.12');process.exit(0)};if(process.argv[process.argv.indexOf('--conversation')+1]!=='native')process.exit(4);process.stdout.write(JSON.stringify({event:'init',conversation_id:'native',init:{cwd:process.cwd(),permission_mode:'request-review'}})+'\\n');let s='';process.stdin.on('data',d=>{s+=d;if(s.includes('\\n')){process.stdout.write(JSON.stringify({event:'step_update',step_update:{conversation_id:'native',step_index:1,state:'running',step_type:'tool',tool_name:'read',text_delta:'secret'}})+'\\n');process.stdout.write(JSON.stringify({event:'result',result:{conversation_id:'native',status:'SUCCESS',response:'fake'}})+'\\n');s='';}});`,{mode:0o700});
 const identity={companyId:"company",agentId:"agent",issueId:"issue",runId:"run",sessionId:"session"};
 const observations: unknown[]=[];
 const options={onToolObservation:(value:unknown)=>observations.push(value),identity:{...identity},runnerInstanceId:"runner",environmentLeaseId:"lease",turnId:"turn",itemId:"item",bindingId:"binding",bindingGeneration:1,conversationId:"native",cwd:root,stateDirectory:join(root,"state"),runnerBinary:process.env.AGY_TEST_RUNNER_BINARY ?? resolve(import.meta.dirname,"../../../runner/target/debug/paperclip-runnerd"),executable:fake,verifiedVersion:"1.4.12",env:{PATH:process.env.PATH},admit:()=>true};
 const backend=createAntigravityHeadlessBackend(options);options.identity.runId="foreign";options.conversationId="foreign";
 let session:Awaited<ReturnType<typeof backend.openSession>>|undefined;
 try{session=await backend.openSession({identity,workingDirectory:root});expect((await session.snapshot()).providerSessionId).toBe("native");const events:import("../../protocol/replay-contract.js").PrpEvent[]=[];const stream=(async()=>{for await(const event of session!.events())events.push(event);})();
  expect(await session.startTurn({message:{role:"user",text:"hello"}})).toEqual({turnId:"turn"});
  await vi.waitFor(()=>expect(events.some(e=>e.eventType==="item.completed")).toBe(true),{timeout:10000,interval:25});
  expect(observations).toHaveLength(1);expect(observations[0]).toMatchObject({authority:"provider_observation_only",conversationId:"native",runId:"run"});expect(JSON.stringify(observations)).not.toContain("secret");
  const diagnostic=events.find(e=>e.eventType==="harness.diagnostic"&&e.payload.code==="antigravity_tool_observation");expect(diagnostic?.payload).toMatchObject({authority:"provider_observation_only",runId:"run",conversationId:"native",observationId:(observations[0] as {observationId:string}).observationId});expect(JSON.stringify(diagnostic)).not.toContain("secret");expect(events.some(e=>e.eventType==="run.terminal"||e.eventType.startsWith("tool.execution."))).toBe(false);expect(await session.result()).toBeNull();await session.close({reason:"test"});await stream;session=undefined;
 }finally{if(session)await session.close({reason:"cleanup"}).catch(()=>{});await rm(root,{recursive:true,force:true});}
},30000);
