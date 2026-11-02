import { describe, it, expect } from "vitest";
import type { HeartbeatRun } from "@paperclipai/shared";
import type { TranscriptEntry } from "../adapters";
import { filterInspectorTranscript, inspectorRunState, inspectorLivenessLabel, meanMetric, selectInspectorRun } from "./agent-live-inspector-model";

const run = (id: string, status: HeartbeatRun["status"], at: string) =>
  ({ id, status, createdAt: at, startedAt: status === "running" ? at : null, finishedAt: null } as unknown as HeartbeatRun);

describe("agent live inspector model", () => {
  it("prefers executing work to newer queued work, but honors an explicit selection", () => {
    const runs = [run("queued", "queued", "2026-10-31T06:00:00Z"), run("active", "running", "2026-10-31T05:00:00Z")];
    expect(selectInspectorRun(runs, null)?.id).toBe("active");
    expect(selectInspectorRun(runs, "queued")?.id).toBe("queued");
    expect(selectInspectorRun(runs, "different")).toBeNull();
  });
  it("does not present queued as active", () => {
    expect(inspectorRunState(run("q", "queued", "2026-10-31T06:00:00Z"))).toMatch(/not started/);
    expect(inspectorRunState(run("a", "running", "2026-10-31T06:00:00Z"))).toMatch(/Run process is marked running/);
  });
  it("never presents a stale terminal failure as the current run health", () => {
    const running = { ...run("r", "running", "2026-10-31T06:00:00Z"),
      livenessState: "failed", livenessReason: "Run ended with scheduled_retry",
      outputSilence: { level: "critical", silenceAgeMs: 3_000_000 } } as unknown as HeartbeatRun;
    expect(inspectorRunState(running)).toContain("silence is critical");
    expect(inspectorLivenessLabel(running)).toBe("Output silence: critical");
    expect(inspectorLivenessLabel({ ...running, status: "failed", finishedAt: "2026-10-31T06:01:00Z" } as unknown as HeartbeatRun)).toBe("failed");
    expect(inspectorLivenessLabel(run("q", "queued", "2026-10-31T06:00:00Z"))).toBe("Not yet executing");
  });

  it("normalizes tool and reasoning views regardless of runner identity", () => {
    const rows = [
      {kind:"thinking",ts:"",text:"reasoning"} as TranscriptEntry,
      {kind:"tool_call",ts:"",name:"shell",input:{}} as TranscriptEntry,
      {kind:"tool_result",ts:"",toolUseId:"t",content:"ok",isError:false} as TranscriptEntry,
      {kind:"assistant",ts:"",text:"answer"} as TranscriptEntry,
    ];
    expect(filterInspectorTranscript(rows,"reasoning")).toHaveLength(1);
    expect(filterInspectorTranscript(rows,"tools")).toHaveLength(2);
    expect(filterInspectorTranscript(rows,"messages")).toHaveLength(1);
    expect(filterInspectorTranscript(rows,"all")).toHaveLength(4);
  });
  it("does not invent a latency mean without observations", () => {
    expect(meanMetric(12, 4)).toBe(3);
    expect(meanMetric(12, 0)).toBeNull();
    expect(meanMetric(null, 4)).toBeNull();
  });
});
