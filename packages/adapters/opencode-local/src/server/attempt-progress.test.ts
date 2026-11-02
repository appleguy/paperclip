import { describe, expect, it } from "vitest";
import { createOpenCodeAttemptProgressGuard } from "./attempt-progress.js";

describe("OpenCode bounded retry evidence", () => {
  const unknown = JSON.stringify({ type: "error", error: { message: "unknown session" } });
  const capacity = JSON.stringify({ type: "error", error: {
    type: "provider.rate-limit", status: 429,
    response: { body: JSON.stringify({ src: "llama-swap",
      error: { code: "concurrency_limit", type: "rate_limit_error", message: "Too many requests" } }) },
  } });
  const start = JSON.stringify({ type: "step_start", sessionID: "ses_existing" });

  it("accepts a pure unknown-session error split across transport chunks", () => {
    const probe = createOpenCodeAttemptProgressGuard();
    probe.observe(unknown.slice(0, 11));
    probe.observe(unknown.slice(11) + "\n");
    expect(probe.hasPossibleWork(unknown)).toBe(false);
    expect(probe.preInferenceCapacityRefusal(unknown)).toBe(false);
  });

  it.each(["tool_use", "text", "step_start", "step_finish", "unknown"])(
    "remembers prior %s work even when final stdout is truncated to an error", (type) => {
      const probe = createOpenCodeAttemptProgressGuard();
      probe.observe(JSON.stringify({ type, sessionID: "ses_1",
        part: { state: { status: "completed" } } }) + "\n");
      probe.observe(unknown + "\n");
      expect(probe.hasPossibleWork(unknown)).toBe(true);
      expect(probe.observedSessionId(unknown)).toBe("ses_1");
    },
  );

  it("recognizes exactly one pre-inference capacity refusal with no progress", () => {
    const probe = createOpenCodeAttemptProgressGuard();
    probe.observe(start.slice(0, 13));
    probe.observe(start.slice(13) + "\n" + capacity + "\n");
    expect(probe.preInferenceCapacityRefusal(capacity)).toBe(true);
    expect(probe.observedSessionId(capacity)).toBe("ses_existing");
  });

  it.each([
    ["tool completed", JSON.stringify({ type: "tool_use", part: { state: { status: "completed" } } })],
    ["model text", JSON.stringify({ type: "text", part: { text: "Already written" } })],
    ["completed step", JSON.stringify({ type: "step_finish" })],
    ["duplicate step start", start],
    ["unrecognized error", unknown],
    ["malformed output", "provider log line"],
  ])("refuses capacity retry when %s preceded the 429", (_label, prior) => {
    const probe = createOpenCodeAttemptProgressGuard();
    probe.observe(start + "\n" + prior + "\n" + capacity);
    expect(probe.preInferenceCapacityRefusal(capacity)).toBe(false);
  });

  it("rejects a string-only HTTP 429 without typed provider evidence", () => {
    const probe = createOpenCodeAttemptProgressGuard();
    probe.observe(start + "\n" + JSON.stringify({ type: "error", error: "429 Too Many Requests" }));
    expect(probe.preInferenceCapacityRefusal()).toBe(false);
  });

  it("fails closed on oversized or malformed output", () => {
    const probe = createOpenCodeAttemptProgressGuard();
    probe.observe("X".repeat(129 * 1024));
    probe.observe(capacity + "\n");
    expect(probe.hasPossibleWork(capacity)).toBe(true);
    expect(probe.preInferenceCapacityRefusal(capacity)).toBe(false);
  });

  it("examines result stdout when a remote transport omits log callbacks", () => {
    expect(createOpenCodeAttemptProgressGuard().hasPossibleWork(unknown)).toBe(false);
    expect(createOpenCodeAttemptProgressGuard().hasPossibleWork(JSON.stringify({ type: "tool_use" }) + "\n" + unknown)).toBe(true);
    expect(createOpenCodeAttemptProgressGuard().preInferenceCapacityRefusal(start + "\n" + capacity)).toBe(true);
  });
});
