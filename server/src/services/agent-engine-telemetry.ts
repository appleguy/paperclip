/**
 * Read-only engine telemetry providers for agent inspector.
 *
 * The registry is deliberately keyed by an exact, installed model identity;
 * no host, URL, shell command or port is ever supplied by the browser/agent.
 * Adding Qwen Quality means adding a provider here, not forking the UI.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GLM_MODEL = "native-fleet/wrx80/glm-5.3-flash-colibri";
const WRX_TARGET = "wrx80";
const GLM_BASE = "http://127.0.0.1:19126";

export type EngineTelemetry = {
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
};

function numericMetric(raw: string, name: string): number | null {
  const match = raw.match(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+([0-9.eE+-]+)\\s*$`, "m"));
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

export function normalizedGlmMetrics(healthInput: unknown, rawMetrics: string, sampledAt: string): EngineTelemetry {
  const health = healthInput && typeof healthInput === "object" ? healthInput as Record<string, unknown> : {};
  const scheduler = health.scheduler && typeof health.scheduler === "object" ? health.scheduler as Record<string, unknown> : {};
  const n = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
  const mean = (name: string) => {
    const sum = numericMetric(rawMetrics, `colibri_scheduler_${name}_seconds_sum`);
    const count = numericMetric(rawMetrics, `colibri_scheduler_${name}_seconds_count`);
    return sum !== null && count !== null && count > 0 ? sum / count : null;
  };
  return {
    supported: true,
    available: health.status === "ok",
    status: health.status === "ok" ? "ok" : "unavailable",
    provider: "Colibri · WRX80 GPU2",
    sampledAt,
    active: n(scheduler.active),
    queued: n(scheduler.queued),
    capacity: n(scheduler.capacity),
    completed: n(scheduler.completed),
    failed: n(scheduler.failed),
    restarts: n(health.engine_restarts),
    firstOutputMeanSeconds: mean("first_output"),
    engineCallMeanSeconds: mean("engine_call"),
    gpuUtilizationPercent: null, gpuMemoryUsedMiB: null, gpuPowerWatts: null,
  };
}

const providers = [{
  key: "glm-colibri-wrx80",
  matches(model: string) { return model === GLM_MODEL; },
  async sample(sampledAt: string): Promise<EngineTelemetry> {
    // The ssh config alias is host-managed. Strict host validation, bounded reads,
    // and fixed localhost endpoints prevent a browser-controlled SSRF/command path.
    const fetch = async (suffix: "/health" | "/metrics") => {
      const { stdout } = await execFileAsync("ssh", [
        "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=2",
        WRX_TARGET, "curl.exe", "--silent", "--show-error", "--fail",
        "--max-time", "3", `${GLM_BASE}${suffix}`,
      ], { timeout: 6000, maxBuffer: 128 * 1024 });
      return stdout;
    };
    const [health, metrics] = await Promise.all([fetch("/health"), fetch("/metrics")]);
    const normalized = normalizedGlmMetrics(JSON.parse(health), metrics, sampledAt);
    // GPU telemetry is independent of engine health. A missing nvidia-smi
    // sample must not incorrectly mark the running engine as unavailable.
    try {
      const { stdout } = await execFileAsync("ssh", [
        "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", "ConnectTimeout=2", WRX_TARGET, "nvidia-smi", "--id=2",
        "--query-gpu=utilization.gpu,memory.used,power.draw",
        "--format=csv,noheader,nounits",
      ], { timeout: 5000, maxBuffer: 4 * 1024 });
      const [utilization, memory, power] = stdout.trim().split(",").map((value) => Number(value.trim()));
      return {
        ...normalized,
        gpuUtilizationPercent: Number.isFinite(utilization) ? utilization : null,
        gpuMemoryUsedMiB: Number.isFinite(memory) ? memory : null,
        gpuPowerWatts: Number.isFinite(power) ? power : null,
      };
    } catch {
      return normalized;
    }
  },
}];

export async function readAgentEngineTelemetry(model: string): Promise<EngineTelemetry> {
  const sampledAt = new Date().toISOString();
  const provider = providers.find((entry) => entry.matches(model));
  if (!provider) return {
    supported: false, available: false, status: "unsupported", provider: null,
    sampledAt, active: null, queued: null, capacity: null, completed: null,
    failed: null, restarts: null, firstOutputMeanSeconds: null, engineCallMeanSeconds: null,
    gpuUtilizationPercent: null, gpuMemoryUsedMiB: null, gpuPowerWatts: null,
  };
  try {
    return await provider.sample(sampledAt);
  } catch {
    // Do not propagate SSH paths, credentials or host diagnostics into the UI.
    return {
      supported: true, available: false, status: "unavailable", provider: "Colibri · WRX80 GPU2",
      sampledAt, active: null, queued: null, capacity: null, completed: null,
      failed: null, restarts: null, firstOutputMeanSeconds: null, engineCallMeanSeconds: null,
    gpuUtilizationPercent: null, gpuMemoryUsedMiB: null, gpuPowerWatts: null,
    };
  }
}
