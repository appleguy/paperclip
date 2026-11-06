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

/** Prior re-entry evidence prevents a local setup failure from proving no work exists. */
export function hasOpenCodeRecoveryHistory(input: {
  run: typeof heartbeatRuns.$inferSelect;
  adapterType: string;
}): boolean {
  if (input.run.runtimeMode !== "legacy" || input.adapterType !== "opencode_local") return false;
  const result = input.run.resultJson;
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  if (Object.hasOwn(result, "restartReattach") ||
      isUnverifiedSharedOpenCode({ ...input, resultJson: result })) return true;
  const session = result.earlySession;
  if (!session || typeof session !== "object" || Array.isArray(session)) return false;
  const params = (session as Record<string, unknown>).sessionParams;
  return !!params && typeof params === "object" && !Array.isArray(params) && Object.hasOwn(params, "narBinding");
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
