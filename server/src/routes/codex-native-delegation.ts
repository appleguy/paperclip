import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin } from "./authz.js";
import { registerCodexNativeDelegation, revokeCodexNativeDelegation, type NativeDaemonHost } from "../services/native-runtime/codex-native-delegation.js";
const registration=z.object({projectId:z.uuid(),agentId:z.uuid(),model:z.string().trim().min(1).max(240),effort:z.string().trim().min(1).max(240),expiresAt:z.iso.datetime()}).strict();
function administrator(req:Request,companyId:string):string {
  assertBoard(req);assertInstanceAdmin(req);assertCompanyAccess(req,companyId);
  if (req.actor.source==="local_implicit" || req.actor.isInstanceAdmin!==true || typeof req.actor.userId!=="string" || !req.actor.userId.trim()) throw forbidden("Authenticated Board instance administrator required");
  return req.actor.userId;
}
/** Host settings are server-owned; no daemon path, PID or claimed identity is accepted from HTTP. */
export function codexNativeDelegationRoutes(db:Db,host:NativeDaemonHost) {
  const router=Router();
  router.post("/companies/:companyId/codex-native-delegations",async(req,res)=>{
    const companyId=z.uuid().parse(req.params.companyId),issuer=administrator(req,companyId),body=registration.parse(req.body);
    const result=await registerCodexNativeDelegation(db,host,{...body,companyId,issuer,expiresAt:new Date(body.expiresAt)});
    res.set("Cache-Control","no-store").status(201).json(result);
  });
  router.post("/companies/:companyId/codex-native-delegations/:connectionId/revoke",async(req,res)=>{
    const companyId=z.uuid().parse(req.params.companyId),issuer=administrator(req,companyId),connectionId=z.uuid().parse(req.params.connectionId);
    z.object({}).strict().parse(req.body ?? {});
    await revokeCodexNativeDelegation(db,{companyId,connectionId,issuer});res.status(204).end();
  });
  return router;
}
