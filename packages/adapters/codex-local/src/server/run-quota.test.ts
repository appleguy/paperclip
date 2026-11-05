import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext, AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { codexRunQuota, parseCodexQuotaReading, withCodexRunQuota } from "./run-quota.js";

const window = (usedPercent: unknown = 12.5, resetsAt = 1_800_000_000) => ({ usedPercent, resetsAt, windowDurationMins: 10_080 });
const rpc = (used: unknown = 12.5, reset = 1_800_000_000) => ({ rateLimits: { primary: { usedPercent: 90, windowDurationMins: 300 }, secondary: window(used, reset) } });
const reading = (used = 12.5, reset = 1_800_000_000) => parseCodexQuotaReading(rpc(used, reset));
const meta = { adapterType: "codex_local", command: "codex", cwd: "/workspace", env: { CODEX_HOME: "/selected/account" } };
function context(overrides: Record<string, unknown> = {}): AdapterExecutionContext {
  return { runId: "quota-run", agent: { id: "quota-agent", companyId: "quota-company", name: "Quota fixture", adapterType: "codex_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, context: {},
    config: { engine: "cli", modelReasoningEffort: "xhigh", env: { OPENAI_API_KEY: "", CODEX_API_KEY: "" } },
    onLog: async () => {}, ...overrides } as AdapterExecutionContext;
}
const success = { exitCode: 0, signal: null, timedOut: false, usage: { inputTokens: 80, cachedInputTokens: 20, outputTokens: 10 } };

describe("Codex run quota parsing", () => {
  it("uses the weekly pool regardless of primary/secondary placement, preserving percentage points", () => {
    expect(parseCodexQuotaReading(rpc())).toEqual({ used_pct: 12.5, resets_at: 1_800_000_000, window_minutes: 10_080 });
    expect(parseCodexQuotaReading({ primary: { used_percent: 0.25, window_minutes: 10_080, resets_at: 1_800_000_000 } })?.used_pct).toBe(0.25);
  });
  it("selects the account codex pool instead of a model-specific limit", () => {
    expect(parseCodexQuotaReading({ rateLimits: { limitId: "review", secondary: window(90) }, rateLimitsByLimitId: { codex: { secondary: window(14) } } })?.used_pct).toBe(14);
    expect(parseCodexQuotaReading({ rateLimits: { limitId: "review", secondary: window() } })).toBeNull();
  });
  it.each([undefined, null, {}, { primary: { used_percent: 0, window_minutes: 300 } }])("keeps a missing weekly reading null: %j", value => {
    expect(parseCodexQuotaReading(value)).toBeNull();
    expect(codexRunQuota(null, null, null)).toMatchObject({ quota_pct_before: null, quota_pct_after: null, window_id: null });
  });
  it.each([null, "12", -1, 101, Number.NaN, Number.POSITIVE_INFINITY])("does not coerce invalid or absent percentages to zero: %j", value => {
    expect(parseCodexQuotaReading(rpc(value))?.used_pct).toBeNull();
  });
  it("retains an observed zero", () => { expect(reading(0)?.used_pct).toBe(0); });
  it("keeps both reset IDs and invalidates the shared window on rollover", () => {
    expect(codexRunQuota(reading(99), reading(1, 1_800_604_800), "xhigh")).toEqual({
      quota_pct_before: 99, quota_pct_after: 1, window_id: null, window_id_before: "1800000000", window_id_after: "1800604800", quota_window_rollover: true, effort: "xhigh",
    });
  });
  it("matches qcost's 120-second reset jitter tolerance without inventing a rollover", () => {
    expect(codexRunQuota(reading(), reading(14, 1_800_000_003), "high")).toMatchObject({ window_id: "1800000000", quota_window_rollover: false });
    expect(codexRunQuota(null, reading(), null).quota_window_rollover).toBeNull();
  });
});

describe("Codex run quota lifecycle", () => {
  it("brackets all attempts once, uses the selected home, and decorates streaming and final usage", async () => {
    const receipts: AdapterUsageCheckpoint[] = [], order: string[] = [];
    const read = vi.fn(async options => { order.push("read"); expect(options.env.CODEX_HOME).toBe("/selected/account"); return rpc(order.length === 1 ? 12.5 : 14); });
    const result = await withCodexRunQuota(context({ onUsage: async (receipt: AdapterUsageCheckpoint) => { receipts.push(receipt); } }), async ctx => {
      await ctx.onMeta!(meta); order.push("turn");
      await ctx.onUsage!({ usage: success.usage, complete: true });
      await ctx.onMeta!(meta); // a retry does not reset the run's opening observation
      return success;
    }, read);
    expect(order).toEqual(["read", "turn", "read"]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(receipts[0]).toMatchObject({ quota_pct_before: 12.5, quota_pct_after: null, effort: "xhigh", usage: success.usage });
    expect(result).toMatchObject({ quota_pct_before: 12.5, quota_pct_after: 14, effort: "xhigh", usage: success.usage });
  });
  it("keeps missing/failed probes null and preserves the execution result", async () => {
    const read = vi.fn().mockRejectedValue(new Error("quota unavailable"));
    const result = await withCodexRunQuota(context(), async ctx => { await ctx.onMeta!(meta); return success; }, read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ...success, quota_pct_before: null, quota_pct_after: null, effort: "xhigh" });
  });
  it("records effort even if startup fails before invocation metadata", async () => {
    let reads = 0;
    const read = async () => { reads++; return null; };
    expect(await withCodexRunQuota(context({ config: { reasoningEffort: " high " } }), async () => success, read)).toMatchObject({ effort: "high", quota_pct_before: null });
    expect(reads).toBe(0);
  });
  it("never probes the host account for remote or API-key executions", async () => {
    let reads = 0;
    const read = async () => { reads++; return null; };
    await withCodexRunQuota(context({ config: { env: { OPENAI_API_KEY: "fixture-key" } } }), async ctx => { await ctx.onMeta!(meta); return success; }, read);
    await withCodexRunQuota(context({ executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace" } }), async ctx => { await ctx.onMeta!(meta); return success; }, read);
    await withCodexRunQuota(context({ config: { managedAiConnection: { provider: "openai", method: "api_key" } } }), async ctx => { await ctx.onMeta!(meta); return success; }, read);
    await withCodexRunQuota(context(), async ctx => { await ctx.onMeta!({ ...meta, env: { ...meta.env, OPENAI_API_KEY: "[REDACTED]" } }); return success; }, read);
    expect(reads).toBe(0);
  });
  it.each(["cli", " CLI "])("records the ACP effort alias and uses the resolved CLI executable: %s", async engine => {
    const read = vi.fn().mockResolvedValue(rpc());
    const result = await withCodexRunQuota(context({ config: { engine, modelReasoningEffort: "", effort: " high ", env: { OPENAI_API_KEY: "", CODEX_API_KEY: "" } } }), async ctx => {
      await ctx.onMeta!({ ...meta, command: "/resolved/codex" }); return success;
    }, read);
    expect(result.effort).toBe("high");
    expect(read.mock.calls[0][0].command).toBe("/resolved/codex");
  });
  it("reads closing quota after an execution failure without certifying new token totals", async () => {
    const receipts: AdapterUsageCheckpoint[] = [], read = vi.fn().mockResolvedValue(rpc());
    await expect(withCodexRunQuota(context({ onUsage: async (receipt: AdapterUsageCheckpoint) => { receipts.push(receipt); } }), async ctx => {
      await ctx.onMeta!(meta); await ctx.onUsage!({ usage: success.usage, complete: false }); throw new Error("provider failed");
    }, read)).rejects.toThrow("provider failed");
    expect(read).toHaveBeenCalledTimes(2);
    expect(receipts.at(-1)).toMatchObject({ quota_pct_after: 12.5, complete: false, usage: success.usage });
  });
  it("preserves the original failure if the closing metadata capture also fails", async () => {
    const failure = new Error("original capture failure");
    const onUsage = vi.fn().mockRejectedValueOnce(failure).mockRejectedValueOnce(new Error("closing capture failure"));
    const read = vi.fn().mockResolvedValue(rpc());
    await expect(withCodexRunQuota(context({ onUsage }), async ctx => {
      await ctx.onMeta!(meta);
      await ctx.onUsage!({ usage: success.usage, complete: false });
      return success;
    }, read)).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("Codex quota RPC fixture", () => {
  it("brackets a run through real subprocess RPC using only the selected home", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-run-quota-"));
    const command = path.join(directory, "codex-fixture.mjs");
    const limits = path.join(directory, "limits.json");
    try {
      // A local JSON-RPC peer exercises actual stdio, initialization, executable
      // selection and shutdown. It has no credentials or network access.
      await fs.writeFile(command, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  const result = request.method === "account/rateLimits/read"
    ? JSON.parse(readFileSync(join(process.env.CODEX_HOME, "limits.json"), "utf8")) : {};
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`, { mode: 0o700 });
      await fs.writeFile(limits, JSON.stringify(rpc(12.5)));
      const result = await withCodexRunQuota(context(), async ctx => {
        await ctx.onMeta!({ ...meta, command, cwd: directory, env: { CODEX_HOME: directory } });
        await fs.writeFile(limits, JSON.stringify(rpc(14, 1_800_000_003)));
        return success;
      });
      expect(result).toEqual({ ...success, quota_pct_before: 12.5, quota_pct_after: 14,
        window_id: "1800000000", window_id_before: "1800000000", window_id_after: "1800000003",
        quota_window_rollover: false, effort: "xhigh" });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
