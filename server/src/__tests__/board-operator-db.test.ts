import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, issueRecoveryActions, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import {
  boardOperatorRecoveryService,
  resolveBoardOperatorQuestionRoute,
} from "../services/board-operator.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Board operator (database)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const operatorId = randomUUID();
  const workerId = randomUUID();
  const issueId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("board-operator-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Board operator", issuePrefix: "BOP" });
    await db.insert(agents).values([
      { id: operatorId, companyId, name: "Board", adapterType: "process", status: "idle" },
      { id: workerId, companyId, name: "Worker", adapterType: "process", status: "idle", reportsTo: operatorId },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Stuck", assigneeAgentId: workerId, status: "blocked" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function configure(boardOperator: Record<string, unknown>) {
    await db.update(companies).set({ boardOperator: boardOperator as never }).where(eq(companies.id, companyId));
  }
  const question = (overrides: Record<string, unknown> = {}) => ({
    companyId,
    creatorAgentId: workerId,
    kind: "ask_user_questions" as const,
    hasToolAction: false,
    hasSecretProposal: false,
    hasQualityReview: false,
    ...overrides,
  });

  it("does not route when the setting is off (default)", async () => {
    await expect(resolveBoardOperatorQuestionRoute(db, question())).resolves.toBeNull();
  });

  it("routes a worker's question to the operator, including an over-restricted human_only request", async () => {
    await configure({ agentId: operatorId, routeAgentQuestions: true, wakeOnRecoveryEscalation: false });
    await expect(resolveBoardOperatorQuestionRoute(db, question())).resolves.toEqual({ addresseeAgentId: operatorId });
    await expect(resolveBoardOperatorQuestionRoute(db, question({ requestedPolicy: "human_only" })))
      .resolves.toEqual({ addresseeAgentId: operatorId });
  });

  it("never routes the operator's own questions, so its escalation reaches the human", async () => {
    await expect(resolveBoardOperatorQuestionRoute(db, question({ creatorAgentId: operatorId }))).resolves.toBeNull();
  });

  it("falls back to the human when the operator is not invokable", async () => {
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, operatorId));
    await expect(resolveBoardOperatorQuestionRoute(db, question())).resolves.toBeNull();
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, operatorId));
  });

  it("wakes the operator once per board-owned recovery action and only when enabled", async () => {
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "deliberate_wait_without_target", status: "active",
      ownerType: "board", cause: "deliberate_wait_without_target", fingerprint: "fp", nextAction: "Inspect.",
    }).returning();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId, title: "Agent-owned", assigneeAgentId: workerId });
    await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: otherIssueId, kind: "other", status: "active", ownerType: "agent",
      ownerAgentId: workerId, cause: "x", fingerprint: "fp2", nextAction: "n",
    });
    const wakeup = vi.fn().mockResolvedValue({ id: "run" });
    const service = boardOperatorRecoveryService(db, { wakeup });

    await configure({ agentId: operatorId, routeAgentQuestions: true, wakeOnRecoveryEscalation: false });
    await expect(service.wakeForBoardOwnedRecoveryActions()).resolves.toMatchObject({ considered: 0, woken: 0 });

    await configure({ agentId: operatorId, routeAgentQuestions: true, wakeOnRecoveryEscalation: true });
    await expect(service.wakeForBoardOwnedRecoveryActions()).resolves.toMatchObject({ considered: 1, woken: 1 });
    expect(wakeup).toHaveBeenCalledTimes(1);
    const [agentId, opts] = wakeup.mock.calls[0]!;
    expect(agentId).toBe(operatorId);
    expect(opts).toMatchObject({
      reason: "board_recovery_escalated",
      idempotencyKey: `board-recovery:${action!.id}`,
      contextSnapshot: expect.objectContaining({ issueId, recoveryActionId: action!.id, wakeReason: "board_recovery_escalated" }),
    });
  });

  describe("interaction creation", () => {
    const questionInput = (resolverPolicy?: "human_only" | "anyone") => ({
      kind: "ask_user_questions",
      title: "Which approach?",
      ...(resolverPolicy ? { resolverPolicy } : {}),
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        questionSet: {
          schema: "paperclip.question_set.v1",
          questions: [{ id: "q", prompt: "Use option A?", required: true, answerMode: "text" }],
        },
      },
    }) as never;
    const create = (input: unknown, agentId: string) =>
      issueThreadInteractionService(db).create({ id: issueId, companyId }, input as never, { agentId });

    it("routes a worker's human_only question to the Board operator as an open, agent-resolvable ask", async () => {
      await configure({ agentId: operatorId, routeAgentQuestions: true, wakeOnRecoveryEscalation: false });
      const interaction = await create(questionInput("human_only"), workerId);
      expect(interaction).toMatchObject({
        addresseeAgentId: operatorId,
        requestedResolverPolicy: "anyone",
        effectiveResolverPolicy: "anyone",
      });
    });

    it("keeps the operator's own question human-only so escalation reaches the owner", async () => {
      const interaction = await create(questionInput("human_only"), operatorId);
      expect(interaction).toMatchObject({ addresseeAgentId: null, effectiveResolverPolicy: "human_only" });
    });

    it("does not route when the feature is off or a company cap requires a human", async () => {
      await configure({ agentId: operatorId, routeAgentQuestions: false, wakeOnRecoveryEscalation: false });
      expect(await create(questionInput("human_only"), workerId)).toMatchObject({ addresseeAgentId: null, effectiveResolverPolicy: "human_only" });

      await configure({ agentId: operatorId, routeAgentQuestions: true, wakeOnRecoveryEscalation: false });
      await db.update(companies).set({ interactionResolverGovernance: { ask_user_questions: { cap: "human_only" } } })
        .where(eq(companies.id, companyId));
      expect(await create(questionInput(), workerId)).toMatchObject({ addresseeAgentId: null, effectiveResolverPolicy: "human_only" });
      await db.update(companies).set({ interactionResolverGovernance: {} }).where(eq(companies.id, companyId));
    });

    it("leaves an explicitly addressed question alone", async () => {
      const other = randomUUID();
      await db.insert(agents).values({ id: other, companyId, name: "Peer", adapterType: "process", status: "idle", reportsTo: operatorId });
      const interaction = await create({ ...(questionInput() as object), addresseeAgentId: other }, workerId);
      expect(interaction).toMatchObject({ addresseeAgentId: other });
    });
  });
});
