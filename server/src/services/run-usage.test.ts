import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, runUsageReceipts, type Db } from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { withCodexRunQuota } from "../../../packages/adapters/codex-local/src/server/run-quota.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createRunUsageRecorder } from "./usage-receipts.js";
import { listRunUsage } from "./run-usage.js";

const fixture = JSON.parse(await fs.readFile(new URL("./run-usage.fixture.json", import.meta.url), "utf8"));
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("Codex quota receipt and cost projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let directory: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("run-usage-quota-");
    db = createDb(database.connectionString);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "run-usage-receipts-"));
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Run usage fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Quota fixture", adapterType: "codex_local", status: "active" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    return { companyId, runId };
  }

  it.each(["same window", "rollover", "unavailable", "strong streaming receipt"])("persists the fixture through recorder completion: %s", async scenario => {
    const owner = await seed();
    const recorder = await createRunUsageRecorder(db, { ...owner, adapterType: "codex_local" }, directory);
    const after = structuredClone(fixture.after);
    if (scenario === "rollover") {
      after.rateLimits.secondary.resetsAt = 1_800_604_800;
      after.rateLimits.secondary.usedPercent = 1;
    }
    const read = vi.fn().mockResolvedValueOnce(scenario === "unavailable" ? null : fixture.before)
      .mockResolvedValueOnce(scenario === "unavailable" ? null : after);
    const ctx = { config: { engine: "cli", modelReasoningEffort: fixture.effort, env: { OPENAI_API_KEY: "", CODEX_API_KEY: "" } },
      onLog: async () => {}, onUsage: recorder.capture } as unknown as AdapterExecutionContext;
    const result = await withCodexRunQuota(ctx, async context => {
      await context.onMeta!({ adapterType: "codex_local", command: "codex", cwd: directory, env: { CODEX_HOME: directory } });
      const usage = { usage: fixture.usage, usageBasis: "per_run" as const, provider: "openai", biller: "openai",
        model: "gpt-6.1-sol", billingType: "subscription" as const, costUsd: 0, complete: true };
      await context.onUsage!(usage);
      return { ...usage, exitCode: 0, signal: null, timedOut: false, usageComplete: scenario !== "strong streaming receipt" };
    }, read);
    await recorder.complete(result);
    expect(read).toHaveBeenCalledTimes(2);
    const expected = scenario === "unavailable" ? { quota_pct_before: null, quota_pct_after: null, window_id: null,
      window_id_before: null, window_id_after: null, quota_window_rollover: null, effort: "xhigh" }
      : scenario === "rollover" ? { ...fixture.expected, quota_pct_after: 1, window_id: null, window_id_after: "1800604800", quota_window_rollover: true }
      : fixture.expected;
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
    expect(stored.usageJson).toMatchObject({ ...fixture.usage, ...expected, accountingReceiptReady: true });
    const [receipt] = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.id, stored.usageJson!.accountingReceiptId as string));
    expect(receipt.receiptJson).toMatchObject({ receipt: { ...expected, usage: fixture.usage, complete: true } });
    const rows = await listRunUsage(db, owner.companyId, { allTime: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: owner.runId, ...expected, ...fixture.usage, model: "gpt-6.1-sol" });
  });

  it("keeps historical missing quota null and scopes and bounds the cost query", async () => {
    const owner = await seed(), foreign = await seed();
    await db.update(heartbeatRuns).set({ usageJson: { inputTokens: 0 } }).where(eq(heartbeatRuns.id, owner.runId));
    const rows = await listRunUsage(db, owner.companyId, { allTime: true }, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: owner.runId, inputTokens: 0, quota_pct_before: null, quota_pct_after: null, window_id: null, effort: null });
    expect(rows.some(row => row.runId === foreign.runId)).toBe(false);
    expect(await listRunUsage(db, owner.companyId, { from: new Date("2000-01-01"), to: new Date("2000-01-02") })).toEqual([]);
  });
});
