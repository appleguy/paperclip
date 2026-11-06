import { expect, it, vi } from "vitest";
import { OpenCodeSharedNativeBackend, type OpenCodeSharedNativePort } from "./shared-native-backend.ts";

it("exposes the owned provider boundary during a managed turn and cancels its lease on stop", async () => {
  const identity = { runId: "run", sessionId: "session", companyId: "company", issueId: "issue", agentId: "agent" };
  const checkpoint = { id: "checkpoint", requestSha256: "a".repeat(64) };
  let ownerSignal: AbortSignal | undefined;
  const resume = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const port: OpenCodeSharedNativePort = {
    identity, runnerInstanceId: "runner", providerSessionId: "ses_fixture",
    verify: async () => {}, readReceipt: async () => null, dispatch: async () => {},
    startObservation: async () => {}, waitForReceipt: async () => { throw new Error("unused"); },
    stop, close: async () => {},
    freezeProvider: async input => { ownerSignal = input.signal; return checkpoint; },
    resumeProvider: resume,
  };
  const session = await new OpenCodeSharedNativeBackend(port).openSession({ identity });
  await expect(session.freezeProvider!({ timeoutMs: 1000, signal: new AbortController().signal })).rejects.toThrow("controller_closed");
  await session.startTurn({ message: { role: "user", text: "task" } });
  expect(await session.freezeProvider!({ timeoutMs: 1000, signal: new AbortController().signal })).toEqual(checkpoint);
  await session.resumeProvider!(checkpoint);
  expect(resume).toHaveBeenCalledWith(checkpoint);
  const cancellation = session.cancel!({ reason: "stop", signal: new AbortController().signal });
  expect(ownerSignal?.aborted).toBe(true);
  await cancellation.cleanup;
  expect(stop).toHaveBeenCalledOnce();
  await expect(session.resumeProvider!(checkpoint)).rejects.toThrow("controller_closed");
});
