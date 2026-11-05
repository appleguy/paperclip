import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  costEvents,
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses } from "../adapters/index.ts";
import { readIssueWakeDelta } from "../services/issue-rewake-throttle-db.ts";
import { ISSUE_WAKE_DELTA_KEY } from "../services/issue-rewake-throttle.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Issue rewake throttle test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue rewake throttle tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat issue rewake throttle", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-rewake-throttle-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await db.insert(authUsers).values({ id: "responsible-user", name: "Test owner", email: "rewake@example.test",
      createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    // Await every in-flight background heartbeat run to quiescence before the
    // deletes below. A wakeup claims a run and dispatches its execution
    // fire-and-forget, and that run can dispatch a follow-up wakeup, so a run or
    // wakeup can still write heartbeat_runs and issues rows when teardown starts
    // and would race the deletes (a heartbeat_runs delete deadlocks on the ON
    // DELETE SET NULL cascade to issues). The shared drain also awaits an
    // in-flight wakeup that is still before run registration, which a plain run
    // table status poll cannot see.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // Post-run bookkeeping (run-event records, follow-up wake scheduling) can
    // still write for a moment after a run reaches a terminal status, so a
    // single delete sweep can hit a foreign-key violation when a late insert
    // lands between two deletes. Retry the sweep until it goes through clean.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(costEvents);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companyMemberships);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      membershipRole: "member", status: "active" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Interrupted import mission",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, issueId };
  }

  async function seedTerminalRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status?: string;
    finishedSecondsAgo: number;
    startedSecondsAgo?: number;
    sessionIdAfter?: string;
  }) {
    const runId = randomUUID();
    const finishedAt = new Date(Date.now() - input.finishedSecondsAgo * 1000);
    const startedAt = input.startedSecondsAgo === undefined
      ? new Date(finishedAt.getTime() - 5_000)
      : new Date(Date.now() - input.startedSecondsAgo * 1000);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: input.status ?? "succeeded",
      responsibleUserId: "responsible-user",
      createdAt: startedAt,
      startedAt,
      finishedAt,
      sessionIdAfter: input.sessionIdAfter,
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_assigned" },
    });
    return runId;
  }

  function pollWake(agentId: string, issueId: string) {
    return heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_queue_drive",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_queue_drive" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
  }

  async function latestWakeRequest(agentId: string) {
    return db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  it("skips event-free re-wakes after consecutive no-progress runs and admits them again on new input", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const throttledWake = await pollWake(agentId, issueId);
    expect(throttledWake).toBeNull();

    const skipped = await latestWakeRequest(agentId);
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.reason).toBe("issue_rewake_throttled");
    const heartbeatSkip = (skipped?.payload as Record<string, unknown> | null)?.heartbeatSkip as
      | Record<string, unknown>
      | undefined;
    expect(heartbeatSkip?.noProgressStreak).toBe(2);
    expect(typeof heartbeatSkip?.nextAllowedAt).toBe("string");

    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(2);

    // A board comment on the issue is new input: the next event-free wake is
    // admitted even though the streak has not been broken by a run.
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
    });

    const admittedWake = await pollWake(agentId, issueId);
    expect(admittedWake).not.toBeNull();
  });

  it("does not throttle system comment-driven wakes even during a no-progress streak", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const commentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      contextSnapshot: { issueId, wakeReason: "issue_commented" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(commentWake).not.toBeNull();
  });

  it("keeps agent comments throttled without hiding genuinely new human input", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const agentCommentId = randomUUID();
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
    });
    await db.insert(issueComments).values({ id: agentCommentId, companyId, issueId,
      authorAgentId: agentId, authorType: "agent", body: "Still waiting." });
    const throttledAgentCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: agentCommentId },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
        wakeCommentId: agentCommentId,
      },
      requestedByActorType: "agent",
      requestedByActorId: agentId,
    });
    expect(throttledAgentCommentWake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");

    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "issue.comment_added",
      entityType: "issue",
      entityId: issueId,
    });
    const nextAgentCommentId = randomUUID();
    const admittedAfterHumanInput = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: nextAgentCommentId },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
        wakeCommentId: nextAgentCommentId,
      },
      requestedByActorType: "agent",
      requestedByActorId: randomUUID(),
    });
    expect(admittedAfterHumanInput).not.toBeNull();
  });

  it("keeps agent-authored explicit resume comments inside the no-progress cooldown", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    const resumeFromRunId = await seedTerminalRun({
      companyId,
      agentId,
      issueId,
      finishedSecondsAgo: 40,
      sessionIdAfter: randomUUID(),
    });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId, issueId,
      authorAgentId: agentId, authorType: "agent", body: "Continue." });
    const resumeWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_reopened_via_comment",
      payload: { issueId, commentId, resumeFromRunId, resumeIntent: true },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_reopened_via_comment",
        wakeCommentId: commentId,
        resumeIntent: true,
      },
      requestedByActorType: "agent",
      requestedByActorId: randomUUID(),
    });

    expect(resumeWake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");
  });

  it("does not throttle the wake that follows a failed run", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 70 });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    await seedTerminalRun({ companyId, agentId, issueId, status: "failed", finishedSecondsAgo: 10 });

    const recoveryWake = await pollWake(agentId, issueId);
    expect(recoveryWake).not.toBeNull();
  });

  it("does not throttle when a recent run produced issue-visible progress", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    const progressRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: progressRunId,
      action: "issue.document_upserted",
      entityType: "issue",
      entityId: issueId,
      createdAt: new Date(Date.now() - 11_000),
    });

    const wake = await pollWake(agentId, issueId);
    expect(wake).not.toBeNull();
  });

  it("does not count progress on another issue toward the current issue", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      title: "Related follow-up",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 40 });
    const progressRunId = await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId: progressRunId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: otherIssueId,
      createdAt: new Date(Date.now() - 11_000),
    });

    const wake = await pollWake(agentId, issueId);
    expect(wake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");
  });

  it("counts a long-running session that finished inside the lookback window", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    await seedTerminalRun({
      companyId,
      agentId,
      issueId,
      finishedSecondsAgo: 40,
      startedSecondsAgo: 7 * 60 * 60,
    });
    await seedTerminalRun({ companyId, agentId, issueId, finishedSecondsAgo: 10 });

    const wake = await pollWake(agentId, issueId);
    expect(wake).toBeNull();
    expect((await latestWakeRequest(agentId))?.reason).toBe("issue_rewake_throttled");
  });

  it("does not suppress a new assignment", async () => {
    const f = await seedCompanyAgentIssue();
    await seedTerminalRun({ ...f, finishedSecondsAgo: 40 });
    await seedTerminalRun({ ...f, finishedSecondsAgo: 10 });
    expect(await heartbeat.wakeup(f.agentId, { reason: "issue_assigned", source: "assignment",
      payload: { issueId: f.issueId }, requestedByActorType: "system" })).not.toBeNull();
  });

  async function delta(f: { companyId: string; agentId: string; issueId: string }, reason = "issue_monitor_due", wakeCommentId: string | null = null) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    return readIssueWakeDelta(db, { ...f, issue: issue!,
      candidate: { reason, wakeCommentId, forceFreshSession: false, hasExplicitResume: false },
      agentConfig: { adapterType: agent!.adapterType, adapterConfig: agent!.adapterConfig, runtimeConfig: agent!.runtimeConfig },
    });
  }

  async function consumeDelta(f: { companyId: string; agentId: string; issueId: string }) {
    const current = await delta(f);
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", status: "claimed", payload: { issueId: f.issueId, [ISSUE_WAKE_DELTA_KEY]: current.fingerprint } });
    return current;
  }

  it("own comments and monitor reschedules neither advance the fingerprint nor reset backoff", async () => {
    const f = await seedCompanyAgentIssue();
    await seedTerminalRun({ ...f, finishedSecondsAgo: 40 });
    const runId = await seedTerminalRun({ ...f, finishedSecondsAgo: 10 });
    const before = await delta(f);
    for (const action of ["issue.comment_added", "issue.monitor_scheduled", "issue.updated"]) {
      await db.insert(activityLog).values({ companyId: f.companyId, actorType: "agent", actorId: f.agentId,
        runId, action, entityType: "issue", entityId: f.issueId, details: { source: "comment", identifier: "TEST" } });
    }
    expect((await delta(f)).fingerprint).toBe(before.fingerprint);
    expect(await heartbeat.wakeup(f.agentId, { reason: "issue_monitor_due", payload: { issueId: f.issueId } })).toBeNull();
    expect((await latestWakeRequest(f.agentId))?.reason).toBe("issue_rewake_throttled");
  });

  it("suppresses the consumed monitor delta before it creates a deferred wake behind an active run", async () => {
    const f = await seedCompanyAgentIssue();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      status: "queued", contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    await consumeDelta(f);
    expect(await heartbeat.wakeup(f.agentId, { reason: "issue_monitor_due", payload: { issueId: f.issueId } })).toBeNull();
    expect((await latestWakeRequest(f.agentId))?.reason).toBe("issue_rewake_no_meaningful_delta");
    const deferred = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, f.agentId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
    expect(deferred).toHaveLength(0);
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
  });

  it("a changed document or workspace change reopens a consumed delta once", async () => {
    const f = await seedCompanyAgentIssue();
    const runId = await seedTerminalRun({ ...f, finishedSecondsAgo: 10 });
    await consumeDelta(f);
    expect((await delta(f)).blocked).toBe(true);
    await db.insert(activityLog).values({ companyId: f.companyId, actorType: "agent", actorId: f.agentId,
      action: "issue.document_upserted", entityType: "issue", entityId: f.issueId });
    expect((await delta(f)).blocked).toBe(false);
    await consumeDelta(f);
    expect((await delta(f)).blocked).toBe(true);
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId,
      runId, seq: 1, eventType: "workspace.diff.recorded", payload: { changeSetId: "change-a" } });
    expect((await delta(f)).blocked).toBe(false);
  });

  it("identical failures do not advance the fingerprint, but a new fault or config does", async () => {
    const f = await seedCompanyAgentIssue();
    const runId = await seedTerminalRun({ ...f, status: "failed", finishedSecondsAgo: 40 });
    await db.update(heartbeatRuns).set({ errorCode: "same-fault" }).where(eq(heartbeatRuns.id, runId));
    await consumeDelta(f);
    const repeatId = await seedTerminalRun({ ...f, status: "failed", finishedSecondsAgo: 10 });
    await db.update(heartbeatRuns).set({ errorCode: "same-fault" }).where(eq(heartbeatRuns.id, repeatId));
    expect((await delta(f)).blocked).toBe(true);
    await db.update(heartbeatRuns).set({ error: "different failure with the same code" }).where(eq(heartbeatRuns.id, repeatId));
    expect((await delta(f)).blocked).toBe(false);
    await consumeDelta(f);
    await db.update(heartbeatRuns).set({ errorCode: "new-fault" }).where(eq(heartbeatRuns.id, repeatId));
    expect((await delta(f)).blocked).toBe(false);
    await consumeDelta(f);
    await db.update(agents).set({ adapterConfig: { model: "changed-model" } }).where(eq(agents.id, f.agentId));
    expect((await delta(f)).blocked).toBe(false);
  });

  it("resolves comment authors from storage and preserves other-author and owner comments", async () => {
    const f = await seedCompanyAgentIssue();
    await consumeDelta(f);
    const peerId = randomUUID();
    await db.insert(agents).values({ id: peerId, companyId: f.companyId, name: "Peer", role: "engineer", adapterType: "http" });
    const ownId = randomUUID(), otherId = randomUUID(), ownerId = randomUUID();
    await db.insert(issueComments).values([
      { id: ownId, companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId, authorType: "agent", body: "Own" },
      { id: otherId, companyId: f.companyId, issueId: f.issueId, authorAgentId: peerId, authorType: "agent", body: "Other" },
      { id: ownerId, companyId: f.companyId, issueId: f.issueId, authorUserId: "owner", authorType: "user", body: "Owner" },
    ]);
    expect((await delta(f, "issue_commented", ownId)).blocked).toBe(true);
    for (const id of [otherId, ownerId, randomUUID()]) {
      expect((await delta(f, "issue_commented", id)).blocked).toBe(false);
    }
    expect((await delta(f, "issue_blockers_resolved")).blocked).toBe(false);
    expect((await delta(f, "issue_assigned")).blocked).toBe(false);
  });

  it("serializes concurrent monitor admission to one wake for a new delta", async () => {
    const f = await seedCompanyAgentIssue();
    await consumeDelta(f);
    await db.insert(activityLog).values({ companyId: f.companyId, actorType: "system", actorId: "system",
      action: "issue.document_upserted", entityType: "issue", entityId: f.issueId });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await held;
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Concurrent test", provider: "test", model: "test-model" };
    });
    try {
      const wakes = await Promise.all(Array.from({ length: 3 }, () => heartbeat.wakeup(f.agentId, {
        reason: "issue_monitor_due", payload: { issueId: f.issueId },
      })));
      expect(wakes.filter(Boolean)).toHaveLength(1);
    } finally {
      release();
    }
  });
});
