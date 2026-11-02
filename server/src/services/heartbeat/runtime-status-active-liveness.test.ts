import { describe, expect, it } from "vitest";
import { decorateHeartbeatRunRuntimeStatus } from "./run-lifecycle.js";

describe("active run status does not reuse prior terminal liveness", () => {
  const historical = {
    id: "run-1", companyId: "company-1", agentId: "agent-1", issueId: "issue-1",
    livenessState: "failed", livenessReason: "Run ended with scheduled_retry",
  };
  it("suppresses stale terminal classification for running and queued attempts", () => {
    for (const status of ["running", "queued", "scheduled_retry"]) {
      const result = decorateHeartbeatRunRuntimeStatus({ ...historical, status });
      expect(result.livenessState).toBeNull();
      expect(result.livenessReason).toBeNull();
    }
  });
  it("retains genuine failures after the run actually terminates", () => {
    const result = decorateHeartbeatRunRuntimeStatus({ ...historical, status: "failed" });
    expect(result.livenessState).toBe("failed");
    expect(result.livenessReason).toBe("Run ended with scheduled_retry");
  });
});
