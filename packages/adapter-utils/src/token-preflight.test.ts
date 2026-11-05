import { describe, expect, it } from "vitest";
import { assertPromptTokenShare, estimatePromptTokens, tokenPreflightModelLimit } from "./token-preflight.js";

describe("token preflight", () => {
  it.each([
    ["gpt-6.1-sol", 272_000], ["gpt-6.1-terra", 272_000],
    ["gemini-3.8-pro", 200_000], ["claude-haiku-5-5", 100_000],
    ["native-fleet/qwen", 102_400], ["maya-metal/glm-5.3-flash", 131_072],
    ["native-fleet/deepseek-v4.1", 131_072],
  ])("applies the configured limit to %s", (model, limit) => {
    expect(tokenPreflightModelLimit(model)).toBe(limit);
    expect(() => assertPromptTokenShare({ seat: "S9", model, prompt: "a".repeat(limit * 3) })).not.toThrow();
    expect(() => assertPromptTokenShare({ seat: "S9", model, prompt: "a".repeat(limit * 3 + 1) })).toThrow(`model limit ${limit}`);
  });
  it("counts UTF-8 bytes and checks the configured share", () => {
    expect(estimatePromptTokens("😀a")).toBe(2);
    expect(() => assertPromptTokenShare({ seat: "S9", model: "gpt-6.1-terra", prompt: "x".repeat(408_001), share: 0.5 })).toThrow(/S9.*gpt-6\.1-terra.*136000.*272000/);
    expect(() => assertPromptTokenShare({ seat: "S9", model: "gpt-6.1-terra", prompt: "", share: NaN })).toThrow(/Invalid/);
  });
  it("leaves models outside the fleet table unchanged", () => {
    expect(tokenPreflightModelLimit("claude-sonnet-5-5")).toBeNull();
  });
});
