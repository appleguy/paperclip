import { describe, expect, it } from "vitest";
import { monitorBackoffMs, monitorCoalescingLimits } from "./monitor-coalescing.js";

describe("issue monitor backoff bounds", () => {
  it("uses safe defaults and validated environment overrides", () => {
    expect(monitorCoalescingLimits({} as NodeJS.ProcessEnv))
      .toEqual({ windowMs: 300_000, capMs: 1_800_000 });
    expect(monitorCoalescingLimits({
      PAPERCLIP_MONITOR_WAKE_WINDOW_MS: "60000",
      PAPERCLIP_MONITOR_BACKOFF_CAP_MS: "480000",
    } as NodeJS.ProcessEnv)).toEqual({ windowMs: 60_000, capMs: 480_000 });
    expect(monitorCoalescingLimits({
      PAPERCLIP_MONITOR_WAKE_WINDOW_MS: "-1",
      PAPERCLIP_MONITOR_BACKOFF_CAP_MS: "NaN",
    } as NodeJS.ProcessEnv)).toEqual({ windowMs: 300_000, capMs: 1_800_000 });
  });

  it("doubles per unchanged wake, caps the delay, and cannot overflow", () => {
    expect([1, 2, 3, 4, 5].map(streak => monitorBackoffMs(60_000, 480_000, streak)))
      .toEqual([60_000, 120_000, 240_000, 480_000, 480_000]);
    expect(monitorBackoffMs(60_000, 480_000, 1_000)).toBe(480_000);
  });
});
