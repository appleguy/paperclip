import { describe, expect, it } from "vitest";
import { buildCodexSharedThreadName } from "./codex-shared-thread-name.js";

describe("buildCodexSharedThreadName", () => {
  it("names an issue thread and strips controls and sensitive links", () => {
    expect(buildCodexSharedThreadName({ agentName: "Luna Low Runner Probe", runId: "12345678-rest", issue: { identifier: "SCO-406", title: "Native Codex pilot:\nsay hello" } }))
      .toBe("SCO-406 · Luna Low Runner Probe · Native Codex pilot: say hello");
    const name = buildCodexSharedThreadName({ agentName: "Agent", runId: "12345678", issue: { identifier: "SCO-1", title: "https://example.com/?token=abc token=secret" } });
    expect(name).toBe("SCO-1 · Agent · [link] [redacted]");
  });

  it("bounds long names by Unicode characters and falls back to the run", () => {
    const name = buildCodexSharedThreadName({ agentName: "A".repeat(100), runId: "12345678-rest", issue: { identifier: "SCO-123", title: "😀".repeat(100) } });
    expect(Array.from(name)).toHaveLength(80);
    expect(buildCodexSharedThreadName({ agentName: "Luna", runId: "12345678-rest" })).toBe("Luna · run 12345678");
  });
});
