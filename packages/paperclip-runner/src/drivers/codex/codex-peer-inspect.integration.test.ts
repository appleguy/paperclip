import { spawn, execFile } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
const run=promisify(execFile), runner=process.env.PAPERCLIP_CODEX_PEER_INSPECT_BIN;
(runner ? describe : describe.skip)("Codex daemon kernel peer inspection",()=>{
  it("identifies an isolated real app-server process and rejects a missing socket",async()=>{
    const dir=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/codex-peer-proof-"),sock=dir+"/server.sock";
    const child=spawn("/opt/homebrew/bin/codex",["app-server","--listen",`unix://${sock}`],{cwd:dir,env:{PATH:"/usr/bin:/bin",HOME:dir,CODEX_HOME:dir,LANG:"C"},stdio:"ignore"});
    try {
      const until=Date.now()+10000;for(;;){try {await stat(sock);break;}catch{if(Date.now()>until)throw new Error("isolated socket unavailable");await new Promise(r=>setTimeout(r,20));}}
      const output=JSON.parse((await run(runner!,["--inspect-codex-peer",await realpath(sock)],{timeout:8000})).stdout);
      expect(output.peer.pid).toBe(child.pid);expect(output.peer.startSeconds).toBeGreaterThan(0);expect(output.peer.startMicroseconds).toBeGreaterThanOrEqual(0);
      expect(await realpath(output.peer.executable)).toBe(await realpath("/opt/homebrew/bin/codex"));
      expect(output.daemonGeneration).toMatch(/^\d+:\d+:-?\d+:\d+$/);
      await expect(run(runner!,["--inspect-codex-peer",dir+"/missing.sock"],{timeout:8000})).rejects.toThrow();
    } finally {child.kill("SIGTERM");if(child.exitCode===null && child.signalCode===null)await once(child,"exit");await rm(dir,{recursive:true,force:true});}
  },30000);
});
