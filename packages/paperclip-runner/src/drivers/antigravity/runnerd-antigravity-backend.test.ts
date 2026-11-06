import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { createAntigravityHeadlessBackend } from "../../backends/native-backend-factory.js";
import { claimAgyHostAdmission } from "../../../../../server/src/adapters/agy/admission.js";
it("executes one fake native turn through a real Runner session, without claiming completion",async()=>{
 const root=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/agy-backend-");const fake=join(root,"fake-agy");
 await writeFile(fake,`#!${process.execPath}\nif(process.argv.includes('--version')){process.stdout.write('1.4.12');process.exit(0)};if(process.argv[process.argv.indexOf('--conversation')+1]!=='native')process.exit(4);process.stdout.write(JSON.stringify({event:'init',conversation_id:'native',init:{cwd:process.cwd(),permission_mode:'request-review'}})+'\\n');let s='';process.stdin.on('data',d=>{s+=d;if(s.includes('\\n')){process.stdout.write(JSON.stringify({event:'result',result:{conversation_id:'native',status:'SUCCESS',response:'fake'}})+'\\n');s='';}});`,{mode:0o700});
 const identity={companyId:"company",agentId:"agent",issueId:"issue",runId:"run",sessionId:"session"};
 const options={identity:{...identity},runnerInstanceId:"runner",environmentLeaseId:"lease",turnId:"turn",itemId:"item",bindingId:"binding",bindingGeneration:1,conversationId:"native",cwd:root,stateDirectory:join(root,"state"),runnerBinary:resolve(import.meta.dirname,"../../../runner/target/debug/paperclip-runnerd"),executable:fake,verifiedVersion:"1.4.12",env:{PATH:process.env.PATH},admit:()=>true};
 const backend=createAntigravityHeadlessBackend(options);options.identity.runId="foreign";options.conversationId="foreign";
 let session:Awaited<ReturnType<typeof backend.openSession>>|undefined;
 try{session=await backend.openSession({identity,workingDirectory:root});expect((await session.snapshot()).providerSessionId).toBe("native");const events:string[]=[];const stream=(async()=>{for await(const event of session!.events())events.push(event.eventType);})();
  expect(await session.startTurn({message:{role:"user",text:"hello"}})).toEqual({turnId:"turn"});
  await vi.waitFor(()=>expect(events).toContain("item.completed"),{timeout:10000,interval:25});
  expect(events).not.toContain("run.terminal");expect(await session.result()).toBeNull();await session.close({reason:"test"});await stream;session=undefined;
 }finally{if(session)await session.close({reason:"cleanup"}).catch(()=>{});await rm(root,{recursive:true,force:true});}
},30000);

it("holds the interactive host admission until the headless child exits",async()=>{
 const root=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/agy-host-admission-");
 const fake=join(root,"fake-agy"), admission=join(root,"admission");
 await writeFile(fake,`#!${process.execPath}\nif(process.argv.includes('--version')){process.stdout.write('1.5.1');process.exit(0)};process.stdout.write(JSON.stringify({event:'init',conversation_id:'native',init:{cwd:process.cwd(),permission_mode:'request-review'}})+'\\n');process.stdin.resume();`,{mode:0o700});
 const identity={companyId:"company",agentId:"agent",issueId:"issue",runId:"run",sessionId:"session"};
 const seat={runId:"seat-run",issueId:"seat-issue",stateDir:"/seat"};
 const owner={runId:identity.runId,issueId:identity.issueId,stateDir:join(root,"state")};
 const options={identity,runnerInstanceId:"runner",environmentLeaseId:"lease",turnId:"turn",itemId:"item",bindingId:"binding",bindingGeneration:1,conversationId:"native",cwd:root,stateDirectory:owner.stateDir,runnerBinary:resolve(import.meta.dirname,"../../../runner/target/debug/paperclip-runnerd"),executable:fake,verifiedVersion:"1.5.1",env:{PATH:process.env.PATH},admit:()=>true,claimHostAdmission:()=>claimAgyHostAdmission(admission,owner,false)};
 let session:Awaited<ReturnType<ReturnType<typeof createAntigravityHeadlessBackend>["openSession"]>>|undefined;
 try{
  const releaseSeat=await claimAgyHostAdmission(admission,seat,false);
  await expect(createAntigravityHeadlessBackend(options).openSession({identity,workingDirectory:root})).rejects.toThrow(/unresolved/);
  await releaseSeat();
  session=await createAntigravityHeadlessBackend({...options,stateDirectory:join(root,"state-2"),claimHostAdmission:()=>claimAgyHostAdmission(admission,owner,false)}).openSession({identity,workingDirectory:root});
  await expect(claimAgyHostAdmission(admission,seat,false)).rejects.toThrow(/unresolved/);
  await session.close({reason:"test"});session=undefined;
  const release=await claimAgyHostAdmission(admission,seat,false);await release();
 }finally{if(session)await session.close({reason:"cleanup"}).catch(()=>{});await rm(root,{recursive:true,force:true});}
},30000);
