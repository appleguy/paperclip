import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, approvals, companies, createDb, issueApprovals, issueRecoveryActions, issueRelations, issues, issueThreadInteractions } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("guarded blocked transition", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-guarded-unblock-");
    db = createDb(temporary.connectionString, { maxConnections: 4 });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Guard", issuePrefix: `G${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Owner", role: "engineer", adapterType: "process", status: "paused" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Blocked", status: "blocked", assigneeAgentId: agent!.id,
      blockedTransitionAt: new Date(), unblockDescriptor: { owner: { agentId: agent!.id }, action: "Review" } }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: "board-user", companyIds: [companyId], isInstanceAdmin: true, source: "local_implicit" }; next(); });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    const expected = { statusVersion: issue!.statusVersion, updatedAt: issue!.updatedAt.toISOString(), blockedTransitionAt: issue!.blockedTransitionAt!.toISOString(), blockedByIssueIds: [] as string[] };
    return { app, issue: issue!, agent: agent!, expected, companyId };
  }
  const send = (app: express.Express, id: string, expected: unknown) => request(app).patch(`/api/issues/${id}/guarded-unblock`).send({ status: "todo", expectedBlockedTransition: expected });

  it("allows exactly one concurrent writer", async () => {
    const { app, issue, expected } = await fixture();
    const responses = await Promise.all([send(app, issue.id, expected), send(app, issue.id, expected)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  });
  it("requires the dedicated endpoint and rejects mixed mutations", async () => {
    const { app, issue, expected } = await fixture();
    const ordinary = await request(app).patch(`/api/issues/${issue.id}`).send({ status: "todo", expectedBlockedTransition: expected });
    const mixed = await request(app).patch(`/api/issues/${issue.id}/guarded-unblock`).send({ status: "todo", expectedBlockedTransition: expected, title: "changed" });
    expect(ordinary.status).toBe(422);
    expect(mixed.status).toBe(422);
  });
  it("rejects a status change committed while the guarded request waits for its row lock", async () => {
    const { app, issue, expected } = await fixture();
    const holderDb = createDb(temporary.connectionString, { maxConnections: 1 });
    const probeDb = createDb(temporary.connectionString, { maxConnections: 1 });
    let release!: () => void, ready!: () => void, holderPid = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const edit = holderDb.transaction(async tx => {
      await tx.update(issues).set({ status: "in_progress", statusVersion: sql`${issues.statusVersion} + 1` }).where(eq(issues.id, issue.id));
      holderPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid;
      ready();
      await gate;
    });
    await locked;
    const attempt = send(app, issue.id, expected).then(response => response);
    let waiting = false;
    try {
      const deadline = Date.now() + 5000;
      while (!waiting && Date.now() < deadline) {
        const [row] = await probeDb.execute<{ waiting: boolean }>(sql`select exists (select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and ${holderPid} = any(pg_blocking_pids(pid))) as waiting`);
        waiting = row!.waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally { release(); await edit; }
    expect(waiting).toBe(true);
    expect((await attempt).status).toBe(409);
    const [saved] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(saved!.status).toBe("in_progress");
  });
  it.each(["interaction", "interaction-reactivation", "approval", "approval-link", "revision", "recovery", "recovery-reactivation", "escalated", "rollback"])('serializes a concurrent %s gate', async (kind) => {
    const { app, issue, expected, companyId } = await fixture();
    const holderDb = createDb(temporary.connectionString, { maxConnections: 1 });
    const probeDb = createDb(temporary.connectionString, { maxConnections: 1 });
    let approvalId = "";
    if (kind === "approval" || kind === "revision" || kind === "approval-link") {
      const [approval] = await db.insert(approvals).values({ companyId, type: "hire_agent", status: kind === "approval-link" ? "pending" : "approved", payload: {} }).returning();
      approvalId = approval!.id;
      if (kind !== "approval-link") await db.insert(issueApprovals).values({ companyId, issueId: issue.id, approvalId });
    }
    if (kind === "interaction-reactivation") await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id, kind: "ask_user_questions", status: "answered", payload: {} as any });
    if (kind === "recovery-reactivation") await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id, kind: "active_run_watchdog", status: "resolved", cause: "test", fingerprint: "test", nextAction: "test" });
    let release!: () => void, ready!: () => void, holderPid = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const writer = holderDb.transaction(async tx => {
      if (kind === "approval" || kind === "revision") {
        await tx.update(approvals).set({ status: kind === "revision" ? "revision_requested" : "pending" }).where(eq(approvals.id, approvalId));
      } else if (kind === "approval-link") {
        await tx.insert(issueApprovals).values({ companyId, issueId: issue.id, approvalId });
      } else if (kind === "interaction-reactivation") {
        await tx.update(issueThreadInteractions).set({ status: "pending" }).where(eq(issueThreadInteractions.issueId, issue.id));
      } else if (kind === "recovery-reactivation") {
        await tx.update(issueRecoveryActions).set({ status: "active" }).where(eq(issueRecoveryActions.sourceIssueId, issue.id));
      } else if (kind === "recovery" || kind === "escalated") {
        await tx.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id, kind: "active_run_watchdog", status: kind === "escalated" ? "escalated" : "active", cause: "test", fingerprint: "test", nextAction: "test" });
      } else {
        await tx.insert(issueThreadInteractions).values({ companyId, issueId: issue.id, kind: "ask_user_questions", status: "pending", payload: {} as any });
      }
      holderPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid;
      ready();
      await gate;
      if (kind === "rollback") throw new Error("rollback test gate");
    }).catch(error => { if (kind !== "rollback") throw error; });
    await locked;
    const attempt = send(app, issue.id, expected).then(response => response);
    let waiting = false;
    try {
      const deadline = Date.now() + 5000;
      while (!waiting && Date.now() < deadline) {
        const [row] = await probeDb.execute<{ waiting: boolean }>(sql`select exists (select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and ${holderPid} = any(pg_blocking_pids(pid))) as waiting`);
        waiting = row!.waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally { release(); await writer; }
    expect(waiting).toBe(true);
    expect((await attempt).status).toBe(kind === "rollback" ? 200 : 409);
    const [saved] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(saved!.status).toBe(kind === "rollback" ? "todo" : "blocked");
  });
  it.each(["transition", "descriptor", "owner", "advanced", "dependency"])('rejects changed %s', async (kind) => {
    const { app, issue, expected, companyId } = await fixture();
    if (kind === "dependency") {
      const [blocker] = await db.insert(issues).values({ companyId, title: "New dependency", status: "todo" }).returning();
      await db.insert(issueRelations).values({ companyId, issueId: blocker!.id, relatedIssueId: issue.id, type: "blocks" });
    } else if (kind === "advanced") {
      await db.update(issues).set({ status: "in_progress", statusVersion: sql`${issues.statusVersion} + 1` }).where(eq(issues.id, issue.id));
    } else if (kind === "owner") {
      await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "new-owner" }).where(eq(issues.id, issue.id));
    } else if (kind === "descriptor") {
      await db.update(issues).set({ unblockDescriptor: { owner: "board", action: "Manual hold" }, statusVersion: sql`${issues.statusVersion} + 1` }).where(eq(issues.id, issue.id));
    } else {
      await db.update(issues).set({ blockedTransitionAt: new Date(issue.blockedTransitionAt!.getTime() + 1000), statusVersion: sql`${issues.statusVersion} + 1` }).where(eq(issues.id, issue.id));
    }
    const response = await send(app, issue.id, expected);
    expect(response.status).toBe(409);
    const [saved] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(saved!.status).toBe(kind === "advanced" ? "in_progress" : "blocked");
  });
});
