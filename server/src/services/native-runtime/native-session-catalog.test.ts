import { describe, expect, it, vi } from "vitest";
import { nativeSessionCatalog, projectNativeSession, type CatalogRow } from "./native-session-catalog.js";
import { canActorReadHeartbeatRun } from "../heartbeat-run-privacy.js";
vi.mock("../heartbeat-run-privacy.js", () => ({ canActorReadHeartbeatRun: vi.fn() }));
const row: CatalogRow = { companyId:"company",runId:"run",agentId:"agent",issueId:"issue",scopeKind:"issue",runStatus:"running",driverKind:"codex_app_server",normalizedSessionId:"normalized",providerSessionBefore:null,providerSessionAfter:"native",taskSessionId:"task-session",goalStatus:null,goalObservedAt:null,startedAt:null,finishedAt:null,lastOutputAt:null };
describe("native session catalog",()=>{
  it("does not infer liveness, ownership, a native link or controls from a persisted session",()=>{
    expect(projectNativeSession(row)).toMatchObject({state:"unknown",stateEvidence:"insufficient_evidence",providerSessionId:"native",providerSessionIdSource:"run.sessionIdAfter",capabilities:{nativeLink:null,nativeControl:"unknown",managedSteering:"unknown"}});
    expect(projectNativeSession({...row,providerSessionBefore:null,providerSessionAfter:null}).providerSessionId).toBeNull();
  });
  it("labels persisted terminal, queue and timestamped goal observations separately from exact live evidence",()=>{
    for (const runStatus of ["succeeded", "failed", "cancelled", "timed_out"]) expect(projectNativeSession({...row,runStatus},"working")).toMatchObject({state:"run-terminal",runStatus,stateEvidence:"persisted_terminal_run"});
    expect(projectNativeSession({...row,runStatus:"queued"}).state).toBe("waiting");
    expect(projectNativeSession({...row,goalStatus:"active"}).state).toBe("unknown");
    expect(projectNativeSession({...row,goalStatus:"active",goalObservedAt:new Date(0)})).toMatchObject({state:"goal-active",stateEvidence:"persisted_goal_observation"});
    expect(projectNativeSession({...row,goalStatus:"paused",goalObservedAt:new Date(0)}).state).toBe("paused");
    expect(projectNativeSession(row,"disconnected")).toMatchObject({state:"disconnected",stateEvidence:"authorized_live_observer"});
    expect(projectNativeSession(row,"working").state).toBe("working");
    expect(projectNativeSession({...row,runStatus:"unknown"})).toMatchObject({state:"saved",stateEvidence:"persisted_session_identity"});
  });
  it("requires company access before querying, checks every private run and rejects cross-company rows",async()=>{
    const limit=vi.fn().mockResolvedValue([row,{...row,runId:"private"},{...row,companyId:"foreign",runId:"foreign"}]);
    const chain:any={from:()=>chain,leftJoin:()=>chain,where:()=>chain,orderBy:()=>chain,limit};
    const db:any={select:vi.fn(()=>chain)};const actor:any={type:"board"};const access:any={};
    vi.mocked(canActorReadHeartbeatRun).mockImplementation(async (_db,_access,_actor,binding)=>binding.issueId==="issue" && (binding as any).runId!=="private");
    const catalog=nativeSessionCatalog(db,access);
    await expect(catalog.list({companyId:"company",actor,authorizeCompany:()=>{throw Error("denied")}})).rejects.toThrow("denied");
    expect(db.select).not.toHaveBeenCalled();
    const rows=await catalog.list({companyId:"company",actor,authorizeCompany:()=>{}});
    expect(rows.map(value=>value.runId)).toEqual(["run"]);
    expect(canActorReadHeartbeatRun).toHaveBeenCalledTimes(2);
  });
});
