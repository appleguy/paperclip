import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { claudeNativePresenceRoutes, singleFlightWithDeadline } from "./claude-native-presence.js";
const company = "55cef09f-ec08-4e71-8e7f-2afb4a912ce8";
const sid = "f8f9af47-d5c8-4a93-a5d8-791c20dfa9d8";
const path = `/api/companies/${company}/native-sessions/claude`;
const board: Express.Request["actor"] = {type:"board",source:"board_key",isInstanceAdmin:true,userId:"user",companyIds:[company]};
function fixture(actor:Express.Request["actor"]) {
  const host = vi.fn(async () => ({claudeExecutable:"/trusted/claude",home:"/trusted"}));
  const row = {sessionId:sid,cwd:"/private/path",pid:123,startedAt:1700000000000,kind:"interactive",status:"idle",name:"PRIVATE TITLE",token:"PRIVATE TOKEN"};
  const inventory = vi.fn(async () => [row]);
  const process = vi.fn(async () => ({pid:123,startedAtMs:1700000000000,executable:"/trusted/claude"}));
  const sdk = {getSessionInfo:vi.fn(async () => ({sessionId:sid,cwd:"/private/path",summary:"PRIVATE SUMMARY"}))};
  const app = express(); app.use((req,_res,next) => {req.actor=actor;next();});
  app.use("/api",claudeNativePresenceRoutes({resolveHostSettings:host,dependencies:() => ({inventory,process,sdk})}));
  app.use(errorHandler);
  return {app,host,inventory,process,sdk};
}
describe("Claude native presence route", () => {
  it("requires authenticated Board instance admin and company access before discovery", async () => {
    for (const actor of [
      {type:"none"}, {type:"agent",source:"agent_key",companyId:company},
      {...board,isInstanceAdmin:false}, {...board,source:"local_implicit"},
      {...board,userId:undefined}, {...board,companyIds:[]},
    ] as Express.Request["actor"][]) {
      const f=fixture(actor); await request(f.app).get(path).expect(403);
      expect(f.host).not.toHaveBeenCalled(); expect(f.inventory).not.toHaveBeenCalled();
    }
  });
  it("refuses client-provided paths, process IDs, or session selectors", async () => {
    const f=fixture(board); await request(f.app).get(path).query({workspace:"/other",pid:"42"}).expect(400);
    expect(f.host).not.toHaveBeenCalled();
  });
  it("returns verified external metadata only, without a run or RC claim", async () => {
    const f=fixture(board); const response=await request(f.app).get(path).expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({sessions:[{sessionId:sid,source:"observed_external",kind:"interactive",status:"idle",remoteControl:"unknown",ownerIntervention:"vendor_native_unverified"}],truncated:false});
    expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE|\/private|123/);
    expect(f.inventory).toHaveBeenCalledTimes(2);
  });
});

describe("discovery single flight", () => {
  it("shares work, times out callers, and retains the slot until a stuck dependency settles", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: string) => void;
      let allowed!: () => boolean;
      const work = vi.fn((check: () => boolean) => { allowed = check; return new Promise<string>(resolve => { finish = resolve; }); });
      const run = singleFlightWithDeadline(work, 50);
      const first = run();
      const second = run();
      const firstFailure = expect(first).rejects.toThrow("deadline");
      const secondFailure = expect(second).rejects.toThrow("deadline");
      await vi.advanceTimersByTimeAsync(50);
      await Promise.all([firstFailure, secondFailure]);
      expect(work).toHaveBeenCalledTimes(1);
      expect(allowed()).toBe(false);
      await expect(run()).rejects.toThrow("deadline");
      expect(work).toHaveBeenCalledTimes(1);
      finish("done");
      await vi.waitFor(() => expect(allowed()).toBe(false));
      await Promise.resolve();
      const next = run();
      await Promise.resolve();
      expect(work).toHaveBeenCalledTimes(2);
      finish("next");
      await expect(next).resolves.toBe("next");
    } finally { vi.useRealTimers(); }
  });
});
