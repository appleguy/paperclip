import { expect, it } from "vitest";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

it("builds explicit shared v2 settings without importing host authority", () => {
  const input = { companyId: "10000000-0000-4000-8000-000000000001", runId: "50000000-0000-4000-8000-000000000005", agentId: "30000000-0000-4000-8000-000000000003", issue: { id: "20000000-0000-4000-8000-000000000002", identifier: "I", title: "Task", description: null, workMode: "standard" as const }, taskPrompt: "Task", workspace: { id: "50000000-0000-4000-8000-000000000005", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId: "session_explicit", provider: "opencode_shared_v2" as const, model: "fixture/model", opencodeEffort: "high", completionContract: { id: "c", sha256: "sha256:" + "a".repeat(64), schemaVersion: "v1", contract: { revision: "1", objective: "Task", criteria: [{ id: "c", requirement: "Done" }] } }, runtimeContext: nativeRuntimeContextFixture() };
  const result = buildNativeExecutionInput(input);
  expect(result).toMatchObject({ schema: "paperclip.native-execution-input.v12", provider: { kind: "opencode_shared_v2", model: "fixture/model", effort: "high", cliVersion: "2.2.5" }, session: { driverKind: "opencode_shared_v2" } });
  expect(result.provider).not.toHaveProperty("leaseId");
  expect(() => buildNativeExecutionInput({ ...input, model: null })).toThrow();
  expect(() => buildNativeExecutionInput({ ...input, opencodeEffort: "" })).toThrow();
  expect(() => buildNativeExecutionInput({ ...input, normalizedSessionId: null })).toThrow();
});
