import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { heartbeatsApi } from "@/api/heartbeats";
import { agentEngineTelemetryApi } from "@/api/agentEngineTelemetry";
import { useLiveRunTranscripts } from "@/components/transcript/useLiveRunTranscripts";
import { RunTranscriptView, type TranscriptMode } from "@/components/transcript/RunTranscriptView";
import { usePageVisibility } from "@/lib/page-visibility";
import { relativeTime } from "@/lib/utils";
import type { HeartbeatRun } from "@paperclipai/shared";
import type { TranscriptEntry } from "@/adapters";
import { filterInspectorTranscript, inspectorRunState, inspectorLivenessLabel, selectInspectorRun, type InspectorFilter } from "./agent-live-inspector-model";

const FILTERS: Array<{id: InspectorFilter; label: string}> = [
  {id:"all", label:"All"},
  {id:"reasoning", label:"Reasoning"},
  {id:"tools", label:"Tools"},
  {id:"messages", label:"Messages"},
];

function metric(value: unknown, suffix = ""): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString("en-US")}${suffix}` : "Unavailable";
}
function elapsed(started: HeartbeatRun["startedAt"], finished: HeartbeatRun["finishedAt"]): string {
  if (!started) return "Not started";
  const end = finished ? Date.parse(String(finished)) : Date.now();
  const delta = Math.max(0, Math.floor((end - Date.parse(String(started))) / 1000));
  if (!Number.isFinite(delta)) return "Unavailable";
  return `${Math.floor(delta / 3600)}h ${Math.floor((delta % 3600) / 60)}m ${delta % 60}s`;
}

/**
 * Shared Paperclip agent inspector. Transcript access stays behind Paperclip's
 * existing authenticated run-log authorization and existing adapter parser.
 * Engine counters are an optional, independently authorized provider plugin.
 */
export function AgentLiveInspector({ agentId, companyId, agentRouteId, adapterType }: {
  agentId: string;
  companyId: string;
  agentRouteId: string;
  adapterType: string;
}) {
  const { visible } = usePageVisibility();
  const [requestedRunId, setRequestedRunId] = useState<string | null>(null);
  const [filter, setFilter] = useState<InspectorFilter>("all");
  const [mode, setMode] = useState<TranscriptMode>("nice");

  const list = useQuery({
    queryKey: ["agent-live-inspector", companyId, agentId, "runs"],
    queryFn: () => heartbeatsApi.list(companyId, agentId, 30),
    refetchInterval: visible ? 5000 : false,
  });
  const runs = list.data ?? [];
  const picked = selectInspectorRun(runs, requestedRunId);
  const detail = useQuery({
    queryKey: ["agent-live-inspector", companyId, agentId, "run", picked?.id],
    queryFn: () => heartbeatsApi.get(picked!.id),
    enabled: Boolean(picked),
    refetchInterval: picked?.status === "running" && visible ? 5000 : false,
  });
  const run = detail.data?.id === picked?.id ? detail.data : picked;
  const engine = useQuery({
    queryKey: ["agent-live-inspector", companyId, agentId, "engine"],
    queryFn: () => agentEngineTelemetryApi.read(agentId),
    enabled: visible,
    refetchInterval: visible ? 12000 : false,
    retry: false,
  });
  const liveInput = useMemo(() => run ? [{
    id: run.id,
    status: run.status,
    adapterType,
    logBytes: run.logBytes,
    lastOutputBytes: run.lastOutputBytes,
    logRef: run.logRef,
    createdAt: run.createdAt,
  }] : [], [run?.id, run?.status, adapterType, run?.logBytes, run?.lastOutputBytes, run?.logRef, run?.createdAt]);
  const transcripts = useLiveRunTranscripts({
    runs: liveInput,
    companyId,
    enabled: Boolean(run),
    maxBytesPerRun: 2_000_000,
  });
  const native = useQuery({
    queryKey: ["agent-live-inspector", companyId, agentId, "reasoning", run?.id],
    queryFn: () => heartbeatsApi.nativeReasoning(run!.id),
    enabled: Boolean(run && run.status !== "queued"),
    refetchInterval: isRunActive(run) && visible ? 10000 : false,
    retry: false,
  });
  const streamEntries = run ? transcripts.transcriptByRun.get(run.id) ?? [] : [];
  const entries = useMemo(() => {
    const nativeParts: TranscriptEntry[] = (native.data?.parts ?? []).map(item => ({
      kind: "thinking", ts: item.ts, text: item.text,
    }));
    if (nativeParts.length === 0) return streamEntries;
    // OpenCode's native SQLite is canonical for reasoning, while its process
    // stream remains canonical for tool events and user-visible messages.
    return [...streamEntries.filter(item => item.kind !== "thinking"), ...nativeParts]
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  }, [streamEntries, native.data?.parts]);

  const filtered = useMemo(() => filterInspectorTranscript(entries, filter), [entries, filter]);
  const usage = run?.usageJson;
  const counters = engine.data;
  const supported = counters?.supported ?? false;
  const terminal = run && !["queued", "running", "scheduled_retry"].includes(run.status);
  const last = run?.lastOutputAt || run?.lastEventAt;
  const isRunning = run?.status === "running" && Boolean(run.startedAt) && !run.finishedAt;

  return <div className="space-y-4" data-testid="agent-live-inspector">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="text-lg font-semibold">Agent live inspector</h3>
        <p className="text-xs text-muted-foreground">
          Read-only · streamed transcript and native engine measurements · no extra model requests
        </p>
      </div>
      <button type="button" className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
        onClick={() => {void list.refetch(); void detail.refetch(); void engine.refetch(); transcripts.retry();}}>
        Refresh
      </button>
    </div>

    <div className="rounded-xl border border-border p-3 space-y-3">
      <label htmlFor="agent-inspector-run" className="block text-xs font-medium text-muted-foreground">Run to inspect</label>
      <select id="agent-inspector-run" className="w-full rounded-lg border border-border bg-background p-2 text-sm"
        value={picked?.id ?? ""} onChange={(event) => setRequestedRunId(event.target.value || null)}>
        {runs.length === 0 && <option value="">No runs available</option>}
        {[...runs].sort((a,b) => Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt))).map(item =>
          <option key={item.id} value={item.id}>
            {item.status.toUpperCase()} · {item.id.slice(0, 8)} · {new Date(item.createdAt).toLocaleString()}
          </option>)}
      </select>
      {list.isError && <p role="alert" className="text-sm text-destructive">Run list unavailable. Access to this agent may be restricted.</p>}
      {requestedRunId && !picked && <p role="alert" className="text-sm text-destructive">The selected run is no longer available for this agent.</p>}
      {run && <>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={isRunning ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground"}>{inspectorRunState(run)}</span>
          <Link to={`/agents/${agentRouteId}/runs/${run.id}`} className="text-xs underline">Full run details</Link>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-sm">
          <Value title="Elapsed" value={elapsed(run.startedAt, run.finishedAt)} />
          <Value title="Input tokens" value={metric(usage?.inputTokens)} />
          <Value title="Output tokens" value={metric(usage?.outputTokens)} />
          <Value title="Last output" value={last ? relativeTime(last) : "Not recorded"} />
          <Value title="Execution health" value={inspectorLivenessLabel(run)} />
        </div>
        {isRunning && (run.outputSilence?.level === "critical" || run.outputSilence?.level === "suspicious") && (
          <p role="alert" className="text-xs text-amber-600 dark:text-amber-400">
            No new Paperclip output for {typeof run.outputSilence.silenceAgeMs === "number"
              ? Math.floor(run.outputSilence.silenceAgeMs / 60000) + " minutes" : "an extended interval"}.
            This is an activity warning, not a terminal run failure. Check the current inference request before deciding whether intervention is necessary.
          </p>
        )}
        {isRunning && <p className="text-xs text-muted-foreground">Elapsed time and token counts are whole-run measurements. They are not model decode tokens/second. Active status alone does not prove active decoding.</p>}
        {terminal && <p className="text-xs text-muted-foreground">This run is no longer executing. Its transcript remains inspectable.</p>}
      </>}
    </div>

    <div className="rounded-xl border border-border p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Inference engine</h4>
        <span className="text-xs text-muted-foreground">{counters?.provider ?? "Engine adapter"} · {counters?.sampledAt ? new Date(counters.sampledAt).toLocaleTimeString() : "No sample"}</span>
      </div>
      {engine.isError ? <p className="text-xs text-muted-foreground">The engine telemetry endpoint is not yet available on this Paperclip deployment.</p>
        : !supported ? <p className="text-xs text-muted-foreground">No registered engine telemetry adapter for this runner yet. Agent transcript and tool monitoring remain available.</p>
        : !counters?.available ? <p role="status" className="text-xs text-muted-foreground">Engine metrics unavailable; existing agent sessions are not interrupted.</p>
        : <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Value title="Active requests" value={metric(counters.active)} />
            <Value title="Engine queue" value={metric(counters.queued)} />
            <Value title="Completed" value={metric(counters.completed)} />
            <Value title="Failures / restarts" value={`${metric(counters.failed)} / ${metric(counters.restarts)}`} />
            <Value title="Avg. first output" value={metricSeconds(counters.firstOutputMeanSeconds)} />
            <Value title="Avg. engine call" value={metricSeconds(counters.engineCallMeanSeconds)} />
            <Value title="Concurrent slots" value={metric(counters.capacity)} />
            <Value title="GPU2 utilization" value={metric(counters.gpuUtilizationPercent, "%")} />
            <Value title="GPU2 VRAM" value={metric(counters.gpuMemoryUsedMiB, " MiB")} />
            <Value title="GPU2 power" value={metric(counters.gpuPowerWatts, " W")} />
          </div>
          <p className="text-xs text-muted-foreground">Averages are across completed engine requests since the server started, not the selected run. Precise prefill/decode throughput is not exposed by this endpoint.</p>
        </>}
    </div>

    <div className="rounded-xl border border-border p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">OpenCode transcript {entries.length > 0 ? `· ${entries.length} events` : ""}</h4>
        <div className="flex items-center gap-2">
          {(["nice","raw"] as const).map(value => <button key={value} type="button" onClick={() => setMode(value)}
            aria-pressed={mode===value}
            className={`rounded-md border px-2 py-1 text-xs ${mode===value ? "bg-accent text-foreground" : "text-muted-foreground"}`}>
            {value === "nice" ? "Formatted" : "Raw"}
          </button>)}
        </div>
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Transcript filter">
        {FILTERS.map(item => <button key={item.id} type="button" onClick={() => setFilter(item.id)}
          aria-pressed={filter === item.id}
          className={`rounded-md border px-3 py-1.5 text-xs ${filter===item.id ? "bg-accent font-semibold" : "text-muted-foreground"}`}>
          {item.label}
        </button>)}
      </div>
      {run?.status === "queued" ? <p className="text-sm text-muted-foreground">Waiting for execution. There is no live model output yet.</p>
        : <>
          {native.isError && <p className="text-xs text-muted-foreground">Native reasoning is not exposed by this deployed backend yet. Tool calls and assistant output remain live.</p>}
          {native.data?.truncated && <p className="text-xs text-muted-foreground">Showing the latest 120 native reasoning messages.</p>}
          {native.data?.parts.some(item => item.truncated) && <p className="text-xs text-muted-foreground">One or more exceptionally long reasoning parts were capped at 40,000 characters.</p>}
          {run && transcripts.errorsByRun.get(run.id) && <p role="alert" className="text-xs text-destructive">Transcript unavailable: {transcripts.errorsByRun.get(run.id)?.message}</p>}
          {run && transcripts.truncatedRunIds.has(run.id) && <p className="text-xs text-muted-foreground">Showing the newest retained transcript window. Earlier output is available in full run history.</p>}
          <div className="max-h-(--sz-65vh) overflow-auto rounded-lg border border-border bg-background/40 p-3">
            <RunTranscriptView entries={filtered} mode={mode} streaming={Boolean(isRunning)}
              density="compact" limit={500} emptyMessage={transcripts.isInitialHydrating ? "Loading transcript…" : "No events in this category."} />
          </div>
          {filtered.length > 500 && <p className="text-xs text-muted-foreground">Displaying the most recent 500 entries. Use full run details for a larger history.</p>}
        </>}
    </div>
  </div>;
}

function isRunActive(run: HeartbeatRun | null | undefined): boolean {
  return run?.status === "running" && Boolean(run.startedAt) && !run.finishedAt;
}
function metricSeconds(value: number | null): string {
  return value === null ? "Unavailable" : `${value.toFixed(value > 10 ? 1 : 2)}s`;
}
function Value({title,value}:{title:string;value:string}) {
  return <div className="min-w-0"><p className="text-xs text-muted-foreground">{title}</p><p className="break-words font-mono text-sm tabular-nums">{value}</p></div>;
}
