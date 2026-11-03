import { describe, expect, it } from "vitest";
import { MAX_SESSION_GENERATION as driverMax, sessionIdFor } from "./opencode-http-driver.js";
// The Herdr tab labeller recomputes session ids outside this package; drift would mislabel every live session an orphan.
// @ts-expect-error plain .mjs ops helper without type declarations
import * as mirror from "../../../../../../ops/research/runner-control/experiments/unified-native-mission/opencode-session-runs.mjs";

describe("ops/.../opencode-session-runs.mjs mirrors the driver's session ids", () => {
  const agentId = "bddd515a-8353-4133-bd35-017c22b334f3";
  const issueId = "62f6d9c4-8c94-4647-bd2e-491a28f269f6";

  it("derives the same id for every generation", () => {
    expect(mirror.MAX_SESSION_GENERATION).toBe(driverMax);
    for (const g of [0, 1, 2, 17, driverMax]) {
      expect(mirror.sessionIdFor(agentId, issueId, g)).toBe(sessionIdFor({ agentId, issueId }, g));
    }
  });

  it("maps a wanted session to its live run and ranks running over queued", () => {
    const rotated = sessionIdFor({ agentId, issueId }, 3);
    const other = sessionIdFor({ agentId, issueId: "00000000-0000-0000-0000-000000000000" });
    const owned = mirror.ownedSessions(
      [{ status: "queued", agentId, issueId }, { status: "running", agentId, issueId }],
      [rotated, other],
    ) as Map<string, string>;
    expect(owned.get(rotated)).toBe("running");
    expect(owned.has(other)).toBe(false);
  });
});
