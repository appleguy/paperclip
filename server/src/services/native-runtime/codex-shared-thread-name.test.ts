import { describe, expect, it } from "vitest";
import { buildCodexSharedThreadName } from "./codex-shared-thread-name.js";

describe("buildCodexSharedThreadName", () => {
  it("puts the issue and title before a compact seat", () => {
    expect(buildCodexSharedThreadName({ agentName: "Codex Sol High", runId: "12345678", issue: { identifier: "SCO-793", title: "Owner ask: make the quota page primary" } }))
      .toBe("SCO-793 make the quota page primary · Sol");
    expect(buildCodexSharedThreadName({ agentName: "Terra Worker 1 (Terra High)", runId: "12345678", issue: { identifier: "SCO-1065", title: "OWNER ASK: implement the change" } }))
      .toBe("SCO-1065 implement the change · Terra 1");
  });

  it("redacts links, secrets, and controls in every part", () => {
    expect(buildCodexSharedThreadName({ agentName: "Codex Luna High", runId: "12345678", issue: { identifier: "SCO-1", title: "Owner ask:\nhttps://example.com/?token=abc token=secret" } }))
      .toBe("SCO-1 [link] [redacted] · Luna");
    expect(buildCodexSharedThreadName({ agentName: "Bearer abc", runId: "12345678", wakeReason: "token=secret" }))
      .toBe("[redacted] · [redacted]");
  });

  it("uses a task summary or wake reason, and only then a short run id", () => {
    expect(buildCodexSharedThreadName({ agentName: "Codex Luna XHigh", runId: "12345678", wakeReason: "timer_wake" })).toBe("timer wake · Luna");
    expect(buildCodexSharedThreadName({ agentName: "Codex Luna XHigh", runId: "12345678", wakeReason: "timer_wake", taskSummary: "Owner ask: check quota" })).toBe("check quota · Luna");
    expect(buildCodexSharedThreadName({ agentName: "Codex Luna XHigh", runId: "12345678" })).toBe("run 123456 · Luna");
    expect(buildCodexSharedThreadName({ agentName: "Codex High", runId: "12345678" })).toBe("run 123456 · Codex High");
  });

  it("shortens the title first and counts Unicode characters", () => {
    const name = buildCodexSharedThreadName({ agentName: "Codex Terra Worker 1 (Terra High)", runId: "12345678", issue: { identifier: "SCO-123", title: "😀".repeat(100) } });
    expect(Array.from(name)).toHaveLength(80);
    expect(name.startsWith("SCO-123 😀")).toBe(true);
    expect(name.endsWith(" · Terra 1")).toBe(true);
    const longSeat = buildCodexSharedThreadName({ agentName: "A".repeat(100), runId: "12345678", issue: { identifier: "SCO-123", title: "hello" } });
    expect(Array.from(longSeat)).toHaveLength(80);
  });
});
