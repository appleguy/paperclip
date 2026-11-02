import { describe, expect, it } from "vitest";
import { normalizedGlmMetrics, readAgentEngineTelemetry } from "./agent-engine-telemetry.js";
describe("agent engine telemetry (no inference)", () => {
  it("normalizes real Colibri Prometheus counters and no fabricated decode rate", () => {
    const parsed = normalizedGlmMetrics(
      { status: "ok", scheduler: { active: 1, queued: 0, capacity: 1, completed: 9, failed: 0 }, engine_restarts: 0 },
      "colibri_scheduler_first_output_seconds_sum 18\ncolibri_scheduler_first_output_seconds_count 3\ncolibri_scheduler_engine_call_seconds_sum 60\ncolibri_scheduler_engine_call_seconds_count 3\n",
      "2026-10-31T06:00:00Z",
    );
    expect(parsed).toMatchObject({ supported: true, available: true, active: 1, queued: 0, firstOutputMeanSeconds: 6, engineCallMeanSeconds: 20 });
    expect(Object.keys(parsed)).not.toContain("decodeTokensPerSecond");
  });
  it("does not issue SSH for other, unregistered models", async () => {
    expect(await readAgentEngineTelemetry("qwen-quality")).toMatchObject({ supported: false, status: "unsupported" });
  });
  it("does not divide by zero when histogram has no samples", () => {
    expect(normalizedGlmMetrics({ status: "ok" }, "colibri_scheduler_first_output_seconds_sum 12\ncolibri_scheduler_first_output_seconds_count 0", "now").firstOutputMeanSeconds).toBeNull();
  });
});
