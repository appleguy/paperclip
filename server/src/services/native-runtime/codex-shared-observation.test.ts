import { createServer, createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { CodexSharedGoalBinding } from "./codex-shared-goal-authority.js";

const authority=vi.hoisted(()=>({begin:vi.fn(),activate:vi.fn()}));
vi.mock("./codex-shared-goal-authority.js",()=>({beginCodexSharedObservation:authority.begin,activateCodexSharedObservation:authority.activate}));
import { attachCodexSharedObservation } from "./codex-shared-observation.js";

describe("shared Codex observation admission",()=>{
  it("persists before socket attach, activates after attestation, and blocks reconnect",async()=>{
    const dir=await mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/codex-observation-");
    const path=join(dir,"s");
    const server=createServer(()=>{});
    await new Promise<void>((ok,fail)=>server.once("error",fail).listen(path,ok));
    const steps:string[]=[]; let begun=false;
    authority.begin.mockImplementation(async()=>{steps.push("reserve");if(begun)return "reconciliation_required";begun=true;return "fresh";});
    authority.activate.mockImplementation(async()=>{steps.push("activate");});
    const input={db:{} as Db,binding:{} as CodexSharedGoalBinding,sourceGoalDigest:null,
      attest:async()=>{steps.push("attest");},
      attach:async()=>{steps.push("attach");const socket=createConnection(path);await new Promise<void>((ok,fail)=>socket.once("connect",ok).once("error",fail));return {detach:async()=>{socket.destroy();},isConnected:()=>!socket.destroyed,onDisconnect:(listener:()=>void)=>{socket.once("close",listener);}};}};
    try {
      const attached=await attachCodexSharedObservation(input);
      expect(steps).toEqual(["attest","reserve","attach","attest","activate"]);
      await attached.detach();
      await expect(attachCodexSharedObservation(input)).rejects.toThrow("reconciliation_required");
      expect(steps.filter(s=>s==="attach")).toHaveLength(1);
    } finally { await new Promise<void>(ok=>server.close(()=>ok())); await rm(dir,{recursive:true,force:true}); }
  });
  it("marks a lost attach acknowledgement uncertain without retry",async()=>{
    let count=0;
    authority.begin.mockImplementation(async()=>++count===1?"fresh":"reconciliation_required");
    const attach=vi.fn(async()=>{throw new Error("lost_ack");});
    await expect(attachCodexSharedObservation({db:{} as Db,binding:{} as CodexSharedGoalBinding,sourceGoalDigest:null,attest:async()=>{},attach})).rejects.toThrow("lost_ack");
    expect(count).toBe(2);expect(attach).toHaveBeenCalledTimes(1);
  });
  it("does not activate a socket lost during the attestation window",async()=>{
    let count=0, checks=0, connected=true;
    let disconnected=()=>{};
    authority.begin.mockImplementation(async()=>++count===1?"fresh":"reconciliation_required");
    authority.activate.mockClear();
    const detach=vi.fn(async()=>{});
    await expect(attachCodexSharedObservation({db:{} as Db,binding:{} as CodexSharedGoalBinding,sourceGoalDigest:null,
      attest:async()=>{if(++checks===2){connected=false;disconnected();}},
      attach:async()=>({detach,isConnected:()=>connected,onDisconnect:(callback:()=>void)=>{disconnected=callback;}}),
    })).rejects.toThrow("observation_disconnected");
    expect(authority.activate).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledTimes(1);
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
