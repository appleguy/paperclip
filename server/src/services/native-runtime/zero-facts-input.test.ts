import { describe, expect, it } from "vitest";
import { buildNativeExecutionInput, renderZeroFactsInput, type BuildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { createHash } from "node:crypto";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

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
  it("includes the materialized answer in fresh and resumed zero prompts", () => {
    const wakePayload = { reason: "answered", externalChatQuestionResponse: {}, interactionId: "i1" };
    const interactionResponses = [{ interactionId: "i1", kind: "ask_user_questions" as const, response: { status: "answered", result: { summaryMarkdown: "Use blue" } } }];
    const fresh = buildNativeExecutionInput({ ...args, zero: true, wakePayload, interactionResponses });
    expect(fresh.task.prompt).toContain("Question response: Use blue");
    const resumed = buildNativeExecutionInput({ ...args, zero: true, wakePayload, interactionResponses, resumedSession: true, previousTurn: { runId: args.runId, task: args.issue } as BuildNativeExecutionInput["previousTurn"] });
    expect(resumed.continuationPrompt).toBe(fresh.task.prompt);
  });
  it("omits initial guidance and handoff in zero mode while retaining the default", () => {
    const options = { ...args, initialCommunicationGuidance: "Communication guidance", freshSessionHandoff: "Handoff" };
    expect(buildNativeExecutionInput({ ...options, zero: true })).not.toHaveProperty("initialCommunicationGuidance");
    expect(buildNativeExecutionInput(options).initialCommunicationGuidance).toBe("Communication guidance\n\nHandoff");
  });
  it("persists and validates the versioned recovery context digest", () => {
    const input = buildNativeExecutionInput({ ...args, zero: true }) as ReturnType<typeof buildNativeExecutionInput> & { zeroContext: { revision: string; text: string; digest: string } };
    expect(input.zeroContext.revision).toBe("paperclip.zero-recovery.v1");
    expect(input.zeroContext.digest).toBe(createHash("sha256").update(input.zeroContext.text).digest("hex"));
    expect(parseNativeExecutionInput(input)).toEqual(input);
    expect(() => parseNativeExecutionInput({ ...input, zeroContext: { ...input.zeroContext, digest: "0".repeat(64) } })).toThrow();
  });
  it("retains the default prompt", () => {
    const normal = buildNativeExecutionInput(args);
    expect(normal).toEqual(buildNativeExecutionInput({ ...args, zero: false }));
    expect(normal.task.prompt).toMatchSnapshot();
  });
});
