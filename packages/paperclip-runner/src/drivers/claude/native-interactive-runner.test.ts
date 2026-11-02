import {afterEach,describe,expect,it,vi} from "vitest";
import {ClaudeInteractiveSession} from "./native-interactive-session.js";
import {ClaudeInteractiveCleanupUncertainError,ClaudeInteractiveRunner,type ClaudeInteractiveRunnerOptions} from "./native-interactive-runner.js";
const id="f8f9af47-d5c8-4a93-a5d8-791c20dfa9d8";
const options:ClaudeInteractiveRunnerOptions={executable:"/bin/claude",cwd:"/work",sessionId:id,model:"sonnet",effort:"low",journalDirectory:"/tmp/journal",ownerAuthority:{authorize:async()=>true},home:"/home/test",sdk:{getSessionInfo:async()=>undefined,namespace:{home:"/home/test"}},hookHelperExecutable:"/bin/helper"};
function mockSession(){
 const active=new Set<string>();
 const session={hookStart:{sessionId:id,event:"SessionStart",peer:"darwin-kernel-pid-uid-and-live-ancestry",namespace:"parent-attested-launch-scope"},observe:vi.fn(async()=>({nativeSessionId:id,processGeneration:"10:birth",identity:"provisional",remoteControl:"requested_connection_unverified"})),ownerInput:vi.fn(async(input:{operationId:string})=>{if(active.has(input.operationId))throw new Error("outcome uncertain");active.add(input.operationId);return {write:"attempted",delivery:"unknown",completion:"unproven",binding:"provisional"};}),detach:vi.fn(async()=>{}),stopOwnedProcess:vi.fn(async()=>{})};
 vi.spyOn(ClaudeInteractiveSession,"launch").mockResolvedValue(session as unknown as ClaudeInteractiveSession);return session;
}
afterEach(()=>vi.restoreAllMocks());
describe("opt-in native interactive Runner controller",()=>{
 it("composes the session and reports hook source without claiming RC or SDK identity",async()=>{const s=mockSession(),runner=await ClaudeInteractiveRunner.launch(options);expect(ClaudeInteractiveSession.launch).toHaveBeenCalledWith(expect.objectContaining({hookHelperExecutable:"/bin/helper",ownedSdkInit:undefined}));expect(await runner.identity()).toMatchObject({nativeSessionId:id,processGeneration:"10:birth",sessionBinding:"provisional",remoteControl:"requested_connection_unverified",hook:{peer:"darwin-kernel-pid-uid-and-live-ancestry"}});expect(runner.capabilities()).toMatchObject({managedTurns:"unsupported",tools:"disabled"});await runner.detach();expect(s.detach).toHaveBeenCalledOnce();await expect(runner.identity()).rejects.toThrow("detached");});
 it("sends Ctrl-C once through durable owner input and never claims settlement",async()=>{const s=mockSession(),runner=await ClaudeInteractiveRunner.launch(options);expect(await runner.interrupt({operationId:"interrupt-1"})).toMatchObject({interrupt:"attempted",delivery:"unknown",settlement:"unproven"});expect(s.ownerInput).toHaveBeenCalledWith({operationId:"interrupt-1",text:"\u0003"});await expect(runner.interrupt({operationId:"interrupt-1"})).rejects.toThrow("uncertain");expect(runner.settlement()).toEqual({state:"unproven",reason:"no_authenticated_turn_terminal"});await expect(runner.startTurn()).rejects.toThrow("unavailable");});
 it("stops its owned child when hook identity is absent",async()=>{const s=mockSession();s.hookStart.sessionId="11111111-1111-4111-8111-111111111111";await expect(ClaudeInteractiveRunner.launch(options)).rejects.toThrow("identity unavailable");expect(s.stopOwnedProcess).toHaveBeenCalledOnce();expect(s.detach).not.toHaveBeenCalled();});
 it("retains a failed stop as uncertain instead of detaching",async()=>{const s=mockSession();s.hookStart.sessionId="11111111-1111-4111-8111-111111111111";s.stopOwnedProcess.mockRejectedValueOnce(new Error("exit unconfirmed"));await expect(ClaudeInteractiveRunner.launch(options)).rejects.toThrow("cleanup is uncertain");expect(s.detach).not.toHaveBeenCalled();});
 it("stops the owned session before marking the runner closed",async()=>{const s=mockSession(),runner=await ClaudeInteractiveRunner.launch(options);await runner.stopOwnedProcess();expect(s.stopOwnedProcess).toHaveBeenCalledOnce();await expect(runner.identity()).rejects.toThrow("detached");});
 it("propagates lost identity and writes no input",async()=>{const s=mockSession(),runner=await ClaudeInteractiveRunner.launch(options);s.observe.mockRejectedValueOnce(new Error("process identity changed"));await expect(runner.identity()).rejects.toThrow("process identity changed");expect(s.ownerInput).not.toHaveBeenCalled();});
 it("opens a scoped real MCP binding for an admitted run, passes it to the session, and reports scoped tools",async()=>{
  mockSession();const dispatch=vi.fn(async()=>({ok:true})),scope={companyId:"c",runId:"r",taskId:"t",leaseId:"l",nativeSessionId:id};
  const runner=await ClaudeInteractiveRunner.launch({...options,mcp:{scope,tools:[{name:"report_progress",inputSchema:{type:"object"}}],dispatch}});
  const passed=(ClaudeInteractiveSession.launch as unknown as {mock:{calls:[{mcpBinding?:{scope:unknown;mcpConfig():{mcpServers:{paperclip:{url:string}}};close():Promise<void>}}][]}}).mock.calls[0]![0].mcpBinding!;
  expect(passed.scope).toEqual(scope);expect(passed.mcpConfig().mcpServers.paperclip.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(runner.capabilities()).toMatchObject({tools:"scoped_admitted_run"});await passed.close();
 });
 it("closes the MCP binding when the session launch fails",async()=>{
  vi.spyOn(ClaudeInteractiveSession,"launch").mockRejectedValue(new Error("launch failed"));
  await expect(ClaudeInteractiveRunner.launch({...options,mcp:{scope:{companyId:"c",runId:"r",taskId:"t",leaseId:"l",nativeSessionId:id},tools:[],dispatch:async()=>null}})).rejects.toThrow("launch failed");
 });

 it("keeps the session tracked for retry when cleanup fails",async()=>{const s=mockSession();s.hookStart.sessionId="11111111-1111-4111-8111-111111111111";s.stopOwnedProcess.mockRejectedValueOnce(new Error("exit unconfirmed"));const error=await ClaudeInteractiveRunner.launch(options).catch(e=>e);expect(error).toBeInstanceOf(ClaudeInteractiveCleanupUncertainError);await error.runner.stopOwnedProcess();expect(s.stopOwnedProcess).toHaveBeenCalledTimes(2);await expect(error.runner.identity()).rejects.toThrow("detached");});
});
