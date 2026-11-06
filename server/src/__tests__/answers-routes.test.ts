import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  documents,
  issues,
  issueDocuments,
  issueThreadInteractions,
  projects,
  type Db,
} from "@paperclipai/db";
import { answersRoutes } from "../routes/answers.js";
import { errorHandler } from "../middleware/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("answers routes", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-answers-routes-");
    db = createDb(temp.connectionString);
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await temp?.cleanup();
  });

  function createTestApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", answersRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("lists past answered questions and supports keyword search", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const userId = "test-board-user";

    await db.insert(companies).values({
      id: companyId,
      name: "Answers Test Co",
      issuePrefix: "SCO",
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Monitoring & Runtimes",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Runtime Observer",
      adapterType: "codex_local",
    });

    const issue1Id = randomUUID();
    const issue2Id = randomUUID();
    const pendingIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: issue1Id,
        companyId,
        projectId,
        identifier: "SCO-504",
        title: "Integrate Maya runtime stats into ztop",
        status: "in_progress",
      },
      {
        id: issue2Id,
        companyId,
        projectId,
        identifier: "SCO-732",
        title: "Qwen runners slow",
        status: "done",
      },
      {
        id: pendingIssueId,
        companyId,
        projectId,
        identifier: "SCO-999",
        title: "Pending question task",
        status: "todo",
      },
    ]);

    // Attach a document to issue 1
    const docId = randomUUID();
    await db.insert(documents).values({
      id: docId,
      companyId,
      title: "Maya Runtime Stats Specification",
      latestBody: "Details of Maya runtime metrics and ztop rendering.",
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId: issue1Id,
      documentId: docId,
      key: "spec",
    });

    const interaction1Id = randomUUID();
    const interaction2Id = randomUUID();
    const pendingInteractionId = randomUUID();

    const t1 = new Date(Date.now() - 60_000);
    const t2 = new Date(Date.now() - 30_000);

    // Answered question 1: Maya stats
    await db.insert(issueThreadInteractions).values({
      id: interaction1Id,
      companyId,
      issueId: issue1Id,
      kind: "ask_user_questions",
      status: "answered",
      title: "Where should Maya runtime stats be displayed?",
      summary: "Owner chose ztop dashboard with live updates.",
      createdByAgentId: agentId,
      resolvedByUserId: userId,
      resolvedAt: t1,
      createdAt: t1,
      payload: {
        version: 1,
        questions: [
          {
            id: "dest",
            prompt: "Where should Maya runtime stats be displayed?",
            selectionMode: "single",
            options: [
              { id: "opt-ztop", label: "ztop dashboard" },
              { id: "opt-cli", label: "Dedicated CLI" },
            ],
          },
        ],
      },
      result: {
        version: 1,
        answers: [
          {
            questionId: "dest",
            optionIds: ["opt-ztop"],
            otherText: "Live update every 5s",
          },
        ],
        summaryMarkdown: "- Where should Maya runtime stats be displayed?: ztop dashboard, Live update every 5s",
      },
    });

    // Answered question 2: Qwen runners
    await db.insert(issueThreadInteractions).values({
      id: interaction2Id,
      companyId,
      issueId: issue2Id,
      kind: "ask_user_questions",
      status: "answered",
      title: "Which runner pool should be capped?",
      summary: "Owner chose WRX80 pool 2.",
      createdByAgentId: agentId,
      resolvedByUserId: userId,
      resolvedAt: t2,
      createdAt: t2,
      payload: {
        version: 1,
        questions: [
          {
            id: "pool",
            prompt: "Which runner pool should be capped?",
            selectionMode: "single",
            options: [
              { id: "pool-1", label: "Mac Pro pool" },
              { id: "pool-2", label: "WRX80 pool 2" },
            ],
          },
        ],
      },
      result: {
        version: 1,
        answers: [
          {
            questionId: "pool",
            optionIds: ["pool-2"],
          },
        ],
        summaryMarkdown: "- Which runner pool should be capped?: WRX80 pool 2",
      },
    });

    // Pending question: should NOT be returned
    await db.insert(issueThreadInteractions).values({
      id: pendingInteractionId,
      companyId,
      issueId: pendingIssueId,
      kind: "ask_user_questions",
      status: "pending",
      title: "Pending question",
      createdAt: new Date(),
      payload: {
        version: 1,
        questions: [
          {
            id: "q1",
            prompt: "Unanswered question?",
            selectionMode: "single",
            options: [{ id: "o1", label: "Choice 1" }],
          },
        ],
      },
    });

    const boardActor = {
      type: "board",
      source: "local_implicit",
      userId,
      companyIds: [companyId],
      isInstanceAdmin: false,
    };

    const app = createTestApp(boardActor);

    // 1. Fetch all answers
    const resAll = await request(app)
      .get(`/api/companies/${companyId}/answers`)
      .expect(200);

    expect(resAll.body.items).toHaveLength(2);
    // Ordered newest resolved first (interaction 2 then 1)
    expect(resAll.body.items[0].id).toBe(interaction2Id);
    expect(resAll.body.items[1].id).toBe(interaction1Id);

    // Check item fields on interaction 1
    const item1 = resAll.body.items[1];
    expect(item1.issueIdentifier).toBe("SCO-504");
    expect(item1.issueTitle).toBe("Integrate Maya runtime stats into ztop");
    expect(item1.projectName).toBe("Monitoring & Runtimes");
    expect(item1.questions).toHaveLength(1);
    expect(item1.questions[0].prompt).toBe("Where should Maya runtime stats be displayed?");
    expect(item1.questions[0].selectedOptionLabels).toEqual(["ztop dashboard"]);
    expect(item1.questions[0].otherText).toBe("Live update every 5s");
    expect(item1.documents).toHaveLength(1);
    expect(item1.documents[0].key).toBe("spec");
    expect(item1.documents[0].title).toBe("Maya Runtime Stats Specification");
    expect(item1.documents[0].href).toBe("/SCO/issues/SCO-504#document-spec");
    expect(item1.href).toBe(`/SCO/issues/SCO-504#interaction-${interaction1Id}`);

    // 2. Search keyword "Maya"
    const resMaya = await request(app)
      .get(`/api/companies/${companyId}/answers?search=Maya`)
      .expect(200);

    expect(resMaya.body.items).toHaveLength(1);
    expect(resMaya.body.items[0].id).toBe(interaction1Id);
    expect(resMaya.body.items[0].issueIdentifier).toBe("SCO-504");

    // 3. Search keyword "Qwen"
    const resQwen = await request(app)
      .get(`/api/companies/${companyId}/answers?search=Qwen`)
      .expect(200);

    expect(resQwen.body.items).toHaveLength(1);
    expect(resQwen.body.items[0].id).toBe(interaction2Id);
    expect(resQwen.body.items[0].issueIdentifier).toBe("SCO-732");

    // 4. Search answer value "ztop"
    const resZtop = await request(app)
      .get(`/api/companies/${companyId}/answers?search=ztop`)
      .expect(200);

    expect(resZtop.body.items).toHaveLength(1);
    expect(resZtop.body.items[0].id).toBe(interaction1Id);

    // 5. Search nonexistent term
    const resNone = await request(app)
      .get(`/api/companies/${companyId}/answers?search=nonexistentkeyword`)
      .expect(200);

    expect(resNone.body.items).toHaveLength(0);

    // 6. Pagination limit
    const resLimit = await request(app)
      .get(`/api/companies/${companyId}/answers?limit=1`)
      .expect(200);

    expect(resLimit.body.items).toHaveLength(1);
    expect(resLimit.body.nextCursor).toBeDefined();

    // 7. Attention alias endpoint
    const resAlias = await request(app)
      .get(`/api/companies/${companyId}/attention/answers`)
      .expect(200);

    expect(resAlias.body.items).toHaveLength(2);

    // 8. Authorization check: access denied for foreign company
    const unauthorizedActor = {
      type: "board",
      source: "session",
      userId,
      companyIds: [randomUUID()],
      isInstanceAdmin: false,
    };
    const unauthApp = createTestApp(unauthorizedActor);
    await request(unauthApp)
      .get(`/api/companies/${companyId}/answers`)
      .expect(403);
  });
});
