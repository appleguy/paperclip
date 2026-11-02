import type { Db } from "@paperclipai/db";
import { environmentLeases, nativeRunFinalizations } from "@paperclipai/db";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";

/** Resolve authority only from the already-claimed server rows, and recheck it before input. */
export async function bindAntigravityHeadlessLease(db: Db, input: {
  companyId: string; runId: string; issueId: string; executionWorkspaceId: string;
  leaseOwner: string; attempt: number; assertControllerActive: () => void;
}): Promise<{ environmentLeaseId: string; generation: number; admit: () => Promise<boolean>; withAdmission: (sourceEventId: string, dispatch: () => void) => Promise<void> }> {
  const environmentConditions = () => and(
    eq(environmentLeases.companyId,input.companyId), eq(environmentLeases.heartbeatRunId,input.runId),
    eq(environmentLeases.issueId,input.issueId), eq(environmentLeases.executionWorkspaceId,input.executionWorkspaceId),
    eq(environmentLeases.status,"active"), or(isNull(environmentLeases.expiresAt),gt(environmentLeases.expiresAt,sql`clock_timestamp()`)),
  );
  const ownerConditions = () => and(
    eq(nativeRunFinalizations.companyId,input.companyId), eq(nativeRunFinalizations.runId,input.runId),
    eq(nativeRunFinalizations.issueId,input.issueId), eq(nativeRunFinalizations.leaseOwner,input.leaseOwner),
    eq(nativeRunFinalizations.attempt,input.attempt), eq(nativeRunFinalizations.phase,"observed"), gt(nativeRunFinalizations.leaseExpiresAt,sql`clock_timestamp()`),
  );
  const leases = await db.select({id:environmentLeases.id}).from(environmentLeases).where(environmentConditions()).limit(2);
  if (leases.length !== 1) throw new Error("antigravity_native_environment_lease_unavailable");
  const owner = await db.select({generation:nativeRunFinalizations.controllerGeneration}).from(nativeRunFinalizations).where(ownerConditions()).limit(1).then(rows=>rows[0]);
  if (!owner || owner.generation < 1) throw new Error("antigravity_native_execution_lease_unavailable");
  const environmentLeaseId=leases[0]!.id, generation=owner.generation;
  const admit = async () => {
    input.assertControllerActive();
    const currentOwner = await db.select({runId:nativeRunFinalizations.runId}).from(nativeRunFinalizations).where(and(ownerConditions(),eq(nativeRunFinalizations.controllerGeneration,generation))).limit(1);
    const currentEnvironment = await db.select({id:environmentLeases.id}).from(environmentLeases).where(and(environmentConditions(),eq(environmentLeases.id,environmentLeaseId))).limit(1);
    return currentOwner.length === 1 && currentEnvironment.length === 1;
  };
  if (!await admit()) throw new Error("antigravity_native_lease_lost");
  const withAdmission = async (_sourceEventId: string, dispatch: () => void) => {
    input.assertControllerActive();
    await db.transaction(async tx => {
      const currentOwner = await tx.select({runId:nativeRunFinalizations.runId}).from(nativeRunFinalizations).where(and(ownerConditions(),eq(nativeRunFinalizations.controllerGeneration,generation))).for("update");
      const currentEnvironment = await tx.select({id:environmentLeases.id}).from(environmentLeases).where(and(environmentConditions(),eq(environmentLeases.id,environmentLeaseId))).for("update");
      if (currentOwner.length !== 1 || currentEnvironment.length !== 1) throw new Error("antigravity_native_lease_lost");
      input.assertControllerActive();
      dispatch();
    });
  };
  return {environmentLeaseId,generation,admit,withAdmission};
}
