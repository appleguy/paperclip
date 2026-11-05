import { expect, it } from "vitest";
import { resolvePaperclipRunnerNativeProviderInput, resolvePaperclipRunnerProviderProfile } from "./provider-profile.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

const config = { provider: "antigravity_headless", model: "gemini-3.1-pro", modelReasoningEffort: "max" };

it("carries saved agy model and effort from profile through the qualified v11 input", () => {
  expect(resolvePaperclipRunnerProviderProfile(config)).toEqual({ provider: "antigravity_headless", backend: "antigravity_headless", model: config.model, effort: "max" });
  const provider = resolvePaperclipRunnerNativeProviderInput({ backend: "antigravity_headless", adapterConfig: config });
  expect(provider).toEqual({ provider: "antigravity_headless", model: config.model, antigravityEffort: "max", homeMode: "preconfigured" });
  const execution = buildNativeExecutionInput({
    companyId: "company", runId: "run", agentId: "agent",
    issue: { id: "issue", identifier: "I", title: "Task", description: null, workMode: "standard" }, taskPrompt: "Task",
    workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId: "session",
    completionContract: { id: "contract", sha256: "sha256:" + "a".repeat(64), schemaVersion: "v1", contract: { revision: "1", objective: "Task", criteria: [{ id: "done", requirement: "Done" }] } },
    runtimeContext: nativeRuntimeContextFixture(), ...provider,
  });
  expect(execution.provider).toEqual({ kind: "antigravity_headless", model: config.model, effort: "max", cliVersion: "1.5.1" });
});

it("leaves native saved defaults available when no model or effort is overridden", () => {
  expect(resolvePaperclipRunnerNativeProviderInput({ backend: "antigravity_headless", adapterConfig: { provider: "antigravity_headless" } })).toEqual({ provider: "antigravity_headless", model: null, homeMode: "preconfigured" });
});

it("rejects invalid settings and mixed provider authority", () => {
  for (const bad of [{ model: "" }, { model: 42 }, { model: "--bad" }, { model: "bad\nmodel" }, { effort: "unlimited", modelReasoningEffort: undefined }, { homeMode: "isolated" }, { lifecycleMode: "persistent" }, { acpxAgent: "antigravity" }]) {
    expect(() => resolvePaperclipRunnerProviderProfile({ ...config, ...bad })).toThrow("Native Antigravity headless requires");
  }
});
