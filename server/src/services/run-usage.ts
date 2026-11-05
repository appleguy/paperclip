import { and, desc, eq, gte, lte } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { z } from "zod";
import { resolveCostDateRange, type CostDateRange } from "./cost-date-range.js";

const percent = z.number().finite().min(0).max(100).nullable().optional();
const windowId = z.string().min(1).max(100).nullable().optional();
/** Optional on historical and non-quota receipts. Null means unobserved, not free. */
export const runUsageMetadataSchema = z.object({
  quota_pct_before: percent,
  quota_pct_after: percent,
  window_id: windowId,
  window_id_before: windowId,
  window_id_after: windowId,
  quota_window_rollover: z.boolean().nullable().optional(),
  effort: z.string().min(1).max(100).nullable().optional(),
});

export function runUsageMetadata(value: unknown) {
  const parsed = runUsageMetadataSchema.parse(value ?? {});
  return {
    quota_pct_before: parsed.quota_pct_before ?? null,
    quota_pct_after: parsed.quota_pct_after ?? null,
    window_id: parsed.window_id ?? null,
    window_id_before: parsed.window_id_before ?? null,
    window_id_after: parsed.window_id_after ?? null,
    quota_window_rollover: parsed.quota_window_rollover ?? null,
    effort: parsed.effort ?? null,
  };
}

/** Quota endpoints are account-wide observations and must not be summed like
 * monetary cost events. Return one accepted usage projection per run. */
export async function listRunUsage(db: Db, companyId: string, range?: CostDateRange, limit = 100) {
  range = resolveCostDateRange(range);
  const conditions = [eq(heartbeatRuns.companyId, companyId)];
  if (range?.from) conditions.push(gte(heartbeatRuns.createdAt, range.from));
  if (range?.to) conditions.push(lte(heartbeatRuns.createdAt, range.to));
  const rows = await db.select({ runId: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status,
    startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt, usage: heartbeatRuns.usageJson,
  }).from(heartbeatRuns).where(and(...conditions)).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(limit);
  return rows.map(({ usage, ...run }) => ({ ...run,
    provider: usage?.provider ?? null, biller: usage?.biller ?? null, model: usage?.model ?? null,
    billingType: usage?.billingType ?? null,
    inputTokens: usage?.inputTokens ?? null, cachedInputTokens: usage?.cachedInputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
    costUsd: usage?.costUsd ?? null, costUsdExact: usage?.costUsdExact ?? null, costStatus: usage?.costStatus ?? null,
    ...runUsageMetadata(usage),
  }));
}
