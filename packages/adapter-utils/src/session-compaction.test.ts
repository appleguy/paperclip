import { describe, expect, it } from "vitest";
import { resolveSessionCompactionPolicy } from "./session-compaction.js";

describe("resolveSessionCompactionPolicy", () => {
  it("uses the updated model-bounded default policy for unknown adapters", () => {
    const resolved = resolveSessionCompactionPolicy("opencode_local", {});
    expect(resolved.policy).toEqual({
      enabled: true,
      maxSessionRuns: 25,
      maxRawInputTokens: 89_600,
      maxSessionAgeHours: 24,
      modelContextWindowTokens: 128_000,
      contextRotationRatio: 0.7,
    });
  });

  it("dynamically derives maxRawInputTokens from modelContextWindowTokens and contextRotationRatio", () => {
    const resolved = resolveSessionCompactionPolicy("opencode_local", {
      heartbeat: {
        sessionCompaction: {
          modelContextWindowTokens: 64_000,
          contextRotationRatio: 0.75,
        },
      },
    });
    expect(resolved.policy.maxRawInputTokens).toBe(48_000);
    expect(resolved.policy.modelContextWindowTokens).toBe(64_000);
    expect(resolved.policy.contextRotationRatio).toBe(0.75);
  });

  it("prioritizes explicit maxRawInputTokens over derived model context window", () => {
    const resolved = resolveSessionCompactionPolicy("opencode_local", {
      heartbeat: {
        sessionCompaction: {
          modelContextWindowTokens: 128_000,
          maxRawInputTokens: 50_000,
        },
      },
    });
    expect(resolved.policy.maxRawInputTokens).toBe(50_000);
  });

  it("keeps zero thresholds for confirmed native adapters", () => {
    const resolved = resolveSessionCompactionPolicy("claude_local", {});
    expect(resolved.policy.maxRawInputTokens).toBe(0);
    expect(resolved.policy.maxSessionRuns).toBe(0);
    expect(resolved.policy.maxSessionAgeHours).toBe(0);
  });
});
