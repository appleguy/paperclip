import { randomUUID } from "node:crypto";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies } from "../../__tests__/helpers/heartbeat-queue.js";
import { createHeartbeatQueue } from "./queue.js";
import { decideQueuedReceipt, reconcileQueuedReceipt } from "./queued-reconciliation.js";
import { decorateHeartbeatRunRuntimeStatus } from "./run-lifecycle.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("queued run reconciliation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("queued-reconciliation-");
    db = createDb(database.connectionString);
    db.$client.options.onnotice = () => {};
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Queue recovery", issuePrefix: `Q${randomUUID().slice(0, 7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Ready seat", role: "engineer", status: "idle",
      adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Saved owner work", status: "todo", assigneeAgentId: agent.id }).returning();
    const [receipt] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "assignment", status: "queued" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "queued", wakeupRequestId: receipt.id,
      invocationSource: "assignment", responsibleUserId: "queue-user", contextSnapshot: { issueId: issue.id },
      createdAt: new Date(Date.now() - 24 * 60 * 60_000) }).returning();
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, receipt.id));
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockResolvedValue(agent);
    return { company, agent, issue, receipt: { ...receipt, runId: run.id }, run, deps, queue: createHeartbeatQueue(db, deps) };
  }
  async function read(id: string) { return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]; }

  it("starts an old legitimate wake after restart without treating age as invalidation", async () => {
    const f = await fixture();
    await f.queue.resumeQueuedRunsAfterDrain();
    expect(await read(f.run.id)).toMatchObject({ status: "running" });
    expect(f.deps.executeRun).toHaveBeenCalledExactlyOnceWith(f.run.id);
    await f.queue.resumeQueuedRunsAfterDrain();
    expect(f.deps.executeRun).toHaveBeenCalledTimes(1);
  });
  it("retains a capacity-blocked control and dispatches its exact wake when capacity releases", async () => {
    const f = await fixture();
    const [active] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "running" }).returning();
    await f.queue.resumeQueuedRunsAfterDrain();
    const queued = await read(f.run.id);
    expect(queued).toMatchObject({ status: "queued", wakeupRequestId: f.receipt.id, nextAction: expect.stringContaining("capacity blocked (1/1") });
    expect(decorateHeartbeatRunRuntimeStatus(queued).queuedAgeMs).toBeGreaterThanOrEqual(24 * 60 * 60_000);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, active.id));
    await f.queue.resumeQueuedRunsAfterDrain();
    expect(f.deps.executeRun).toHaveBeenCalledExactlyOnceWith(f.run.id);
    const started = await read(f.run.id);
    expect(started.nextAction).toBeNull();
    expect(decorateHeartbeatRunRuntimeStatus(started).queuedAgeMs).toBeNull();
  });
  it("holds an orphan receipt across repeated restart passes without inventing a replacement wake", async () => {
    const f = await fixture();
    // The run FK preserves its receipt, but the receipt's execution pointer
    // may be orphaned after partial historical recovery.
    await db.update(agentWakeupRequests).set({ runId: randomUUID() }).where(eq(agentWakeupRequests.id, f.receipt.id));
    expect(decideQueuedReceipt(f.run, null, null).kind).toBe("held");
    for (let pass = 0; pass < 3; pass++) await f.queue.resumeQueuedRunsAfterDrain();
    expect(await read(f.run.id)).toMatchObject({ status: "queued", nextAction: expect.stringContaining("receipt reconciliation") });
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });
  it.each(["running", "succeeded"])("retires only an exact receipt shadow already owned by a %s execution", async status => {
    const f = await fixture();
    const [target] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status,
      wakeupRequestId: f.receipt.id, responsibleUserId: f.run.responsibleUserId, contextSnapshot: f.run.contextSnapshot, startedAt: new Date(),
      finishedAt: status === "succeeded" ? new Date() : null }).returning();
    await db.update(agentWakeupRequests).set({ status: status === "succeeded" ? "completed" : "claimed", runId: target.id })
      .where(eq(agentWakeupRequests.id, f.receipt.id));
    await f.queue.resumeQueuedRunsAfterDrain();
    expect(await read(f.run.id)).toMatchObject({ status: "cancelled", errorCode: "queued_wake_superseded" });
    expect(await read(target.id)).toEqual(target);
    expect((await db.select().from(agentWakeupRequests))[0]).toMatchObject({ runId: target.id, status: status === "succeeded" ? "completed" : "claimed" });
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });
  it("never discards distinct owner input because a duplicate receipt points elsewhere", async () => {
    const f = await fixture();
    const [target] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "succeeded",
      wakeupRequestId: f.receipt.id, responsibleUserId: f.run.responsibleUserId, contextSnapshot: { issueId: f.issue.id, wakeCommentIds: ["owner-a"] } }).returning();
    const input = { ...f.run, contextSnapshot: { issueId: f.issue.id, wakeCommentIds: ["owner-a", "owner-b"] } };
    expect(decideQueuedReceipt(input, { ...f.receipt, runId: target.id, status: "coalesced" }, target).kind).toBe("held");
    expect(decideQueuedReceipt({ ...f.run, contextSnapshot: { ...input.contextSnapshot, commentId: "owner-c" } },
      { ...f.receipt, runId: target.id, status: "coalesced" }, target).kind).toBe("held");
    expect(decideQueuedReceipt({ ...f.run, contextSnapshot: { issueId: f.issue.id, interactionResponse: "new answer" } },
      { ...f.receipt, runId: target.id }, target).kind).toBe("held");
    expect(decideQueuedReceipt({ ...f.run, startedAt: new Date() }, { ...f.receipt, runId: target.id }, target).kind).toBe("held");
    expect(decideQueuedReceipt(f.run, { ...f.receipt, runId: target.id }, { ...target, responsibleUserId: "different-owner" }).kind).toBe("held");
  });
  it("coalesces a shadow only when the destination covers every queued owner comment", async () => {
    const f = await fixture();
    const [target] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "running",
      responsibleUserId: f.run.responsibleUserId, contextSnapshot: { issueId: f.issue.id, wakeCommentIds: ["owner-a", "owner-b"] } }).returning();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issue.id, wakeCommentIds: ["owner-a"] } })
      .where(eq(heartbeatRuns.id, f.run.id));
    await db.update(agentWakeupRequests).set({ status: "coalesced", runId: target.id }).where(eq(agentWakeupRequests.id, f.receipt.id));
    await f.queue.resumeQueuedRunsAfterDrain();
    expect(await read(f.run.id)).toMatchObject({ status: "cancelled", errorCode: "queued_wake_superseded" });
    expect(await read(target.id)).toEqual(target);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });
  it("does not reinterpret an accepted result with a missing settlement as new work", async () => {
    const f = await fixture();
    await db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, f.receipt.id));
    expect((await reconcileQueuedReceipt(db, f.run)).kind).toBe("held");
    await f.queue.resumeQueuedRunsAfterDrain();
    expect(await read(f.run.id)).toMatchObject({ status: "queued", nextAction: expect.stringContaining("completed") });
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });
  it("continues healthy seats when another agent lookup fails and leaves a retry obligation", async () => {
    const broken = await fixture();
    const healthy = await fixture();
    healthy.deps.getAgent.mockImplementation(async id => {
      if (id === broken.agent.id) throw new Error("broken seat lookup");
      return healthy.agent;
    });
    await expect(healthy.queue.resumeQueuedRunsAfterDrain()).rejects.toThrow("Some agent queues could not resume");
    expect(await read(healthy.run.id)).toMatchObject({ status: "running" });
    expect(await read(broken.run.id)).toMatchObject({ status: "queued" });
    expect(healthy.deps.executeRun).toHaveBeenCalledExactlyOnceWith(healthy.run.id);
  });
});
