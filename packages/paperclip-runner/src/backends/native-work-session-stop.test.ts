import { describe, expect, it, vi } from "vitest";
import { ClaudeInteractiveNativeBackend } from "../drivers/claude/native-interactive-backend.js";
import { OpenCodeSharedNativeBackend } from "../drivers/opencode/shared-native-backend.js";

describe.each(["claude", "opencode"] as const)("%s work-session Stop", kind => {
  async function fixture() {
    const identity = { runId: "run", sessionId: "session", companyId: "company", issueId: "issue", agentId: "agent" };
    const port = { identity, runnerInstanceId: "runner", nativeSessionId: "session", providerSessionId: "ses_owned",
      verify: vi.fn(async () => {}), readReceipt: vi.fn(async () => null), dispatch: vi.fn(async () => {}),
      startObservation: vi.fn(async () => {}), waitForReceipt: vi.fn(), stop: vi.fn(async () => {}),
      detach: vi.fn(async () => {}), close: vi.fn(async () => {}),
    };
    const backend = kind === "claude" ? new ClaudeInteractiveNativeBackend(port) : new OpenCodeSharedNativeBackend(port);
    return { port, session: await backend.openSession({ identity }) };
  }

  it("revokes dispatch immediately and waits for provider Stop before acknowledging cleanup", async () => {
    const { port, session } = await fixture();
    let release!: () => void;
    port.stop.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
    let settled = false;
    const cleanup = session.cancel!({ reason: "Company paused", signal: new AbortController().signal }).cleanup.then(() => { settled = true; });
    await expect(session.startTurn({ message: { role: "user", text: "late work" } })).rejects.toThrow("dispatch_unavailable");
    expect(settled).toBe(false);
    expect(port.dispatch).not.toHaveBeenCalled();
    expect(port.stop).toHaveBeenCalledOnce();
    release();
    await cleanup;
    expect(settled).toBe(true);
  });

  it("propagates an unconfirmed provider Stop for retry", async () => {
    const { port, session } = await fixture();
    port.stop.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(session.cancel!({ reason: "Board Stop", signal: new AbortController().signal }).cleanup).rejects.toThrow("provider unavailable");
    await session.cancel!({ reason: "Retry Stop", signal: new AbortController().signal }).cleanup;
    expect(port.stop).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch after Stop races a pending receipt read", async () => {
    const { port, session } = await fixture();
    let release!: () => void;
    port.readReceipt.mockReturnValueOnce(new Promise<null>(resolve => { release = () => resolve(null); }));
    const turn = session.startTurn({ message: { role: "user", text: "work" } });
    const rejected = expect(turn).rejects.toThrow("dispatch_unavailable");
    await session.cancel!({ reason: "Agent paused", signal: new AbortController().signal }).cleanup;
    release();
    await rejected;
    expect(port.dispatch).not.toHaveBeenCalled();
  });

  it("detaches for restart without Stop, including subsequent controller cleanup", async () => {
    const { port, session } = await fixture();
    await session.detachControllerForRestart!();
    await session.close();
    expect(port.stop).not.toHaveBeenCalled();
    if (kind === "claude") {
      expect(port.detach).toHaveBeenCalledOnce();
      expect(port.close).not.toHaveBeenCalled();
    } else expect(port.close).toHaveBeenCalledOnce();
  });

  it("fences provider Stop before asynchronous restart detachment begins", async () => {
    const { port, session } = await fixture();
    let release!: () => void;
    const detaching = new Promise<void>(resolve => { release = resolve; });
    (kind === "claude" ? port.detach : port.close).mockReturnValueOnce(detaching);
    const restart = session.detachControllerForRestart!();
    expect(() => session.cancel!({ reason: "late cleanup", signal: new AbortController().signal })).toThrow("controller_detached");
    expect(port.stop).not.toHaveBeenCalled();
    release();
    await restart;
    await session.close();
    expect(port.stop).not.toHaveBeenCalled();
  });
});
