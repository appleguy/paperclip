import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { registerLiveRunnerGoalController, type RunnerSessionGoalControlInput } from "../runner-goal-control-broker.js";
import { CODEX_SHARED_ACTIVE_GOAL_TOKEN_CAP, commitCodexSharedGoalReceipt, readCodexSharedGoalAction, reserveCodexSharedGoalAction, withReservedCodexActiveGoalSend, withReservedCodexPausedGoalSend, type CodexGoalSourceStatus, type CodexSharedGoalBinding } from "./codex-shared-goal-authority.js";

type Goal = { threadId:string; objective:string; status:Exclude<CodexGoalSourceStatus,"cleared">; tokenBudget:number|null; tokensUsed?:number };
type SharedGoalControl = RunnerSessionGoalControlInput;
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
function sourceDigest(goal:Goal|null, threadId:string):string|null {
  if (!goal) return null;
  if (goal.threadId!==threadId || !goal.objective || !["active","paused","blocked","limited","usageLimited","budgetLimited","complete"].includes(goal.status) || !(goal.tokenBudget===null || Number.isSafeInteger(goal.tokenBudget))) throw new Error("codex_shared_goal_identity_mismatch");
  return hash(JSON.stringify({threadId,objective:goal.objective,status:goal.status,tokenBudget:goal.tokenBudget}));
}
/**
 * Connects the existing Runner session to the existing goal broker. Caller must
 * supply a session already attached to the attested daemon and an OS-backed
 * attestation; it must not open a second daemon or derive identity from input.
 * The Runner session owns PRP turn/goal events, including goal autostarts.
 */
export function registerCodexSharedGoalController(input:{
  db:Db; binding:CodexSharedGoalBinding;
  session:{goal(input:{action:"get"}):Promise<Goal|null>};
  dispatch(control:SharedGoalControl):Promise<Goal|null>;
  /** Explicit paused `thread/goal/set` for a thread with no goal; never the Runner create path, which activates. */
  createPaused?(control:{requestId:string;objective:string;tokenBudget?:number|null}):Promise<Goal|null>;
  /** Explicit `thread/goal/set status=active` of an existing paused goal with its own budget; absent means resume is refused. */
  activate?(control:{requestId:string;objective:string;tokenBudget:number}):Promise<Goal|null>;
  /** Explicit `thread/goal/set status=paused` of an active goal; the hard stop for an overrun. Absent means pause is refused. */
  pause?(control:{requestId:string;objective:string;tokenBudget:number|null}):Promise<Goal|null>;
  attestDaemon():Promise<void>;
  onUncertain?(requestId:string):void;
}) {
  const b=input.binding;
  return registerLiveRunnerGoalController({companyId:b.companyId,issueId:b.issueId,agentId:b.agentId,runId:b.runId},{
    async control(control) {
      await input.attestDaemon();
      const current=await readCodexSharedGoalAction(input.db,b,control.requestId);
      if (current.action!==control.action || current.payload.requestId!==control.requestId || current.payload.agentId!==b.agentId || current.payload.objective!==control.objective || current.payload.tokenBudget!==control.tokenBudget) throw new Error("codex_shared_payload_mismatch");
      // The existing Runner maps create, replace and resume to active goals.
      // Admitted: editing an already-paused goal, and creating a goal only as an
      // explicit paused write on a thread without one. Reject the others before
      // reserving so a known rejection never becomes uncertain.
      // Activation is only the resume of an existing paused goal whose budget is set and within the canary cap;
      // pause only stops an active goal. Both reuse the goal's own objective and budget.
      const creating=control.action==="create", activating=control.action==="resume", pausing=control.action==="pause";
      const writer=activating ? input.activate : pausing ? input.pause : creating ? input.createPaused : input.dispatch;
      if (!(control.action==="edit" || ((creating || activating || pausing) && writer))) throw new Error("codex_shared_goal_action_not_admitted");
      const before=await input.session.goal({action:"get"});
      const objective=activating || pausing ? control.objective ?? before?.objective : control.objective;
      if (!objective || objective!==objective.trim()) throw new Error("codex_shared_goal_action_not_admitted");
      if (creating ? before!==null : (!before || before.status!==(pausing ? "active" : "paused") || ((activating || pausing) && before.objective!==objective))) throw new Error("codex_shared_goal_action_not_admitted");
      if (activating && !(typeof before!.tokenBudget==="number" && before!.tokenBudget>=1 && before!.tokenBudget<=CODEX_SHARED_ACTIVE_GOAL_TOKEN_CAP && (control.tokenBudget===undefined || control.tokenBudget===before!.tokenBudget))) throw new Error("codex_shared_goal_action_not_admitted");
      if (pausing && control.tokenBudget!==undefined && control.tokenBudget!==before!.tokenBudget) throw new Error("codex_shared_goal_action_not_admitted");
      if (sourceDigest(before,b.threadId)!==current.sourceGoalDigest) throw new Error("codex_shared_source_changed");
      await input.attestDaemon();
      const inputDigest=hash(JSON.stringify(current.payload));
      const reserved=await reserveCodexSharedGoalAction(input.db,b,{requestId:control.requestId,action:control.action,expectedRevision:current.expectedRevision,inputDigest,sourceGoalDigest:current.sourceGoalDigest});
      if (reserved!=="fresh") return; // A previous send may have landed; never redispatch it.
      try {
        await input.attestDaemon();
        const write={requestId:control.requestId,threadId:b.threadId,objective};
        const result=activating
          ? await withReservedCodexActiveGoalSend(input.db,b,{...write,status:"active",tokenBudget:before!.tokenBudget},()=>input.activate!({requestId:control.requestId,objective,tokenBudget:before!.tokenBudget as number}))
          : await withReservedCodexPausedGoalSend(input.db,b,{...write,status:"paused",...(creating && control.tokenBudget!==undefined ? {tokenBudget:control.tokenBudget} : pausing ? {tokenBudget:before!.tokenBudget} : {})},()=>creating ? input.createPaused!({requestId:control.requestId,objective,...(control.tokenBudget!==undefined ? {tokenBudget:control.tokenBudget} : {})}) : pausing ? input.pause!({requestId:control.requestId,objective,tokenBudget:before!.tokenBudget}) : input.dispatch(control));
        const observed=await input.session.goal({action:"get"});
        // The post-state must be exactly what was written (same objective and budget); anything else is held for reconciliation, never retried or committed.
        const landed=(status:"active"|"paused")=>observed?.status===status && result?.status===status && observed.objective===objective && result.objective===objective && observed.tokenBudget===before!.tokenBudget && result.tokenBudget===before!.tokenBudget;
        if (activating && !landed("active")) throw new Error("codex_shared_activate_not_active");
        if (pausing && !landed("paused")) throw new Error("codex_shared_pause_not_paused");
        if (creating && (observed?.status!=="paused" || result?.status!=="paused" || observed.objective!==control.objective)) throw new Error("codex_shared_create_not_paused");
        const resultDigest=sourceDigest(result,b.threadId), observedDigest=sourceDigest(observed,b.threadId);
        if (resultDigest!==observedDigest) throw new Error("codex_shared_readback_changed");
        await commitCodexSharedGoalReceipt(input.db,b,{requestId:control.requestId,inputDigest,sourceGoalDigest:observedDigest??hash(`goal:cleared:${b.threadId}`),sourceStatus:observed?.status??"cleared"});
      } catch {
        // Dispatch or receipt may have landed. Keep the durable reservation and
        // let PRP/source reconciliation decide; the broker must not mark it failed.
        try { input.onUncertain?.(control.requestId); } catch { /* observation only */ }
      }
    },
  });
}

/** Hard stop for an ACTIVE canary goal: true once settled usage reaches the budget it was admitted with (or the budget vanished or exceeds the cap). */
export function codexActiveGoalOverrun(goal:{status:string;tokenBudget:number|null;tokensUsed?:number}|null):boolean {
  if (!goal || goal.status!=="active") return false;
  return goal.tokenBudget===null || goal.tokenBudget>CODEX_SHARED_ACTIVE_GOAL_TOKEN_CAP || (goal.tokensUsed ?? 0)>=goal.tokenBudget;
}

/**
 * Feeds every observed goal (snapshot or update) to the overrun check and calls `requestPause` at most once per goal objective.
 * `requestPause` must route through the goal broker's `pause` action so the reservation is committed before the send.
 * A failed or lost pause is reported through `onHold` and never retried; a goal Codex itself budget-limited needs no pause.
 */
export function createCodexActiveGoalOverrunGuard(input:{requestPause(goal:Goal):Promise<void>;onHold?(reason:"pause_failed",goal:Goal):void}) {
  const latched=new Set<string>();
  return {
    async observe(goal:Goal|null):Promise<"idle"|"pause_requested"|"already_requested"|"pause_failed"> {
      if (!goal || !codexActiveGoalOverrun(goal)) return "idle";
      const key=hash(JSON.stringify([goal.threadId,goal.objective]));
      if (latched.has(key)) return "already_requested";
      latched.add(key); // latch first: a pause that errors may still have landed, so it is never repeated
      try { await input.requestPause(goal); return "pause_requested"; }
      catch { try { input.onHold?.("pause_failed",goal); } catch { /* observation only */ } return "pause_failed"; }
    },
  };
}
