import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, issueIdentifierAliases, issues, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("project issue prefixes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-issue-prefixes-");
    db = createDb(tempDb.connectionString);
  });
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allocates per-project identifiers, keeps company ones, and resolves aliases", async () => {
    const companyId = randomUUID();
    const tensorId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pfx", issuePrefix: "SCO" });
    await db.insert(projects).values([
      { id: tensorId, companyId, name: "Tensor64", issuePrefix: "T" },
    ]);
    const svc = issueService(db);

    const plain1 = await svc.create(companyId, { title: "plain 1" } as any);
    const t1 = await svc.create(companyId, { title: "t1", projectId: tensorId } as any);
    const t2 = await svc.create(companyId, { title: "t2", projectId: tensorId } as any);
    const plain2 = await svc.create(companyId, { title: "plain 2" } as any);
    expect([plain1.identifier, t1.identifier, t2.identifier, plain2.identifier]).toEqual([
      "SCO-1",
      "T-1",
      "T-2",
      "SCO-2",
    ]);

    // Re-key plain2 to a project identifier; the old identifier stays an alias.
    await db.update(issues).set({ identifier: "T-3", issueNumber: 3 }).where(eq(issues.id, plain2.id));
    await db.insert(issueIdentifierAliases).values({ identifier: "SCO-2", issueId: plain2.id, companyId });
    expect((await svc.getByIdentifier("sco-2"))?.id).toBe(plain2.id);
    expect((await svc.getByIdentifier("T-3"))?.id).toBe(plain2.id);

    const t4 = await svc.create(companyId, { title: "t4", projectId: tensorId } as any);
    expect(t4.identifier).toBe("T-4");
  });
});
