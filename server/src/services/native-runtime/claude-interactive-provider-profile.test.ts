import { expect, it } from "vitest";
import { resolvePaperclipRunnerNativeProviderInput, resolvePaperclipRunnerProviderProfile } from "./provider-profile.js";

const config = { provider: "claude_interactive", model: "claude-sonnet-5-5", effort: "high" };

it("resolves an explicit Claude interactive profile and the v13 provider input", () => {
  expect(resolvePaperclipRunnerProviderProfile(config)).toEqual({ provider: "claude_interactive", backend: "claude_interactive", model: "claude-sonnet-5-5", effort: "high" });
  expect(resolvePaperclipRunnerNativeProviderInput({ backend: "claude_interactive", adapterConfig: config })).toEqual({
    provider: "claude_interactive", model: "claude-sonnet-5-5", homeMode: "preconfigured", claudeEffort: "high", claudeAutoCompactTokens: 200000,
  });
});

it("rejects missing model, unsupported effort, non-preconfigured home and ACPX mixing", () => {
  for (const bad of [{ ...config, model: "" }, { ...config, effort: "xhigh" }, { ...config, effort: undefined }, { ...config, homeMode: "isolated" }, { ...config, acpxAgent: "claude" }]) {
    expect(() => resolvePaperclipRunnerProviderProfile(bad)).toThrow("Claude interactive requires an explicit model and effort");
  }
});

