import { api } from "./client";

/** Common engine sample, independent of whether the provider is Colibri, MLX, or another runner. */
export interface EngineTelemetry {
  supported: boolean;
  available: boolean;
  provider: string | null;
  sampledAt: string;
  status: "ok" | "unavailable" | "unsupported";
  active: number | null;
  queued: number | null;
  capacity: number | null;
  completed: number | null;
  failed: number | null;
  restarts: number | null;
  firstOutputMeanSeconds: number | null;
  engineCallMeanSeconds: number | null;
  gpuUtilizationPercent: number | null;
  gpuMemoryUsedMiB: number | null;
  gpuPowerWatts: number | null;
}

export const agentEngineTelemetryApi = {
  read: (agentId: string) => api.get<EngineTelemetry>(`/agents/${encodeURIComponent(agentId)}/engine-telemetry`),
};
