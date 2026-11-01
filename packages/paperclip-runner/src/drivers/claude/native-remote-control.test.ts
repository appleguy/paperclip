import { describe, expect, it, vi } from "vitest";
import { ClaudeNativeRemoteControl, claudeNativeRemoteCapabilities, type ClaudeNativeSessionBinding, type ClaudeSessionReader } from "./native-remote-control.js";
const binding: ClaudeNativeSessionBinding = {companyId:"company",issueId:"issue",agentId:"agent",taskSessionId:"task-session",runId:"run",nativeSessionId:"f8f9af47-d5c8-4a93-a5d8-791c20dfa9d8",workspace:"/project",nativeProcessGeneration:"generation"};
const row = (uuid:string, type:"user"|"assistant" = "user") => ({uuid,type,session_id:binding.nativeSessionId,message:{content:"private"},parent_tool_use_id:null,parent_agent_id:null});
function fixture(rows = [row("msg-1"),row("msg-2","assistant")]) {
  const reader: ClaudeSessionReader = {getSessionInfo:vi.fn(async () => ({sessionId:binding.nativeSessionId,cwd:binding.workspace})),getSessionMessages:vi.fn(async (_id, options) => rows.slice(options.offset,options.offset+options.limit))};
  const verify = vi.fn(async () => true);
  const queue = {record:vi.fn(async () => "recorded" as const)};
  return {reader,verify,queue,controller:new ClaudeNativeRemoteControl(binding,reader,{verify},queue)};
}
describe("Claude native Remote Control boundary", () => {
  it("reads exact-session scoped transcript pages without claiming origin or liveness", async () => {
    const f = fixture(); const first = await f.controller.readPage(undefined,1);
    expect(first).toMatchObject({delivery:"transcript_snapshot",liveConnection:"unknown",messages:[{sourceMessageId:"msg-1",origin:"unknown"}],cursor:{offset:1,previousMessageId:"msg-1"}});
    expect((await f.controller.readPage(first.cursor,1)).messages[0]).toMatchObject({sourceMessageId:"msg-2",role:"assistant"});
    expect(f.reader.getSessionInfo).toHaveBeenCalledWith(binding.nativeSessionId,{dir:binding.workspace});
  });
  it("rejects incomplete, foreign and stale identity", async () => {
    const f = fixture();
    expect(() => new ClaudeNativeRemoteControl({...binding,nativeSessionId:"title"},f.reader,{verify:f.verify})).toThrow("invalid Claude native binding");
    vi.mocked(f.reader.getSessionInfo).mockResolvedValueOnce({sessionId:binding.nativeSessionId,cwd:"/other"});
    await expect(f.controller.readPage()).rejects.toThrow("identity mismatch");
    f.verify.mockResolvedValueOnce(false);
    await expect(f.controller.readPage()).rejects.toThrow("authority denied");
  });
  it("rejects foreign rows, bad limits and changed cursor anchors", async () => {
    const foreign = fixture([{...row("x"),session_id:"another"}]);
    await expect(foreign.controller.readPage()).rejects.toThrow("foreign");
    const f = fixture();
    await expect(f.controller.readPage({offset:1,previousMessageId:"old"})).rejects.toThrow("transcript changed");
    await expect(f.controller.readPage(undefined,101)).rejects.toThrow("invalid Claude observation cursor");
  });
  it("withholds transcript when authority changes during the read", async () => {
    const f = fixture(); f.verify.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(f.controller.readPage()).rejects.toThrow("authority denied");
  });
  it("records an owner action without starting or signalling Claude", async () => {
    const f = fixture();
    expect(await f.controller.requestOwnerAction({requestId:"request-1",action:"steer",instruction:"Please steer."})).toEqual({status:"owner_action_requested",providerActionPerformed:false});
    expect(f.queue.record).toHaveBeenCalledOnce(); expect(f.reader.getSessionMessages).not.toHaveBeenCalled();
    expect(claudeNativeRemoteCapabilities.sameRunningSessionWriter).toBe("unsupported_documented_surface");
    expect(claudeNativeRemoteCapabilities.paperclipApproval).toBe("unknown");
  });
  it("preserves an uncertain owner action record for reconciliation", async () => {
    const f = fixture(); const controller = new ClaudeNativeRemoteControl(binding,f.reader,{verify:f.verify},{record:async () => "uncertain"});
    await expect(controller.requestOwnerAction({requestId:"r1",action:"interrupt",instruction:"Please interrupt."})).rejects.toThrow("reconcile before retry");
  });
});
