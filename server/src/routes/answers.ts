import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { assertBoardOrAgent, assertCompanyAccess } from "./authz.js";
import { answersService } from "../services/answers.js";

const querySchema = z
  .object({
    search: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().max(1000).optional(),
    projectId: z.string().uuid().optional(),
    issueId: z.string().uuid().optional(),
  })
  .strict();

export function answersRoutes(db: Db) {
  const router = Router();
  const svc = answersService(db);

  const handler = async (req: any, res: any) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardOrAgent(req);

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      throw badRequest("Invalid answers query parameters");
    }

    const data = await svc.list(companyId, {
      ...parsed.data,
      actor: req.actor,
      userId: req.actor?.userId ?? null,
    });
    res.json(data);
  };

  router.get("/companies/:companyId/answers", handler);
  router.get("/companies/:companyId/attention/answers", handler);

  return router;
}
