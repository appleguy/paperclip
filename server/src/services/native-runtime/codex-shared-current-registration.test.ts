import { describe, expect, it, vi } from "vitest";
import { codexDaemonGeneration } from "./codex-native-delegation.js";
import { resolveCurrentCodexSharedRegistration } from "./codex-shared-registration.js";
import { inspectCodexSharedDaemon } from "./codex-shared-daemon.js";
import type { Db } from "@paperclipai/db";

vi.mock("./codex-shared-daemon.js", () => ({ inspectCodexSharedDaemon: vi.fn() }));
vi.mock("./codex-native-delegation.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./codex-native-delegation.js")>(),
  registerCodexNativeDelegation: vi.fn().mockResolvedValue({grantId:"automatic"}),
}));
import { registerCodexNativeDelegation } from "./codex-native-delegation.js";
const daemon = { socketPath:"/socket",codexHome:"/codex",cliVersion:"0.166.0" as const,appServerVersion:"0.166.0" as const,daemonGeneration:"old",peer:{pid:1,startSeconds:1,startMicroseconds:1,executable:"/codex/bin"} };
const env = { PAPERCLIP_CODEX_SHARED_AGENT_ID:"agent",PAPERCLIP_CODEX_SHARED_GRANT_ID:"old-id",PAPERCLIP_CODEX_SHARED_HOST_ID:"host",PAPERCLIP_CODEX_SHARED_EXECUTABLE:"/codex/bin",PAPERCLIP_CODEX_SHARED_CODEX_HOME:"/codex",PAPERCLIP_CODEX_SHARED_HOME:"/home" };
const row = (id:string, generation:string, expiresAt:string) => ({id,config:{codexNativeDelegation:{schema:"paperclip.codex-native-delegation.v1",agentId:"agent",hostId:"host",processGeneration:generation,expiresAt}}});
const db = (rows:unknown[]) => ({select:()=>({from:()=>({innerJoin:()=>({where:()=>({orderBy:async()=>rows})})})})}) as unknown as Db;
describe("current shared registration",()=>{
  it("selects a renewed grant after a daemon generation change",async()=>{
    const current={...daemon,daemonGeneration:"new"}; vi.mocked(inspectCodexSharedDaemon).mockResolvedValue(current);
    const expiry=new Date(Date.now()+60000).toISOString();
    const result=await resolveCurrentCodexSharedRegistration(env,db([row("new-id",codexDaemonGeneration(current),expiry),row("old-id",codexDaemonGeneration(daemon),expiry)]),"company","agent","/runner");
    expect(result?.grantId).toBe("new-id");
    await expect(resolveCurrentCodexSharedRegistration(env,db([row("old-id",codexDaemonGeneration(daemon),expiry)]),"company","agent","/runner")).rejects.toThrow("codex_shared_grant_stale: run renew-shared-grants");
  });
  it("selects the grant bound to the issue project and keeps a projectless issue off the route",async()=>{
    vi.mocked(inspectCodexSharedDaemon).mockResolvedValue(daemon);
    const expiry=new Date(Date.now()+60000).toISOString(), generation=codexDaemonGeneration(daemon);
    const forProject=(id:string,projectId:string)=>({id,config:{codexNativeDelegation:{...row(id,generation,expiry).config.codexNativeDelegation,projectId}}});
    const rows=[forProject("grant-b","project-b"),forProject("grant-a","project-a")];
    expect((await resolveCurrentCodexSharedRegistration(env,db(rows),"company","agent","/runner",async()=>"project-a"))?.grantId).toBe("grant-a");
    expect((await resolveCurrentCodexSharedRegistration(env,db(rows),"company","agent","/runner",async()=>"project-b"))?.grantId).toBe("grant-b");
    expect(await resolveCurrentCodexSharedRegistration(env,db(rows),"company","agent","/runner",async()=>null)).toBeNull();
    await expect(resolveCurrentCodexSharedRegistration(env,db(rows),"company","agent","/runner",async()=>"project-c")).rejects.toThrow("codex_shared_grant_stale");
  });
  it("rejects an expired grant and keeps non-enrolled agents off the route",async()=>{
    vi.mocked(inspectCodexSharedDaemon).mockResolvedValue(daemon);
    await expect(resolveCurrentCodexSharedRegistration(env,db([row("old-id",codexDaemonGeneration(daemon),new Date(1).toISOString())]),"company","agent","/runner")).rejects.toThrow("codex_shared_grant_stale: run renew-shared-grants");
    expect(await resolveCurrentCodexSharedRegistration(env,db([]),"company","other","/runner")).toBeNull();
  });
  it("creates a correctly scoped grant when generation or model changes, and requires an issuer",async()=>{
    vi.mocked(inspectCodexSharedDaemon).mockResolvedValue(daemon);
    vi.mocked(registerCodexNativeDelegation).mockClear();
    const expiry=new Date(Date.now()+60000).toISOString();
    const existing={id:"wrong-model",config:{codexNativeDelegation:{...row("x",codexDaemonGeneration(daemon),expiry).config.codexNativeDelegation,projectId:"project",model:"other",effort:"low"}}};
    const scope={model:"model",effort:"high"};
    await expect(resolveCurrentCodexSharedRegistration(env,db([existing]),"company","agent","/runner",async()=>"project",scope)).rejects.toThrow("codex_shared_issuer_unset");
    const result=await resolveCurrentCodexSharedRegistration({...env,PAPERCLIP_CODEX_SHARED_ISSUER_USER_ID:"board"},db([existing]),"company","agent","/runner",async()=>"project",scope);
    expect(result?.grantId).toBe("automatic");
    expect(registerCodexNativeDelegation).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.objectContaining({companyId:"company",projectId:"project",agentId:"agent",model:"model",effort:"high",issuer:"board"}));
    const stale={id:"stale",config:{codexNativeDelegation:{...existing.config.codexNativeDelegation,model:"model",effort:"high",processGeneration:"previous-daemon"}}};
    expect((await resolveCurrentCodexSharedRegistration({...env,PAPERCLIP_CODEX_SHARED_ISSUER_USER_ID:"board"},db([stale]),"company","agent","/runner",async()=>"project",scope))?.grantId).toBe("automatic");
  });
});
