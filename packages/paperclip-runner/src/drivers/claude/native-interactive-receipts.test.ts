import { describe, expect, it } from "vitest";
import { ClaudeInteractiveReceiptFence } from "./native-interactive-receipts.js";
const sessionId="f8f9af47-d5c8-4a93-a5d8-791c20dfa9d8";
const fence=()=>new ClaudeInteractiveReceiptFence({sessionId,cwd:"/project",processGeneration:"pid:birth"});
const input=(event:string,extra:Record<string,unknown>={})=>JSON.stringify({session_id:sessionId,cwd:"/project",hook_event_name:event,...extra});
describe("Claude interactive hook receipt fence",()=>{
  it("preserves owner-origin uncertainty and does not label Stop a completion",()=>{
    const f=fence();
    const prompt=f.project(input("UserPromptSubmit",{prompt:"private prompt"}),"pid:birth");
    expect(prompt).toEqual({sessionId,event:"UserPromptSubmit",origin:"unknown",dispatchCorrelation:"unknown",runCompletion:"unproven"});
    expect(JSON.stringify(prompt)).not.toContain("private prompt");
    expect(f.project(input("Stop",{last_assistant_message:"private answer"}),"pid:birth").runCompletion).toBe("unproven");
  });
  it("rejects stale, foreign, unsupported and oversized input",()=>{
    const f=fence();
    expect(()=>f.project(input("Stop"),"other")).toThrow("generation");
    expect(()=>f.project(input("Stop",{session_id:"other"}),"pid:birth")).toThrow("identity");
    expect(()=>f.project(input("Stop",{cwd:"/other"}),"pid:birth")).toThrow("identity");
    expect(()=>f.project(input("Unknown"),"pid:birth")).toThrow("unsupported");
    expect(()=>f.project("x".repeat(262145),"pid:birth")).toThrow("large");
  });
});
