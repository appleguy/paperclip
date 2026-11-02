import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createAntigravityHeadlessBackend } from "../../backends/native-backend-factory.js";

it("refuses an old Runner before any native stdin write",async()=>{
 const root=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/agy-neg-");const fake=join(root,"agy"),writes=join(root,"writes");await writeFile(writes,"");
 await writeFile(fake,`#!${process.execPath}\nif(process.argv.includes('--version')){process.stdout.write('1.4.12');process.exit(0)};process.stdout.write(JSON.stringify({event:'init',conversation_id:'native',init:{cwd:process.cwd(),permission_mode:'request-review'}})+'\\n');process.stdin.on('data',()=>require('node:fs').appendFileSync(${JSON.stringify(writes)},'write\\n'));`,{mode:0o700});
 const identity={companyId:"c",agentId:"a",issueId:"i",runId:"r",sessionId:"s"};
 const backend=createAntigravityHeadlessBackend({identity,runnerInstanceId:"runner",environmentLeaseId:"lease",turnId:"turn",itemId:"item",bindingId:"binding",bindingGeneration:1,conversationId:"native",cwd:root,stateDirectory:join(root,"state"),runnerBinary:process.env.AGY_TEST_OLD_RUNNER ?? resolve(import.meta.dirname,"../../../runner/target/debug/paperclip-runnerd"),executable:fake,verifiedVersion:"1.4.12",env:{PATH:process.env.PATH},admit:()=>true});
 try{await expect(backend.openSession({identity,workingDirectory:root})).rejects.toThrow();expect(await readFile(writes,"utf8")).toBe("");}finally{await rm(root,{recursive:true,force:true});}
},30000);
