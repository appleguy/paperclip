import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

/** Preserve the run until the provider turn is reconciled, even when the
 * local shared CLI exited. Returning true also holds on a lost row CAS. */
export function isUnverifiedSharedOpenCode(input: {
  run: typeof heartbeatRuns.$inferSelect;
  adapterType: string;
  resultJson: Record<string, unknown> | null | undefined;
}): boolean {
  const recovery = input.resultJson?.executionRecovery;
  if (input.run.runtimeMode !== "legacy" || input.adapterType !== "opencode_local" ||
      !recovery || typeof recovery !== "object" || Array.isArray(recovery) ||
      !["shared_session_unverified", "stop_before_dispatch_unverified"].some(reason => reason === (recovery as Record<string, unknown>).reason) ||
      (recovery as Record<string, unknown>).providerWorkStarted !== true) return false;
  return true;
}

export async function persistUnverifiedSharedOpenCode(db: Db, input: {
  run: typeof heartbeatRuns.$inferSelect;
  resultJson: Record<string, unknown> | null | undefined;
}): Promise<void> {
  const recovery = input.resultJson?.executionRecovery;
  await db.update(heartbeatRuns).set({
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ executionRecovery: recovery })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(eq(heartbeatRuns.id, input.run.id), eq(heartbeatRuns.companyId, input.run.companyId),
    eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "running"),
    input.run.controllerBootId
      ? sql`${heartbeatRuns.controllerBootId} = ${input.run.controllerBootId} and ${heartbeatRuns.controllerLeaseExpiresAt} > clock_timestamp()`
      : sql`false`));
}
