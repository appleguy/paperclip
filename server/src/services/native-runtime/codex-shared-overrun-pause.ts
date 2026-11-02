import { randomUUID } from "node:crypto";
import type { RunnerGoalActionAccepted, RunnerGoalActionRequest, RunnerGoalProjection } from "@paperclipai/shared";
import { createCodexActiveGoalOverrunGuard } from "./codex-shared-goal-controller.js";

type Event = { eventType: string; payload?: unknown };
const STATUSES = ["active", "paused", "blocked", "limited", "usageLimited", "budgetLimited", "complete"] as const;
const rec = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * Hard stop for a shared-Codex ACTIVE goal. Feeds each PRP goal snapshot/update to the overrun guard; on an overrun it files an
 * ordinary goal-service `pause` action (row insert and revision bump happen inside `act`), which the live broker routes through
 * the shared goal controller so the reservation is committed before the pause is sent. One request per goal, never retried.
 */
export function createCodexSharedOverrunPause(input: {
  threadId: string; companyId: string; issueId: string; agentId: string;
  goals: {
    projection(companyId: string, issueId: string, agentId: string): Promise<Pick<RunnerGoalProjection, "revision"> | null>;
    act(companyId: string, issueId: string, request: RunnerGoalActionRequest): Promise<RunnerGoalActionAccepted>;
  };
  onHold?(reason: string): void;
}) {
  const guard = createCodexActiveGoalOverrunGuard({
    async requestPause() {
      const current = await input.goals.projection(input.companyId, input.issueId, input.agentId);
      if (!current) throw new Error("codex_shared_overrun_projection_missing");
      await input.goals.act(input.companyId, input.issueId, { requestId: randomUUID(), agentId: input.agentId, expectedRevision: current.revision, action: "pause" });
    },
    onHold: reason => input.onHold?.(reason),
  });
  return async (event: Event): Promise<void> => {
    if (event.eventType !== "session.goal.snapshot" && event.eventType !== "session.goal.updated") return;
    const goal = rec(rec(event.payload)?.goal);
    if (!goal || typeof goal.objective !== "string" || !goal.objective) return;
    const status = String(goal.status ?? "").replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    if (!(STATUSES as readonly string[]).includes(status)) return;
    await guard.observe({
      threadId: input.threadId, objective: goal.objective, status: status as (typeof STATUSES)[number],
      tokenBudget: typeof goal.tokenBudget === "number" ? goal.tokenBudget : null,
      tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0,
    });
  };
}
