import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { authorizationService } from "../services/authorization.js";
import { nativeSessionCatalog } from "../services/native-runtime/native-session-catalog.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function nativeSessionCatalogRoutes(db: Db) {
  const router = Router();
  const catalog = nativeSessionCatalog(db, authorizationService(db));
  router.get("/companies/:companyId/native-sessions", async (req, res) => {
    assertBoard(req);
    const companyId = z.uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    if (Object.keys(req.query).some(key => key !== "limit")) throw badRequest("Unknown catalog parameter");
    const parsed = z.coerce.number().int().min(1).max(100).optional().safeParse(req.query.limit);
    if (!parsed.success) throw badRequest("Invalid catalog limit");
    const sessions = await catalog.list({ companyId, actor: req.actor,
      authorizeCompany: () => assertCompanyAccess(req, companyId), limit: parsed.data });
    res.set("Cache-Control", "no-store").json({ sessions });
  });
  return router;
}
