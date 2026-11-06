import { heartbeatRuns, type Db } from "@paperclipai/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { legacyControllerBootId } from "../legacy-controller-lease.js";
import { preserveWorkspaceRestoreRecoveryMetadataSql } from "../legacy-workspace-restore-recovery.js";

/** Claim only the scanned owner; merge only the new restart metadata into the
 * current row so a concurrent checkpoint or Stop cannot be overwritten. */
export async function claimLegacyRestartController(
  db: Db,
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "controllerBootId">,
  restart: { count: number; previousServerPid: number; newServerPid: number; at: Date },
) {
  const [claimed] = await db.update(heartbeatRuns).set({
    controllerBootId: legacyControllerBootId,
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    executionStage: "preparing",
    resultJson: preserveWorkspaceRestoreRecoveryMetadataSql({
      restartReattach: {
        count: restart.count,
        at: restart.at.toISOString(),
        previousServerPid: restart.previousServerPid,
        newServerPid: restart.newServerPid,
      },
    }, true),
    updatedAt: restart.at,
  }).where(and(
    eq(heartbeatRuns.id, run.id),
    eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.runtimeMode, "legacy"),
    run.controllerBootId === null
      ? isNull(heartbeatRuns.controllerBootId)
      : eq(heartbeatRuns.controllerBootId, run.controllerBootId),
  )).returning();
  return claimed ?? null;
}
