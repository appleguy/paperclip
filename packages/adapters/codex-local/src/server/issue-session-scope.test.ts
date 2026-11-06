import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";
import { codexIssueScope, prepareCodexIssueSession, stampCodexIssueSession } from "./issue-session-scope.js";

describe("Codex issue session scope", () => {
  const scope = { issueId: "issue-a", projectId: "project-a" };
  const context = { issueId: scope.issueId, projectId: scope.projectId };
  const runtime = { sessionId: "session-a", sessionDisplayId: "session-a", taskKey: "issue-a", sessionParams: { sessionId: "session-a", cwd: "/work" } };
  const prepare = (nextContext: Record<string, unknown>, nextRuntime = runtime) => prepareCodexIssueSession({ context: nextContext, runtime: nextRuntime } as never);

  it("starts fresh for old seat sessions, a different issue or project, and missing project identity", () => {
    expect(prepare(context).ctx.runtime.sessionId).toBeNull();
    const scoped = stampCodexIssueSession(runtime, scope);
    expect(prepare(context, scoped).ctx.runtime.sessionId).toBe("session-a");
    expect(prepare({ ...context, issueId: "issue-b" }, scoped).ctx.runtime.sessionId).toBeNull();
    expect(prepare({ ...context, projectId: "project-b" }, scoped).ctx.runtime.sessionId).toBeNull();
    expect(prepare({ issueId: "issue-a" }, scoped).ctx.runtime.sessionId).toBeNull();
  });

  it("drops a resume delta when rejecting an unscoped session", () => {
    const result = prepareCodexIssueSession({ context, runtime, executionContinuation: { resumeDelta: { baseRunId: "prior", messages: [] }, objective: "current" } } as never);
    expect(result.ctx.executionContinuation?.resumeDelta).toBeUndefined();
    expect(result.ctx.executionContinuation?.objective).toBe("current");
  });

  it("keeps ordinary seat wakes unchanged and resolves server-authored issue context", () => {
    expect(prepare({}, runtime).ctx.runtime).toBe(runtime);
    expect(codexIssueScope({ paperclipIssue: { id: "issue-a" }, projectId: "project-a" })).toEqual(scope);
  });

  it.each([{ sessionId: "session-a", cwd: "/work" }, { runtimeSessionName: "acp-a", cwd: "/work" }])("retains the issue binding through the session codec", params => {
    const scoped = stampCodexIssueSession({ sessionParams: params }, scope).sessionParams;
    expect(sessionCodec.deserialize(sessionCodec.serialize(scoped))).toEqual(scoped);
  });
});
