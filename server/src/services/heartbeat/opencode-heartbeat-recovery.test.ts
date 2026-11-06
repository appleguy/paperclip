import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues, toolMcpGateways, toolMcpGatewayTokens, toolProfiles, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import * as executionContinuation from "../execution-continuation.js";
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

  it("retains the original run and resources when re-entry throws before dispatch", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const oldBoot = randomUUID();
    const earlySession = { sessionId: "synthetic-session", sessionParams: { narBinding: { messageId: "synthetic-original-message" } } };
    const recovery = { kind: "bootstrap", reason: "outcome_unknown", providerWorkStarted: false, providerWorkEvidence: "unverified" };
    await db.insert(authUsers).values({ id: "synthetic-user", name: "Synthetic", email: "synthetic@example.test", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Synthetic", issuePrefix: `T${companyId.slice(0, 6)}`, defaultResponsibleUserId: "synthetic-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "synthetic-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic", role: "engineer", status: "running", adapterType: "opencode_local", adapterConfig: { nativeRuntime: "nar" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic recovery", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "synthetic-user" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, invocationSource: "assignment", status: "running", runtimeMode: "legacy", controllerBootId: oldBoot, executionStage: "dispatching", contextSnapshot: { issueId }, resultJson: { earlySession, executionRecovery: recovery } });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issueId));
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: "synthetic", name: "Synthetic" }).returning();
    const [gateway] = await db.insert(toolMcpGateways).values({ companyId, name: "Synthetic", slug: "synthetic", profileId: profile!.id }).returning();
    const [token] = await db.insert(toolMcpGatewayTokens).values({ companyId, gatewayId: gateway!.id, name: "Synthetic", tokenHash: "synthetic-hash", subjectType: "heartbeat_run", subjectId: runId }).returning();
    const workspace = join(home, "synthetic-workspace-file");
    await writeFile(workspace, "original artifact");
    const failSetup = vi.spyOn(executionContinuation, "buildExecutionContinuation").mockRejectedValueOnce(new Error("synthetic re-entry failure"));
    const intent = await writeHotRestartIntent({ previousServerPid: process.pid, previousServerIdentity: "synthetic-old-server", previousServerVersion: "synthetic", preflightActiveRunIds: [runId] });
    await writeHotRestartShutdownSnapshot({ intent, signal: "SIGTERM", activeRuns: [{ runId, companyId, agentId, issueId, adapterType: "opencode_local", status: "running", runtimeMode: "legacy", processPid: null, processGroupId: null }] });

    const heartbeat = heartbeatService(db);
    const adoption = await heartbeat.reconcileHotRestartAdoption(new Date());
    expect(adoption).toMatchObject({ mode: "reported", adoptedRunIds: [runId], lostRunIds: [], skippedRunIds: [] });
    await heartbeat.drainActiveRunExecutions();

    expect(failSetup).toHaveBeenCalledOnce();
    expect(adapter.execute).not.toHaveBeenCalled();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: runId, status: "running", resultJson: { earlySession, executionRecovery: recovery, restartReattach: { count: 1 } } });
    expect(runs[0]!.controllerBootId).not.toBe(oldBoot);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ checkoutRunId: runId, executionRunId: runId });
    expect((await db.select().from(toolMcpGatewayTokens).where(eq(toolMcpGatewayTokens.id, token!.id)))[0]?.revokedAt).toBeNull();
    expect(await readFile(workspace, "utf8")).toBe("original artifact");
  }, 30_000);
});
