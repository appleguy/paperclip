import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, forbidden } from "../errors.js";
import { exactCancelledOwner } from "../services/native-runtime/cancelled-retained-cleanup-authority.js";
import { reconcileCancelledRetainedNativeSessionCleanup } from "../services/native-runtime/native-session-executor.js";
import { logActivity } from "../services/activity-log.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";

/** An explicit Board request can only address the inventoried cancelled owner.
 * Proofs and receipts are exclusively server-derived, never request payloads. */
export function cancelledNativeCleanupRoutes(db: Db) {
  const router = Router();
  router.post("/companies/:companyId/native-cleanup/cancelled", async (req, res) => {
    assertBoard(req);
    assertInstanceAdmin(req);
    // Local implicit administration is intentionally insufficient for this
    // exact-owner operation: the audit must identify an authenticated Board user.
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin !== true ||
        typeof req.actor.userId !== "string" || !req.actor.userId.trim()) {
      throw forbidden("Authenticated Board instance administrator required");
    }
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body: unknown = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).length !== 3 ||
        Object.keys(body).some((key) => !["runId", "expectedFingerprint", "requestId"].includes(key))) {
      throw badRequest("Exact run, source fingerprint and request ID are required");
    }
    const input = body as Record<string, unknown>;
    if (companyId !== exactCancelledOwner.companyId || input.runId !== exactCancelledOwner.runId ||
        input.expectedFingerprint !== exactCancelledOwner.sourceFingerprint ||
        typeof input.requestId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.requestId)) {
      throw badRequest("Exact cancelled owner and valid request ID are required");
    }
    const audit = { companyId, actorType: "user" as const, actorId: req.actor.userId,
      entityType: "heartbeat_run", entityId: input.runId,
      details: { requestId: input.requestId } };
    await logActivity(db, { ...audit, action: "native_cleanup.cancelled_requested" });
    let result: Awaited<ReturnType<typeof reconcileCancelledRetainedNativeSessionCleanup>>;
    try {
      result = await reconcileCancelledRetainedNativeSessionCleanup(db, {
        companyId, runId: input.runId, expectedFingerprint: input.expectedFingerprint,
        requestId: input.requestId, actorId: req.actor.userId,
      });
    } catch (error) {
      await logActivity(db, { ...audit, action: "native_cleanup.cancelled_result",
        details: { ...audit.details, status: "error" } });
      throw error;
    }
    await logActivity(db, { ...audit, action: "native_cleanup.cancelled_result",
      details: { ...audit.details, status: result.status } });
    // The in-process proof and receipt material must never cross the API boundary.
    res.json({ status: result.status });
  });
  return router;
}
