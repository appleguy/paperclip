import { agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRunEvents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { NativeSessionSteeringError, steerNativeSession } from "../native-runtime/native-session-executor.js";
import { deliverOwnerCorrection, ownerCorrectionContext, OWNER_CORRECTION_REASON } from "./owner-corrections.js";
import type { WakeupOptions } from "./run-preparation.js";

vi.mock("../native-runtime/native-session-executor.js", () => ({
  steerNativeSession: vi.fn(),
  NativeSessionSteeringError: class extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  },
}));
vi.mock("../activity-log.js", () => ({ logActivity: vi.fn() }));

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_OWNER_CORRECTION_TEST_DATABASE_URL");
const support = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping owner correction database tests: ${support.reason}`);
describe.skipIf(!support.supported)("scoped owner correction delivery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-owner-corrections");
    db = createDb(external ?? database!.connectionString, { maxConnections: 4 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
    vi.mocked(steerNativeSession).mockReset().mockResolvedValue({ turnId: "turn-one" });
  });
  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Correction tests", issuePrefix: "OC" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", status: "running", adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Use direct host mode", assigneeAgentId: agent.id, status: "in_progress" }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorUserId: "owner", authorType: "user", body: "Use the native shell for this task; do not ask for Accessibility again." }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, scopeKind: "issue", issueId: issue.id, status: "running", contextSnapshot: { issueId: issue.id } }).returning();
    const opts: WakeupOptions = { manualUserWake: true, reason: OWNER_CORRECTION_REASON, requestedByActorType: "user", requestedByActorId: "owner", payload: { issueId: issue.id, ownerCorrection: { commentId: comment.id } } };
    return { company, agent, issue, comment, run, opts };
  }
  async function receipt() {
    const [row] = await db.select().from(agentWakeupRequests);
    return row.payload!.ownerCorrectionV1 as { commentId: string; deliveries: Record<string, { status: string; code?: string; turnId?: string }> };
  }
  async function anotherComment(s: Awaited<ReturnType<typeof seed>>, body: string) {
    const [comment] = await db.insert(issueComments).values({ companyId: s.company.id, issueId: s.issue.id, authorUserId: "owner", body }).returning();
    return comment;
  }

  it("does not infer delivery or applicability from a comment, and steers only the selected task and agent", async () => {
    const s = await seed();
    expect(await ownerCorrectionContext(db, s.company.id, s.agent.id, s.issue.id)).toEqual({ markdown: "", ids: [] });
    const [otherIssue] = await db.insert(issues).values({ companyId: s.company.id, title: "Unrelated" }).returning();
    const [otherAgent] = await db.insert(agents).values({ companyId: s.company.id, name: "Peer" }).returning();
    await db.insert(heartbeatRuns).values([
      { companyId: s.company.id, agentId: s.agent.id, issueId: otherIssue.id, status: "running" },
      { companyId: s.company.id, agentId: otherAgent.id, issueId: s.issue.id, status: "running" },
      { companyId: s.company.id, agentId: s.agent.id, issueId: s.issue.id, status: "succeeded" },
    ]);
    expect((await deliverOwnerCorrection(db, s.agent, s.opts))?.id).toBe(s.run.id);
    expect(steerNativeSession).toHaveBeenCalledTimes(1);
    expect(steerNativeSession).toHaveBeenCalledWith(expect.objectContaining({ runId: s.run.id,
      correlationId: `owner-correction:${s.comment.id}`, message: expect.stringContaining("Preserve existing permissions") }));
    expect((await receipt()).deliveries).toEqual({ [s.run.id]: { status: "acknowledged", turnId: "turn-one" } });
    expect((await ownerCorrectionContext(db, s.company.id, s.agent.id, otherIssue.id)).ids).toEqual([]);
    expect((await ownerCorrectionContext(db, s.company.id, otherAgent.id, s.issue.id)).ids).toEqual([]);
  });

  it("persists dispatch before provider I/O and does not duplicate a long-running delivery", async () => {
    const s = await seed();
    let release!: (value: { turnId: string }) => void;
    let entered!: () => void;
    const called = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(steerNativeSession).mockImplementationOnce(() => { entered(); return new Promise(resolve => { release = resolve; }); });
    const first = deliverOwnerCorrection(db, s.agent, s.opts);
    await called;
    expect((await receipt()).deliveries[s.run.id].status).toBe("dispatching");
    await expect(deliverOwnerCorrection(db, s.agent, s.opts)).rejects.toMatchObject({ details: { code: "owner_correction_delivery_incomplete" } });
    release({ turnId: "long-turn" });
    await first;
    await deliverOwnerCorrection(db, s.agent, s.opts);
    expect(steerNativeSession).toHaveBeenCalledTimes(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
    expect((await receipt()).deliveries[s.run.id]).toEqual({ status: "acknowledged", turnId: "long-turn" });
  });

  it.each(["steering_unsupported", "steering_rejected", "steering_temporarily_unavailable"] as const)("records %s and allows an explicit retry with the same identity", async code => {
    const s = await seed();
    vi.mocked(steerNativeSession).mockRejectedValueOnce(new NativeSessionSteeringError(code, "Unavailable"));
    await expect(deliverOwnerCorrection(db, s.agent, s.opts)).rejects.toMatchObject({ details: { code: "owner_correction_delivery_incomplete" } });
    expect((await receipt()).deliveries[s.run.id]).toMatchObject({ status: "failed", code });
    await deliverOwnerCorrection(db, s.agent, s.opts);
    expect(steerNativeSession).toHaveBeenCalledTimes(2);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
    expect((await receipt()).deliveries[s.run.id].status).toBe("acknowledged");
  });

  it("reconciles a durable late acknowledgement after timeout/restart without resending", async () => {
    const s = await seed();
    vi.mocked(steerNativeSession).mockRejectedValueOnce(new NativeSessionSteeringError("steering_timeout", "Timed out"));
    await expect(deliverOwnerCorrection(db, s.agent, s.opts)).rejects.toMatchObject({ status: 409 });
    await expect(deliverOwnerCorrection(db, s.agent, s.opts)).rejects.toMatchObject({ status: 409 });
    expect((await receipt()).deliveries[s.run.id].status).toBe("uncertain");
    expect(steerNativeSession).toHaveBeenCalledTimes(1);
    await db.insert(heartbeatRunEvents).values({ companyId: s.company.id, agentId: s.agent.id, runId: s.run.id,
      seq: 1, sourceEventId: "ack-one", eventType: "item.completed", payload: { prpEvent: {
        turnId: "late-turn", itemId: `late-turn:steer:owner-correction:${s.comment.id}`, payload: { kind: "steering_acknowledgement" },
      } } });
    await deliverOwnerCorrection(db, s.agent, s.opts);
    expect((await receipt()).deliveries[s.run.id]).toEqual({ status: "acknowledged", turnId: "late-turn" });
    expect(steerNativeSession).toHaveBeenCalledTimes(1);
  });

  it("loads corrections on later/resumed runs without starting a new run or steering twice", async () => {
    const s = await seed();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, s.run.id));
    expect(await deliverOwnerCorrection(db, s.agent, s.opts)).toBeNull();
    const fresh = await ownerCorrectionContext(db, s.company.id, s.agent.id, s.issue.id);
    expect(fresh.ids).toEqual([s.comment.id]);
    expect(fresh.markdown).toContain(s.comment.body);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: s.company.id, agentId: s.agent.id, issueId: s.issue.id,
      status: "running", contextSnapshot: { issueId: s.issue.id, ownerCorrectionIds: fresh.ids } }).returning();
    await deliverOwnerCorrection(db, s.agent, s.opts);
    expect(steerNativeSession).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(2);
    expect((await ownerCorrectionContext(db, s.company.id, s.agent.id, s.issue.id)).ids).toEqual(fresh.ids);
    expect(run.status).toBe("running");
  });

  it("keeps distinct corrections and supersedes only explicitly selected guidance", async () => {
    const s = await seed();
    await deliverOwnerCorrection(db, s.agent, s.opts);
    const unrelated = await anotherComment(s, "Preserve the user's existing output format.");
    await deliverOwnerCorrection(db, s.agent, { ...s.opts, payload: { issueId: s.issue.id, ownerCorrection: { commentId: unrelated.id } } });
    const next = await anotherComment(s, "Use the native typed executor for the remaining host work.");
    const opts = { ...s.opts, payload: { issueId: s.issue.id, ownerCorrection: { commentId: next.id, supersedes: [s.comment.id] } } };
    await deliverOwnerCorrection(db, s.agent, opts);
    const current = await ownerCorrectionContext(db, s.company.id, s.agent.id, s.issue.id);
    expect(current.ids).toEqual(expect.arrayContaining([next.id, unrelated.id]));
    expect(current.ids).not.toContain(s.comment.id);
    expect(current.markdown).not.toContain(s.comment.body);
    expect(current.markdown).toContain("Their previous guidance is no longer current");
    await expect(deliverOwnerCorrection(db, s.agent, s.opts)).rejects.toMatchObject({ details: { code: "owner_correction_superseded" } });
    await expect(deliverOwnerCorrection(db, s.agent, { ...opts, payload: { issueId: s.issue.id, ownerCorrection: { commentId: next.id } } })).rejects.toMatchObject({ status: 409 });
  });

  it("does not label edited or deleted sources current", async () => {
    const s = await seed();
    await deliverOwnerCorrection(db, s.agent, s.opts);
    await db.update(issueComments).set({ body: "Changed after registration" }).where(eq(issueComments.id, s.comment.id));
    const current = await ownerCorrectionContext(db, s.company.id, s.agent.id, s.issue.id);
    expect(current.markdown).toContain("no longer current");
    expect(current.markdown).not.toContain(s.comment.body);
    await expect(deliverOwnerCorrection(db, s.agent, s.opts)).rejects.toMatchObject({ status: 409 });
    await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, s.comment.id));
    await expect(deliverOwnerCorrection(db, s.agent, s.opts)).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    { requestedByActorType: "agent" as const }, { requestedByActorType: "system" as const },
    { manualUserWake: false }, { requestedByActorId: "peer" }, { failedRunId: "retry" },
  ])("rejects a forged or unauthorized correction wake: %j", async override => {
    const s = await seed();
    await expect(deliverOwnerCorrection(db, s.agent, { ...s.opts, ...override })).rejects.toMatchObject({ status: 403 });
    expect(steerNativeSession).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("rejects cross-company sources and unresolved supersession", async () => {
    const s = await seed();
    const [company] = await db.insert(companies).values({ name: "Other", issuePrefix: "ZZ" }).returning();
    await expect(deliverOwnerCorrection(db, { ...s.agent, companyId: company.id }, s.opts)).rejects.toMatchObject({ status: 403 });
    vi.mocked(steerNativeSession).mockRejectedValueOnce(new NativeSessionSteeringError("steering_timeout", "Unknown"));
    await expect(deliverOwnerCorrection(db, s.agent, s.opts)).rejects.toMatchObject({ status: 409 });
    const next = await anotherComment(s, "Replace the old instruction.");
    await expect(deliverOwnerCorrection(db, s.agent, { ...s.opts, payload: { issueId: s.issue.id,
      ownerCorrection: { commentId: next.id, supersedes: [s.comment.id] } } })).rejects.toMatchObject({ details: { code: "owner_correction_supersession_pending" } });
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
  });
});
