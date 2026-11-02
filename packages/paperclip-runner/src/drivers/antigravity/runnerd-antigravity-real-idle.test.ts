import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { RunnerdAntigravityBackend } from "./runnerd-antigravity-backend.js";
const real=process.env.PAPERCLIP_TEST_AGY_IDLE_CANARY==="1";
it.skipIf(!real)("binds and closes an exact real agy session with zero input",async()=>{
 const root=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/agy-real-idle-");
 const env={HOME:process.env.HOME,USER:process.env.USER,LOGNAME:process.env.LOGNAME,PATH:process.env.PATH,LANG:process.env.LANG};
 let child:ReturnType<typeof spawn>|undefined;let session:Awaited<ReturnType<RunnerdAntigravityBackend["openSession"]>>|undefined;
 try {
  child=spawn("/opt/homebrew/bin/agy",["--input-format","stream-json","--output-format","stream-json","--settings","{}"],{cwd:root,env,stdio:"pipe"});
  const native=await new Promise<string>((resolveId,reject)=>{let pending="";const timer=setTimeout(()=>reject(new Error("idle init deadline")),5000);child!.stdout!.on("data",data=>{pending+=data.toString();const newline=pending.indexOf("\n");if(newline<0)return;try{const event=JSON.parse(pending.slice(0,newline));if(event.event!=="init"||!event.conversation_id||event.init?.cwd!==root)throw new Error("idle init mismatch");clearTimeout(timer);resolveId(event.conversation_id);}catch(e){clearTimeout(timer);reject(e);}});child!.on("error",reject);});
  child.stdin!.end();await new Promise<void>((resolveExit,reject)=>child!.once("close",code=>code===0?resolveExit():reject(new Error("idle CLI exit failed"))));child=undefined;
  const identity={companyId:"fixture-company",agentId:"fixture-agent",issueId:"fixture-issue",runId:"fixture-run",sessionId:"fixture-session"};
  const backend=new RunnerdAntigravityBackend({identity,runnerInstanceId:"fixture-runner",environmentLeaseId:"fixture-lease",turnId:"fixture-turn",itemId:"fixture-item",bindingId:"fixture-binding",bindingGeneration:1,conversationId:native,cwd:root,stateDirectory:join(root,"state"),runnerBinary:resolve(import.meta.dirname,"../../../runner/target/debug/paperclip-runnerd"),executable:"/opt/homebrew/bin/agy",verifiedVersion:"1.4.12",env,admit:()=>false});
  session=await backend.openSession({identity,workingDirectory:root});expect((await session.snapshot()).providerSessionId).toBe(native);await session.close({reason:"idle test"});session=undefined;
 }finally{if(session)await session.close({reason:"cleanup"}).catch(()=>{});if(child){child.kill("SIGTERM");await new Promise<void>(r=>child!.once("close",()=>r()));}await rm(root,{recursive:true,force:true});}
},30000);
