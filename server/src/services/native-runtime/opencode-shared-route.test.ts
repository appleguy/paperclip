import { activityLog, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { issueRoutes } from "../../routes/issues.js";
import { describeEmbeddedPostgres, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "../../__tests__/helpers/route-test-harness.js";

const start = vi.hoisted(() => vi.fn());
vi.mock("./opencode-shared-host.js", () => ({ startOpenCodeSharedHost: start }));

describeEmbeddedPostgres("OpenCode empty observation route", () => {
  const ctx = useEmbeddedPostgres("paperclip-opencode-observe-");
  const oldExecutable = process.env.PAPERCLIP_OPENCODE_V2_EXECUTABLE;
  const oldRoot = process.env.PAPERCLIP_OPENCODE_V2_DATA_ROOT;
  beforeAll(() => { process.env.PAPERCLIP_OPENCODE_V2_EXECUTABLE = "/fixture/opencode"; process.env.PAPERCLIP_OPENCODE_V2_DATA_ROOT = "/fixture/data"; });
  afterAll(() => {
    if (oldExecutable === undefined) delete process.env.PAPERCLIP_OPENCODE_V2_EXECUTABLE; else process.env.PAPERCLIP_OPENCODE_V2_EXECUTABLE = oldExecutable;
    if (oldRoot === undefined) delete process.env.PAPERCLIP_OPENCODE_V2_DATA_ROOT; else process.env.PAPERCLIP_OPENCODE_V2_DATA_ROOT = oldRoot;
  });
  it("requires an instance admin and rejects caller-supplied binding data", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "OpenCode");
    const [issue] = await ctx.db.insert(issues).values({ companyId: company.companyId, title: "Probe" }).returning();
    const path = `/api/issues/${issue!.id}/opencode-shared/empty-observation`;
    const admin = { ...company.actor, isInstanceAdmin: true };
    start.mockReset(); const shutdown = vi.fn(async () => {}); start.mockResolvedValue({ createEmptyObservation: async () => ({ sessionId: "ses_fixture", generation: "generation", version: "2.2.5", observed: true, managed: false }), shutdown });
    await request(routeApp(ctx.db, company.actor, issueRoutes)).post(path).send({}).expect(403);
    await request(routeApp(ctx.db, admin, issueRoutes)).post(path).send({ sessionId: "ses_foreign" }).expect(400);
    expect(start).not.toHaveBeenCalled();
    const app = routeApp(ctx.db, admin, issueRoutes);
    const result = await request(app).post(path).send({}).expect(200);
    expect(result.body).toEqual({ issueId: issue!.id, sessionId: "ses_fixture", generation: "generation", version: "2.2.5", observed: true, managed: false });
    expect(start).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    await request(app).post(path).send({}).expect(200);
    expect(start).toHaveBeenCalledTimes(2); expect(shutdown).toHaveBeenCalledTimes(2);
    const audit = await ctx.db.select().from(activityLog).where(eq(activityLog.entityId, issue!.id));
    expect(audit.map(item => item.action)).toEqual(expect.arrayContaining(["issue.opencode_empty_observation_requested", "issue.opencode_empty_observation_completed"]));
    expect(audit.filter(item => item.action === "issue.opencode_empty_observation_requested")).toHaveLength(2);
    expect(audit.filter(item => item.action === "issue.opencode_empty_observation_completed")).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain("authorization");
  });
});
