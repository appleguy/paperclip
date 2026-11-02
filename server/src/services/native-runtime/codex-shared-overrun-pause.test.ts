import { describe, expect, it, vi } from "vitest";
import { createCodexSharedOverrunPause } from "./codex-shared-overrun-pause.js";
const goal = (status: string, tokensUsed: number, tokenBudget: number | null = 15000) => ({ eventType: "session.goal.updated", payload: { goal: { status, objective: "o", tokenBudget, tokensUsed } } });
const make = () => {
  const act = vi.fn(async () => ({ requestId: "r", status: "accepted" })), projection = vi.fn(async () => ({ revision: 7 }));
  const onHold = vi.fn();
  const observe = createCodexSharedOverrunPause({ threadId: "t", companyId: "c", issueId: "i", agentId: "a", goals: { projection, act } as never, onHold });
  return { act, projection, onHold, observe };
};
describe("shared Codex overrun pause", () => {
  it("files one ordinary pause action at the current revision when an active goal reaches its budget", async () => {
    const { act, observe } = make();
    await observe(goal("active", 14999)); await observe({ eventType: "turn.started", payload: {} });
    expect(act).not.toHaveBeenCalled();
    await observe(goal("active", 15446)); await observe({ ...goal("active", 20000), eventType: "session.goal.snapshot" });
    expect(act).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledWith("c", "i", expect.objectContaining({ agentId: "a", expectedRevision: 7, action: "pause", requestId: expect.any(String) }));
    expect((act.mock.calls[0] as unknown[])[2]).not.toHaveProperty("objective");
  });
  it("ignores budget-limited, paused and malformed goals", async () => {
    const { act, observe } = make();
    await observe(goal("budget_limited", 15446)); await observe(goal("paused", 99999)); await observe({ eventType: "session.goal.updated", payload: { goal: null } }); await observe(goal("bogus", 99999));
    expect(act).not.toHaveBeenCalled();
  });
  it("treats a missing budget as an overrun and holds without retry when the action fails", async () => {
    const { act, onHold, observe } = make(); act.mockRejectedValueOnce(new Error("lost"));
    await observe(goal("active", 1, null)); await observe(goal("active", 2, null));
    expect(act).toHaveBeenCalledTimes(1); expect(onHold).toHaveBeenCalledWith("pause_failed");
  });
});
