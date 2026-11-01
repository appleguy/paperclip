import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp,readFile,readdir,rm } from "node:fs/promises";
import { join } from "node:path";
import {expect,it,vi} from "vitest";
import {NativeOwnerCommandJournal} from "./native-owner-command-journal.js";
import {ClaudeInteractiveController} from "./native-interactive-controller.js";
import {ClaudeNativePtyFactory,verifyClaudePtyGeneration} from "./native-pty-factory.js";
const id="f8f9af47-d5c8-4a93-a5d8-791c20dfa9d8",gen="pid:birth";
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
const root="/Volumes/NVM/AI_Agent_Runtime/tmp";
const require=createRequire(import.meta.url);
let ptyPath=process.env.CLAUDE_TEST_PTY_MODULE;
if (!ptyPath) {try {ptyPath=require.resolve("node-pty");}catch{}}
it("atomically reserves once across independent instances and rejects changed inputs",async()=>{
  const dir=await mkdtemp(join(root,"claude-journal-"));
  try {
    const one=new NativeOwnerCommandJournal({directory:dir,sessionId:id,processGeneration:gen});
    const two=new NativeOwnerCommandJournal({directory:dir,sessionId:id,processGeneration:gen});
    const input={operationId:"operation",sessionId:id,processGeneration:gen,inputSha256:hash("private")};
    const outcomes=await Promise.all([one.begin(input),two.begin(input)]);
    expect(outcomes.filter(x=>x==="reserved")).toHaveLength(1);
    expect(["existing","uncertain"]).toContain(outcomes.find(x=>x!=="reserved"));
    expect(await new NativeOwnerCommandJournal({directory:dir,sessionId:id,processGeneration:gen}).begin(input)).toBe("existing");
    await expect(two.begin({...input,inputSha256:hash("changed")})).rejects.toThrow("conflict");
    expect(await readFile(join(dir,(await readdir(dir))[0]!),"utf8")).not.toContain("private");
  } finally {await rm(dir,{recursive:true,force:true});}
});
it.skipIf(process.platform!=="darwin" || !ptyPath)("never repeats after a reservation crash or after a real PTY write",async()=>{
  const dir=await mkdtemp(join(root,"claude-journal-pty-"));
  const factory=new ClaudeNativePtyFactory({loadPty:()=>require(ptyPath!)});
  const pty=await factory.start({executable:"/bin/cat",cwd:dir,args:[]});
  let writes=0;
  const wrapped={...pty,writeInput:(text:string)=>{writes++;pty.writeInput(text);}};
  const verifier={process:verifyClaudePtyGeneration,session:async()=>undefined};
  const make=()=>new NativeOwnerCommandJournal({directory:dir,sessionId:id,processGeneration:pty.generation});
  const input={operationId:"crash-before-write",sessionId:id,processGeneration:pty.generation,inputSha256:hash("hello\r")};
  try {
    expect(await make().begin(input)).toBe("reserved");
    const controller=await ClaudeInteractiveController.launch({executable:"/bin/cat",cwd:dir,sessionId:id,model:"sonnet",effort:"low",autoCompactTokens:140000},{start:async()=>wrapped},verifier,{authorize:async()=>true},make());
    await expect(controller.ownerInput({operationId:input.operationId,text:"hello\r"})).rejects.toThrow("outcome uncertain");
    expect(writes).toBe(0);
    expect(await controller.ownerInput({operationId:"sent-once",text:"hello\r"})).toMatchObject({delivery:"unknown",binding:"provisional"});
    expect(writes).toBe(1);
    const marker=(await readdir(dir)).find(name=>name.endsWith(".written"));
    expect(marker).toBeDefined();
    expect(JSON.parse(await readFile(join(dir,marker!),"utf8"))).toEqual({write:"attempted",delivery:"unknown"});
    const restarted=await ClaudeInteractiveController.launch({executable:"/bin/cat",cwd:dir,sessionId:id,model:"sonnet",effort:"low",autoCompactTokens:140000},{start:async()=>wrapped},verifier,{authorize:async()=>true},make());
    await expect(restarted.ownerInput({operationId:"sent-once",text:"hello\r"})).rejects.toThrow("outcome uncertain");
    expect(writes).toBe(1);
  } finally {
    if(await verifyClaudePtyGeneration(pty.pid,pty.generation))await pty.stop();
    await vi.waitFor(async()=>expect(await verifyClaudePtyGeneration(pty.pid,pty.generation)).toBe(false),{timeout:3000,interval:30});
    await rm(dir,{recursive:true,force:true});
  }
});
