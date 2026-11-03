import type {
  RunnerGoalActionRequest,
  RunnerGoalCapability,
  RunnerGoalSnapshot,
} from "@paperclipai/shared";

// OpenCode exposes no structured session goal, so Paperclip owns the goal for
// opencode_local agents: it is stored in the agent_task_sessions goal columns
// like any other runner goal and rendered into every run's prompt as a standing
// objective. A provider-native goal can replace this controller by returning
// null from managedGoalControllerFor (runner-goals.ts) and reporting its own
// capability.
export const OPENCODE_GOAL_SOURCE_ID = "paperclip:opencode-managed";

export interface ManagedGoalController {
  capability: RunnerGoalCapability;
  /** Next stored goal for an action; null clears the goal. */
  next(current: RunnerGoalSnapshot | null, request: RunnerGoalActionRequest, now: Date): RunnerGoalSnapshot | null;
}

const opencodeCapability: RunnerGoalCapability = {
  availability: "available",
  verified: true,
  actions: ["set", "pause", "resume", "clear"],
  autonomousUpdates: false,
  persistentAcrossResume: true,
  maxObjectiveChars: 4_000,
  tokenBudgetControl: false,
  usageReporting: false,
  reasonCode: "paperclip_managed_goal",
  reason: "Paperclip keeps this goal and adds it to every run's prompt; a change takes effect on the next run.",
};

export const opencodeGoalController: ManagedGoalController = {
  capability: opencodeCapability,
  next(current, request, now) {
    const stamp = now.toISOString();
    switch (request.action) {
      case "clear":
        return null;
      case "pause":
        return current && { ...current, status: "paused", updatedAt: stamp };
      case "resume":
        return current && { ...current, status: "active", updatedAt: stamp };
      case "edit":
        return current && { ...current, objective: request.objective ?? current.objective, updatedAt: stamp };
      default:
        // create and replace start a fresh goal.
        return {
          objective: request.objective ?? "",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          elapsedSeconds: 0,
          iterations: 0,
          lastReason: null,
          createdAt: stamp,
          updatedAt: stamp,
          completedAt: null,
          workingNow: false,
        };
    }
  },
};

export function managedGoalControllerFor(agent: { adapterType: string }): ManagedGoalController | null {
  return agent.adapterType === "opencode_local" ? opencodeGoalController : null;
}

/** The standing objective a run's prompt should carry, or null when no active managed goal exists. */
export function managedGoalPromptContext(adapterType: string, goalJson: unknown): { objective: string } | null {
  if (!managedGoalControllerFor({ adapterType })) return null;
  if (typeof goalJson !== "object" || goalJson === null) return null;
  const goal = goalJson as { objective?: unknown; status?: unknown };
  return goal.status === "active" && typeof goal.objective === "string" && goal.objective.trim()
    ? { objective: goal.objective }
    : null;
}
