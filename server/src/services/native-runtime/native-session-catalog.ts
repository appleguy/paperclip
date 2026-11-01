import { agentTaskSessions, heartbeatRuns, type Db } from "@paperclipai/db";
import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import { canActorReadHeartbeatRun } from "../heartbeat-run-privacy.js";

/** Persisted observations, not a provider liveness or write-authority claim. */
export type CatalogRow = {
  companyId: string; runId: string; agentId: string; issueId: string | null;
  scopeKind: string; runStatus: string; driverKind: string | null;
  normalizedSessionId: string | null; providerSessionBefore: string | null; providerSessionAfter: string | null;
  taskSessionId: string | null; goalStatus: string | null; goalObservedAt: Date | null;
  startedAt: Date | null; finishedAt: Date | null; lastOutputAt: Date | null;
};
export type CatalogState = "working" | "waiting" | "goal-active" | "paused" | "saved" | "disconnected" | "run-terminal" | "unknown";

/** Strong live signals must be supplied by an authorized, exact-run native observer. */
export function projectNativeSession(row: CatalogRow, live: "working" | "waiting" | "disconnected" | null = null) {
  const terminal = ["succeeded", "failed", "cancelled", "timed_out"].includes(row.runStatus);
  const state: CatalogState = terminal ? "run-terminal"
    : live ?? (row.runStatus === "queued" ? "waiting" : row.goalObservedAt && row.goalStatus === "paused" ? "paused"
      : row.goalObservedAt && row.goalStatus === "active" ? "goal-active" : row.runStatus !== "running" && (row.providerSessionAfter || row.providerSessionBefore) ? "saved" : "unknown");
  return {
    source: "paperclip_persisted_run" as const,
    companyId: row.companyId, runId: row.runId, agentId: row.agentId, issueId: row.issueId,
    driverKind: row.driverKind, normalizedSessionId: row.normalizedSessionId,
    providerSessionId: row.providerSessionAfter ?? row.providerSessionBefore,
    providerSessionIdSource: row.providerSessionAfter ? "run.sessionIdAfter" as const : row.providerSessionBefore ? "run.sessionIdBefore" as const : null,
    taskSessionId: row.taskSessionId, runStatus: row.runStatus, state,
    stateEvidence: terminal ? "persisted_terminal_run" as const : live ? "authorized_live_observer" as const
      : state === "waiting" ? "persisted_queue" as const : state === "saved" ? "persisted_session_identity" as const : state === "paused" || state === "goal-active" ? "persisted_goal_observation" as const : "insufficient_evidence" as const,
    goal: row.goalObservedAt && row.goalStatus ? { status: row.goalStatus, observedAt: row.goalObservedAt } : null,
    startedAt: row.startedAt, finishedAt: row.finishedAt, lastOutputAt: row.lastOutputAt,
    capabilities: { nativeLink: null, nativeControl: "unknown" as const, managedSteering: "unknown" as const },
  };
}

/** The caller must perform assertCompanyAccess before invoking this service. Per-run
 * issue/private-project visibility is always checked by the existing privacy service. */
export function nativeSessionCatalog(db: Db, access: Parameters<typeof canActorReadHeartbeatRun>[1]) {
  return {
    async list(input: { companyId: string; actor: Parameters<typeof canActorReadHeartbeatRun>[2]; authorizeCompany: () => void | Promise<void>; limit?: number }) {
      await input.authorizeCompany();
      const limit = Math.max(1, Math.min(100, Number.isSafeInteger(input.limit) ? input.limit! : 50));
      const rows = await db.select({ companyId: heartbeatRuns.companyId, runId: heartbeatRuns.id, agentId: heartbeatRuns.agentId,
        issueId: heartbeatRuns.issueId, scopeKind: heartbeatRuns.scopeKind, runStatus: heartbeatRuns.status,
        driverKind: heartbeatRuns.driverKind, normalizedSessionId: heartbeatRuns.nativeSessionId,
        providerSessionBefore: heartbeatRuns.sessionIdBefore, providerSessionAfter: heartbeatRuns.sessionIdAfter,
        taskSessionId: agentTaskSessions.id, goalStatus: agentTaskSessions.goalStatus, goalObservedAt: agentTaskSessions.goalObservedAt,
        startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt, lastOutputAt: heartbeatRuns.lastOutputAt,
      }).from(heartbeatRuns).leftJoin(agentTaskSessions, and(eq(agentTaskSessions.lastRunId, heartbeatRuns.id),
        eq(agentTaskSessions.companyId, heartbeatRuns.companyId), eq(agentTaskSessions.agentId, heartbeatRuns.agentId)))
        .where(and(eq(heartbeatRuns.companyId, input.companyId), or(isNotNull(heartbeatRuns.nativeSessionId),
          isNotNull(heartbeatRuns.sessionIdBefore), isNotNull(heartbeatRuns.sessionIdAfter), isNotNull(agentTaskSessions.id))))
        .orderBy(desc(heartbeatRuns.createdAt)).limit(limit);
      const visible = [];
      for (const row of rows) {
        if (row.companyId !== input.companyId) continue;
        if (await canActorReadHeartbeatRun(db, access, input.actor, row)) visible.push(projectNativeSession(row));
      }
      return visible;
    },
  };
}
