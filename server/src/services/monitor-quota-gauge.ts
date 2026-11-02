import { agents, heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";

export const MONITOR_HOURLY_WINDOW_MS = 60 * 60_000;

export function monitorQuotaLimits(env: NodeJS.ProcessEnv = process.env) {
  function countLimit(name: string, fallback: number) {
    const value = Number(env[name]);
    return Number.isSafeInteger(value) && value > 0 && value <= 100_000 ? value : fallback;
  }
  return {
    runsPerHour: countLimit("PAPERCLIP_MONITOR_RUNS_PER_AGENT_HOUR", 12),
    commentsPerHour: countLimit("PAPERCLIP_MONITOR_COMMENTS_PER_AGENT_HOUR", 12),
  };
}

export function monitorQuotaExceeded(
  usage: { runs: number; comments: number },
  limits: ReturnType<typeof monitorQuotaLimits>,
): "hourly_run_cap" | "hourly_comment_cap" | null {
  if (usage.runs >= limits.runsPerHour) return "hourly_run_cap";
  if (usage.comments >= limits.commentsPerHour) return "hourly_comment_cap";
  return null;
}

/** DB counters include all adapter runs/comments, while enforcement only pauses automatic issue-monitor wakes. */
export async function agentHourlyUsage(
  db: Db, agentId: string, now = new Date(),
) {
  const since = new Date(now.getTime() - MONITOR_HOURLY_WINDOW_MS);
  const [runs, comments] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.agentId, agentId), gte(heartbeatRuns.createdAt, since),
      lte(heartbeatRuns.createdAt, now),
    )),
    db.select({ n: sql<number>`count(*)::int` }).from(issueComments).where(and(
      eq(issueComments.authorAgentId, agentId), gte(issueComments.createdAt, since),
      lte(issueComments.createdAt, now),
    )),
  ]);
  return { runs: runs[0]?.n ?? 0, comments: comments[0]?.n ?? 0 };
}

export interface MonitorQuotaGauge {
  windowMinutes: number;
  limits: ReturnType<typeof monitorQuotaLimits>;
  agents: Array<{ agentId: string; name: string; adapterType: string; runs: number; comments: number }>;
}

const healthCache = new WeakMap<Db, { expiresAt: number; value: MonitorQuotaGauge }>();

/** Cheap grouped counters, cached for 30 seconds on the full-details health endpoint only. */
export async function readMonitorQuotaGauge(db: Db, now = new Date()): Promise<MonitorQuotaGauge> {
  const cached = healthCache.get(db);
  if (cached && now.getTime() < cached.expiresAt) return cached.value;
  const since = new Date(now.getTime() - MONITOR_HOURLY_WINDOW_MS);
  const [runTotals, commentTotals] = await Promise.all([
    db.select({ id: heartbeatRuns.agentId, n: sql<number>`count(*)::int` })
      .from(heartbeatRuns).where(and(gte(heartbeatRuns.createdAt, since), lte(heartbeatRuns.createdAt, now)))
      .groupBy(heartbeatRuns.agentId),
    db.select({ id: issueComments.authorAgentId, n: sql<number>`count(*)::int` })
      .from(issueComments).where(and(gte(issueComments.createdAt, since), lte(issueComments.createdAt, now)))
      .groupBy(issueComments.authorAgentId),
  ]);
  const runMap = new Map(runTotals.map(x => [x.id, x.n]));
  const commentMap = new Map(commentTotals.filter(x => x.id).map(x => [x.id!, x.n]));
  const ids = [...new Set([...runMap.keys(), ...commentMap.keys()])];
  const rows = ids.length
    ? await db.select({ id: agents.id, name: agents.name, adapterType: agents.adapterType })
      .from(agents).where(inArray(agents.id, ids))
    : [];
  const gauge: MonitorQuotaGauge = {
    windowMinutes: 60, limits: monitorQuotaLimits(),
    agents: rows.map(x => ({
      agentId: x.id, name: x.name, adapterType: x.adapterType,
      runs: runMap.get(x.id) ?? 0, comments: commentMap.get(x.id) ?? 0,
    })).sort((a, b) => b.runs + b.comments - a.runs - a.comments).slice(0, 100),
  };
  healthCache.set(db, { expiresAt: now.getTime() + 30_000, value: gauge });
  return gauge;
}
