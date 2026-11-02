import {createHash} from "node:crypto";
import {mkdtemp,readdir,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {describe,expect,it,vi} from "vitest";
import {ClaudeHookStartIngress} from "./native-hook-binding.js";
import {NativeOwnerCommandJournal} from "./native-owner-command-journal.js";
const identity={sessionId:"f8f9af47-d5c8-4a93-a5d8-791c20dfa9d8",cwd:"/workspace",pid:123,processGeneration:"123:birth",namespace:"account-scope"};
const nonce="ab".repeat(32), body=JSON.stringify({session_id:identity.sessionId,cwd:identity.cwd,hook_event_name:"SessionStart",pid:999999});
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
async function temp(){return mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/claude-hook-test-");}
function fixture(dir:string){const verify=vi.fn(async()=>true);const ingress=new ClaudeHookStartIngress({identity,nonce,journalDirectory:dir,peer:{verify}});return{ingress,verify};}
describe("Claude SessionStart hook durable ingress",()=>{
  it("accepts one kernel-adapter verified receipt and rejects replay after recreation",async()=>{const dir=await temp();try{
    const f=fixture(dir);expect(await f.ingress.accept({connection:{},nonce,body})).toEqual({sessionId:identity.sessionId,event:"SessionStart",origin:"unknown",dispatchCorrelation:"unknown",runCompletion:"unproven"});
    expect(f.verify.mock.calls[0]![1]).toEqual(identity);
    await expect(fixture(dir).ingress.accept({connection:{},nonce,body})).rejects.toThrow("already consumed");
    const contents=await Promise.all((await readdir(dir)).map(name=>readFile(join(dir,name),"utf8")));
    expect(contents.join("")).not.toContain(nonce);expect(contents.join("")).not.toContain(body);
  }finally{await rm(dir,{recursive:true,force:true});}});
  it("rejects unverified peer, bad nonce, wrong session or event and oversized payload before reservation",async()=>{const dir=await temp();try{
    const f=fixture(dir);f.verify.mockResolvedValueOnce(false);await expect(f.ingress.accept({connection:{},nonce,body})).rejects.toThrow("peer unverified");
    await expect(f.ingress.accept({connection:{},nonce:"cd".repeat(32),body})).rejects.toThrow("nonce mismatch");
    await expect(f.ingress.accept({connection:{},nonce,body:body.replace(identity.sessionId,"00000000-0000-0000-0000-000000000000")})).rejects.toThrow("identity mismatch");
    await expect(f.ingress.accept({connection:{},nonce,body:body.replace("SessionStart","Stop")})).rejects.toThrow("not SessionStart");
    await expect(f.ingress.accept({connection:{},nonce,body:"x".repeat(4097)})).rejects.toThrow("invalid Claude hook input");
    expect(await readdir(dir)).toEqual([]);
  }finally{await rm(dir,{recursive:true,force:true});}});
  it("leaves an interrupted reservation uncertain across process recreation",async()=>{const dir=await temp();try{
    const journal=new NativeOwnerCommandJournal({directory:dir,sessionId:identity.sessionId,processGeneration:identity.processGeneration});
    expect(await journal.begin({operationId:`hook-start:${sha(nonce)}`,sessionId:identity.sessionId,processGeneration:identity.processGeneration,inputSha256:sha(body)})).toBe("reserved");
    await expect(fixture(dir).ingress.accept({connection:{},nonce,body})).rejects.toThrow("already consumed or uncertain");
    expect((await readdir(dir)).filter(name=>name.endsWith(".written"))).toHaveLength(0);
  }finally{await rm(dir,{recursive:true,force:true});}});
});
