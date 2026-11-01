import { describe, expect, it } from "vitest";
import {
  isBoardRoutableQuestion,
  normalizeBoardOperatorConfig,
} from "../services/board-operator.js";

const base = {
  kind: "ask_user_questions" as const,
  hasToolAction: false,
  hasSecretProposal: false,
  hasQualityReview: false,
};

describe("board operator config", () => {
  it("defaults to disabled and ignores malformed values", () => {
    expect(normalizeBoardOperatorConfig(undefined)).toEqual({
      agentId: null, routeAgentQuestions: false, wakeOnRecoveryEscalation: false,
    });
    expect(normalizeBoardOperatorConfig({ agentId: 5, routeAgentQuestions: "yes" })).toEqual({
      agentId: null, routeAgentQuestions: false, wakeOnRecoveryEscalation: false,
    });
  });

  it("keeps explicit switches", () => {
    expect(normalizeBoardOperatorConfig({
      agentId: "a", routeAgentQuestions: true, wakeOnRecoveryEscalation: true,
    })).toEqual({ agentId: "a", routeAgentQuestions: true, wakeOnRecoveryEscalation: true });
  });
});

describe("Board-first question routing eligibility", () => {
  it.each([undefined, "anyone", "human_only"] as const)(
    "routes a plain question with requested policy %s",
    (requestedPolicy) => {
      expect(isBoardRoutableQuestion({ ...base, requestedPolicy })).toBe(true);
    },
  );

  it("never routes governed or owner-only decisions", () => {
    expect(isBoardRoutableQuestion({ ...base, kind: "request_confirmation" })).toBe(false);
    expect(isBoardRoutableQuestion({ ...base, kind: "request_item_verdicts" })).toBe(false);
    expect(isBoardRoutableQuestion({ ...base, kind: "suggest_tasks" })).toBe(false);
    expect(isBoardRoutableQuestion({ ...base, hasToolAction: true })).toBe(false);
    expect(isBoardRoutableQuestion({ ...base, hasSecretProposal: true })).toBe(false);
    expect(isBoardRoutableQuestion({ ...base, hasQualityReview: true })).toBe(false);
    expect(isBoardRoutableQuestion({ ...base, requestedPolicy: "not_creator" })).toBe(false);
  });
});
