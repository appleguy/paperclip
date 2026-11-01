import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");
const mocks = vi.hoisted(() => ({ reconcile: vi.fn(), logActivity: vi.fn() }));
vi.mock("../services/native-runtime/native-session-executor.js", () => ({
  reconcileCancelledRetainedNativeSessionCleanup: mocks.reconcile,
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: mocks.logActivity }));
import { errorHandler } from "../middleware/error-handler.js";
import { exactCancelledOwner } from "../services/native-runtime/cancelled-retained-cleanup-authority.js";
import { cancelledNativeCleanupRoutes } from "./cancelled-native-cleanup.js";

const db = {} as Db;
const owner = exactCancelledOwner;
const path = `/api/companies/${owner.companyId}/native-cleanup/cancelled`;
const input = { runId: owner.runId, expectedFingerprint: owner.sourceFingerprint,
  requestId: "a1e52d6f-4d43-4db8-a7af-99f010001111" };
const board: Express.Request["actor"] = { type: "board", source: "board_key",
  isInstanceAdmin: true, userId: "board-user", companyIds: [owner.companyId] };

function app(actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", cancelledNativeCleanupRoutes(db));
  app.use(errorHandler);
  return app;
}

describe("cancelled native cleanup route", () => {
  beforeEach(() => { mocks.reconcile.mockReset().mockResolvedValue({ status: "settled" }); mocks.logActivity.mockReset().mockResolvedValue(undefined); });
  it("denies agent, non-admin and implicit actors before calling the executor", async () => {
    for (const actor of [
      { type: "agent", source: "agent_key", companyId: owner.companyId },
      { ...board, isInstanceAdmin: false },
      { ...board, source: "local_implicit" },
      { ...board, userId: undefined },
    ] as Express.Request["actor"][]) {
      await request(app(actor)).post(path).send(input).expect(403);
    }
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });
  it("denies a Board admin without access to the target company", async () => {
    await request(app({ ...board, companyIds: [] })).post(path).send(input).expect(403);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });
  it("rejects wrong owner, fingerprint, request ID and client proof", async () => {
    for (const body of [
      { ...input, runId: "other" }, { ...input, expectedFingerprint: "0".repeat(64) },
      { ...input, requestId: "bad" }, { ...input, proof: {} },
    ]) await request(app(board)).post(path).send(body).expect(400);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it("passes only the exact request and authenticated actor to the server executor", async () => {
    mocks.reconcile.mockResolvedValueOnce({ status: "settled", proof: { private: true }, receipt: "private" });
    await request(app(board)).post(path).send(input).expect(200, { status: "settled" });
    expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(db, {
      companyId: owner.companyId, ...input, actorId: "board-user",
    });
    expect(mocks.logActivity.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ action: "native_cleanup.cancelled_requested", actorId: "board-user", details: { requestId: input.requestId } }),
      expect.objectContaining({ action: "native_cleanup.cancelled_result", actorId: "board-user", details: { requestId: input.requestId, status: "settled" } }),
    ]);
  });
  it("audits executor errors without logging error or receipt contents", async () => {
    mocks.reconcile.mockRejectedValueOnce(new Error("private"));
    await request(app(board)).post(path).send(input).expect(500);
    expect(mocks.logActivity.mock.calls[1]?.[1]).toMatchObject({
      action: "native_cleanup.cancelled_result", details: { requestId: input.requestId, status: "error" },
    });
  });
});
