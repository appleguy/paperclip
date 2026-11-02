import { describe, expect, it, vi } from "vitest";
import { createClaudeInteractiveVerifier, createLocalClaudeInteractiveVerifier, type ClaudeVerifierDependencies } from "./native-interactive-verifier.js";
const sessionId="f8f9af47-d5c8-4a93-a5d8-791c20dfa9d8", cwd="/work", pid=123, generation="123:birth", startedAtMs=1_700_000_000_000;
const target={sessionId,cwd,pid,generation};
function fixture() {
  const process=vi.fn(async () => ({pid,generation,startedAtMs,executable:"/usr/bin/claude"}));
  const inventory=vi.fn(async ():Promise<unknown> => [{sessionId,cwd,pid,startedAt:startedAtMs,kind:"interactive",title:"PRIVATE"}]);
  const getSessionInfo=vi.fn(async ():Promise<{sessionId:string;cwd?:string}|undefined> => ({sessionId,cwd}));
  const ownedSdkInit=vi.fn(async ():Promise<any> => null);
  const deps:ClaudeVerifierDependencies={executable:"/usr/bin/claude",process,inventory,getSessionInfo,ownedSdkInit};
  return {process,inventory,getSessionInfo,ownedSdkInit,verifier:createClaudeInteractiveVerifier(deps)};
}
describe("Claude interactive verifier", () => {
  it("keeps native inventory plus SDK metadata provisional without process-bound evidence", async () => {
    const f=fixture(); expect(await f.verifier.binding!(target)).toBe(false);
    expect(await f.verifier.session(sessionId,cwd)).toEqual({sessionId,cwd});
    expect(f.getSessionInfo).toHaveBeenCalledWith(sessionId,{dir:cwd});
  });
  it("verifies an exact SDK init receipt captured from the owned process", async () => {
    const f=fixture(); f.ownedSdkInit.mockResolvedValue({source:"owned-sdk-init",...target});
    expect(await f.verifier.binding!(target)).toBe(true);
    f.ownedSdkInit.mockResolvedValue({source:"owned-sdk-init",...target,generation:"other"});
    expect(await f.verifier.binding!(target)).toBe(false);
  });
  it("fails closed on wrong cwd, session, executable, or process generation", async () => {
    const f=fixture(); f.getSessionInfo.mockResolvedValueOnce({sessionId,cwd:"/other"});
    await expect(f.verifier.session(sessionId,cwd)).rejects.toThrow("identity mismatch");
    f.getSessionInfo.mockResolvedValueOnce({sessionId:"11111111-1111-1111-1111-111111111111",cwd});
    await expect(f.verifier.session(sessionId,cwd)).rejects.toThrow("identity mismatch");
    f.getSessionInfo.mockRejectedValueOnce(new Error("PRIVATE SDK DATA"));
    await expect(f.verifier.session(sessionId,cwd)).rejects.toThrow("metadata unavailable");
    f.inventory.mockResolvedValueOnce([{...target,cwd:"/other",startedAt:startedAtMs}]);
    await expect(f.verifier.binding!(target)).rejects.toThrow("identity mismatch");
    f.process.mockResolvedValueOnce({pid,generation:"other",startedAtMs,executable:"/usr/bin/claude"});
    expect(await f.verifier.process(pid,generation)).toBe(false);
    f.process.mockResolvedValueOnce({pid,generation,startedAtMs,executable:"/tmp/claude"});
    expect(await f.verifier.process(pid,generation)).toBe(false);
  });
  it("never verifies a forged receipt when both inventories omit the session", async () => {
    const f=fixture(); f.inventory.mockResolvedValue([]);
    f.ownedSdkInit.mockResolvedValue({source:"owned-sdk-init",...target});
    expect(await f.verifier.binding!(target)).toBe(false);
  });
  it("requires the explicitly scoped SDK reader to match the CLI namespace", () => {
    const sdk={getSessionInfo:async()=>undefined,namespace:{home:"/other",claudeConfigDir:"/other/.claude"}};
    expect(() => createLocalClaudeInteractiveVerifier({executable:"/bin/true",home:"/work",sdk})).toThrow("namespace mismatch");
    expect(() => createLocalClaudeInteractiveVerifier({executable:"/bin/true",home:"/work",claudeConfigDir:"/work/custom",sdk:{...sdk,namespace:{home:"/work",claudeConfigDir:"/work/.claude"}}})).toThrow("namespace mismatch");
  });
  it("detects inventory and process races without using title matches", async () => {
    const f=fixture(); f.inventory.mockResolvedValueOnce([{...target,startedAt:startedAtMs}]).mockResolvedValueOnce([]);
    await expect(f.verifier.binding!(target)).rejects.toThrow("changed during inspection");
    f.inventory.mockResolvedValueOnce([{...target,sessionId:"different",startedAt:startedAtMs,title:sessionId}]).mockResolvedValueOnce([]);
    expect(await f.verifier.binding!(target)).toBe(false);
    f.process.mockResolvedValueOnce({pid,generation,startedAtMs,executable:"/usr/bin/claude"}).mockResolvedValueOnce({pid,generation:"new",startedAtMs:startedAtMs+10000,executable:"/usr/bin/claude"});
    await expect(f.verifier.binding!(target)).rejects.toThrow("changed during inspection");
  });
  it("handles absent SDK metadata and bounds inventory and stalled lookups", async () => {
    const f=fixture(); f.getSessionInfo.mockResolvedValueOnce(undefined);
    expect(await f.verifier.session(sessionId,cwd)).toBeUndefined();
    f.inventory.mockResolvedValueOnce(Array.from({length:1001},()=>({})));
    await expect(f.verifier.binding!(target)).rejects.toThrow("invalid Claude session inventory");
    const stalled=createClaudeInteractiveVerifier({executable:"/usr/bin/claude",process:async()=>new Promise(()=>{}),inventory:async()=>[],getSessionInfo:async()=>undefined},10);
    await expect(stalled.process(pid,generation)).rejects.toThrow("timeout");
  });
});
