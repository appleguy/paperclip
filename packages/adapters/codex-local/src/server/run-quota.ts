import type { AdapterExecutionContext, AdapterExecutionResult, AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { readAdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { fetchCodexRateLimits, type CodexQuotaProbeOptions } from "./quota.js";

const WEEK_MINUTES = 10_080;
// qcost v0 groups server reset-time jitter into the same epoch.
const RESET_JITTER_SECONDS = 120;

export interface CodexQuotaReading {
  used_pct: number | null;
  resets_at: number | null;
  window_minutes: number;
}

export interface CodexRunQuota {
  quota_pct_before: number | null;
  quota_pct_after: number | null;
  window_id: string | null;
  window_id_before: string | null;
  window_id_after: string | null;
  quota_window_rollover: boolean | null;
  effort: string | null;
}

/** Accept both account/rateLimits/read and rollout token_count.rate_limits.
 * Never confuse a five-hour or model-specific meter with qcost's weekly pool. */
export function parseCodexQuotaReading(value: unknown): CodexQuotaReading | null {
  const result = parseObject(value);
  const byId = parseObject(result.rateLimitsByLimitId);
  const root = parseObject(result.rateLimits ?? result.rate_limits ?? value);
  const limit = parseObject(byId.codex ?? root);
  const limitId = limit.limitId ?? limit.limit_id;
  if (limitId != null && limitId !== "codex") return null;
  for (const candidate of [limit.primary, limit.secondary]) {
    const window = parseObject(candidate);
    const duration = window.windowDurationMins ?? window.window_minutes;
    if (duration !== WEEK_MINUTES) continue;
    const used = window.usedPercent ?? window.used_percent;
    const reset = window.resetsAt ?? window.resets_at;
    return {
      used_pct: typeof used === "number" && Number.isFinite(used) && used >= 0 && used <= 100 ? used : null,
      resets_at: typeof reset === "number" && Number.isSafeInteger(reset) && reset > 0 ? reset : null,
      window_minutes: WEEK_MINUTES,
    };
  }
  return null;
}

export function codexRunQuota(before: CodexQuotaReading | null, after: CodexQuotaReading | null, effort: string | null): CodexRunQuota {
  const start = before?.resets_at ?? null, end = after?.resets_at ?? null;
  const rollover = start !== null && end !== null ? Math.abs(start - end) > RESET_JITTER_SECONDS : null;
  return {
    quota_pct_before: before?.used_pct ?? null,
    quota_pct_after: after?.used_pct ?? null,
    // A cross-window subtraction is invalid. Preserve both endpoints instead
    // of manufacturing a negative (or clamped-zero) quota cost.
    window_id: rollover ? null : start !== null ? String(start) : end !== null ? String(end) : null,
    window_id_before: start === null ? null : String(start),
    window_id_after: end === null ? null : String(end),
    quota_window_rollover: rollover,
    effort,
  };
}

/** One pair of bounded account reads per invocation, quiet while the run is
 * active. Invocation metadata supplies the already-prepared credential home;
 * only its path is consumed, never redacted credentials or the host's account.
 * Remote execution cannot probe a host login on behalf of the remote user. */
export async function withCodexRunQuota(
  ctx: AdapterExecutionContext,
  execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>,
  readLimits: (options: CodexQuotaProbeOptions) => Promise<unknown> = fetchCodexRateLimits,
): Promise<AdapterExecutionResult & CodexRunQuota> {
  const effort = [ctx.config.modelReasoningEffort, ctx.config.reasoningEffort, ctx.config.thinkingEffort, ctx.config.effort]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
  const target = readAdapterExecutionTarget({ executionTarget: ctx.executionTarget, legacyRemoteExecution: ctx.executionTransport?.remoteExecution });
  const envConfig = parseObject(ctx.config.env);
  const configuredEnv = Object.fromEntries(Object.entries(envConfig).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const env = { ...process.env, ...configuredEnv };
  const managedApiKey = parseObject(ctx.config.managedAiConnection).method === "api_key";
  const cliEngine = typeof ctx.config.engine === "string" && ctx.config.engine.trim().toLowerCase() === "cli";
  let options: CodexQuotaProbeOptions | null = null;
  let started = false;
  let before: CodexQuotaReading | null = null, after: CodexQuotaReading | null = null;
  const last: { receipt: AdapterUsageCheckpoint | null } = { receipt: null };
  const read = async () => {
    if (!options) return null;
    try { return parseCodexQuotaReading(await readLimits(options)); }
    catch { return null; } // Missing quota evidence never changes token accounting or execution.
  };
  const quota = () => codexRunQuota(before, after, effort);
  try {
    const result = await execute({
      ...ctx,
      onMeta: async meta => {
        if (!started) {
          started = true;
          const home = meta.env?.CODEX_HOME;
          if (target?.kind !== "remote" && home && !home.includes("[REDACTED]") && !managedApiKey
            && !env.OPENAI_API_KEY && !env.CODEX_API_KEY && !meta.env?.OPENAI_API_KEY && !meta.env?.CODEX_API_KEY) {
            options = { command: cliEngine ? meta.command : "codex",
              env: { ...env, CODEX_HOME: home }, cwd: meta.cwd, timeoutMs: 1_500 };
            before = await read();
          }
        }
        await ctx.onMeta?.(meta);
      },
      onUsage: ctx.onUsage ? async receipt => {
        last.receipt = receipt;
        await ctx.onUsage!({ ...receipt, ...quota() });
      } : undefined,
    });
    after = await read();
    return { ...result, ...quota() };
  } catch (error) {
    after = await read();
    // Preserve post-failure quota alongside an already-observed token receipt.
    // Do not invent a complete/zero token receipt when execution threw early.
    if (last.receipt) {
      try { await ctx.onUsage?.({ ...last.receipt, ...quota() }); }
      catch { /* Preserve the original execution/capture failure. */ }
    }
    throw error;
  }
}
