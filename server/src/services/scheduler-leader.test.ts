import { describe, expect, it, vi } from "vitest";
import { awaitSchedulerLeadership, createSchedulerHandoff, getSchedulerLeadershipState, SCHEDULER_LEADER_LOCK_NAME } from "./scheduler-leader.js";

const db = {} as never;

describe("awaitSchedulerLeadership", () => {
  it("is a no-op when disabled: no lock, no wait", async () => {
    const acquire = vi.fn();
    await expect(awaitSchedulerLeadership(db, { enabled: false, acquire })).resolves.toBeNull();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("holds the named lock when enabled and passes signal and loss callback through", async () => {
    const lock = { release: vi.fn(async () => undefined) };
    const acquire = vi.fn(async () => lock);
    const signal = new AbortController().signal;
    const onLost = vi.fn();
    const leadership = await awaitSchedulerLeadership(db, { enabled: true, acquire, signal, onLost });
    expect(getSchedulerLeadershipState().state).toBe("leader");
    expect(acquire).toHaveBeenCalledWith(db, SCHEDULER_LEADER_LOCK_NAME, { signal, onLost: expect.any(Function) });
    await leadership?.release();
    expect(lock.release).toHaveBeenCalledOnce();
    expect(getSchedulerLeadershipState().state).toBe("released");
  });

  it("propagates an aborted wait", async () => {
    const acquire = vi.fn(async () => { throw new Error("aborted"); });
    await expect(awaitSchedulerLeadership(db, { enabled: true, acquire })).rejects.toThrow("aborted");
  });
});

describe("scheduler handoff", () => {
  it("keeps leadership through detachment and coalesces simultaneous handoff requests", async () => {
    let detached!: () => void;
    const prepare = vi.fn(() => new Promise<void>(resolve => { detached = resolve; }));
    const release = vi.fn(async () => undefined);
    const handoff = createSchedulerHandoff({ prepare, release });
    const first = handoff();
    expect(handoff()).toBe(first);
    expect(release).not.toHaveBeenCalled();
    detached();
    await first;
    await handoff();
    expect(prepare).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("retains leadership if detachment fails", async () => {
    const release = vi.fn(async () => undefined);
    const handoff = createSchedulerHandoff({ prepare: async () => { throw new Error("detach failed"); }, release });
    await expect(handoff()).rejects.toThrow("detach failed");
    expect(release).not.toHaveBeenCalled();
  });
});
