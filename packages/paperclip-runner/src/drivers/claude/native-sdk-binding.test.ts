import { describe, expect, it } from "vitest";
import { ClaudeSdkIdentityFence } from "./native-sdk-binding.js";
const sessionId = "f8f9af47-d5c8-4a93-a5d8-791c20dfa9d8";
const messageId = "4db33e52-0ec9-4392-a92a-c6cb92f85c12";
const identity = {sessionId,cwd:"/workspace",cliVersion:"2.1.309",model:"claude-test",processGeneration:"pid:birth"};
const init = {type:"system",subtype:"init",session_id:sessionId,cwd:"/workspace",claude_code_version:"2.1.309",model:"claude-test",capabilities:["interrupt_receipt_v1"]};
describe("Claude SDK identity fence", () => {
  it("accepts exact init, input replay and result without treating replay as completion", () => {
    const f=new ClaudeSdkIdentityFence(identity);
    expect(f.accept(init,"pid:birth").kind).toBe("initialized");
    expect(f.accept({type:"user",isReplay:true,uuid:messageId,session_id:sessionId},"pid:birth").kind).toBe("input_replayed");
    expect(f.accept({type:"result",uuid:messageId,session_id:sessionId,result_index:0},"pid:birth")).toMatchObject({kind:"result",resultIndex:0});
    expect(f.disconnect()).toEqual({pendingDelivery:"unknown",remoteControl:"unverified"});
    expect(() => f.accept(init,"pid:birth")).toThrow("closed");
  });
  it("rejects foreign, wrong generation, model, version, workspace and malformed events", () => {
    for (const changes of [{session_id:messageId},{cwd:"/other"},{claude_code_version:"2.0"},{model:"other"},{capabilities:[1]}]) {
      expect(() => new ClaudeSdkIdentityFence(identity).accept({...init,...changes},"pid:birth")).toThrow();
    }
    const f=new ClaudeSdkIdentityFence(identity);
    expect(() => f.accept(init,"other")).toThrow("generation");
    f.accept(init,"pid:birth");
    expect(() => f.accept({type:"user",isReplay:true,session_id:sessionId},"pid:birth")).toThrow("lacks message id");
    expect(() => f.accept({type:"result",uuid:messageId,session_id:messageId},"pid:birth")).toThrow("foreign");
  });
});
