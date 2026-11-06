import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("assignment changes cancel queued runs", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-assignment-queue-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Assignment", issuePrefix: `A${companyId.slice(0, 6)}` });
    const [a, b] = await db.insert(agents).values(["A", "B"].map(name => ({ companyId, name, role: "engineer", adapterType: "process", status: "idle" }))).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Queued assignment", status: "in_progress", assigneeAgentId: a!.id }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId: a!.id, source: "assignment", status: "queued" }).returning();
    const [queued, another, running, otherIssue] = await db.insert(heartbeatRuns).values([
      { companyId, agentId: a!.id, status: "queued", wakeupRequestId: wake!.id, contextSnapshot: { issueId: issue!.id } },
      { companyId, agentId: a!.id, status: "queued", nativeIssueId: issue!.id },
      { companyId, agentId: a!.id, status: "running", contextSnapshot: { issueId: issue!.id } },
      { companyId, agentId: a!.id, status: "queued", contextSnapshot: { issueId: randomUUID() } },
    ]).returning();
    await db.update(agentWakeupRequests).set({ runId: queued!.id }).where(eq(agentWakeupRequests.id, wake!.id));
    await db.update(issues).set({ executionRunId: queued!.id, checkoutRunId: another!.id }).where(eq(issues.id, issue!.id));
    return { companyId, a: a!, b: b!, issue: issue!, wake: wake!, queued: queued!, another: another!, running: running!, otherIssue: otherIssue! };
  }

  it.each(["reassign", "unassign", "release", "force-release"] as const)("cancels only old queued runs on %s", async action => {
    const f = await fixture(), svc = issueService(db);
    if (action === "reassign") await svc.update(f.issue.id, { assigneeAgentId: f.b.id, companyGuard: f.companyId });
    if (action === "unassign") await svc.update(f.issue.id, { assigneeAgentId: null, companyGuard: f.companyId });
    if (action === "release") await svc.release(f.issue.id);
    if (action === "force-release") await svc.adminForceRelease(f.issue.id, { clearAssignee: true });
    const [saved] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(saved).toMatchObject({ assigneeAgentId: action === "reassign" ? f.b.id : null, executionRunId: null, checkoutRunId: null });
    for (const run of [f.queued, f.another]) {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(row).toMatchObject({ status: "cancelled", errorCode: "issue_assignee_changed" });
    }
    for (const run of [f.running, f.otherIssue]) {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(row!.status).toBe(run.status);
    }
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
    expect(wake!.status).toBe("skipped");
  });

  it("rolls cancellation back with the assignment transaction", async () => {
    const f = await fixture();
    await expect(db.transaction(async tx => {
      await issueService(db).update(f.issue.id, { assigneeAgentId: f.b.id }, tx);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.queued.id));
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(run!.status).toBe("queued");
    expect(issue).toMatchObject({ assigneeAgentId: f.a.id, executionRunId: f.queued.id });
  });

  it("lets the successor claim its queued run without waiting for the old agent", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: {} }).where(eq(heartbeatRuns.id, f.running.id));
    await issueService(db).update(f.issue.id, { assigneeAgentId: f.b.id });
    const [successor] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.b.id,
      status: "queued", invocationSource: "assignment", responsibleUserId: "queue-test-user",
      contextSnapshot: { issueId: f.issue.id, wakeReason: "issue_assigned" } }).returning();
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockResolvedValue(f.b);
    expect(await createHeartbeatQueue(db, deps).claimQueuedRun(successor!)).toMatchObject({ id: successor!.id, status: "running" });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.queued.id)))[0]!.status).toBe("cancelled");
  });
});
