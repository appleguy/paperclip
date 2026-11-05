import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { receiptFilePath } from "../agy/execute.js";
import { isReviewContinuation, reconcileForeignSettlement, settleOutcome } from "./settlement.js";

const sourceRunId = "11111111-1111-4111-8111-111111111111";
const receipt = { runId: sourceRunId, issueId: "original", status: "done", summary: "Original work complete",
  report: "Original operation verified with committed work and durable evidence. ".repeat(6) };
const outcome = { kind: "done" as const, receipt };
let dir: string;
let activePath: string;
let report: { body: string; latestRevisionId: string } | null;
let status: string;
let failAt: string | null;
let calls: string[];
let fetchMock: Mock<(url: string, init: RequestInit) => Promise<Response>>;
const ctx = (issueId = "original") => ({
  runId: "22222222-2222-4222-8222-222222222222", agent: { id: "seat" }, context: { issueId },
  authToken: "scoped-test", onLog: vi.fn(),
} as unknown as AdapterExecutionContext);

beforeEach(async () => {
  dir = await fs.mkdtemp("/Volumes/NVM/AI_Agent_Runtime/tmp/f07-settlement-");
  activePath = path.join(dir, "active.json");
  await fs.writeFile(activePath, JSON.stringify({ runId: sourceRunId, issueId: "original", rcUrl: "https://claude.ai/code/original",
    receiptPath: receiptFilePath(dir, sourceRunId) }));
  await fs.writeFile(receiptFilePath(dir, sourceRunId), JSON.stringify(receipt));
  report = null; status = "in_progress"; failAt = null; calls = [];
  fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const route = new URL(url).pathname;
    const call = `${init.method} ${route}`;
    calls.push(call);
    expect((init.headers as Record<string, string>)["X-Paperclip-Run-Id"]).toBe(ctx().runId);
    if (failAt === call) throw new Error("simulated process/transport interruption");
    if (route === "/api/agents/seat/wakeup") return Response.json({ status: "queued" }, { status: 202 });
    if (route.endsWith("/documents/report")) {
      if (init.method === "PUT") {
        report = { body: JSON.parse(init.body as string).body, latestRevisionId: "revision" };
        return Response.json(report);
      }
      return report ? Response.json(report) : Response.json({ error: "absent" }, { status: 404 });
    }
    if (init.method === "PATCH") status = JSON.parse(init.body as string).status;
    return Response.json({ id: "original", status });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  // Synthetic state only; original owner records never enter this fixture.
  await fs.rm(dir, { recursive: true, force: true });
});

const retained = async () => expect(await fs.readFile(activePath, "utf8")).toContain(sourceRunId);
const noForeignDelivery = () => expect(calls.every(call => call === "POST /api/agents/seat/wakeup")).toBe(true);

describe("F07 durable receipt settlement", () => {
  it("retains a valid receipt written before delivery and requests only a scoped recovery", async () => {
    await expect(reconcileForeignSettlement(ctx("next"), dir, activePath)).rejects.toThrow("previous task unresolved");
    await retained(); noForeignDelivery();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      payload: { issueId: "original" }, idempotencyKey: `claude-rc-settlement:${sourceRunId}`,
    });
  });
  it("never treats one-character JSON or a block terminal as settlement", async () => {
    await fs.writeFile(receiptFilePath(dir, sourceRunId), "{");
    await fs.mkdir(path.join(dir, "channel-bridge"));
    await fs.writeFile(path.join(dir, "channel-bridge/ledger.jsonl"), JSON.stringify({ ev: "terminal", kind: "block", op_id: sourceRunId }));
    await expect(reconcileForeignSettlement(ctx("next"), dir, activePath)).rejects.toThrow("previous task unresolved");
    await retained(); noForeignDelivery();
  });
  it("finishes report-before-status recovery without publishing a second report revision", async () => {
    failAt = "GET /api/issues/original";
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).rejects.toThrow("interruption");
    expect(report?.body).toBe(receipt.report);
    await retained();
    failAt = null;
    await settleOutcome(ctx(), dir, sourceRunId, "original", outcome);
    expect(calls.filter(c => c.startsWith("PUT"))).toHaveLength(1);
    expect(status).toBe("done");
    await reconcileForeignSettlement(ctx("next"), dir, activePath);
    await expect(fs.stat(activePath)).rejects.toThrow();
  });
  it("reconciles status persisted before acknowledgement/cleanup without repeating the transition", async () => {
    let loseAck = true;
    const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const response = await handler(url, init);
      if (init.method === "PATCH" && loseAck) { loseAck = false; throw new Error("lost status acknowledgement"); }
      return response;
    });
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).rejects.toThrow("lost status");
    expect(status).toBe("done");
    // A foreign issue still cannot infer delivery from files/status it cannot reconcile.
    await expect(reconcileForeignSettlement(ctx("next"), dir, activePath)).rejects.toThrow("unresolved");
    await retained();
    await settleOutcome(ctx(), dir, sourceRunId, "original", outcome);
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
    await reconcileForeignSettlement(ctx("next"), dir, activePath);
    await expect(fs.stat(activePath)).rejects.toThrow();
  });
  it("archives a settled checkpoint after a cleanup crash without delivery or provider replay", async () => {
    await settleOutcome(ctx(), dir, sourceRunId, "original", outcome);
    calls = [];
    await reconcileForeignSettlement(ctx("next"), dir, activePath);
    expect(calls).toEqual([]);
    expect(await fs.readFile(path.join(dir, `active.settled-${sourceRunId}.json`), "utf8")).toContain(sourceRunId);
  });
  it("retains malformed/mismatched markers and a receipt replaced after delivery", async () => {
    await fs.writeFile(path.join(dir, `settled-${sourceRunId}.json`), "{");
    await expect(reconcileForeignSettlement(ctx("next"), dir, activePath)).rejects.toThrow("unresolved");
    await settleOutcome(ctx(), dir, sourceRunId, "original", outcome);
    await fs.writeFile(receiptFilePath(dir, sourceRunId), JSON.stringify({ ...receipt, report: receipt.report + "changed" }));
    await expect(reconcileForeignSettlement(ctx("next"), dir, activePath)).rejects.toThrow("unresolved");
    await retained();
  });
  it("does not mutate another issue even with a syntactically valid receipt", async () => {
    await expect(settleOutcome(ctx("next"), dir, sourceRunId, "original", outcome)).rejects.toThrow("original issue scope");
    expect(calls).toEqual([]); await retained();
  });
  it("retains original work if recovery scheduling is denied", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "denied" }, { status: 403 }));
    await expect(reconcileForeignSettlement(ctx("next"), dir, activePath)).rejects.toThrow("unresolved");
    await retained();
  });
  it("retains failed authenticated delivery and does not mark it settled", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "denied" }, { status: 403 }));
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).rejects.toThrow("HTTP 403");
    await retained();
    await expect(fs.stat(path.join(dir, `settled-${sourceRunId}.json`))).rejects.toThrow();
  });
  it("does not mistake a successful review-stage PATCH for done or replay it", async () => {
    const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const response = await handler(url, init);
      if (init.method === "PATCH") status = "in_review";
      return response;
    });
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).resolves.toMatchObject({ status: "in_review" });
    expect(await isReviewContinuation(ctx(), dir, sourceRunId, "original", receipt)).toBe(true);
    expect(await isReviewContinuation(ctx(), dir, sourceRunId, "original", { ...receipt, report: receipt.report + "changed" })).toBe(false);
    expect(await isReviewContinuation(ctx("next"), dir, sourceRunId, "next", receipt)).toBe(false);
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).resolves.toMatchObject({ status: "in_review" });
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
    await retained();
    await expect(reconcileForeignSettlement(ctx("next"), dir, activePath)).rejects.toThrow("unresolved");
    await retained();
    status = "done"; // The real reviewer, rather than the delivery retry, finished review.
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).resolves.toMatchObject({ status: "done" });
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
    await reconcileForeignSettlement(ctx("next"), dir, activePath);
    await expect(fs.stat(activePath)).rejects.toThrow();
  });
  it("keeps same-issue adoption on the existing operation", async () => {
    await reconcileForeignSettlement(ctx(), dir, activePath);
    await retained(); expect(calls).toEqual([]);
  });

  it.each(["", "{", "null", "{}"])("retains an invalid status acknowledgement and recovers review without repeating PATCH: %j", async body => {
    const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      const response = await handler(url, init);
      if (init.method === "PATCH") { status = "in_review"; return new Response(body); }
      return response;
    });
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).rejects.toThrow();
    await retained();
    await expect(fs.stat(path.join(dir, `settled-${sourceRunId}.json`))).rejects.toThrow();
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).resolves.toMatchObject({ status: "in_review" });
    expect(calls.filter(c => c.startsWith("PATCH"))).toHaveLength(1);
  });

  it.each(["", "{", "null", "{}"])("rejects an invalid report success acknowledgement: %j", async body => {
    const handler = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
      init.method === "PUT" ? new Response(body) : handler(url, init));
    await expect(settleOutcome(ctx(), dir, sourceRunId, "original", outcome)).rejects.toThrow();
    await retained();
    expect(calls.some(c => c.startsWith("PATCH"))).toBe(false);
  });
  it("requires verified blocked delivery before releasing a foreign block terminal", async () => {
    await settleOutcome(ctx(), dir, sourceRunId, "original", { kind: "block", reason: "Missing input" });
    expect(status).toBe("blocked");
    calls = [];
    await reconcileForeignSettlement(ctx("next"), dir, activePath);
    expect(calls).toEqual([]);
    await expect(fs.stat(activePath)).rejects.toThrow();
  });
});
