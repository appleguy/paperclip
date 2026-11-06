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

/** A heartbeat failure cannot settle earlier work on the strength of local setup alone. */
export async function openCodeHeartbeatFailureHold(input: {
  run: typeof heartbeatRuns.$inferSelect;
  readRun: (runId: string) => Promise<typeof heartbeatRuns.$inferSelect | null | undefined>;
}): Promise<Record<string, unknown> | null> {
  const adapterType = "opencode_local";
  if (input.run.runtimeMode !== "legacy") return null;
  const latest = await input.readRun(input.run.id).catch(() => null);
  let recoveryRun = input.run;
  if (latest && isUnverifiedSharedOpenCode({ run: latest, adapterType, resultJson: latest.resultJson })) recoveryRun = latest;
  else if (!isUnverifiedSharedOpenCode({ run: input.run, adapterType, resultJson: input.run.resultJson }) &&
      latest && hasOpenCodeRecoveryHistory({ run: latest, adapterType })) recoveryRun = latest;
  const historyUncertain = !latest || latest.runtimeMode !== "legacy" || latest.status !== "running" ||
    latest.controllerBootId !== input.run.controllerBootId ||
    (!!input.run.controllerBootId && (!latest.controllerLeaseExpiresAt || latest.controllerLeaseExpiresAt.getTime() <= Date.now()));
  if (!historyUncertain && !hasOpenCodeRecoveryHistory({ run: recoveryRun, adapterType })) return null;
  const executionRecovery = isUnverifiedSharedOpenCode({ run: recoveryRun, adapterType, resultJson: recoveryRun.resultJson })
    ? recoveryRun.resultJson!.executionRecovery
    : { kind: "bootstrap", reason: "heartbeat_exception_unverified", providerWorkStarted: true, providerWorkEvidence: "unverified" };
  return { executionRecovery };
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
