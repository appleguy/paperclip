import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

/** Identify a result that must not authorize resource cleanup. */
export function isUnverifiedSharedOpenCode(input: {
  run: typeof heartbeatRuns.$inferSelect;
  adapterType: string;
  resultJson: Record<string, unknown> | null | undefined;
}): boolean {
  const recovery = input.resultJson?.executionRecovery;
  if (input.run.runtimeMode !== "legacy" || input.adapterType !== "opencode_local" ||
      !recovery || typeof recovery !== "object" || Array.isArray(recovery)) return false;
  const evidence = recovery as Record<string, unknown>;
  return evidence.kind === "bootstrap" && (evidence.providerWorkEvidence === "unverified" ||
    (evidence.providerWorkStarted === true && ["shared_session_unverified", "stop_before_dispatch_unverified"].includes(String(evidence.reason))));
}

export async function persistUnverifiedSharedOpenCode(db: Db, input: {
  run: typeof heartbeatRuns.$inferSelect;
  resultJson: Record<string, unknown> | null | undefined;
}): Promise<boolean> {
  const recovery = input.resultJson?.executionRecovery;
  const updated = await db.update(heartbeatRuns).set({
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ executionRecovery: recovery })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(eq(heartbeatRuns.id, input.run.id), eq(heartbeatRuns.companyId, input.run.companyId),
    eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "running"),
    input.run.controllerBootId
      ? sql`${heartbeatRuns.controllerBootId} = ${input.run.controllerBootId} and ${heartbeatRuns.controllerLeaseExpiresAt} > clock_timestamp()`
      : sql`false`)).returning({ id: heartbeatRuns.id });
  return updated.length === 1;
}
