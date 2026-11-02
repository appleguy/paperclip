import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityHeadlessController } from "./headless-controller.js";
import { AntigravityHeadlessNativeBackend } from "./headless-native-backend.js";
const identity = { companyId: "company", agentId: "agent", issueId: "issue", runId: "run", sessionId: "session" };
const binding = { executable: "/bin/agy", verifiedVersion: "1.4.12", cwd: "/tmp", conversationId: "native", identity, env: {} };
afterEach(() => vi.restoreAllMocks());
describe("native headless backend boundary", () => {
  it("binds exact initialized conversation, rejects task dispatch, and closes its child", async () => {
    const closeOwned = vi.fn(async () => {});
    vi.spyOn(AntigravityHeadlessController, "launch").mockImplementation(options => {
      queueMicrotask(() => options.onEvent({ kind: "init", conversationId: "native", cwd: "/tmp", permissionMode: "request-review" }));
      return { closeOwned } as unknown as AntigravityHeadlessController;
    });
    const backend = new AntigravityHeadlessNativeBackend(binding);
    const session = await backend.openSession({ identity, workingDirectory: "/tmp" });
    expect((await session.snapshot()).providerSessionId).toBe("native");
    expect(await session.capabilities()).toMatchObject({ structuredResult: false, interruption: false });
    await expect(session.startTurn({ message: { role: "user", text: "hello" } })).rejects.toThrow(/durable owner/);
    await session.close({ reason: "test" }); expect(closeOwned).toHaveBeenCalledOnce();
  });
  it("rejects foreign bindings before launching", async () => {
    const launch = vi.spyOn(AntigravityHeadlessController, "launch");
    await expect(new AntigravityHeadlessNativeBackend(binding).openSession({ identity: { ...identity, runId: "other" }, workingDirectory: "/tmp" })).rejects.toThrow(/identity/);
    expect(launch).not.toHaveBeenCalled();
  });
});

it("freezes the admitted run and native conversation against later caller mutation", async () => {
  const supplied = { ...binding, identity: { ...identity } };
  const backend = new AntigravityHeadlessNativeBackend(supplied);
  supplied.identity.runId = "foreign";
  supplied.conversationId = "foreign-native";
  const launch = vi.spyOn(AntigravityHeadlessController, "launch").mockImplementation(options => {
    expect(options.conversationId).toBe("native");
    queueMicrotask(() => options.onEvent({ kind: "init", conversationId: "native", cwd: "/tmp", permissionMode: "request-review" }));
    return { closeOwned: vi.fn(async () => {}) } as unknown as AntigravityHeadlessController;
  });
  await expect(backend.openSession({ identity: supplied.identity, workingDirectory: "/tmp" })).rejects.toThrow(/identity/);
  const session = await backend.openSession({ identity, workingDirectory: "/tmp" });
  expect(launch).toHaveBeenCalledOnce();
  expect((await session.snapshot()).providerSessionId).toBe("native");
  await session.close({ reason: "test" });
});
