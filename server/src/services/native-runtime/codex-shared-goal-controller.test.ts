import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchLiveRunnerGoalControl, runnerGoalControlBrokerInternals } from "../runner-goal-control-broker.js";
import { codexActiveGoalOverrun, createCodexActiveGoalOverrunGuard, registerCodexSharedGoalController } from "./codex-shared-goal-controller.js";
import type { CodexSharedGoalBinding } from "./codex-shared-goal-authority.js";
const f=vi.hoisted(()=>({read:vi.fn(),reserve:vi.fn(),commit:vi.fn()}));
vi.mock("./codex-shared-goal-authority.js",()=>({CODEX_SHARED_ACTIVE_GOAL_TOKEN_CAP:20_000,withReservedCodexActiveGoalSend:async (_db:unknown,_binding:unknown,_input:unknown,send:()=>Promise<unknown>)=>send(),readCodexSharedGoalAction:f.read,reserveCodexSharedGoalAction:f.reserve,commitCodexSharedGoalReceipt:f.commit,withReservedCodexPausedGoalSend:async (_db:unknown,_binding:unknown,_input:unknown,send:()=>Promise<unknown>)=>send()}));
const binding={companyId:"company",issueId:"issue",agentId:"agent",runId:"run",threadId:"thread"} as CodexSharedGoalBinding;
const before={threadId:"thread",objective:"goal",status:"paused" as const,tokenBudget:100};
const after={...before,objective:"edited"};
const digest=(g:{threadId:string;objective:string;status:string;tokenBudget:number|null})=>createHash("sha256").update(JSON.stringify(g)).digest("hex");
const control={requestId:"request",action:"edit" as const,objective:"edited"};
const broker=()=>dispatchLiveRunnerGoalControl(binding,control)!;
afterEach(()=>{runnerGoalControlBrokerInternals.resetForTests();vi.resetAllMocks();});
describe("Codex shared goal broker composition",()=>{
  it("reserves before editing a paused goal and persists readback",async()=>{
    f.read.mockResolvedValue({action:"edit",payload:{requestId:"request",agentId:"agent",action:"edit",objective:"edited",expectedRevision:1},expectedRevision:1,sourceGoalDigest:digest(before)});f.reserve.mockResolvedValue("fresh");
    const session={goal:vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after)};
    const dispatch=vi.fn(async()=>{expect(f.reserve).toHaveBeenCalledOnce();return after;});
    const release=registerCodexSharedGoalController({db:{} as never,binding,session,dispatch,attestDaemon:async()=>{}});
    await broker().completion;
    expect(dispatch).toHaveBeenCalledOnce();expect(f.commit).toHaveBeenCalledWith(expect.anything(),binding,expect.objectContaining({sourceStatus:"paused",sourceGoalDigest:digest(after)}));release();
  });
  it("keeps an uncertain reservation without redispatch when a provider acknowledgement is lost",async()=>{
    f.read.mockResolvedValue({action:"edit",payload:{requestId:"request",agentId:"agent",action:"edit",objective:"edited",expectedRevision:1},expectedRevision:1,sourceGoalDigest:digest(before)});f.reserve.mockResolvedValueOnce("fresh").mockResolvedValueOnce("existing_or_uncertain");
    const uncertain=vi.fn(),dispatch=vi.fn(async()=>{throw new Error("lost ack");});
    registerCodexSharedGoalController({db:{} as never,binding,session:{goal:async()=>before},dispatch,attestDaemon:async()=>{},onUncertain:uncertain});
    await broker().completion;await broker().completion;
    expect(dispatch).toHaveBeenCalledOnce();expect(uncertain).toHaveBeenCalledWith("request");expect(f.commit).not.toHaveBeenCalled();
  });
  it("rejects changed native state before reserving or sending",async()=>{
    f.read.mockResolvedValue({action:"edit",payload:{requestId:"request",agentId:"agent",action:"edit",objective:"edited",expectedRevision:1},expectedRevision:1,sourceGoalDigest:digest(before)});
    const dispatch=vi.fn();registerCodexSharedGoalController({db:{} as never,binding,session:{goal:async()=>after},dispatch,attestDaemon:async()=>{}});
    await expect(broker().completion).rejects.toThrow("source_changed");expect(f.reserve).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
  });
  it("rejects resume before reservation or dispatch",async()=>{
    f.read.mockResolvedValue({action:"resume",payload:{requestId:"request",agentId:"agent",action:"resume",expectedRevision:1},expectedRevision:1,sourceGoalDigest:digest(before)});
    const dispatch=vi.fn();registerCodexSharedGoalController({db:{} as never,binding,session:{goal:async()=>before},dispatch,attestDaemon:async()=>{}});
    await expect(dispatchLiveRunnerGoalControl(binding,{requestId:"request",action:"resume"})!.completion).rejects.toThrow("action_not_admitted");
    expect(f.reserve).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
  });

  describe("paused create",()=>{
    const created={threadId:"thread",objective:"made",status:"paused" as const,tokenBudget:null};
    const createRead=()=>f.read.mockResolvedValue({action:"create",payload:{requestId:"request",agentId:"agent",action:"create",objective:"made",expectedRevision:1},expectedRevision:1,sourceGoalDigest:null});
    const make=()=>dispatchLiveRunnerGoalControl(binding,{requestId:"request",action:"create",objective:"made"})!;
    it("creates only as an explicit paused write on a thread without a goal",async()=>{
      createRead();f.reserve.mockResolvedValue("fresh");const dispatch=vi.fn(),createPaused=vi.fn(async()=>{expect(f.reserve).toHaveBeenCalledOnce();return created;});
      registerCodexSharedGoalController({db:{} as never,binding,session:{goal:vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(created)},dispatch,createPaused,attestDaemon:async()=>{}});
      await make().completion;
      expect(createPaused).toHaveBeenCalledWith({requestId:"request",objective:"made"});expect(dispatch).not.toHaveBeenCalled();
      expect(f.commit).toHaveBeenCalledWith(expect.anything(),binding,expect.objectContaining({sourceStatus:"paused",sourceGoalDigest:digest(created)}));
    });
    it("holds without retry or receipt when the post-state is active",async()=>{
      createRead();f.reserve.mockResolvedValue("fresh");const active={...created,status:"active" as const},uncertain=vi.fn(),createPaused=vi.fn(async()=>active);
      registerCodexSharedGoalController({db:{} as never,binding,session:{goal:vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(active)},dispatch:vi.fn(),createPaused,attestDaemon:async()=>{},onUncertain:uncertain});
      await make().completion;
      expect(createPaused).toHaveBeenCalledOnce();expect(uncertain).toHaveBeenCalledWith("request");expect(f.commit).not.toHaveBeenCalled();
    });
    it("rejects create without the explicit paused writer (the Runner create path activates)",async()=>{
      createRead();const dispatch=vi.fn();registerCodexSharedGoalController({db:{} as never,binding,session:{goal:async()=>null},dispatch,attestDaemon:async()=>{}});
      await expect(make().completion).rejects.toThrow("action_not_admitted");expect(f.reserve).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
    });
    it("rejects create over an existing goal before reserving",async()=>{
      createRead();const createPaused=vi.fn();registerCodexSharedGoalController({db:{} as never,binding,session:{goal:async()=>before},dispatch:vi.fn(),createPaused,attestDaemon:async()=>{}});
      await expect(make().completion).rejects.toThrow("action_not_admitted");expect(f.reserve).not.toHaveBeenCalled();expect(createPaused).not.toHaveBeenCalled();
    });
    it.each(["replace","resume"] as const)("rejects %s even with a paused writer",async action=>{
      f.read.mockResolvedValue({action,payload:{requestId:"request",agentId:"agent",action,objective:"made",expectedRevision:1},expectedRevision:1,sourceGoalDigest:null});const createPaused=vi.fn(),dispatch=vi.fn();
      registerCodexSharedGoalController({db:{} as never,binding,session:{goal:async()=>null},dispatch,createPaused,attestDaemon:async()=>{}});
      await expect(dispatchLiveRunnerGoalControl(binding,{requestId:"request",action,objective:"made"})!.completion).rejects.toThrow("action_not_admitted");
      expect(f.reserve).not.toHaveBeenCalled();expect(createPaused).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe("ACTIVE activation (resume of a paused goal)",()=>{
    const paused={threadId:"thread",objective:"reply OK",status:"paused" as const,tokenBudget:20000};
    const active={...paused,status:"active" as const};
    const act=(over:Record<string,unknown>={})=>dispatchLiveRunnerGoalControl(binding,{requestId:"request",action:"resume",...over})!;
    const read=(payloadOver:Record<string,unknown>={},goal=paused)=>f.read.mockResolvedValue({action:"resume",payload:{requestId:"request",agentId:"agent",action:"resume",expectedRevision:1,...payloadOver},expectedRevision:1,sourceGoalDigest:digest(goal)});
    it("reserves first, writes active with the goal's own objective and budget, and receipts active",async()=>{
      read();f.reserve.mockResolvedValue("fresh");const activate=vi.fn(async()=>{expect(f.reserve).toHaveBeenCalledOnce();return active;});
      registerCodexSharedGoalController({db:{} as never,binding,session:{goal:vi.fn().mockResolvedValueOnce(paused).mockResolvedValueOnce(active)},dispatch:vi.fn(),activate,attestDaemon:async()=>{}});
      await act().completion;
      expect(activate).toHaveBeenCalledWith({requestId:"request",objective:"reply OK",tokenBudget:20000});
      expect(f.commit).toHaveBeenCalledWith(expect.anything(),binding,expect.objectContaining({sourceStatus:"active",sourceGoalDigest:digest(active)}));
    });
    it.each([
      ["no activator",paused,undefined,{}],
      ["no budget",{...paused,tokenBudget:null},true,{}],
      ["budget over the cap",{...paused,tokenBudget:20001},true,{}],
      ["zero budget",{...paused,tokenBudget:0},true,{}],
      ["budget changed in the control",paused,true,{tokenBudget:100}],
      ["different objective",paused,true,{objective:"other"}],
      ["goal not paused",active,true,{}],
    ] as const)("rejects before reservation: %s",async(_name,goal,withActivator,over)=>{
      read(over,goal as typeof paused);const activate=vi.fn();
      registerCodexSharedGoalController({db:{} as never,binding,session:{goal:async()=>goal as typeof paused},dispatch:vi.fn(),...(withActivator ? {activate} : {}),attestDaemon:async()=>{}});
      await expect(act(over).completion).rejects.toThrow("action_not_admitted");
      expect(f.reserve).not.toHaveBeenCalled();expect(activate).not.toHaveBeenCalled();
    });
    it.each([
      ["still paused",paused],
      ["objective changed",{...active,objective:"other"}],
      ["budget changed",{...active,tokenBudget:20000-1}],
    ])("holds without retry or receipt when the read-back is wrong: %s",async(_name,landed)=>{
      read();f.reserve.mockResolvedValue("fresh");const uncertain=vi.fn(),activate=vi.fn(async()=>active);
      registerCodexSharedGoalController({db:{} as never,binding,session:{goal:vi.fn().mockResolvedValueOnce(paused).mockResolvedValueOnce(landed)},dispatch:vi.fn(),activate,attestDaemon:async()=>{},onUncertain:uncertain});
      await act().completion;
      expect(activate).toHaveBeenCalledOnce();expect(uncertain).toHaveBeenCalledWith("request");expect(f.commit).not.toHaveBeenCalled();
    });
    it("never redispatches an existing reservation",async()=>{
      read();f.reserve.mockResolvedValue("existing_or_uncertain");const activate=vi.fn();
      registerCodexSharedGoalController({db:{} as never,binding,session:{goal:async()=>paused},dispatch:vi.fn(),activate,attestDaemon:async()=>{}});
      await act().completion;expect(activate).not.toHaveBeenCalled();expect(f.commit).not.toHaveBeenCalled();
    });
    it("a provider acknowledgement lost after the send is held, not retried",async()=>{
      read();f.reserve.mockResolvedValue("fresh");const uncertain=vi.fn(),activate=vi.fn(async()=>{throw new Error("lost ack");});
      registerCodexSharedGoalController({db:{} as never,binding,session:{goal:async()=>paused},dispatch:vi.fn(),activate,attestDaemon:async()=>{},onUncertain:uncertain});
      await act().completion;expect(activate).toHaveBeenCalledOnce();expect(uncertain).toHaveBeenCalledWith("request");expect(f.commit).not.toHaveBeenCalled();
    });
  });

  describe("pause (hard stop of an active goal)",()=>{
    const active={threadId:"thread",objective:"reply OK",status:"active" as const,tokenBudget:20000};
    const paused={...active,status:"paused" as const};
    const pauseControl=()=>dispatchLiveRunnerGoalControl(binding,{requestId:"request",action:"pause"})!;
    const read=()=>f.read.mockResolvedValue({action:"pause",payload:{requestId:"request",agentId:"agent",action:"pause",expectedRevision:1},expectedRevision:1,sourceGoalDigest:digest(active)});
    it("pauses an active goal through the explicit paused writer and receipts paused",async()=>{
      read();f.reserve.mockResolvedValue("fresh");const pause=vi.fn(async()=>{expect(f.reserve).toHaveBeenCalledOnce();return paused;});
      registerCodexSharedGoalController({db:{} as never,binding,session:{goal:vi.fn().mockResolvedValueOnce(active).mockResolvedValueOnce(paused)},dispatch:vi.fn(),pause,attestDaemon:async()=>{}});
      await pauseControl().completion;
      expect(pause).toHaveBeenCalledWith({requestId:"request",objective:"reply OK",tokenBudget:20000});
      expect(f.commit).toHaveBeenCalledWith(expect.anything(),binding,expect.objectContaining({sourceStatus:"paused",sourceGoalDigest:digest(paused)}));
    });
    it("rejects pause without a writer or on a goal that is not active, before reserving",async()=>{
      read();registerCodexSharedGoalController({db:{} as never,binding,session:{goal:async()=>active},dispatch:vi.fn(),attestDaemon:async()=>{}});
      await expect(pauseControl().completion).rejects.toThrow("action_not_admitted");
      runnerGoalControlBrokerInternals.resetForTests();
      registerCodexSharedGoalController({db:{} as never,binding,session:{goal:async()=>paused},dispatch:vi.fn(),pause:vi.fn(),attestDaemon:async()=>{}});
      await expect(pauseControl().completion).rejects.toThrow("action_not_admitted");
      expect(f.reserve).not.toHaveBeenCalled();
    });
    it("holds when the read-back is still active",async()=>{
      read();f.reserve.mockResolvedValue("fresh");const uncertain=vi.fn();
      registerCodexSharedGoalController({db:{} as never,binding,session:{goal:async()=>active},dispatch:vi.fn(),pause:vi.fn(async()=>active),attestDaemon:async()=>{},onUncertain:uncertain});
      await pauseControl().completion;expect(uncertain).toHaveBeenCalledWith("request");expect(f.commit).not.toHaveBeenCalled();
    });
  });

  describe("overrun detection",()=>{
    const g={status:"active",tokenBudget:1000};
    it.each([
      [{...g,tokensUsed:999},false],[{...g,tokensUsed:1000},true],[{...g,tokensUsed:1001},true],[{...g,tokensUsed:33904,tokenBudget:15000},true],[{status:"budgetLimited",tokenBudget:15000,tokensUsed:33904},false],[{...g,tokenBudget:null},true],[{...g,tokenBudget:20001},true],
      [{status:"paused",tokenBudget:1000,tokensUsed:5000},false],[null,false],
    ] as const)("%j -> %s",(goal,expected)=>expect(codexActiveGoalOverrun(goal as never)).toBe(expected));
  });

  describe("overrun guard",()=>{
    const active={threadId:"thread",objective:"goal",status:"active" as const,tokenBudget:15000};
    it("requests exactly one pause for an overrun goal and ignores in-budget or non-active goals",async()=>{
      const requestPause=vi.fn(async()=>{});const guard=createCodexActiveGoalOverrunGuard({requestPause});
      expect(await guard.observe(null)).toBe("idle");
      expect(await guard.observe({...active,tokensUsed:14999})).toBe("idle");
      expect(await guard.observe({...active,status:"budgetLimited",tokensUsed:33904})).toBe("idle");
      expect(requestPause).not.toHaveBeenCalled();
      expect(await guard.observe({...active,tokensUsed:33904})).toBe("pause_requested");
      expect(await guard.observe({...active,tokensUsed:40000})).toBe("already_requested");
      expect(requestPause).toHaveBeenCalledTimes(1);
    });
    it("latches before the pause so a failed pause is reported once and never retried",async()=>{
      const requestPause=vi.fn(async()=>{throw new Error("lost");});const onHold=vi.fn();const guard=createCodexActiveGoalOverrunGuard({requestPause,onHold});
      expect(await guard.observe({...active,tokensUsed:20000})).toBe("pause_failed");
      expect(await guard.observe({...active,tokensUsed:21000})).toBe("already_requested");
      expect(requestPause).toHaveBeenCalledTimes(1);expect(onHold).toHaveBeenCalledWith("pause_failed",expect.objectContaining({objective:"goal"}));
    });
  });
});
