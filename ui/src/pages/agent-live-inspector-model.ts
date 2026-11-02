import type { HeartbeatRun } from "@paperclipai/shared";
import type { TranscriptEntry } from "../adapters";

export type InspectorFilter = "all" | "reasoning" | "tools" | "messages";

export function selectInspectorRun(runs: readonly HeartbeatRun[], requestedId: string | null): HeartbeatRun | null {
  const sorted = [...runs].sort((a, b) => Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)));
  if (requestedId) return sorted.find((run) => run.id === requestedId) ?? null;
  return sorted.find((run) => run.status === "running") ?? sorted[0] ?? null;
}

export function filterInspectorTranscript(entries: readonly TranscriptEntry[], filter: InspectorFilter): TranscriptEntry[] {
  if (filter === "all") return [...entries];
  return entries.filter((entry) => {
    if (filter === "reasoning") return entry.kind === "thinking";
    if (filter === "tools") return entry.kind === "tool_call" || entry.kind === "tool_result";
    return entry.kind === "assistant" || entry.kind === "user" || entry.kind === "result";
  });
}

export function inspectorRunState(run: Pick<HeartbeatRun, "status" | "startedAt" | "finishedAt" | "outputSilence">) {
  if (run.status === "queued") return "Queued: the agent has not started this run.";
  if (run.status === "scheduled_retry") return "Waiting for a scheduled retry; no active generation.";
  if (run.status === "running" && run.startedAt && !run.finishedAt) {
    if (run.outputSilence?.level === "critical") return "Run process is marked running, but output silence is critical. Investigate the current model/tool request.";
    if (run.outputSilence?.level === "suspicious") return "Run process is marked running, but output has been quiet longer than expected.";
    return "Run process is marked running. Active decoding is not independently confirmed.";
  }
  return `Run ${run.status}. No active generation is implied.`;
}

export function inspectorLivenessLabel(run: Pick<HeartbeatRun, "status" | "finishedAt" | "livenessState" | "outputSilence">): string {
  if (run.status === "running" && !run.finishedAt) {
    return run.outputSilence?.level === "critical" ? "Output silence: critical"
      : run.outputSilence?.level === "suspicious" ? "Output silence: suspicious"
      : "Executing · no terminal verdict";
  }
  if (run.status === "queued" || run.status === "scheduled_retry") return "Not yet executing";
  return run.livenessState ?? "Not assessed";
}

export function meanMetric(sum: number | null | undefined, count: number | null | undefined): number | null {
  return typeof sum === "number" && Number.isFinite(sum) && typeof count === "number" && count > 0
    ? sum / count
    : null;
}
