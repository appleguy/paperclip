import {expect,it,vi} from "vitest";
import {ClaudeInteractiveController, type ClaudeInteractivePtyFactory} from "./native-interactive-controller.js";
const id="f8f9af47-d5c8-4a93-a5d8-791c20dfa9d8";
const config={executable:"/opt/claude",cwd:"/work",sessionId:id,model:"sonnet",effort:"low" as const,autoCompactTokens:140000};
function fixture(){const pty={pid:123,generation:"123:birth",detach:vi.fn(async()=>{}),stop:vi.fn(async()=>{})}; const factory={start:vi.fn(async(_input:Parameters<ClaudeInteractivePtyFactory["start"]>[0])=>pty)};const verifier={process:vi.fn(async()=>true),binding:vi.fn(async()=>true),session:vi.fn(async():Promise<{sessionId:string;cwd?:string}|undefined>=>undefined)};return {pty,factory,verifier};}
it("launches an explicit interactive no-tools PTY and distinguishes provisional from verified",async()=>{const f=fixture(),c=await ClaudeInteractiveController.launch(config,f.factory,f.verifier);expect(f.factory.start.mock.calls[0][0].args).toEqual(["--remote-control","--session-id",id,"--autocompact","140000","--model","sonnet","--effort","low","--setting-sources","","--settings","{}","--strict-mcp-config","--no-chrome","--tools",""]);expect(await c.observe()).toMatchObject({identity:"provisional",remoteControl:"requested_connection_unverified",managedDispatch:"unsupported"});f.verifier.session.mockResolvedValue({sessionId:id,cwd:"/work"});expect(await c.observe()).toMatchObject({identity:"verified",completionCorrelation:"unproven"});await c.detach();expect(f.pty.detach).toHaveBeenCalledOnce();expect(f.pty.stop).not.toHaveBeenCalled();});
it("rejects mismatched identity and never signals a reused process",async()=>{const f=fixture(),c=await ClaudeInteractiveController.launch(config,f.factory,f.verifier);f.verifier.session.mockResolvedValue({sessionId:id,cwd:"/other"});await expect(c.observe()).rejects.toThrow("SDK identity");f.verifier.process.mockResolvedValue(false);await expect(c.stopOwnedProcess()).rejects.toThrow("process identity");expect(f.pty.stop).not.toHaveBeenCalled();});
it("rejects unsafe bounds and makes stop a single attempt",async()=>{const f=fixture();await expect(ClaudeInteractiveController.launch({...config,autoCompactTokens:250000},f.factory,f.verifier)).rejects.toThrow();expect(f.factory.start).not.toHaveBeenCalled();const c=await ClaudeInteractiveController.launch(config,f.factory,f.verifier);f.pty.stop.mockRejectedValueOnce(new Error("uncertain"));await expect(c.stopOwnedProcess()).rejects.toThrow("uncertain");await expect(c.stopOwnedProcess()).rejects.toThrow("stopping");expect(f.pty.stop).toHaveBeenCalledOnce();});
it("admits authorized owner input with durable reservation and reports delivery unknown",async()=>{
  const f=fixture(); const writeInput=vi.fn(); const authority={authorize:vi.fn(async()=>true)};
  const journal={begin:vi.fn(async()=>"reserved" as const),written:vi.fn(async()=>{})};
  f.verifier.session.mockResolvedValue({sessionId:id,cwd:"/work"});
  const c=await ClaudeInteractiveController.launch(config,{start:async()=>({...f.pty,writeInput})},f.verifier,authority,journal);
  expect(await c.ownerInput({operationId:"op1",text:"hello\r"})).toEqual({write:"attempted",delivery:"unknown",completion:"unproven",binding:"verified"});
  expect(writeInput).toHaveBeenCalledWith("hello\r");expect(f.pty.stop).not.toHaveBeenCalled();
  authority.authorize.mockResolvedValueOnce(false);
  await expect(c.ownerInput({operationId:"op2",text:"again\r"})).rejects.toThrow("access denied");expect(writeInput).toHaveBeenCalledTimes(1);
});
it("permits provisional bootstrap but never retries an existing reservation",async()=>{
  const f=fixture(); const writeInput=vi.fn(); const journal={begin:vi.fn().mockResolvedValueOnce("reserved").mockResolvedValueOnce("existing"),written:vi.fn(async()=>{})};const c=await ClaudeInteractiveController.launch(config,{start:async()=>({...f.pty,writeInput})},f.verifier,{authorize:async()=>true},journal);
  expect(await c.ownerInput({operationId:"op1",text:"one\r"})).toMatchObject({binding:"provisional",delivery:"unknown"});
  await expect(c.ownerInput({operationId:"op1",text:"one\r"})).rejects.toThrow("outcome uncertain");expect(writeInput).toHaveBeenCalledTimes(1);expect(f.pty.stop).not.toHaveBeenCalled();
});
