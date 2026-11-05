import { and, asc, eq, gt } from "drizzle-orm";
import { issues, issueThreadInteractions, issueWatchdogs, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { IssueRecoveryScope } from "./issue-recovery-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";
import { pendingTaskInteractionCondition } from "./task-watchdogs.js";

type Entry = { id: string; companyId: string; dueAt: number; interactionId?: string };

export function registerTaskWatchdogWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  owner: {
    enabled(): Promise<boolean>;
    reconcile(scope: { companyId: string; watchdogId: string; onDeferredDeadline: (at: number) => void }): Promise<{ incomplete: number }>;
    reconcilePendingInteraction(scope: { companyId: string; interactionId: string }): Promise<{ nextCheckAt: number | null }>;
  },
  canRun: () => boolean,
) {
  const cursors = new Map<string, { watchdog?: string; interaction?: string; watchdogDone?: boolean; interactionDone?: boolean }>();
  let enabled = false;
  return registerScopedDeadlineWork<Entry, IssueRecoveryScope>(coordinator, {
    queue: DELIVERY_QUEUES.taskWatchdogs,
    reconstructionIntervalMs: 30_000,
    beforePass: async () => { enabled = await owner.enabled(); },
    decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint) as IssueRecoveryScope,
    matches: (entry, scope) => !scope || entry.companyId === scope.companyId,
    load: async scope => {
      const key = scope?.companyId ?? "*";
      if (!enabled) { cursors.delete(key); return []; }
      const cursor = cursors.get(key) ?? {};
      const rows = cursor.watchdogDone ? [] : await db.select({ id: issueWatchdogs.id, companyId: issueWatchdogs.companyId })
        .from(issueWatchdogs).where(and(eq(issueWatchdogs.status, "active"),
          scope ? eq(issueWatchdogs.companyId, scope.companyId) : undefined,
          cursor.watchdog ? gt(issueWatchdogs.id, cursor.watchdog) : undefined))
        .orderBy(asc(issueWatchdogs.id)).limit(100);
      const interactions = cursor.interactionDone ? [] : await db
        .select({ id: issueThreadInteractions.id, companyId: issueThreadInteractions.companyId })
        .from(issueThreadInteractions).innerJoin(issues, eq(issues.id, issueThreadInteractions.issueId))
        .where(and(pendingTaskInteractionCondition(scope?.companyId),
          cursor.interaction ? gt(issueThreadInteractions.id, cursor.interaction) : undefined))
        .orderBy(asc(issueThreadInteractions.id)).limit(100);
      cursor.watchdogDone ||= rows.length < 100;
      cursor.interactionDone ||= interactions.length < 100;
      if (rows.length) cursor.watchdog = rows.at(-1)!.id;
      if (interactions.length) cursor.interaction = interactions.at(-1)!.id;
      const complete = Boolean(cursor.watchdogDone && cursor.interactionDone);
      if (complete) cursors.delete(key); else cursors.set(key, cursor);
      return { rows: [
        ...rows.map(row => ({ ...row, dueAt: Date.now() })),
        ...interactions.map(row => ({ ...row, id: `interaction:${row.id}`, interactionId: row.id, dueAt: Date.now() })),
      ], complete };
    },
    check: async entry => {
      if (!enabled) return null;
      if (entry.interactionId) {
        const result = await owner.reconcilePendingInteraction({ companyId: entry.companyId, interactionId: entry.interactionId });
        return result.nextCheckAt === null ? null : { ...entry, dueAt: result.nextCheckAt };
      }
      let next: number | null = null;
      const result = await owner.reconcile({ companyId: entry.companyId, watchdogId: entry.id,
        onDeferredDeadline: at => { next = next === null ? at : Math.min(next, at); } });
      if (result.incomplete > 0) throw new Error(`Task watchdog ${entry.id} in company ${entry.companyId} has an incomplete subtree`);
      return next === null ? null : { ...entry, dueAt: next };
    },
  }, canRun);
}
