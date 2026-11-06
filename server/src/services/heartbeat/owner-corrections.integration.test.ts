import { agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { createHeartbeatQueueTestDependencies } from "../../__tests__/helpers/heartbeat-queue.js";
import { createHeartbeatQueue } from "./queue.js";
import { prepareHeartbeatTaskContext } from "./task-context.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_OWNER_CORRECTION_INTEGRATION_TEST_DATABASE_URL");
const support = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("owner corrections through heartbeat entry points", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-owner-correction-entry");
    db = createDb(external ?? database!.connectionString, { maxConnections: 4 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(async () => { await db.execute(sql`truncate table companies restart identity cascade`); });

  it("registers without a provider run and refreshes all task-context variants on resume", async () => {
    const [company] = await db.insert(companies).values({ name: "Correction entry", issuePrefix: "CE" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", status: "idle", adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Host task", description: "Inspect the assigned host data and report the result.", assigneeAgentId: agent.id, status: "in_progress" }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorUserId: "owner", authorType: "user", body: "Use native host tools for this task." }).returning();
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockResolvedValue(agent);
    const queue = createHeartbeatQueue(db, deps);
    expect(await queue.trackWakeup(agent.id, { reason: "owner_correction", manualUserWake: true,
      requestedByActorType: "user", requestedByActorId: "owner", payload: { issueId: issue.id, ownerCorrection: { commentId: comment.id } } })).toBeNull();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(deps.executeRun).not.toHaveBeenCalled();
    expect(deps.budgets.getInvocationBlock).not.toHaveBeenCalled();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, scopeKind: "issue", issueId: issue.id, status: "running" }).returning();
    const context: Record<string, unknown> = { issueId: issue.id, ownerCorrectionIds: ["forged"] };
    const input: Parameters<typeof prepareHeartbeatTaskContext>[1] = {
      run, agent, task: { issueRef: issue, issueContext: null, context, taskSession: null },
      policy: { trustPreset: { kind: "standard" }, experimentalInstanceSettings: {} },
      services: { issuesSvc: { getAncestors: vi.fn().mockResolvedValue([]) }, getPinnedSkillTestContext: vi.fn() },
    };
    await prepareHeartbeatTaskContext(db, input);
    for (const field of ["paperclipTaskMarkdown", "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownCompact", "paperclipTaskMarkdownAssignmentCompact"])
      expect(context[field]).toContain(comment.body);
    expect(context.ownerCorrectionIds).toEqual([comment.id]);
    // A new distinct correction must also reach a reused provider session.
    const [next] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorUserId: "owner", body: "Keep the existing output format." }).returning();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    await queue.trackWakeup(agent.id, { reason: "owner_correction", manualUserWake: true,
      requestedByActorType: "user", requestedByActorId: "owner", payload: { issueId: issue.id, ownerCorrection: { commentId: next.id } } });
    await prepareHeartbeatTaskContext(db, { ...input, task: { ...input.task, taskSession: { lastRunId: run.id } } });
    expect(context.paperclipTaskMarkdownAssignmentCompact).toContain(next.body);
    expect(context.ownerCorrectionIds).toEqual([comment.id, next.id]);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(2);
  });

  it("returns an actionable persisted failure from the real unsupported/unattached steering boundary", async () => {
    const [company] = await db.insert(companies).values({ name: "Unattached entry", issuePrefix: "UE" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", status: "running", adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Running task", assigneeAgentId: agent.id }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorUserId: "owner", body: "Use direct mode." }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, status: "running" }).returning();
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockResolvedValue(agent);
    await expect(createHeartbeatQueue(db, deps).trackWakeup(agent.id, { reason: "owner_correction", manualUserWake: true,
      requestedByActorType: "user", requestedByActorId: "owner", payload: { issueId: issue.id, ownerCorrection: { commentId: comment.id } } }))
      .rejects.toMatchObject({ status: 409, details: { code: "owner_correction_delivery_incomplete", deliveries: {
        [run.id]: { status: "failed", code: "steering_temporarily_unavailable", nextAction: expect.any(String) },
      } } });
    expect(deps.executeRun).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  });
});
