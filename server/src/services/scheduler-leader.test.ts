import { describe, expect, it, vi } from "vitest";
import { awaitSchedulerLeadership, SCHEDULER_LEADER_LOCK_NAME } from "./scheduler-leader.js";

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
    await expect(awaitSchedulerLeadership(db, { enabled: true, acquire, signal, onLost })).resolves.toBe(lock);
    expect(acquire).toHaveBeenCalledWith(db, SCHEDULER_LEADER_LOCK_NAME, { signal, onLost });
  });

  it("propagates an aborted wait", async () => {
    const acquire = vi.fn(async () => { throw new Error("aborted"); });
    await expect(awaitSchedulerLeadership(db, { enabled: true, acquire })).rejects.toThrow("aborted");
  });
});
