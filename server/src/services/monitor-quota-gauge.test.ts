import { describe, expect, it } from "vitest";
import { monitorQuotaExceeded, monitorQuotaLimits } from "./monitor-quota-gauge.js";

describe("hourly issue-monitor quota gauge", () => {
  it("accepts bounded env configuration and safe defaults", () => {
    expect(monitorQuotaLimits({} as NodeJS.ProcessEnv))
      .toEqual({ runsPerHour: 12, commentsPerHour: 12 });
    expect(monitorQuotaLimits({
      PAPERCLIP_MONITOR_RUNS_PER_AGENT_HOUR: "4",
      PAPERCLIP_MONITOR_COMMENTS_PER_AGENT_HOUR: "7",
    } as NodeJS.ProcessEnv)).toEqual({ runsPerHour: 4, commentsPerHour: 7 });
    expect(monitorQuotaLimits({
      PAPERCLIP_MONITOR_RUNS_PER_AGENT_HOUR: "-1",
      PAPERCLIP_MONITOR_COMMENTS_PER_AGENT_HOUR: "Infinity",
    } as NodeJS.ProcessEnv)).toEqual({ runsPerHour: 12, commentsPerHour: 12 });
  });
  it("pauses only the hourly monitor source at either hard cap", () => {
    const limits = { runsPerHour: 12, commentsPerHour: 12 };
    expect(monitorQuotaExceeded({ runs: 11, comments: 11 }, limits)).toBeNull();
    expect(monitorQuotaExceeded({ runs: 12, comments: 0 }, limits)).toBe("hourly_run_cap");
    expect(monitorQuotaExceeded({ runs: 0, comments: 12 }, limits)).toBe("hourly_comment_cap");
    expect(monitorQuotaExceeded({ runs: 12, comments: 12 }, limits)).toBe("hourly_run_cap");
  });
});
