import { describe, expect, it, vi } from "vitest";
import { codexDaemonGeneration } from "./codex-native-delegation.js";
import { resolveCurrentCodexSharedRegistration } from "./codex-shared-registration.js";
import { inspectCodexSharedDaemon } from "./codex-shared-daemon.js";
import type { Db } from "@paperclipai/db";

vi.mock("./codex-shared-daemon.js", () => ({ inspectCodexSharedDaemon: vi.fn() }));
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
  it("rejects an expired grant and keeps non-enrolled agents off the route",async()=>{
    vi.mocked(inspectCodexSharedDaemon).mockResolvedValue(daemon);
    await expect(resolveCurrentCodexSharedRegistration(env,db([row("old-id",codexDaemonGeneration(daemon),new Date(1).toISOString())]),"company","agent","/runner")).rejects.toThrow("codex_shared_grant_stale: run renew-shared-grants");
    expect(await resolveCurrentCodexSharedRegistration(env,db([]),"company","other","/runner")).toBeNull();
  });
});
