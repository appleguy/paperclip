import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { ClaudeInteractiveSession } from "./native-interactive-session.js";
import { openClaudeNativeMcpBinding } from "./claude-native-mcp-binding.js";

const sessionId="f8f9af47-d5c8-4a93-a5d8-791c20dfa9d8";
const scope={companyId:"company",runId:"run",taskId:"task",leaseId:"lease",nativeSessionId:sessionId};
async function fixture(directory:string) {
  const dispatch=vi.fn(async()=>({accepted:true}));
  const binding=await openClaudeNativeMcpBinding({scope,tools:[],dispatch});
  const detach=vi.fn(async()=>{}), stop=vi.fn(async()=>{});
  const start=vi.fn(async (_input:{args:readonly string[]})=>({pid:123,generation:"generation",detach,stop}));
  const verifierDependencies={executable:"/opt/claude",process:async()=>({pid:123,generation:"generation",startedAtMs:1,executable:"/opt/claude"}),getSessionInfo:async()=>undefined,inventory:async()=>[]};
  const options={executable:"/opt/claude",cwd:"/work",sessionId,model:"sonnet",effort:"low" as const,journalDirectory:directory,ownerAuthority:{authorize:async()=>true},home:"/home/test",sdk:{getSessionInfo:async()=>undefined,namespace:{home:"/home/test"}},ptyFactory:{start},verifierDependencies,mcpBinding:binding};
  return {options,binding,dispatch,start,detach,stop};
}
describe("Claude interactive scoped MCP composition",()=>{
  it("passes a private file to the same launch and closes it without killing the owner",async()=>{
    const dir=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/claude-mcp-session-");
    try {
      const f=await fixture(dir), session=await ClaudeInteractiveSession.launch(f.options);
      const args=f.start.mock.calls[0]![0].args;
      expect(args).toContain("--strict-mcp-config"); expect(args).toContain("--remote-control");
      const path=args[args.indexOf("--mcp-config")+1]!;
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const config=JSON.parse(await readFile(path,"utf8"));
      const response=await fetch(config.mcpServers.paperclip.url,{method:"POST",headers:{"content-type":"application/json",authorization:config.mcpServers.paperclip.headers.Authorization},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})});
      expect(response.status).toBe(200);
      await session.detach(); expect(f.detach).toHaveBeenCalledOnce(); expect(f.stop).not.toHaveBeenCalled();
      expect(await readdir(dir)).not.toContain(path.split("/").pop());
      await expect(fetch(config.mcpServers.paperclip.url,{method:"POST"})).rejects.toThrow();
    } finally {await rm(dir,{recursive:true,force:true});}
  });
  it("cleans up binding and private config on launch failure without stopping a process",async()=>{
    const dir=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/claude-mcp-session-");
    try {
      const f=await fixture(dir);f.start.mockRejectedValueOnce(new Error("launch failed"));
      await expect(ClaudeInteractiveSession.launch(f.options)).rejects.toThrow("launch failed");
      expect(await readdir(dir)).toEqual([]);expect(f.stop).not.toHaveBeenCalled();
      expect(()=>f.binding.mcpConfig()).toThrow("closed");
    } finally {await rm(dir,{recursive:true,force:true});}
  });
  it("preserves a launched child when its identity is invalid and closes the helper",async()=>{
    const dir=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/claude-mcp-session-");
    try {
      const f=await fixture(dir);
      f.start.mockResolvedValueOnce({pid:0,generation:"generation",detach:f.detach,stop:f.stop});
      await expect(ClaudeInteractiveSession.launch(f.options)).rejects.toThrow("reconcile launch");
      expect(f.stop).not.toHaveBeenCalled();expect(f.detach).not.toHaveBeenCalled();
      expect(await readdir(dir)).toEqual([]);expect(()=>f.binding.mcpConfig()).toThrow("closed");
    } finally {await rm(dir,{recursive:true,force:true});}
  });
});
