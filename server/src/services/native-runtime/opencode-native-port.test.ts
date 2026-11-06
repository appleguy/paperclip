import { describe, expect, it, vi } from "vitest";
import { createOpenCodeNativePort } from "./opencode-native-port.js";

describe("OpenCode native Stop port", () => {
  function fixture() {
    const binding = { runId: "run", agentId: "agent", companyId: "company", issueId: "issue", normalizedSessionId: "session",
      runnerInstanceId: "runner", providerSessionId: "ses_owned", controllerProcessStartedAt: new Date(0) };
    const host = { interruptForRun: vi.fn(async () => {}), shutdown: vi.fn(async () => {}) };
    return { host, binding, port: createOpenCodeNativePort({} as never, binding as never, host as never).port };
  }

  it("interrupts only its binding and confirms owned host exit before settling Stop", async () => {
    const { host, binding, port } = fixture();
    let exit!: () => void;
    host.shutdown.mockReturnValueOnce(new Promise<void>(resolve => { exit = resolve; }));
    let acknowledged = false;
    const stop = port.stop().then(() => { acknowledged = true; });
    await vi.waitFor(() => expect(host.shutdown).toHaveBeenCalledOnce());
    expect(host.interruptForRun).toHaveBeenCalledWith({}, binding);
    expect(acknowledged).toBe(false);
    exit();
    await stop;
    await port.stop();
    expect(host.interruptForRun).toHaveBeenCalledOnce();
    expect(host.shutdown).toHaveBeenCalledOnce();
  });

  it("retries an unconfirmed exit without interrupting a second time", async () => {
    const { host, port } = fixture();
    host.shutdown.mockRejectedValueOnce(new Error("exit unconfirmed"));
    await expect(port.stop()).rejects.toThrow("exit unconfirmed");
    await port.stop();
    expect(host.interruptForRun).toHaveBeenCalledOnce();
    expect(host.shutdown).toHaveBeenCalledTimes(2);
  });

  it("closes the observer for restart without interrupting or shutting down the provider", async () => {
    const { host, port } = fixture();
    await port.close();
    expect(host.interruptForRun).not.toHaveBeenCalled();
    expect(host.shutdown).not.toHaveBeenCalled();
  });
});
