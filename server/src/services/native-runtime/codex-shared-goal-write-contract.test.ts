import { describe, expect, it } from "vitest";
import { CODEX_SHARED_ACTIVE_GOAL_TOKEN_CAP, codexSharedGoalWriteContract } from "./codex-shared-goal-authority.js";

const paused={objective:"reply OK",status:"paused",tokenBudget:20000};
const active={...paused,status:"active"};
const write=(status:"paused"|"active",over:Record<string,unknown>={})=>({requestId:"r",threadId:"t",objective:"reply OK",status,...over}) as Parameters<typeof codexSharedGoalWriteContract>[2];

describe("Codex shared goal write contract",()=>{
  it("pins the canary cap",()=>expect(CODEX_SHARED_ACTIVE_GOAL_TOKEN_CAP).toBe(20_000));
  describe("activation is the resume of an existing paused goal",()=>{
    it("admits resume of a paused goal with its own budget and returns the expected pre-state",()=>{
      expect(codexSharedGoalWriteContract("resume",{},write("active",{tokenBudget:20000}),paused)).toEqual(paused);
      expect(codexSharedGoalWriteContract("resume",{objective:"reply OK",tokenBudget:20000},write("active",{tokenBudget:20000}),paused)).toEqual(paused);
    });
    it.each(["create","edit","replace","pause","clear"])("refuses status active for action %s",action=>
      expect(()=>codexSharedGoalWriteContract(action,{objective:"reply OK"},write("active",{tokenBudget:20000}),paused)).toThrow("action_mismatch"));
    it("refuses create-active: no existing goal",()=>
      expect(()=>codexSharedGoalWriteContract("resume",{},write("active",{tokenBudget:20000}),null)).toThrow("source_changed"));
    it.each([
      ["null budget",{...paused,tokenBudget:null},{tokenBudget:null}],
      ["zero budget",{...paused,tokenBudget:0},{tokenBudget:0}],
      ["over the cap",{...paused,tokenBudget:20001},{tokenBudget:20001}],
      ["wire budget differs from the goal's",paused,{tokenBudget:100}],
      ["wire budget absent",paused,{}],
    ])("refuses %s",(_n,goal,over)=>expect(()=>codexSharedGoalWriteContract("resume",{},write("active",over),goal)).toThrow("active_budget_not_admitted"));
    it("refuses a payload budget that differs from the goal's",()=>
      expect(()=>codexSharedGoalWriteContract("resume",{tokenBudget:50},write("active",{tokenBudget:20000}),paused)).toThrow("active_budget_not_admitted"));
    it("refuses a different objective on the wire or in the payload",()=>{
      expect(()=>codexSharedGoalWriteContract("resume",{},write("active",{tokenBudget:20000,objective:"other"}),paused)).toThrow("action_mismatch");
      expect(()=>codexSharedGoalWriteContract("resume",{objective:"other"},write("active",{tokenBudget:20000}),paused)).toThrow("action_mismatch");
    });
    it("refuses a goal that is not paused",()=>
      expect(()=>codexSharedGoalWriteContract("resume",{},write("active",{tokenBudget:20000}),active)).toThrow("source_changed"));
  });
  describe("paused writes",()=>{
    it("keeps create on no goal and edit on a paused goal",()=>{
      expect(codexSharedGoalWriteContract("create",{objective:"reply OK"},write("paused"),null)).toBeNull();
      expect(codexSharedGoalWriteContract("edit",{objective:"reply OK"},write("paused"),paused)).toEqual(paused);
      expect(()=>codexSharedGoalWriteContract("edit",{objective:"reply OK"},write("paused"),active)).toThrow("source_changed");
      expect(()=>codexSharedGoalWriteContract("edit",{objective:"reply OK"},write("paused"),null)).toThrow("source_changed");
      expect(()=>codexSharedGoalWriteContract("edit",{objective:"other"},write("paused"),paused)).toThrow("action_mismatch");
    });
    it("pause only stops an active goal and keeps its objective",()=>{
      expect(codexSharedGoalWriteContract("pause",{},write("paused"),active)).toEqual(active);
      expect(()=>codexSharedGoalWriteContract("pause",{},write("paused"),paused)).toThrow("source_changed");
      expect(()=>codexSharedGoalWriteContract("pause",{},write("paused"),null)).toThrow("source_changed");
      expect(()=>codexSharedGoalWriteContract("pause",{},write("paused",{objective:"other"}),active)).toThrow("action_mismatch");
    });
    it("refuses resume/replace/clear as a paused write",()=>{
      for (const a of ["resume","replace","clear"]) expect(()=>codexSharedGoalWriteContract(a,{},write("paused"),paused)).toThrow("action_mismatch");
    });
  });
});
