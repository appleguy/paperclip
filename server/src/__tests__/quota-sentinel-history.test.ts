import express from "express";
import request from "supertest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { costRoutes } from "../routes/costs.js";
import { errorHandler } from "../middleware/error-handler.js";

vi.mock("../services/index.js", () => ({
  heartbeatService: () => ({}), costService: () => ({}), financeService: () => ({}), budgetService: () => ({}),
  companyService: () => ({ getById: async () => ({}) }), agentService: () => ({}), issueService: () => ({}), accessService: () => ({}),
}));
const companyId = "11111111-1111-4111-8111-111111111111";
const path = `/api/companies/${companyId}/costs/quota-sentinel/history`;
let directory = "";
afterEach(async () => { delete process.env.PAPERCLIP_QUOTA_SENTINEL_SAMPLES_PATH; if (directory) await rm(directory, { recursive: true, force: true }); });
function app(agent = false) {
  const instance = express();
  instance.use((req, _res, next) => { req.actor = agent ? { type: "agent", agentId: "agent", companyId } as typeof req.actor : { type: "board", source: "session", userId: "alice", companyIds: [companyId] } as typeof req.actor; next(); });
  instance.use("/api", costRoutes({} as Db)); instance.use(errorHandler); return instance;
}
describe("quota history", () => {
  it("filters and allowlists streamed samples, enforces access, and bounds history", async () => {
    directory = await mkdtemp(join(tmpdir(), "quota-history-"));
    const file = join(directory, "samples.jsonl");
    process.env.PAPERCLIP_QUOTA_SENTINEL_SAMPLES_PATH = file;
    const sample = (days: number) => JSON.stringify({ observed_at: new Date(Date.now() - days * 86400000).toISOString(), secret: "private", providers: { claude: { windows: { weekly: { used_pct: 25, reset_at: "2027-01-01T00:00:00Z", account: "private" }, secret: { used_pct: 50 } } }, secret: { windows: { weekly: { used_pct: 50 } } } } });
    await writeFile(file, ["{bad", sample(1), sample(20), sample(31)].join("\n"));
    const response = await request(app()).get(path);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body.series).toEqual([{ provider: "claude", pool: "weekly", points: [expect.objectContaining({ usedPercent: 25, resetsAt: "2027-01-01T00:00:00Z" })] }]);
    expect(JSON.stringify(response.body)).not.toContain("private");
    expect((await request(app()).get(`${path}?days=999`)).body.series[0].points).toHaveLength(2);
    expect((await request(app()).get(`${path}?days=bad`)).status).toBe(400);
    expect((await request(app(true)).get(path)).status).toBe(403);
    expect((await request(app()).get("/api/companies/other/costs/quota-sentinel/history")).status).toBe(403);
  });
});
