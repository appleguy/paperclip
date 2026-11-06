import { describe, expect, it } from "vitest";
import { buildNativeExecutionInput, renderZeroFactsInput, type BuildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

const args: BuildNativeExecutionInput = {
  companyId: "10000000-0000-4000-8000-000000000001", agentId: "30000000-0000-4000-8000-000000000003", runId: "50000000-0000-4000-8000-000000000005",
  issue: { id: "20000000-0000-4000-8000-000000000002", identifier: "SCO-1", title: "Fix", status: "open", description: "Details\nverbatim", workMode: "standard" },
  taskPrompt: "Default assignment", workspace: { id: "50000000-0000-4000-8000-000000000005", cwd: "/work", repoUrl: null, repoRef: null, branchName: null }, normalizedSessionId: null,
  wakePayload: { reason: "issue_commented", comments: [{ authorType: "user", author: { id: "u1" }, body: "older" }, { authorType: "agent", author: { id: "a1" }, body: "redacted body" }], executionContinuation: { completedWork: "Finished step" } },
  completionContract: { id: "70000000-0000-4000-8000-000000000007", sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Deliver", criteria: [{ id: "output", requirement: "Done" }] } },
  runtimeContext: nativeRuntimeContextFixture(),
};

describe("native zero facts", () => {
  it("projects exact supplied facts without template guidance", () => {
    const prompt = buildNativeExecutionInput({ ...args, zero: true }).task.prompt;
    expect(prompt).toBe("Issue: SCO-1 Fix\n\nStatus: open\n\nDescription: Details\nverbatim\n\nWake: issue_commented\n\nComments:\nagent a1 redacted body\nuser u1 older\n\nContinuation: Finished step\n\nWorkspace: /work");
    for (const marker of ["Paperclip", "skill", "You are", "checkout", "heartbeat", "paperclip_"]) expect(prompt).not.toContain(marker);
  });
  it("omits absent facts without substitutes", () => {
    expect(renderZeroFactsInput({ ...args, issue: { ...args.issue, identifier: null, status: null, description: null }, wakePayload: null })).toBe("Issue: Fix\n\nWorkspace: /work");
  });
  it("retains the default prompt", () => {
    const normal = buildNativeExecutionInput(args);
    expect(normal).toEqual(buildNativeExecutionInput({ ...args, zero: false }));
    expect(normal.task.prompt).toMatchSnapshot();
  });
});
