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
const path = `/api/companies/${companyId}/costs/quota-sentinel`;
let directory = "";
afterEach(async () => {
  delete process.env.PAPERCLIP_QUOTA_SENTINEL_STATUS_PATH;
  delete process.env.PAPERCLIP_CHATGPT_WEB_QUOTA_PATH;
  delete process.env.PAPERCLIP_CREDIT_OFFERS_PATH;
  delete process.env.PAPERCLIP_WEB_STATS_EVENTS_PATH;
  delete process.env.PAPERCLIP_WEB_STATS_FALLBACK_PATH;
  if (directory) await rm(directory, { recursive: true, force: true });
});
function app() {
  const instance = express();
  instance.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: "alice", companyIds: [companyId] } as typeof req.actor; next(); });
  instance.use("/api", costRoutes({} as Db)); instance.use(errorHandler); return instance;
}
const iso = (ms: number) => new Date(ms).toISOString();
describe("quota sentinel web dispatches", () => {
  it("reports deduplicated observed dispatch counts with source and observation time", async () => {
    directory = await mkdtemp(join(tmpdir(), "quota-web-dispatches-"));
    const now = Date.now();
    const status = join(directory, "status.json");
    await writeFile(status, JSON.stringify({ observed_at: iso(now), providers: {} }));
    process.env.PAPERCLIP_QUOTA_SENTINEL_STATUS_PATH = status;
    process.env.PAPERCLIP_CHATGPT_WEB_QUOTA_PATH = join(directory, "missing-quota.json");
    process.env.PAPERCLIP_CREDIT_OFFERS_PATH = join(directory, "missing-offers.json");
    const events = join(directory, "events.jsonl");
    const send = (at: number, url: string) => JSON.stringify({ at: iso(at), kind: "send", url });
    await writeFile(events, [
      "{bad",
      send(now - 2 * 60000, "https://chatgpt.com/c/one"),
      send(now - 2 * 60000, "https://chatgpt.com/c/one"), // duplicate log of the same dispatch
      JSON.stringify({ at: iso(now - 30 * 60000), op: "follow-up", url: "https://chatgpt.com/c/two" }),
      JSON.stringify({ at: iso(now - 3 * 3600000), kind: "new-thread", url: "https://chatgpt.com/c/three" }),
      send(now - 3 * 86400000, "https://chatgpt.com/c/old"), // outside 24h
      JSON.stringify({ at: iso(now - 60000), kind: "load", url: "https://chatgpt.com/c/page" }), // page load, not a dispatch
      JSON.stringify({ kind: "send", url: "https://chatgpt.com/c/notime" }), // untimestamped
      send(now + 3600000, "https://chatgpt.com/c/future"), // future-dated
    ].join("\n"));
    process.env.PAPERCLIP_WEB_STATS_EVENTS_PATH = events;
    process.env.PAPERCLIP_WEB_STATS_FALLBACK_PATH = join(directory, "missing-fallback.jsonl");
    const response = await request(app()).get(path);
    expect(response.status).toBe(200);
    expect(response.body.webDispatches).toEqual({
      source: "b-web-stats",
      observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
      counts: { "5m": 1, "1h": 2, "24h": 3 },
    });
  });
  it("falls back to the second feed when the primary is missing", async () => {
    directory = await mkdtemp(join(tmpdir(), "quota-web-dispatches-"));
    const now = Date.now();
    const status = join(directory, "status.json");
    await writeFile(status, JSON.stringify({ observed_at: iso(now), providers: {} }));
    process.env.PAPERCLIP_QUOTA_SENTINEL_STATUS_PATH = status;
    process.env.PAPERCLIP_CHATGPT_WEB_QUOTA_PATH = join(directory, "missing-quota.json");
    process.env.PAPERCLIP_CREDIT_OFFERS_PATH = join(directory, "missing-offers.json");
    const fallback = join(directory, "pro-events.jsonl");
    await writeFile(fallback, JSON.stringify({ at: iso(now - 10 * 60000), kind: "send", url: "https://chatgpt.com/c/one" }) + "\n");
    process.env.PAPERCLIP_WEB_STATS_EVENTS_PATH = join(directory, "missing-events.jsonl");
    process.env.PAPERCLIP_WEB_STATS_FALLBACK_PATH = fallback;
    const response = await request(app()).get(path);
    expect(response.status).toBe(200);
    expect(response.body.webDispatches).toMatchObject({ source: "b-web-stats", counts: { "5m": 0, "1h": 1, "24h": 1 } });
  });
  it("reports zero counts from a readable empty feed and no source when both feeds are missing", async () => {
    directory = await mkdtemp(join(tmpdir(), "quota-web-dispatches-"));
    const now = Date.now();
    const status = join(directory, "status.json");
    await writeFile(status, JSON.stringify({ observed_at: iso(now), providers: {} }));
    process.env.PAPERCLIP_QUOTA_SENTINEL_STATUS_PATH = status;
    process.env.PAPERCLIP_CHATGPT_WEB_QUOTA_PATH = join(directory, "missing-quota.json");
    process.env.PAPERCLIP_CREDIT_OFFERS_PATH = join(directory, "missing-offers.json");
    const empty = join(directory, "events.jsonl");
    await writeFile(empty, "");
    process.env.PAPERCLIP_WEB_STATS_EVENTS_PATH = empty;
    process.env.PAPERCLIP_WEB_STATS_FALLBACK_PATH = join(directory, "missing-fallback.jsonl");
    const observed = await request(app()).get(path);
    expect(observed.status).toBe(200);
    expect(observed.body.webDispatches).toMatchObject({ source: "b-web-stats", counts: { "5m": 0, "1h": 0, "24h": 0 } });
    process.env.PAPERCLIP_WEB_STATS_EVENTS_PATH = join(directory, "missing-events.jsonl");
    const missing = await request(app()).get(path);
    expect(missing.status).toBe(200);
    expect(missing.body.webDispatches).toBeNull();
  });
});
