import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentInstructionWorkingCopies, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, toolMcpGateways, toolMcpGatewayTokens, toolProfiles, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import * as executionContinuation from "../execution-continuation.js";
import * as instructionCopies from "../agent-instruction-working-copies.js";
import * as environmentOrchestrator from "../environment-run-orchestrator.js";
import * as runtimeExecution from "./runtime-execution.js";
import { logger } from "../../middleware/logger.js";
import { writeHotRestartIntent, writeHotRestartShutdownSnapshot } from "../hot-restart.js";
import { heartbeatService } from "../heartbeat.js";

const adapter = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../adapters/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../adapters/index.js")>(),
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: adapter.execute })),
}));

describe.skipIf(!recoveryPostgresSupport.supported)("OpenCode heartbeat restart failure", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: Db;
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(process.env.PAPERCLIP_TEST_TMPDIR ?? tmpdir(), "opencode-heartbeat-test-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "opencode-heartbeat-test");
    database = await startRecoveryPostgres("opencode-heartbeat-test");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it.each(["outer", "inner", "database_error"] as const)("retains the original run and resources after a synthetic %s exception", async (which) => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const userId = `synthetic-${which}`;
    const oldBoot = randomUUID();
    const earlySession = { sessionId: "synthetic-session", sessionParams: { narBinding: { messageId: "synthetic-original-message" } } };
    const recovery = { kind: "bootstrap", reason: "outcome_unknown", providerWorkStarted: false, providerWorkEvidence: "unverified" };
    await db.insert(authUsers).values({ id: userId, name: "Synthetic", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Synthetic", issuePrefix: `T${companyId.slice(0, 6)}`, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic", role: "engineer", status: "running", adapterType: "opencode_local", adapterConfig: { nativeRuntime: "nar" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic recovery", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: userId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, invocationSource: "assignment", status: "running", runtimeMode: "legacy", controllerBootId: oldBoot, executionStage: "dispatching", contextSnapshot: { issueId }, resultJson: which === "database_error" ? { earlySession } : { earlySession, executionRecovery: recovery } });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issueId));
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: "synthetic", name: "Synthetic" }).returning();
    const [gateway] = await db.insert(toolMcpGateways).values({ companyId, name: "Synthetic", slug: "synthetic", profileId: profile!.id }).returning();
    const [token] = await db.insert(toolMcpGatewayTokens).values({ companyId, gatewayId: gateway!.id, name: "Synthetic", tokenHash: `synthetic-${which}`, subjectType: "heartbeat_run", subjectId: runId }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId, status: "active", provider: "synthetic" }).returning();
    await db.insert(agentInstructionWorkingCopies).values({ runId, companyId, agentId, responsibleUserId: userId, entryFile: "AGENTS.md", baseHash: "synthetic", localRoot: home, executionRoot: home, location: "local", state: "prepared" });
    const workspace = join(home, `synthetic-workspace-${which}`);
    await writeFile(workspace, "original artifact");
    const failSetup = which !== "inner"
      ? vi.spyOn(executionContinuation, "buildExecutionContinuation").mockRejectedValueOnce(new Error("synthetic outer failure"))
      : vi.spyOn(runtimeExecution, "executeHeartbeatRuntime").mockRejectedValueOnce(new Error("synthetic inner failure"));
    const logError = vi.spyOn(logger, "error");
    const releaseEnvironment = vi.fn();
    const makeEnvironment = environmentOrchestrator.environmentRunOrchestrator;
    vi.spyOn(environmentOrchestrator, "environmentRunOrchestrator").mockImplementation((...args) => {
      const service = makeEnvironment(...args);
      const release = service.releaseForRun;
      service.releaseForRun = (...releaseArgs) => { releaseEnvironment(); return release(...releaseArgs); };
      return service;
    });
    const releaseInstructions = vi.fn();
    const makeInstructions = instructionCopies.agentInstructionWorkingCopyService;
    vi.spyOn(instructionCopies, "agentInstructionWorkingCopyService").mockImplementation((...args) => {
      const service = makeInstructions(...args);
      const release = service.release;
      service.release = (...releaseArgs) => { releaseInstructions(); return release(...releaseArgs); };
      return service;
    });
    if (which === "database_error") {
      // This trigger exists only in the disposable test database and rejects
      // precisely the previously absent hold marker, not restart adoption.
      await db.execute(sql`create function reject_synthetic_hold() returns trigger language plpgsql as $$
        begin if new.result_json ? 'executionRecovery' and not coalesce(old.result_json ? 'executionRecovery', false)
          then raise exception 'synthetic hold write failure'; end if; return new; end $$`);
      await db.execute(sql`create trigger reject_synthetic_hold before update on heartbeat_runs
        for each row execute function reject_synthetic_hold()`);
    }
    const intent = await writeHotRestartIntent({ previousServerPid: process.pid, previousServerIdentity: "synthetic-old-server", previousServerVersion: "synthetic", preflightActiveRunIds: [runId] });
    await writeHotRestartShutdownSnapshot({ intent, signal: "SIGTERM", activeRuns: [{ runId, companyId, agentId, issueId, adapterType: "opencode_local", status: "running", runtimeMode: "legacy", processPid: null, processGroupId: null }] });

    const heartbeat = heartbeatService(db);
    const adoption = await heartbeat.reconcileHotRestartAdoption(new Date());
    expect(adoption).toMatchObject({ mode: "reported", adoptedRunIds: [runId], lostRunIds: [], skippedRunIds: [] });
    await heartbeat.drainActiveRunExecutions();

    expect(failSetup).toHaveBeenCalledOnce();
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(releaseEnvironment).not.toHaveBeenCalled();
    expect(releaseInstructions).not.toHaveBeenCalled();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: runId, status: "running", resultJson: { earlySession, restartReattach: { count: 1 }, ...(which === "database_error" ? {} : { executionRecovery: recovery }) } });
    if (which === "database_error") {
      expect(runs[0]!.resultJson).not.toHaveProperty("executionRecovery");
      expect(logError).toHaveBeenCalledWith(expect.anything(), "failed to persist OpenCode heartbeat exception hold");
      await db.execute(sql`drop trigger reject_synthetic_hold on heartbeat_runs`);
      await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'` }).where(eq(heartbeatRuns.id, runId));
      const reaped = await heartbeat.reapOrphanedRuns();
      expect(reaped.runIds).not.toContain(runId);
      const surviving = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(surviving).toHaveLength(1);
      expect(surviving[0]).toMatchObject({ id: runId, status: "running", resultJson: { earlySession, restartReattach: { count: 1 } } });
      expect(surviving[0]!.controllerBootId).not.toBe(runs[0]!.controllerBootId);
      expect(surviving[0]!.resultJson).not.toHaveProperty("executionRecovery");
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toEqual(
        expect.arrayContaining([expect.objectContaining({ cause: "opencode_controller_lost_provider_unverified", evidence: expect.objectContaining({ runId }) })]),
      );
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(releaseEnvironment).not.toHaveBeenCalled();
      expect(releaseInstructions).not.toHaveBeenCalled();
    }
    expect(runs[0]!.controllerBootId).not.toBe(oldBoot);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ checkoutRunId: runId, executionRunId: runId });
    expect((await db.select().from(toolMcpGatewayTokens).where(eq(toolMcpGatewayTokens.id, token!.id)))[0]?.revokedAt).toBeNull();
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease!.id)))[0]).toMatchObject({ status: "active", releasedAt: null });
    expect((await db.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.runId, runId)))[0]).toMatchObject({ state: "prepared", processStoppedAt: null });
    expect(await readFile(workspace, "utf8")).toBe("original artifact");
    vi.restoreAllMocks();
  }, 30_000);
});
