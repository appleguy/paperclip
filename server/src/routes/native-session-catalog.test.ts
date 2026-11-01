import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { nativeSessionCatalogRoutes } from "./native-session-catalog.js";
import { canActorReadHeartbeatRun } from "../services/heartbeat-run-privacy.js";
vi.mock("../services/heartbeat-run-privacy.js",()=>({canActorReadHeartbeatRun:vi.fn()}));
const company="55cef09f-ec08-4e71-8e7f-2afb4a912ce8";
const actor:Express.Request["actor"]={type:"board",source:"board_key",isInstanceAdmin:false,userId:"user",companyIds:[company]};
const row={companyId:company,runId:"run",agentId:"agent",issueId:"public",scopeKind:"issue",runStatus:"running",driverKind:null,normalizedSessionId:null,providerSessionBefore:null,providerSessionAfter:null,taskSessionId:null,goalStatus:null,goalObservedAt:null,startedAt:null,finishedAt:null,lastOutputAt:null};
function fixture(identity:Express.Request["actor"]) {
  const limit=vi.fn().mockResolvedValue([row,{...row,runId:"private",issueId:"private"},{...row,companyId:"foreign",runId:"foreign"}]);
  const chain:any={from:()=>chain,leftJoin:()=>chain,where:()=>chain,orderBy:()=>chain,limit};const db:any={select:vi.fn(()=>chain)};
  const app=express();app.use((req,_res,next)=>{req.actor=identity;next()});app.use("/api",nativeSessionCatalogRoutes(db));app.use(errorHandler);
  return {app,db};
}
describe("native session catalog route",()=>{
  it("rejects non-Board and foreign company before querying",async()=>{
    for(const identity of [{type:"none"},{type:"agent",source:"agent_key",companyId:company},{...actor,companyIds:[]}] as Express.Request["actor"][]){const f=fixture(identity);await request(f.app).get(`/api/companies/${company}/native-sessions`).expect(403);expect(f.db.select).not.toHaveBeenCalled();}
  });
  it("filters private-project and foreign-company rows using run privacy",async()=>{
    vi.mocked(canActorReadHeartbeatRun).mockImplementation(async(_db,_access,_actor,run)=>run.issueId!=="private");
    const f=fixture(actor);const result=await request(f.app).get(`/api/companies/${company}/native-sessions`).expect(200);
    expect(result.headers["cache-control"]).toBe("no-store");expect(result.body.sessions.map((item:any)=>item.runId)).toEqual(["run"]);
  });
  it("rejects arbitrary selectors before discovery",async()=>{const f=fixture(actor);await request(f.app).get(`/api/companies/${company}/native-sessions?pid=1`).expect(400);expect(f.db.select).not.toHaveBeenCalled();});
});
