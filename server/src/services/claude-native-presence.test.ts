import { describe, expect, it, vi } from "vitest";
import { discoverClaudeNativePresence, inspectClaudeNativePresence, type ClaudePresenceDependencies } from "./claude-native-presence.js";
const target = {sessionId:"f8f9af47-d5c8-4a93-a5d8-791c20dfa9d8",workspace:"/project"};
const row = {sessionId:target.sessionId,cwd:target.workspace,pid:123,startedAt:1_700_000_000_000,kind:"interactive",status:"idle",name:"PRIVATE TITLE",token:"PRIVATE"};
function fixture() {
  const authorize = vi.fn(async () => true);
  const inventory = vi.fn(async () => [row]);
  const process = vi.fn(async () => ({pid:123,startedAtMs:1_700_000_000_000,executable:"/usr/local/bin/claude"}));
  const sdk = {getSessionInfo:vi.fn(async () => ({sessionId:target.sessionId,cwd:target.workspace}))};
  const deps: ClaudePresenceDependencies = {authorize,inventory,process,sdk};
  return {deps,authorize,inventory,process,sdk};
}
describe("Claude native presence", () => {
  it("joins exact session, workspace, native inventory and OS process across two snapshots", async () => {
    const f = fixture(); const presence = await inspectClaudeNativePresence(target,f.deps);
    expect(presence).toMatchObject({state:"verified_local_session",sessionId:target.sessionId,remoteControl:"unknown",ownerIntervention:"unrestricted_by_observer"});
    expect(JSON.stringify(presence)).not.toContain("PRIVATE");
    expect(f.inventory).toHaveBeenCalledTimes(2); expect(f.process).toHaveBeenCalledTimes(2);
    expect(f.sdk.getSessionInfo).toHaveBeenCalledWith(target.sessionId,{dir:target.workspace});
  });
  it("never substitutes a title or another session for a missing UUID", async () => {
    const f = fixture(); f.inventory.mockResolvedValueOnce([]);
    expect(await inspectClaudeNativePresence(target,f.deps)).toEqual({state:"not_listed",sessionId:target.sessionId,remoteControl:"unknown"});
    expect(f.sdk.getSessionInfo).not.toHaveBeenCalled();
  });
  it("rejects workspace mismatch and duplicate session identities", async () => {
    const f = fixture(); f.inventory.mockResolvedValueOnce([{...row,cwd:"/foreign"}]);
    await expect(inspectClaudeNativePresence(target,f.deps)).rejects.toThrow("ambiguous");
    f.inventory.mockResolvedValueOnce([row,row]);
    await expect(inspectClaudeNativePresence(target,f.deps)).rejects.toThrow("ambiguous");
  });
  it("rejects PID reuse, other executables, stale SDK identity, and disappearing sessions", async () => {
    const f = fixture();
    f.process.mockResolvedValueOnce({pid:123,startedAtMs:row.startedAt+10_000,executable:"claude"});
    await expect(inspectClaudeNativePresence(target,f.deps)).rejects.toThrow("process identity");
    f.process.mockResolvedValueOnce({pid:123,startedAtMs:row.startedAt,executable:"other"});
    await expect(inspectClaudeNativePresence(target,f.deps)).rejects.toThrow("process identity");
    f.sdk.getSessionInfo.mockResolvedValueOnce({sessionId:target.sessionId,cwd:"/foreign"});
    await expect(inspectClaudeNativePresence(target,f.deps)).rejects.toThrow("SDK session identity");
    f.inventory.mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    await expect(inspectClaudeNativePresence(target,f.deps)).rejects.toThrow("changed during inspection");
  });
  it("checks server access at both boundaries", async () => {
    const f = fixture(); f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(inspectClaudeNativePresence(target,f.deps)).rejects.toThrow("access changed");
  });
  it("omits ambiguous external sessions and only returns safe source fields", async () => {
    const f = fixture();
    f.inventory.mockResolvedValueOnce([row,row]).mockResolvedValueOnce([row,row]);
    expect(await discoverClaudeNativePresence({...f.deps,authorize:async()=>true})).toEqual({sessions:[],truncated:false});
    expect(f.process).not.toHaveBeenCalled();
  });
  it("does not emit a stale external session when its PID changes", async () => {
    const f = fixture(); f.inventory.mockResolvedValueOnce([row]).mockResolvedValueOnce([{...row,pid:999}]);
    expect(await discoverClaudeNativePresence({...f.deps,authorize:async()=>true})).toEqual({sessions:[],truncated:false});
  });
});
