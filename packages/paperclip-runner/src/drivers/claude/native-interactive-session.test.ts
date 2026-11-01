import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaudeInteractiveSession } from "./native-interactive-session.js";
import type { ClaudeVerifierDependencies } from "./native-interactive-verifier.js";
const sessionId="f8f9af47-d5c8-4a93-a5d8-791c20dfa9d8", cwd="/work", pid=123, generation="123:birth", startedAtMs=1_700_000_000_000;
function fixture(directory:string) {
  const writeInput=vi.fn(), detach=vi.fn(async()=>{}), stop=vi.fn(async()=>{});
  const pty={pid,generation,writeInput,detach,stop};
  const start=vi.fn(async()=>pty), authorize=vi.fn(async()=>true);
  const process=vi.fn(async()=>({pid,generation,startedAtMs,executable:"/opt/claude"}));
  const getSessionInfo=vi.fn(async()=>({sessionId,cwd}));
  const ownedSdkInit=vi.fn(async():Promise<any>=>null);
  const inventory=vi.fn(async()=>[{sessionId,cwd,pid,startedAt:startedAtMs}]);
  const verifierDependencies:ClaudeVerifierDependencies={executable:"/opt/claude",process,getSessionInfo,ownedSdkInit,inventory};
  const options={executable:"/opt/claude",cwd,sessionId,model:"sonnet",effort:"low" as const,journalDirectory:directory,ownerAuthority:{authorize},home:"/home/test",sdk:{getSessionInfo,namespace:{home:"/home/test"}},ptyFactory:{start},verifierDependencies};
  return {options,writeInput,detach,stop,start,authorize,process,ownedSdkInit};
}
async function temp(){return mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/claude-session-test-");}
describe("Claude interactive session composition",()=>{
  it("uses the real controller and journal with exact identity; no-tools and detach retain the owner process",async()=>{
    const dir=await temp();try{
      const f=fixture(dir), session=await ClaudeInteractiveSession.launch(f.options);
      expect(f.start.mock.calls[0]![0]).toMatchObject({cwd,args:expect.arrayContaining(["--remote-control","--session-id",sessionId,"--autocompact","140000","--tools",""])});
      expect(await session.observe()).toMatchObject({nativeSessionId:sessionId,processGeneration:generation,identity:"provisional"});
      f.ownedSdkInit.mockResolvedValue({source:"owned-sdk-init",sessionId,cwd,pid,generation});
      expect(await session.observe()).toMatchObject({identity:"verified"});
      expect(await session.ownerInput({operationId:"one",text:"hello\r"})).toMatchObject({delivery:"unknown",binding:"verified"});
      await expect(session.ownerInput({operationId:"one",text:"hello\r"})).rejects.toThrow("outcome uncertain");
      expect(f.writeInput).toHaveBeenCalledTimes(1); expect((await readdir(dir)).filter(x=>x.endsWith(".reservation"))).toHaveLength(1);
      await session.detach(); expect(f.detach).toHaveBeenCalledOnce(); expect(f.stop).not.toHaveBeenCalled();
      await expect(session.observe()).rejects.toThrow("detached");
    } finally {await rm(dir,{recursive:true,force:true});}
  });
  it("denies input before journal reservation when authorization or process identity is lost",async()=>{
    const dir=await temp();try{
      const f=fixture(dir), session=await ClaudeInteractiveSession.launch(f.options);
      f.authorize.mockResolvedValueOnce(false); await expect(session.ownerInput({operationId:"denied",text:"x"})).rejects.toThrow("access denied");
      f.process.mockResolvedValueOnce({pid,generation:"changed",startedAtMs,executable:"/opt/claude"});
      await expect(session.ownerInput({operationId:"lost",text:"x"})).rejects.toThrow("process identity");
      expect(f.writeInput).not.toHaveBeenCalled();expect(await readdir(dir)).toEqual([]);
    } finally {await rm(dir,{recursive:true,force:true});}
  });
  it("retains an uncertain reservation after a failed terminal write and never repeats it",async()=>{
    const dir=await temp();try{
      const f=fixture(dir);f.writeInput.mockImplementationOnce(()=>{throw new Error("write failed");});
      const session=await ClaudeInteractiveSession.launch(f.options);
      await expect(session.ownerInput({operationId:"uncertain",text:"x"})).rejects.toThrow("outcome uncertain");
      await expect(session.ownerInput({operationId:"uncertain",text:"x"})).rejects.toThrow("outcome uncertain");
      expect(f.writeInput).toHaveBeenCalledTimes(1);expect((await readdir(dir)).filter(x=>x.endsWith(".reservation"))).toHaveLength(1);
    } finally {await rm(dir,{recursive:true,force:true});}
  });
});
