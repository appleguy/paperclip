import { describe, expect, it } from "vitest";
import {
  ManagedNativeCodexGoalBridge,
  verifiedNativeGoalSnapshot,
  type GoalControlRequest,
  type PaperclipGoalControlPin,
  type PaperclipGoalJournal,
} from "./managed-native-goal-bridge.js";

const pin: PaperclipGoalControlPin = {
  companyId: "company-tst", projectId: "project-tst", issueId: "issue-tst",
  agentId: "agent-tst", paperclipGoalId: "organizational-goal-tst",
  taskSessionId: "durable-task-session", runId: "authoritative-paperclip-run",
  nativeThreadId: "native-thread-1", provider: "codex", protocolVersion: "0.166.0",
  model: "gpt-6-luna", effort: "low", writerGrantId: "server-grant-1",
  writerEpoch: 1, goalRevision: 7, runCheckedOut: true,
  exclusiveNativeWriterVerified: true, nativeProcessGeneration: "pid:birth:33",
  expectedSourceGoalDigest: null,
  issueStatus: "in_progress",
};
const request = (props: Partial<GoalControlRequest> = {}): GoalControlRequest => ({
  requestId: "req-paused-1", action: "set_paused",
  expectedRevision: pin.goalRevision,
  objective: "Test-only paused goal; no inference.", tokenBudget: 1024,
  ...props,
});

function fixture(options: {
  brokenAck?: boolean; badReadback?: boolean;
  failAfterNativeSend?: boolean; authority?: Partial<PaperclipGoalControlPin>;
} = {}) {
  let nativeGoal: null | { threadId: string; objective: string; status: string; tokenBudget: number } = null;
  let sends = 0;
  let failNextRead = false;
  const calls: string[] = [];
  const intents = new Set<string>();
  const commits: string[] = [];
  const native = {
    async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
      calls.push(method);
      if (params.threadId !== pin.nativeThreadId) throw Error("native identity mismatch");
      if (method === "thread/goal/get") {
        if (failNextRead) {
          failNextRead = false;
          return { goal: nativeGoal && options.badReadback ?
            {...nativeGoal, objective: "MUTATED BY EXTERNAL CLIENT"} : nativeGoal };
        }
        return { goal: nativeGoal };
      }
      if (method === "thread/goal/set") {
        sends++;
        nativeGoal = {
          threadId: pin.nativeThreadId,
          objective: typeof params.objective === "string" ? params.objective :
            nativeGoal?.objective ?? "",
          status: String(params.status),
          tokenBudget: typeof params.tokenBudget === "number" ? params.tokenBudget :
            nativeGoal?.tokenBudget ?? 0,
        };
        failNextRead = true;
        if (options.failAfterNativeSend) throw Error("native transport dropped");
        return { goal: nativeGoal };
      }
      if (method === "thread/goal/clear") {
        sends++;
        nativeGoal = null;
        if (options.failAfterNativeSend) throw Error("native transport dropped");
        return { goal: null };
      }
      throw Error("unexpected provider invocation " + method);
    },
  };
  const journal: PaperclipGoalJournal = {
    async reserveOnce(input) {
      if (intents.has(input.requestId)) return "existing_or_uncertain";
      if (!input.inputDigest || !input.writerGrantId || input.runId !== pin.runId)
        throw Error("invalid durable intent");
      intents.add(input.requestId);
      return "fresh";
    },
    async commitSourceReceipt(input) {
      if (options.brokenAck) throw Error("Paperclip server receipt unavailable");
      if (input.writerGrantId !== pin.writerGrantId ||
          input.nativeThreadId !== pin.nativeThreadId) throw Error("source scope mismatch");
      commits.push(input.requestId);
    },
  };
  let authorizations = 0;
  const bridge = new ManagedNativeCodexGoalBridge(
    native,
    async (requestedPin) => {
      authorizations++;
      return { ...requestedPin, ...options.authority };
    },
    journal,
  );
  return {
    bridge, calls, intents, commits,
    get sends() { return sends; },
    get authorizations() { return authorizations; },
    nativeGoal: () => nativeGoal,
  };
}

describe("Paperclip → Codex Remote Control paused goal binding", () => {
  it("commits one source-linked native PAUSED objective and never autostarts a model", async () => {
    const f = fixture();
    const result = await f.bridge.applyPaused(pin, request());
    expect(result).toMatchObject({
      requestId: "req-paused-1", nativeThreadId: pin.nativeThreadId,
      status: "paused", tokenBudget: 1024,
      paperclipRunCompleted: false, modelTurnStarted: false,
    });
    expect(result.objectiveDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("Test-only paused goal");
    expect(f.commits).toEqual(["req-paused-1"]);
    expect(f.calls).toEqual([
      "thread/goal/get", "thread/goal/set", "thread/goal/get",
    ]);
    expect(f.authorizations).toBe(4);
    expect(f.calls).not.toContain("turn/start");
  });

  it("does not expose even goal metadata without the exact fresh server authority", async () => {
    const f = fixture({authority:{companyId:"different"}});
    await expect(f.bridge.read(pin)).rejects.toThrow("stale_authority");
    expect(f.calls).toEqual([]);
  });

  it("reads live native goal metadata without publishing the private objective", async () => {
    const f = fixture();
    await f.bridge.applyPaused(pin, request());
    const status = await f.bridge.read(pin);
    expect(status).toMatchObject({ configured:true, status:"paused", tokenBudget:1024 });
    expect(status.objectiveDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(status).not.toHaveProperty("objective");
  });

  it("idempotency rejects a duplicate intent even when the first source ACK is saved", async () => {
    const f = fixture();
    await f.bridge.applyPaused(pin, request());
    await expect(f.bridge.applyPaused(pin, request())).rejects.toThrow(
      "wrong_goal",
    );
    expect(f.sends).toBe(1);
  });

  it("denies stale revision, foreign issue, wrong run, writer and missing lease before writes", async () => {
    for (const mismatch of [
      { provider: "other" as "codex" }, { companyId: "foreign" }, { projectId: "foreign" },
      { issueId: "SCO-337" }, { agentId: "other" },
      { paperclipGoalId: "foreign" }, { taskSessionId: "foreign" },
      { runId: "old-run" }, { nativeThreadId: "other-native" },
      { writerGrantId: "old-grant" }, { writerEpoch: 2 },
      { nativeProcessGeneration: "pid:replaced" },
      { model: "different-model" }, { effort: "high" },
      { goalRevision: 8 }, { issueStatus: "blocked" as const },
      { expectedSourceGoalDigest: "old-digest" },
      { exclusiveNativeWriterVerified: false },
      { runCheckedOut: false },
    ]) {
      const f = fixture({authority:mismatch});
      await expect(f.bridge.applyPaused(pin, request())).rejects.toThrow();
      expect(f.sends).toBe(0);
      expect(f.commits).toHaveLength(0);
    }
    const f = fixture();
    await expect(f.bridge.applyPaused(pin, request({expectedRevision: 6})))
      .rejects.toThrow("invalid_operation");
    expect(f.sends).toBe(0);
  });

  it("refuses active goals, so mobile/idle autoresume cannot launch unaccounted inference", async () => {
    const f = fixture();
    await expect(f.bridge.applyPaused(pin, request({
      action: "resume" as GoalControlRequest["action"],
    }))).rejects.toThrow("invalid_operation");
    expect(f.sends).toBe(0);
  });

  it("validates source thread rather than accepting native IDs as authority", () => {
    expect(() => verifiedNativeGoalSnapshot({
      goal: {threadId:"another-thread",objective:"foreign",status:"paused",tokenBudget:32},
    },pin.nativeThreadId)).toThrow("wrong_thread");
    expect(() => verifiedNativeGoalSnapshot({ ok:true },pin.nativeThreadId)).toThrow("wrong_thread");
  });

  it("rejects incomplete identity pins before contacting the provider", async () => {
    const f = fixture();
    await expect(f.bridge.read({ ...pin, nativeProcessGeneration: "" }))
      .rejects.toThrow("not_paperclip_owned");
    expect(f.calls).toEqual([]);
  });

  it("leaves a delivered change uncertain when authority expires before receipt", async () => {
    let checks = 0;
    let committed = false;
    let goal: unknown = null;
    const bridge = new ManagedNativeCodexGoalBridge({
      async request(method, params) {
        if (method === "thread/goal/set") goal = { ...params };
        return { goal };
      },
    }, async () => ({ ...pin, writerEpoch: ++checks === 4 ? 2 : 1 }), {
      async reserveOnce() { return "fresh"; },
      async commitSourceReceipt() { committed = true; },
    });
    await expect(bridge.applyPaused(pin, request())).rejects.toThrow("stale_authority");
    expect(goal).not.toBeNull();
    expect(committed).toBe(false);
  });

  it("edits and clears a PAUSED goal without starting another native turn", async () => {
    const f = fixture();
    const created = await f.bridge.applyPaused(pin,request());
    const edit = await f.bridge.applyPaused({...pin, expectedSourceGoalDigest: created.sourceGoalDigest},request({
      requestId:"req-budget-edit", action:"edit_paused",
      objective: undefined,tokenBudget:2048,
    }));
    expect(edit).toMatchObject({status:"paused",tokenBudget:2048});
    const cleared=await f.bridge.applyPaused({...pin, expectedSourceGoalDigest: edit.sourceGoalDigest},request({
      requestId:"req-clear",action:"clear_paused",
      objective:undefined,tokenBudget:undefined,
    }));
    expect(cleared).toMatchObject({status:"cleared",objectiveDigest:null});
    expect(f.calls.filter(x=>x==="thread/goal/set")).toHaveLength(2);
    expect(f.calls.filter(x=>x==="thread/goal/clear")).toHaveLength(1);
    expect(f.calls).not.toContain("turn/start");
    expect(f.commits).toEqual(["req-paused-1","req-budget-edit","req-clear"]);
  });

  it("preserves ambiguous provider post-send as unknown without replay or fake settlement", async () => {
    const f=fixture({failAfterNativeSend:true});
    await expect(f.bridge.applyPaused(pin,request())).rejects.toThrow("native transport dropped");
    expect(f.sends).toBe(1);
    expect(f.intents.has("req-paused-1")).toBe(true);
    expect(f.commits).toHaveLength(0);
    await expect(f.bridge.applyPaused(pin,request())).rejects.toThrow();
    expect(f.sends).toBe(1);
  });

  it("a failure writing Paperclip's final source receipt is NOT a provider failure to retry", async () => {
    const f=fixture({brokenAck:true});
    await expect(f.bridge.applyPaused(pin,request())).rejects.toThrow(
      "Paperclip server receipt unavailable",
    );
    expect(f.sends).toBe(1);
    expect(f.intents.size).toBe(1);
    expect(f.commits).toHaveLength(0);
  });

  it("rejects native side edits between delivery and source readback", async () => {
    const f=fixture({badReadback:true});
    await expect(f.bridge.applyPaused(pin,request())).rejects.toThrow(
      "reconcile_before_retry",
    );
    expect(f.sends).toBe(1);
    expect(f.commits).toHaveLength(0);
  });

  it("rejects invalid budgets, malformed objective and unsupported status paths", async () => {
    for (const props of [
      {tokenBudget:0}, {tokenBudget:1.5}, {tokenBudget:100_000_001},
      {objective:""}, {objective:"x".repeat(4001)},
      {requestId:""}, {requestId:"x".repeat(129)},
      {action:"activate_goal" as GoalControlRequest["action"]},
    ]) {
      const f=fixture();
      await expect(f.bridge.applyPaused(pin,request(props))).rejects.toThrow();
      expect(f.sends).toBe(0);
    }
  });
});
