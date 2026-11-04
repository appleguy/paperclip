import { createHash } from "node:crypto";
import type {
  RunnerGoalActionRequest,
  RunnerGoalCapability,
  RunnerGoalSnapshot,
} from "@paperclipai/shared";

// SCO-756: an adapter without a provider-native goal lifecycle gets a
// Paperclip-managed goal. It is stored in the agent_task_sessions goal columns
// like any other runner goal and rendered into the run's prompt by
// selectPaperclipPromptSections (adapter-utils). On a resumed or kept
// conversation the text is sent once and then only when it changes (see
// managedGoalPromptContext). Native lifecycles (paperclip_runner with Codex or
// Claude ACP) keep their own controller in runner-goals.ts.
export const MANAGED_GOAL_SOURCE_ID = "paperclip:managed";

export interface ManagedGoalController {
  capability: RunnerGoalCapability;
  /** Next stored goal for an action; null clears the goal. */
  next(current: RunnerGoalSnapshot | null, request: RunnerGoalActionRequest, now: Date): RunnerGoalSnapshot | null;
}

/** Adapters whose prompt is built by selectPaperclipPromptSections, so a managed goal reaches the model. */
const MANAGED_GOAL_ADAPTERS = new Set([
  "acpx_local",
  "agy_local",
  "claude_local",
  "claude_rc_local",
  "codex_local",
  "cursor",
  "cursor_cloud",
  "gemini_local",
  "grok_local",
  "hermes_gateway",
  "hermes_local",
  "kimi_local",
  "openclaw_gateway",
  "opencode_local",
  "pi_local",
]);

const managedCapability: RunnerGoalCapability = {
  availability: "available",
  verified: true,
  actions: ["set", "pause", "resume", "clear"],
  autonomousUpdates: false,
  persistentAcrossResume: true,
  maxObjectiveChars: 4_000,
  tokenBudgetControl: false,
  usageReporting: false,
  reasonCode: "paperclip_managed_goal",
  reason: "Paperclip keeps this goal and adds it to the run's prompt (a kept conversation gets it once, then only on change); a change takes effect on the next run.",
};

export const managedGoalController: ManagedGoalController = {
  capability: managedCapability,
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
  return MANAGED_GOAL_ADAPTERS.has(agent.adapterType) ? managedGoalController : null;
}

export interface ManagedGoalPromptContext {
  /** active: render the objective; paused/cleared: tell a conversation that saw the goal once. */
  state: "active" | "paused" | "cleared";
  objective: string | null;
  /** Identity of state+objective; equal keys mean the conversation already holds this goal state. */
  key: string;
  /** Key the resumed conversation last received, when known. */
  deliveredKey?: string | null;
}

export function managedGoalKey(state: string, objective: string | null): string {
  return state === "cleared"
    ? "cleared"
    : `${state}:${createHash("sha256").update(objective ?? "").digest("hex").slice(0, 16)}`;
}

/** Goal state a managed adapter's prompt should carry, or null for an adapter with no managed goal. */
export function managedGoalPromptContext(
  adapterType: string,
  goalJson: unknown,
  deliveredKey?: string | null,
): ManagedGoalPromptContext | null {
  if (!managedGoalControllerFor({ adapterType })) return null;
  const goal = typeof goalJson === "object" && goalJson !== null
    ? goalJson as { objective?: unknown; status?: unknown }
    : null;
  const objective = typeof goal?.objective === "string" && goal.objective.trim() ? goal.objective : null;
  const state = !objective || goal?.status === "complete"
    ? "cleared"
    : goal?.status === "active" ? "active" : "paused";
  return {
    state,
    objective: state === "cleared" ? null : objective,
    key: managedGoalKey(state, objective),
    ...(deliveredKey !== undefined ? { deliveredKey } : {}),
  };
}
